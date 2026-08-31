"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCard = exports.snapshotFromState = exports.clearStatus = exports.updateStatus = exports.buildModelCard = exports.buildStatus = void 0;
const pi_tui_1 = require("@earendil-works/pi-tui");
const formatContext = (n) => {
    if (n >= 1_000_000)
        return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
    if (n >= 1_000)
        return `${Math.round(n / 1_000)}K`;
    return String(n);
};
const formatSize = (bytes) => {
    if (bytes <= 0)
        return '';
    if (bytes >= 1_000_000_000)
        return `${(bytes / 1_000_000_000).toFixed(1)}G`;
    if (bytes >= 1_000_000)
        return `${Math.round(bytes / 1_000_000)}M`;
    if (bytes >= 1_000)
        return `${Math.round(bytes / 1_000)}K`;
    return String(bytes);
};
const relativeTime = (iso) => {
    if (!iso)
        return '';
    const then = new Date(iso).getTime();
    if (isNaN(then))
        return '';
    const seconds = Math.floor((Date.now() - then) / 1000);
    if (seconds < 60)
        return `${seconds}s`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400)
        return `${Math.floor(seconds / 3600)}h`;
    if (seconds < 2592000)
        return `${Math.floor(seconds / 86400)}d`;
    return `${Math.floor(seconds / 2592000)}mo`;
};
/** Single-line footer status. Only shows what pi doesn't already display. */
const buildStatus = (theme, data, showCapLabelText = false, showLocationLabels = false) => {
    const { current } = data;
    if (!current)
        return '';
    // Location: cloud OR local disk size (mutually exclusive markers)
    // Optionally with text labels: "☁ cloud" / "▽ local" or just the icon
    const locLabel = (icon, label, color = 'muted') => {
        const styledIcon = theme.fg(color, icon);
        if (!showLocationLabels)
            return styledIcon;
        return `${styledIcon}${theme.fg(color, ' ' + label)}`;
    };
    const locationParts = [];
    if (current.remote) {
        locationParts.push(locLabel('☁', 'cloud', 'accent'));
    }
    else if (current.size) {
        // Local model — icon + "local" label, then disk size
        locationParts.push(locLabel('▽', 'local', 'dim'));
        locationParts.push(theme.fg('dim', `◧:${formatSize(current.size)}`));
    }
    // Type: model variants like QAT or embedding
    // Optionally with text labels
    const typeLabel = (icon, label, on, color) => {
        const styledIcon = theme.fg(color, icon);
        if (!showLocationLabels)
            return styledIcon;
        return `${styledIcon}${theme.fg(on ? color : 'dim', ' ' + label)}`;
    };
    const typeParts = [];
    if (current.qat)
        typeParts.push(typeLabel('✦', 'QAT', true, 'success'));
    if (current.embedding)
        typeParts.push(typeLabel('◇', 'embed', true, 'muted'));
    // Capability icons: "Caps:" then icon-then-label for each
    // (label AFTER the icon, not before)
    const cap = (icon, on, label) => {
        const styledIcon = on ? theme.fg('success', icon) : theme.fg('dim', icon);
        if (!showCapLabelText)
            return styledIcon;
        const styledLabel = on ? theme.fg('success', label) : theme.fg('dim', label);
        return `${styledIcon}${styledLabel}`;
    };
    const capIcons = [
        cap('◉', current.vision, ' vision'),
        cap('◆', current.reasoning, ' thinking'),
        cap('⏵', current.tools, ' tools'),
    ].join(' ');
    // Stats: parameter size first, then context window
    const statParts = [];
    if (current.parameterSize) {
        statParts.push(theme.fg('muted', `◫:${current.parameterSize}`));
    }
    if (current.contextWindow > 0) {
        statParts.push(theme.fg('muted', `▣:${formatContext(current.contextWindow)}`));
    }
    // Assemble:
    //   Model: [location]  [type]  [caps]  [stats]
    // - "Model:" prefix shown only when labels are hidden (otherwise self-evident)
    // - single-space between location and type (they're related attributes)
    // - double-space between caps and stats
    // - double-space between stats items
    // - no extra padding after location (icons are visually distinct enough)
    // "Caps:" label is only shown when cap labels are hidden (icons alone are ambiguous)
    const capSection = showCapLabelText ? capIcons : `${theme.fg('muted', 'Caps:')} ${capIcons}`;
    const locationSection = locationParts.join(' ');
    const typeSection = typeParts.join(' ');
    const sections = [];
    if (!showLocationLabels && !showCapLabelText) {
        sections.push(theme.fg('dim', 'Model:'));
    }
    if (locationSection)
        sections.push(locationSection);
    if (typeSection)
        sections.push(typeSection);
    if (capSection)
        sections.push(capSection);
    sections.push(...statParts);
    return sections.filter(s => s.length > 0).join('  ');
};
exports.buildStatus = buildStatus;
/** Multi-line model card content for the popup. */
const buildModelCard = (theme, snapshot, ollama) => {
    if (!ollama)
        return '';
    const lines = [];
    const o = ollama;
    const name = snapshot.name;
    const tags = [];
    if (snapshot.remote)
        tags.push('☁ cloud');
    if (snapshot.qat)
        tags.push('✦ QAT');
    if (snapshot.embedding)
        tags.push('◇ embed');
    lines.push(`${theme.fg('accent', name)}${tags.length ? ' ' + theme.fg('muted', tags.join(' ')) : ''}`);
    const meta = [];
    if (snapshot.family)
        meta.push(snapshot.family);
    if (snapshot.parameterSize)
        meta.push(snapshot.parameterSize);
    if (snapshot.quantization)
        meta.push(snapshot.quantization);
    if (snapshot.format && snapshot.format !== 'gguf')
        meta.push(snapshot.format);
    if (meta.length) {
        lines.push(theme.fg('muted', meta.join(' · ')));
    }
    lines.push('');
    lines.push(`${theme.fg('muted', 'context')}     ${snapshot.contextWindow > 0 ? formatContext(snapshot.contextWindow) : '?'}${snapshot.contextWindow ? ' tokens' : ''}`);
    if (snapshot.size) {
        lines.push(`${theme.fg('muted', 'size')}        ${formatSize(snapshot.size)}${snapshot.remote ? ' (remote)' : ' on disk'}`);
    }
    if (snapshot.digest) {
        lines.push(`${theme.fg('muted', 'digest')}      ${snapshot.digest.slice(0, 12)}`);
    }
    if (snapshot.modifiedAt && !snapshot.remote) {
        lines.push(`${theme.fg('muted', 'modified')}    ${relativeTime(snapshot.modifiedAt)} ago`);
    }
    lines.push('');
    const cap = (label, on) => on
        ? theme.fg('success', `● ${label}`)
        : theme.fg('dim', `○ ${label}`);
    lines.push(`${cap('vision', snapshot.vision)}   ${cap('thinking', snapshot.reasoning)}   ${cap('tools', snapshot.tools)}   ${snapshot.embedding ? theme.fg('success', '● embedding') : ''}`);
    return lines.join('\n');
};
exports.buildModelCard = buildModelCard;
const updateStatus = (ctx, data, enabled, showCapLabelText = false) => {
    if (!enabled) {
        ctx.ui.setWidget('providers', undefined);
        return;
    }
    // Build the status line once, but truncate on render to avoid crashing on narrow terminals
    const text = (0, exports.buildStatus)(ctx.ui.theme, data, showCapLabelText);
    ctx.ui.setWidget('providers', (_tui, _theme) => ({
        render: (width) => text ? [(0, pi_tui_1.truncateToWidth)(text, width)] : [],
        invalidate: () => { },
    }), { placement: 'belowEditor' });
};
exports.updateStatus = updateStatus;
const clearStatus = (ctx) => {
    ctx.ui.setWidget('providers', undefined);
};
exports.clearStatus = clearStatus;
const snapshotFromState = (ref, state) => {
    const slash = ref.indexOf('/');
    if (slash < 0)
        return null;
    const provider = ref.slice(0, slash);
    const id = ref.slice(slash + 1);
    if (provider !== 'ollama')
        return null;
    const ollama = state.lastSync?.ollama;
    if (!ollama)
        return null;
    if (!ollama.modelIds.includes(id))
        return null;
    return {
        ref,
        id,
        name: id,
        contextWindow: ollama.contextWindows[id] ?? 0,
        vision: ollama.vision.includes(id),
        reasoning: ollama.reasoning.includes(id),
        tools: ollama.tools.includes(id),
        embedding: ollama.embedding?.includes(id) ?? false,
        remote: ollama.remote?.includes(id) ?? false,
        qat: ollama.qat?.includes(id) ?? false,
        family: ollama.families[id],
        parameterSize: ollama.parameterSizes[id],
        quantization: ollama.quantizations[id],
        format: ollama.formats?.[id],
        size: ollama.sizes?.[id],
        digest: ollama.digests?.[id],
        modifiedAt: ollama.modifiedAt?.[id],
    };
};
exports.snapshotFromState = snapshotFromState;
/** Build the full model card text (used by /providers card and shortcut). */
const buildCard = (theme, snapshot, state) => {
    if (!snapshot)
        return theme.fg('muted', 'No model selected.');
    return (0, exports.buildModelCard)(theme, snapshot, state.lastSync?.ollama);
};
exports.buildCard = buildCard;
