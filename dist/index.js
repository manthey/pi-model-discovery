"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const state_1 = require("./state");
const ui_1 = require("./ui");
const commands_1 = require("./commands");
const sync_1 = require("./sync");
const widget_1 = require("./widget");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const pi_coding_agent_1 = require("@earendil-works/pi-coding-agent");
const modelDiscoveryExtension = async (pi) => {
    let currentConfig = config_1.FALLBACK_CONFIG;
    let currentCwd = process.cwd();
    let debugEnabled = false;
    let enabled = false;
    let lastSync = undefined;
    let lastPersistedSnapshot;
    let currentModelRef = null;
    let thinkingLevel = null;
    let ollamaReachable = false;
    let syncedAt = undefined;
    let activeCtx = null;
    // Cached capabilities from last sync — used to rebuild provider configs when active
    // context limits change without re-fetching /api/tags.
    let cachedOllamaCapabilities = null;
    // Track which models have been observed at their server-enforced limits via api/ps.
    let seenContextLimits = null;
    const persist = (state) => {
        const snapshot = JSON.stringify({ ...state, timestamp: 0 });
        if (snapshot === lastPersistedSnapshot)
            return;
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
        const configPath = (0, node_path_1.join)((0, pi_coding_agent_1.getAgentDir)(), 'local-providers.json');
        if (!(0, node_fs_1.existsSync)(configPath))
            return; // No file yet — wait for /providers init
        try {
            // Merge with what's on disk so user-added fields aren't lost
            const existing = JSON.parse((0, node_fs_1.readFileSync)(configPath, 'utf-8')) || {};
            const merged = { ...existing, ...currentConfig };
            (0, node_fs_1.writeFileSync)(configPath, JSON.stringify(merged, null, 2), 'utf-8');
        }
        catch { /* best-effort */ }
    };
    const getCurrentSnapshot = () => {
        if (!currentModelRef)
            return null;
        return (0, widget_1.snapshotFromState)(currentModelRef, {
            enabled, debugEnabled, lastSync, timestamp: 0,
        });
    };
    const refreshStatus = () => {
        if (!activeCtx)
            return;
        (0, ui_1.updateStatus)(activeCtx, {
            current: getCurrentSnapshot(),
            totalRegistered: lastSync?.ollama?.modelIds.length ?? 0,
            thinkingLevel,
        }, currentConfig.showFooterStatus !== false, currentConfig.showCapLabelText === true, currentConfig.showLocationLabels === true);
    };
    const actions = {
        persistState: () => persist((0, state_1.buildPersistedState)(enabled, debugEnabled, lastSync)),
        updateActiveContextLimits: async () => {
            const ollamaCfg = currentConfig.providers?.ollama;
            if (!enabled || !ollamaReachable || !lastSync?.ollama) {
                return false;
            }
            const baseUrl = (ollamaCfg?.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
            const activeLimits = await (0, sync_1.fetchActiveContextLimits)(baseUrl);
            if (!lastSync.ollama.contextWindows) {
                return false;
            }
            let needsUpdate = false;
            const windowsCopy = { ...lastSync.ollama.contextWindows };
            for (const [name, limit] of Object.entries(activeLimits)) {
                if (typeof limit === 'number' && limit < (windowsCopy[name] ?? Infinity)) {
                    windowsCopy[name] = limit;
                    needsUpdate = true;
                }
            }
            if (!needsUpdate) {
                return false;
            }
            // Track that we've observed these models at their current limits.
            if (!seenContextLimits)
                seenContextLimits = new Set();
            for (const name of Object.keys(activeLimits)) {
                seenContextLimits.add(name);
            }
            return actions.rebuildAndResyncOllama(windowsCopy);
        },
        rebuildAndResyncOllama: async (newContextWindows) => {
            if (!lastSync?.ollama || !cachedOllamaCapabilities) {
                return false;
            }
            const ollamaCfg = currentConfig.providers?.ollama;
            const baseUrl = (ollamaCfg?.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
            if (!cachedOllamaCapabilities)
                return false;
            const models = lastSync.ollama.modelIds.map((modelName) => {
                const caps = cachedOllamaCapabilities[modelName];
                if (!caps)
                    return null;
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
                    input: (caps.vision ? ['text', 'image'] : ['text']),
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: effectiveWindow,
                    maxTokens: 4096,
                };
            }).filter((m) => m !== null);
            if (!models.length) {
                return false;
            }
            pi.registerProvider('ollama', { baseUrl: baseUrl + '/v1', apiKey: 'ollama', api: 'openai-completions', models });
            lastSync = { ...lastSync, ollama: { ...lastSync.ollama, contextWindows: newContextWindows } };
            syncedAt = Date.now();
            persist((0, state_1.buildPersistedState)(enabled, debugEnabled, lastSync));
            if (debugEnabled) {
                const changedModels = Object.entries(newContextWindows)
                    .filter(([m, limit]) => {
                    const caps = cachedOllamaCapabilities?.[m];
                    return typeof limit === 'number' && !!caps && caps.contextWindow > limit;
                })
                    .map(([m, l]) => `${m}: ${l}`);
                if (changedModels.length) {
                    console.log('[Providers] Updated context windows:', changedModels.join(', '));
                }
            }
            return true;
        },
        persistLastSync: (next) => {
            lastSync = next;
            syncedAt = Date.now();
            persist((0, state_1.buildPersistedState)(enabled, debugEnabled, lastSync));
            refreshStatus();
        },
        setShowFooterStatus: (on) => {
            currentConfig = { ...currentConfig, showFooterStatus: on };
            persistConfigToDisk();
        },
        setShowCapLabelText: (on) => {
            currentConfig = { ...currentConfig, showCapLabelText: on };
            persistConfigToDisk();
        },
        setShowLocationLabels: (on) => {
            currentConfig = { ...currentConfig, showLocationLabels: on };
            persistConfigToDisk();
        },
        updateStatus: (_ctx) => refreshStatus(),
        refreshStatus,
        reloadConfig: (ctx, options) => {
            const loaded = (0, config_1.loadModelDiscoveryConfig)(currentCwd);
            // Merge with the previous in-memory config so toggles (labels on/off, etc.)
            // are not reset when the user runs /providers reload.
            const previous = currentConfig;
            currentConfig = { ...previous, ...loaded.config };
            if (!options?.preserveDebug)
                debugEnabled = currentConfig.debug ?? false;
            if (ctx)
                refreshStatus();
        },
    };
    // ── Startup sync (async factory - runs before session_start) ─────
    actions.reloadConfig();
    if (currentConfig.syncOnStartup) {
        const result = await (0, sync_1.performSync)(pi, {
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
        }
        else if (!result.success) {
            console.log(`[Providers] ${result.message}`);
        }
    }
    const restoreStateFromSession = async (ctx) => {
        currentCwd = ctx.cwd;
        activeCtx = ctx;
        actions.reloadConfig(ctx);
        enabled = true;
        const entries = ctx.sessionManager.getBranch();
        const savedState = entries
            .filter((e) => e.type === 'custom' && e.customType === 'discovery-state')
            .map((e) => e.data)
            .findLast((data) => (0, state_1.isModelDiscoveryState)(data));
        if ((0, state_1.isModelDiscoveryState)(savedState)) {
            enabled = savedState.enabled;
            debugEnabled = savedState.debugEnabled ?? debugEnabled;
            if (savedState.lastSync)
                lastSync = savedState.lastSync;
        }
        actions.persistState();
        refreshStatus();
    };
    (0, commands_1.registerCommands)(pi, {
        get currentConfig() { return currentConfig; },
        get enabled() { return enabled; },
        set enabled(v) { enabled = v; },
        get debugEnabled() { return debugEnabled; },
        set debugEnabled(v) { debugEnabled = v; },
        get lastSync() { return lastSync; },
        get currentModelRef() { return currentModelRef; },
    }, actions);
    pi.on('session_start', async (_event, ctx) => {
        activeCtx = ctx;
        await restoreStateFromSession(ctx);
        // Detect already-selected ollama model on startup (so footer shows immediately)
        if (!currentModelRef && ctx.model && ctx.model.provider === 'ollama') {
            currentModelRef = `ollama/${ctx.model.id}`;
        }
        // Scope sync runs after Pi has settled, avoiding startup overwrite
        if (currentConfig.addToScope) {
            const result = await (0, sync_1.performSync)(pi, {
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
        // Check active limits — loads from session_start are now visible.
        actions.updateActiveContextLimits();
        refreshStatus();
        if (debugEnabled)
            ctx.ui.notify('Providers initialized.', 'info');
    });
    pi.on('session_shutdown', () => {
        if (activeCtx) {
            try {
                (0, ui_1.updateStatus)(activeCtx, { current: null, totalRegistered: 0, thinkingLevel: null }, false);
            }
            catch { }
        }
        activeCtx = null;
    });
    pi.on('model_select', async (event, ctx) => {
        currentModelRef = `${event.model.provider}/${event.model.id}`;
        activeCtx = ctx;
        if (enabled && event.model.provider === 'ollama' && event.model.id) {
            await actions.updateActiveContextLimits();
        }
        refreshStatus();
    });
    // Re-check any model that missed the initial api/ps (e.g., loaded after session_start).
    pi.on('before_provider_request', async (event) => {
        if (!enabled || !currentModelRef)
            return;
        const parts = currentModelRef.split('/');
        const modelName = parts.length > 1 ? parts[1] : '';
        if (!parts[0] || parts[0] !== 'ollama' || !modelName)
            return;
        if (!seenContextLimits?.has(modelName)) {
            await actions.updateActiveContextLimits();
        }
    });
    pi.on('thinking_level_select', async (event, ctx) => {
        thinkingLevel = String(event.level);
        activeCtx = ctx;
        refreshStatus();
    });
};
/** Build capability map from the last /api/tags sync result. */
function extractCapabilitiesFromTags(result) {
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
    return Object.fromEntries(modelIds.map((id) => [id, {
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
        }]));
}
exports.default = modelDiscoveryExtension;
