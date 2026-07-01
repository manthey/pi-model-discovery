import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ModelDiscoveryConfig, ModelDiscoveryState } from './types';
import { FALLBACK_CONFIG, loadModelDiscoveryConfig } from './config';
import { isModelDiscoveryState, buildPersistedState } from './state';
import { updateStatus } from './ui';
import { registerCommands } from './commands';
import { performSync, fetchActiveContextLimits, type ModelCapabilities } from './sync';
import { snapshotFromState, type ModelSnapshot } from './widget';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const modelDiscoveryExtension = async (pi: ExtensionAPI) => {
  let currentConfig: ModelDiscoveryConfig = FALLBACK_CONFIG;
  let currentCwd = process.cwd();
  let debugEnabled = false;
  let enabled = false;
  let lastSync: ModelDiscoveryState['lastSync'] = undefined;
  let lastPersistedSnapshot: string | undefined;
  let currentModelRef: string | null = null;
  let thinkingLevel: string | null = null;
  let ollamaReachable = false;
  let syncedAt: number | undefined = undefined;
  let activeCtx: ExtensionContext | null = null;

  // Cache of per-model capabilities built during the last sync so we can rebuild models
  // when active context limits change without re-fetching /api/tags.
  let cachedOllamaCapabilities: Record<string, ModelCapabilities> | null = null;

  // Track whether we've verified each model's context limit via api/ps.
  // When a model is selected or session starts, it may not be loaded yet so
  // won't appear in api/ps — we recheck after the first provider request.
  let seenModelCtxLimits: Set<string> | null = null;

  /** Check if we have already verified this model exists in active server state. */
  const hasSeenModelContextLimit = (modelName: string): boolean => {
    return seenModelCtxLimits?.has(modelName) ?? false;
  };

  /** Record that we've seen a model's context limit in the server response. */
  const markModelSeen = (modelName: string): void => {
    if (!seenModelCtxLimits) seenModelCtxLimits = new Set();
    seenModelCtxLimits.add(modelName);
  };

  const persist = (state: ModelDiscoveryState) => {
    const snapshot = JSON.stringify({ ...state, timestamp: 0 });
    if (snapshot === lastPersistedSnapshot) return;
    pi.appendEntry('discovery-state', state);
    lastPersistedSnapshot = snapshot;
  };

  /**
   * Write the current effective config to disk.
   * Only writes if a config file already exists (created via /providers init).
   * Otherwise toggles are kept in-memory only — the user explicitly opts in
   * to disk persistence by running /providers init first.
   */
  const persistConfigToDisk = () => {
    const configPath = join(getAgentDir(), 'local-providers.json');
    if (!existsSync(configPath)) return; // No file yet — wait for /providers init
    try {
      // Merge with what's on disk so user-added fields aren't lost
      const existing = JSON.parse(readFileSync(configPath, 'utf-8')) || {};
      const merged = { ...existing, ...currentConfig };
      writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
    } catch { /* best-effort */ }
  };

  const getCurrentSnapshot = (): ModelSnapshot | null => {
    if (!currentModelRef) return null;
    return snapshotFromState(currentModelRef, {
      enabled, debugEnabled, lastSync, timestamp: 0,
    });
  };

  const refreshStatus = () => {
    if (!activeCtx) return;
    updateStatus(
      activeCtx,
      {
        current: getCurrentSnapshot(),
        totalRegistered: lastSync?.ollama?.modelIds.length ?? 0,
        thinkingLevel,
      },
      currentConfig.showFooterStatus !== false,
      currentConfig.showCapLabelText === true,
      currentConfig.showLocationLabels === true,
    );
  };

  const actions = {
    persistState: () => persist(buildPersistedState(enabled, debugEnabled, lastSync)),
    /**
     * Check Ollama's api/ps for active model context limits. If any found to be lower than
     * our cached values, rebuild the provider config with updated windows and re-register it
     * so compaction uses the correct limits.
     */
    updateActiveContextLimits: async (): Promise<boolean> => {
      const ollamaCfg = currentConfig.providers?.ollama;
      if (!enabled || !ollamaReachable || !lastSync?.ollama) {
        return false;
      }

      const baseUrl = (ollamaCfg?.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
      try {
        const activeLimits = await fetchActiveContextLimits(baseUrl);

        if (!activeLimits || Object.keys(activeLimits).length === 0) {
          // No active models on server — no update needed yet
          return false;
        }

        if (!lastSync.ollama.contextWindows) {
          return false; // Nothing to compare against
        }

        // Check if any active limit is lower than what we have
        const windowsCopy = { ...lastSync.ollama.contextWindows };
        let needsUpdate = false;

        for (const [name, limit] of Object.entries(activeLimits)) {
          // Mark all found models as seen so we don't recheck on every provider request.
          markModelSeen(name);
          if (typeof limit === 'number' && limit < (windowsCopy[name] ?? Infinity)) {
            windowsCopy[name] = limit;
            needsUpdate = true;
          }
        }

        // If nothing changed or no update needed, don't do anything.
        if (!needsUpdate) {
          return false;
        }

        // Rebuild and re-register the provider with updated context windows
        await actions.rebuildAndResyncOllama(windowsCopy);
        return true; // Indicate we successfully updated something
      } catch (err) {
        if (debugEnabled) console.error('[Providers] Error fetching active context limits:', err);
        return false;
      }
    },

    /** Re-sync Ollama models with updated context windows using cached capabilities data. */
    rebuildAndResyncOllama: async (newContextWindows: Record<string, number>) => {
      if (!lastSync?.ollama || !cachedOllamaCapabilities) {
        return;
      }

      const ollamaCfg = currentConfig.providers?.ollama;
      const baseUrl = (ollamaCfg?.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');

      try {
        // Rebuild the model array using cached capabilities and new context windows
        const models = lastSync.ollama.modelIds.map((modelName) => {
          const caps = cachedOllamaCapabilities![modelName];
          if (!caps) return null;

          // Use the server-enforced limit for this model if we have it
          const effectiveWindow = newContextWindows[modelName] ?? caps.contextWindow;

          const displayName = caps.parameterSize
            ? `${modelName} (${caps.parameterSize})`
            : modelName;

          return {
            id: modelName,
            name: displayName,
            reasoning: caps.reasoning,
            thinkingLevelMap: caps.reasoning
              ? { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high' }
              : { off: null, minimal: null, low: null, medium: null, high: null },
            input: (caps.vision ? ['text', 'image'] : ['text']) as ('text' | 'image')[],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: effectiveWindow,
            maxTokens: 4096,
          };
        }).filter((m): m is NonNullable<typeof m> => m !== null);

        if (models.length === 0) {
          return;
        }

        // Re-register the Ollama provider with updated models.
        pi.registerProvider('ollama', {
          baseUrl: baseUrl + '/v1',
          apiKey: 'ollama',
          api: 'openai-completions',
          models,
        });

        // Update our local state with the new context windows
        const newState = {
          ...lastSync,
          ollama: { ...lastSync.ollama, contextWindows: newContextWindows },
        };
        lastSync = newState;
        syncedAt = Date.now();
        persist(buildPersistedState(enabled, debugEnabled, lastSync));

        if (debugEnabled) {
          // Collect models that had their limits lowered (comparing server limit vs manifest default)
          const baseUrl2 = (ollamaCfg?.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
          try {
            const latestActiveLimits = await fetchActiveContextLimits(baseUrl2);
            const updatedModels: string[] = [];
            for (const [m, limit] of Object.entries(latestActiveLimits ?? {})) {
              if (typeof limit === 'number' && cachedOllamaCapabilities?.[m]) {
                const original = cachedOllamaCapabilities[m].contextWindow;
                if (limit < original) {
                  updatedModels.push(`- ${m}: ${limit} (was ${original})`);
                }
              }
            }
            if (updatedModels.length > 0) {
              console.log('[Providers] Updated context windows:', updatedModels.join(', '));
            }
          } catch {}
        }
      } catch (err) {
        if (debugEnabled) console.error('[Providers] Error rebuilding provider:', err);
      }
    },

    persistLastSync: (next: ModelDiscoveryState['lastSync']) => {
      lastSync = next;
      syncedAt = Date.now();
      persist(buildPersistedState(enabled, debugEnabled, lastSync));
      refreshStatus();
    },
    setShowFooterStatus: (on: boolean) => {
      currentConfig = { ...currentConfig, showFooterStatus: on };
      persistConfigToDisk();
    },
    setShowCapLabelText: (on: boolean) => {
      currentConfig = { ...currentConfig, showCapLabelText: on };
      persistConfigToDisk();
    },
    setShowLocationLabels: (on: boolean) => {
      currentConfig = { ...currentConfig, showLocationLabels: on };
      persistConfigToDisk();
    },
    updateStatus: (_ctx: ExtensionContext) => refreshStatus(),
    refreshStatus,
    reloadConfig: (ctx?: ExtensionContext, options?: { preserveDebug?: boolean }) => {
      const loaded = loadModelDiscoveryConfig(currentCwd);
      // Merge with the previous in-memory config so toggles (labels on/off, etc.)
      // are not reset when the user runs /providers reload.
      const previous = currentConfig;
      currentConfig = { ...previous, ...loaded.config };
      if (!options?.preserveDebug) debugEnabled = currentConfig.debug ?? false;
      if (ctx) refreshStatus();
    },
  };

  // ── Startup sync (async factory - runs before session_start) ─────
  actions.reloadConfig();

  if (currentConfig.syncOnStartup) {
    const result = await performSync(pi, {
      syncOnStartup: true,
      addToScope: false,
      providers: currentConfig.providers ?? {},
    });
    if (result.capabilities) {
      lastSync = result.capabilities;
      syncedAt = Date.now();
      cachedOllamaCapabilities = extractCapabilitiesFromTags(result);
    }
    ollamaReachable = result.success;
    if (result.added.length > 0) {
      console.log(`[Providers] Registered ${result.added.length} Ollama model(s).`);
    } else if (!result.success) {
      console.log(`[Providers] ${result.message}`);
    }
  }

  const restoreStateFromSession = async (ctx: ExtensionContext) => {
    currentCwd = ctx.cwd;
    activeCtx = ctx;
    actions.reloadConfig(ctx);
    enabled = true;

    const entries = ctx.sessionManager.getBranch() as any[];
    const savedState = entries
      .filter((e) => e.type === 'custom' && e.customType === 'discovery-state')
      .map((e) => e.data)
      .findLast((data) => isModelDiscoveryState(data));

    if (isModelDiscoveryState(savedState)) {
      enabled = savedState.enabled;
      debugEnabled = savedState.debugEnabled ?? debugEnabled;
      if (savedState.lastSync) lastSync = savedState.lastSync;
    }

    actions.persistState();
    refreshStatus();
  };

  registerCommands(
    pi,
    {
      get currentConfig() { return currentConfig; },
      get enabled() { return enabled; },
      set enabled(v) { enabled = v; },
      get debugEnabled() { return debugEnabled; },
      set debugEnabled(v) { debugEnabled = v; },
      get lastSync() { return lastSync; },
      get currentModelRef() { return currentModelRef; },
    },
    actions,
  );

  pi.on('session_start', async (_event, ctx) => {
    activeCtx = ctx;
    await restoreStateFromSession(ctx);

    // Detect already-selected ollama model on startup (so footer shows immediately)
    if (!currentModelRef && ctx.model && ctx.model.provider === 'ollama') {
      currentModelRef = `ollama/${ctx.model.id}`;
    }

    // Scope sync runs after Pi has settled, avoiding startup overwrite
    if (currentConfig.addToScope) {
      const result = await performSync(pi, {
        syncOnStartup: false,
        addToScope: true,
        providers: currentConfig.providers ?? {},
      });
      if (result.capabilities) {
        lastSync = result.capabilities;
        syncedAt = Date.now();
        cachedOllamaCapabilities = extractCapabilitiesFromTags(result);
        actions.persistState();
      }
      ollamaReachable = result.success || ollamaReachable;
      if (result.success && result.added.length > 0) {
        ctx.ui.notify(`[Providers] Scope updated with ${result.added.length} model(s).`, 'info');
      }
    }

    // Run an immediate check so any models that loaded during session start get updated right away.
    // We do this once at startup rather than with a periodic interval to avoid unnecessary traffic.
    actions.updateActiveContextLimits();

    refreshStatus();
    if (debugEnabled) ctx.ui.notify('Providers initialized.', 'info');
  });

  pi.on('session_shutdown', () => {
    if (activeCtx) {
      try { updateStatus(activeCtx, { current: null, totalRegistered: 0, thinkingLevel: null }, false); } catch {}
    }
    activeCtx = null;
  });

  pi.on('model_select', async (event, ctx) => {
    currentModelRef = `${event.model.provider}/${event.model.id}`;
    activeCtx = ctx;

    // Check for updated context limits whenever a new ollama model is selected.
    // This allows pi to use the correct compaction threshold even if the server
    // enforces a lower limit via CONTEXT_LENGTH or memory management.
    // We only do this for ollama and only during an active session.
    if (enabled && event.model.provider === 'ollama' && event.model.id) {
      await actions.updateActiveContextLimits();
    }

    refreshStatus();
  });

  // After the agent makes its first request, re-check context limits for any
  // ollama model that wasn't loaded during session_start (and thus didn't appear
  // in api/ps the first time we checked).
  pi.on('before_provider_request', async (event) => {
    if (!enabled || !currentModelRef) return;
    const parts = currentModelRef.split('/');
    if (parts.length < 2 || parts[0] !== 'ollama') return;
    const modelName = parts[1];

    // Only trigger the recheck once, for models we haven't verified yet
    if (!hasSeenModelContextLimit(modelName)) {
      await actions.updateActiveContextLimits();
    }
  });

  pi.on('thinking_level_select', async (event, ctx) => {
    thinkingLevel = String(event.level);
    activeCtx = ctx;
    refreshStatus();
  });
};

/** Extract per-model capabilities from sync result for later use in rebuilds. */
function extractCapabilitiesFromTags(result: any): Record<string, ModelCapabilities> | null {
  if (!result?.capabilities?.ollama || !result.capabilities.ollama.modelIds) {
    return null;
  }

  const ollama = result.capabilities.ollama;
  const modelIds = ollama.modelIds;
  const contextWindows = ollama.contextWindows ?? {};
  const families = ollama.families ?? {};
  const parameterSizes = ollama.parameterSizes ?? {};
  const quantizations = ollama.quantizations ?? {};
  const formats = ollama.formats ?? {};

  return Object.fromEntries(
    modelIds.map((id: string) => [id, {
      vision: ollama.vision.includes(id),
      reasoning: ollama.reasoning.includes(id),
      tools: true, // All registered ollama models have tools = true by convention
      embedding: ollama.embedding.includes(id),
      imageGeneration: false,
      contextWindow: contextWindows[id] ?? 128000,
      parameterSize: parameterSizes[id],
      family: families[id],
      quantization: quantizations[id],
      size: 0,
      digest: '',
      modifiedAt: '',
      remote: false, // would need additional logic from tags
      qat: id.toLowerCase().endsWith('-qat'),
      format: formats[id],
    } as ModelCapabilities]),
  );
}

export default modelDiscoveryExtension;
