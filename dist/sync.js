"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.performSync = exports.capabilitiesFromTag = exports.inferCapabilitiesFromName = exports.fetchActiveContextLimits = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const pi_coding_agent_1 = require("@earendil-works/pi-coding-agent");
const cache_1 = require("./cache");
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Get per-model context limits from currently loaded models on the server. */
const fetchActiveContextLimits = async (baseUrl) => {
    try {
        const res = await fetch(`${baseUrl}/api/ps`);
        if (!res.ok)
            return {};
        const data = await res.json();
        // Ollama returns `models` array at the root of api/ps response.
        const liveModels = Array.isArray(data.models) ? data.models : [];
        const activeLimits = {};
        for (const m of liveModels) {
            if (typeof m.context_length === 'number') {
                activeLimits[m.name] = m.context_length;
            }
        }
        return activeLimits;
    }
    catch {
        return {};
    }
};
exports.fetchActiveContextLimits = fetchActiveContextLimits;
const detectQat = (name) => name.toLowerCase().endsWith('-qat');
const inferCapabilitiesFromName = (modelName) => {
    const lower = modelName.toLowerCase();
    return {
        vision: ['vl', 'vision', 'ocr'].some(kw => lower.includes(kw)),
        reasoning: ['thinking', 'reason', 'cascade', 'deepseek-r1', '-r1', 'qwq'].some(kw => lower.includes(kw)),
        tools: true,
        embedding: lower.includes('embed'),
        imageGeneration: false,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        size: 0,
        digest: '',
        modifiedAt: '',
        remote: lower.includes(':cloud'),
        qat: detectQat(modelName),
    };
};
exports.inferCapabilitiesFromName = inferCapabilitiesFromName;
/** Build a capability snapshot directly from /api/tags (no /api/show call). */
const capabilitiesFromTag = (tag) => {
    const caps = tag.capabilities ?? [];
    const d = tag.details;
    return {
        vision: caps.includes('vision'),
        reasoning: caps.includes('thinking') || caps.includes('reasoning'),
        tools: caps.includes('tools'),
        embedding: caps.includes('embedding'),
        imageGeneration: caps.includes('image-generation') || caps.includes('image'),
        contextWindow: (d?.context_length && d.context_length > 0) ? d.context_length : DEFAULT_CONTEXT_WINDOW,
        parameterSize: d?.parameter_size,
        family: d?.family,
        quantization: d?.quantization_level,
        format: d?.format,
        size: tag.size ?? 0,
        digest: tag.digest ?? '',
        modifiedAt: tag.modified_at ?? '',
        remote: !!tag.remote_model,
        remoteHost: tag.remote_host,
        qat: detectQat(tag.name),
    };
};
exports.capabilitiesFromTag = capabilitiesFromTag;
const performSync = async (pi, config) => {
    const results = [];
    if (config.providers.ollama?.enabled !== false) {
        results.push(await syncOllama(pi, config));
    }
    const totalAdded = results.flatMap(r => r.added);
    const scopeMsg = config.addToScope ? ' Scope updated.' : '';
    // Aggregate capabilities from all successful provider results
    const capabilities = {};
    for (const r of results) {
        if (r.success && r.capabilities) {
            Object.assign(capabilities, r.capabilities);
        }
    }
    if (!results.every(r => r.success)) {
        const failures = results.filter(r => !r.success);
        return { added: [], message: failures.map(f => f.message).join('; '), success: false };
    }
    if (totalAdded.length > 0) {
        return { added: totalAdded, message: `Registered ${totalAdded.length} model(s).${scopeMsg}`, success: true, capabilities };
    }
    return { added: [], message: `Already up to date.${scopeMsg}`, success: true, capabilities };
};
exports.performSync = performSync;
const syncOllama = async (pi, config) => {
    const ollamaCfg = config.providers.ollama;
    const baseUrl = (ollamaCfg?.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    const ttlHours = (0, cache_1.resolveTtl)(ollamaCfg?.cacheTtlHours);
    let tags;
    try {
        const res = await fetch(`${baseUrl}/api/tags`);
        if (!res.ok)
            return { added: [], message: `Ollama API returned ${res.status}`, success: false };
        tags = await res.json();
    }
    catch {
        return { added: [], message: `Ollama not reachable at ${baseUrl}`, success: false };
    }
    if (!tags.models?.length) {
        return {
            added: [],
            message: 'No Ollama models found',
            success: true,
            capabilities: {
                ollama: {
                    modelIds: [], vision: [], reasoning: [], tools: [], embedding: [], remote: [], qat: [],
                    contextWindows: {}, families: {}, parameterSizes: {}, quantizations: {}, formats: {},
                    sizes: {}, digests: {}, modifiedAt: {},
                },
            },
        };
    }
    // Ollama 0.30+ returns all the data we need in /api/tags. We still use the
    // cache layer for resilience when the server is briefly unreachable.
    const cache = (0, cache_1.readCache)();
    const liveModelIds = new Set(tags.models.map(m => m.name));
    const needsFetch = [];
    for (const m of tags.models) {
        if (config.forceRefresh || !(0, cache_1.isCacheValid)(cache[m.name], ttlHours)) {
            needsFetch.push(m.name);
        }
    }
    if (needsFetch.length > 0) {
        for (const name of needsFetch) {
            const tag = tags.models.find(m => m.name === name);
            if (tag)
                (0, cache_1.updateCacheEntry)(cache, name, (0, exports.capabilitiesFromTag)(tag));
        }
    }
    (0, cache_1.dropStaleCacheEntries)(cache, liveModelIds);
    if (needsFetch.length > 0 || Object.keys(cache).length !== liveModelIds.size) {
        (0, cache_1.writeCache)(cache);
    }
    // Fetch currently active limits from the running models on the Ollama server.
    const activeLimits = await (0, exports.fetchActiveContextLimits)(baseUrl);
    // Build capability lists + per-model maps from the cache (always current).
    const modelIds = [];
    const vision = [];
    const reasoning = [];
    const tools = [];
    const embedding = [];
    const remote = [];
    const qat = [];
    const contextWindows = {};
    const families = {};
    const parameterSizes = {};
    const quantizations = {};
    const formats = {};
    const sizes = {};
    const digests = {};
    const modifiedAt = {};
    const models = tags.models.map((m) => {
        const caps = cache[m.name];
        modelIds.push(m.name);
        if (caps.vision)
            vision.push(m.name);
        if (caps.reasoning)
            reasoning.push(m.name);
        if (caps.tools)
            tools.push(m.name);
        if (caps.embedding)
            embedding.push(m.name);
        if (caps.remote)
            remote.push(m.name);
        if (caps.qat)
            qat.push(m.name);
        // Prefer server-enforced limit over manifest default.
        const effectiveWindow = activeLimits[m.name] ?? caps.contextWindow;
        contextWindows[m.name] = effectiveWindow;
        if (caps.family)
            families[m.name] = caps.family;
        if (caps.parameterSize)
            parameterSizes[m.name] = caps.parameterSize;
        if (caps.quantization)
            quantizations[m.name] = caps.quantization;
        if (caps.format)
            formats[m.name] = caps.format;
        if (caps.size)
            sizes[m.name] = caps.size;
        if (caps.digest)
            digests[m.name] = caps.digest;
        if (caps.modifiedAt)
            modifiedAt[m.name] = caps.modifiedAt;
        const displayName = caps.parameterSize
            ? `${m.name} (${caps.parameterSize})`
            : m.name;
        return {
            id: m.name,
            name: displayName,
            reasoning: caps.reasoning,
            thinkingLevelMap: caps.reasoning
                ? { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high' }
                : { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null },
            input: (caps.vision ? ['text', 'image'] : ['text']),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: effectiveWindow,
            maxTokens: 4096,
        };
    });
    pi.registerProvider('ollama', {
        baseUrl: baseUrl + '/v1',
        apiKey: 'ollama',
        api: 'openai-completions',
        models,
    });
    if (config.addToScope) {
        updateOllamaScope(modelIds, ollamaCfg?.cleanupStale === true);
    }
    return {
        added: modelIds,
        message: `${modelIds.length} Ollama model(s) registered.`,
        success: true,
        capabilities: {
            ollama: {
                modelIds, vision, reasoning, tools, embedding, remote, qat,
                contextWindows, families, parameterSizes, quantizations, formats,
                sizes, digests, modifiedAt,
            },
        },
    };
};
const updateOllamaScope = (modelIds, cleanupStale) => {
    const settingsPath = (0, node_path_1.join)((0, pi_coding_agent_1.getAgentDir)(), 'settings.json');
    let settings = {};
    try {
        if ((0, node_fs_1.existsSync)(settingsPath)) {
            settings = JSON.parse((0, node_fs_1.readFileSync)(settingsPath, 'utf-8'));
        }
    }
    catch { /* ignore */ }
    const existing = Array.isArray(settings.enabledModels) ? settings.enabledModels : [];
    const refs = modelIds.map(id => `ollama/${id}`);
    let merged;
    if (cleanupStale) {
        merged = [...new Set([...existing.filter(m => !m.startsWith('ollama/')), ...refs])];
    }
    else {
        merged = [...new Set([...existing, ...refs])];
    }
    if (merged.length !== existing.length || !merged.every((m, i) => m === existing[i])) {
        settings.enabledModels = merged;
        (0, node_fs_1.writeFileSync)(settingsPath, JSON.stringify(settings, null, 2));
    }
};
