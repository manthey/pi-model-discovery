"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dropStaleCacheEntries = exports.updateCacheEntry = exports.resolveTtl = exports.isCacheValid = exports.writeCache = exports.readCache = exports.getCachePath = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const pi_coding_agent_1 = require("@earendil-works/pi-coding-agent");
const CACHE_FILENAME = 'ollama-model-cache.json';
const DEFAULT_TTL_HOURS = 24;
/** Bump when ModelCapabilities shape changes so old caches get re-fetched. */
const CACHE_VERSION = 2;
const getCachePath = () => (0, node_path_1.join)((0, pi_coding_agent_1.getAgentDir)(), CACHE_FILENAME);
exports.getCachePath = getCachePath;
const readVersioned = () => {
    const path = (0, exports.getCachePath)();
    if (!(0, node_fs_1.existsSync)(path))
        return null;
    try {
        const raw = JSON.parse((0, node_fs_1.readFileSync)(path, 'utf-8'));
        // Handle both new versioned format and legacy flat format
        if (typeof raw === 'object' && raw !== null && 'version' in raw) {
            return raw;
        }
        return { version: 1, entries: raw };
    }
    catch {
        return null;
    }
};
const readCache = () => {
    const v = readVersioned();
    if (!v)
        return {};
    if (v.version !== CACHE_VERSION)
        return {}; // version mismatch → rebuild
    return v.entries;
};
exports.readCache = readCache;
const writeCache = (cache) => {
    const wrapped = { version: CACHE_VERSION, entries: cache };
    try {
        (0, node_fs_1.writeFileSync)((0, exports.getCachePath)(), JSON.stringify(wrapped, null, 2));
    }
    catch { /* best-effort */ }
};
exports.writeCache = writeCache;
const isCacheValid = (entry, ttlHours) => {
    if (!entry)
        return false;
    if (ttlHours <= 0)
        return false;
    const ageMs = Date.now() - entry.cachedAt;
    return ageMs < ttlHours * 60 * 60 * 1000;
};
exports.isCacheValid = isCacheValid;
const resolveTtl = (configured) => typeof configured === 'number' ? configured : DEFAULT_TTL_HOURS;
exports.resolveTtl = resolveTtl;
const updateCacheEntry = (cache, modelName, caps) => {
    cache[modelName] = { ...caps, cachedAt: Date.now() };
};
exports.updateCacheEntry = updateCacheEntry;
const dropStaleCacheEntries = (cache, liveModelIds) => {
    for (const key of Object.keys(cache)) {
        if (!liveModelIds.has(key))
            delete cache[key];
    }
};
exports.dropStaleCacheEntries = dropStaleCacheEntries;
