"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearStatus = exports.updateStatus = void 0;
const widget_1 = require("./widget");
const updateStatus = (ctx, data, enabled, showCapLabelText = false, showLocationLabels = false) => {
    if (!enabled) {
        ctx.ui.setStatus('z-providers', undefined);
        ctx.ui.setWidget('providers', undefined);
        return;
    }
    const text = (0, widget_1.buildStatus)(ctx.ui.theme, data, showCapLabelText, showLocationLabels);
    // Use setStatus with a key that sorts last alphabetically to appear on the right
    // of the footer. Use a truncated version to avoid the terminal-width crash.
    const maxLen = 200; // safe upper bound; pi truncates further if needed
    const truncated = text.length > maxLen ? text.slice(0, maxLen - 1) + '\u2026' : text;
    ctx.ui.setStatus('z-providers', truncated);
    // Clear the widget since we're using setStatus now
    ctx.ui.setWidget('providers', undefined);
};
exports.updateStatus = updateStatus;
const clearStatus = (ctx) => {
    ctx.ui.setStatus('z-providers', undefined);
    ctx.ui.setWidget('providers', undefined);
};
exports.clearStatus = clearStatus;
