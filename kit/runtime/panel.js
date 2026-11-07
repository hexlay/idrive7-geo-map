'use strict';
/**
 * panel.js - how big the centre display physically is, so the kit and the apps can size what a finger
 * presses in millimetres rather than pixels (as CarPlay does: the head unit tells the phone its screen's
 * size, and the phone keeps its buttons the same size on any screen).
 *
 * iDrive 7 shows the same 1920 x 720 HMI on three centre displays (all 8:3):
 *   8.8"   209 mm wide   (Live Cockpit Plus)
 *   10.25" 244 mm wide   (Live Cockpit Professional, most cars)
 *   12.3"  292 mm wide   (Live Cockpit Professional, large display)
 * Apps lay out in the same pixels on all three, so a page that looks right on a 12.3" display is a fifth
 * smaller on a 10.25" one.
 *
 * Which one it is, in order:
 *   1. the app's setting "screen" ('8.8' | '10.25' | '12.3'; 'auto' or none: on)
 *   2. MGU_PANEL (the same values; the emulator and preview)
 *   3. the display's own data: the EDID of the centre display's connector (/sys/class/drm), which gives
 *      its width in millimetres
 *   4. 10.25", the common one (and the smaller of the two big ones: buttons sized for it are never too
 *      small on the others)
 *
 * size factor k: how much bigger than the apps' original drawing (laid out at 1.0) controls and text are
 * drawn here. 1.2 on a 12.3" display, and as much more as the display is smaller, so they come out the
 * same size in millimetres on every display.
 */
const fs = require('fs');
const path = require('path');

const PANELS = {
    '8.8': { inches: 8.8, widthMm: 209.3 },
    '10.25': { inches: 10.25, widthMm: 243.8 },
    '12.3': { inches: 12.3, widthMm: 292.5 },
};
const FALLBACK = '10.25';
const REF = PANELS['12.3'].widthMm;
const BASE_K = 1.2;

/** EDID (a Buffer) -> { wMm, hMm } or null: the first detailed timing's size, else the base block's (cm). */
function edidSize(b) {
    if (!b || b.length < 128) return null;
    const head = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
    if (head.some((v, i) => b[i] !== v)) return null;
    // detailed timing descriptor 1 at 54 (a pixel clock of 0 means it is another kind of descriptor)
    if (b[54] | b[55]) {
        const w = b[66] | ((b[68] & 0xf0) << 4), h = b[67] | ((b[68] & 0x0f) << 8);
        if (w > 0 && h > 0) return { wMm: w, hMm: h };
    }
    if (b[21] > 0 && b[22] > 0) return { wMm: b[21] * 10, hMm: b[22] * 10 };
    return null;
}

/** The panel nearest a width in mm (none when it is far from all of them: a made-up or missing size). */
function nearest(wMm) {
    let best = null, d = Infinity;
    Object.keys(PANELS).forEach((k) => { const e = Math.abs(PANELS[k].widthMm - wMm); if (e < d) { d = e; best = k; } });
    return d <= 30 ? best : null;
}

/** What /sys/class/drm says about the centre display: { key, wMm, connector, mode } or { why }. */
function probe(root) {
    const dir = root || '/sys/class/drm';
    let names;
    try { names = fs.readdirSync(dir).filter((n) => /^card\d+-/.test(n)); } catch (e) { return { why: dir + ': ' + e.code }; }
    if (!names.length) return { why: 'no display connectors in ' + dir };
    // the centre display: HDMI-A-1 on the MGU (weston's first output), then any connected one
    const rank = (n) => (/HDMI-A-1$/.test(n) ? 0 : 1);
    names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const seen = [];
    for (const n of names) {
        const read = (f) => { try { return fs.readFileSync(path.join(dir, n, f)); } catch (e) { return null; } };
        const status = String(read('status') || '').trim();
        if (status && status !== 'connected') { seen.push(n + ' ' + status); continue; }
        const mode = String(read('modes') || '').split('\n')[0].trim();
        const size = edidSize(read('edid'));
        if (!size) { seen.push(n + (mode ? ' ' + mode : '') + ' (no EDID size)'); continue; }
        const key = nearest(size.wMm);
        if (key) return { key, wMm: size.wMm, connector: n, mode };
        seen.push(n + ' ' + size.wMm + ' x ' + size.hMm + ' mm (not an iDrive 7 display size)');
    }
    return { why: seen.join(', ') };
}

const valid = (v) => (v != null && PANELS[String(v)] ? String(v) : null);

/**
 * The panel: { key, inches, widthMm, k, source }.
 * setting: the app's "screen" setting (or null); env: process.env; root: /sys/class/drm (tests).
 */
function resolve(setting, env, root) {
    const e = env || process.env;
    let key = valid(setting), source = key && 'setting';
    if (!key && (key = valid(e.MGU_PANEL))) source = 'MGU_PANEL';
    let found = null;
    if (!key) {
        found = probe(root);
        if (found.key) { key = found.key; source = 'EDID ' + found.connector + ' ' + found.wMm + ' mm' + (found.mode ? ' ' + found.mode : ''); }
    }
    if (!key) { key = FALLBACK; source = 'default (' + (found && found.why) + ')'; }
    const p = PANELS[key];
    return { key, inches: p.inches, widthMm: p.widthMm, k: Math.round(BASE_K * REF / p.widthMm * 100) / 100, source };
}

module.exports = { resolve, probe, edidSize, PANELS, FALLBACK };
