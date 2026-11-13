'use strict';
/**
 * hudturn.js - Navigation's next turn on the windshield head-up display, through cluster-render (crclient.js; the
 * MGU Store service, robertnisipeanu/idrive-apps). Display only: nothing is sent to the car, nothing BMW draws on
 * the HUD is taken away by this app (cluster-render never unmaps BMW's own HUD content, and gives way to its pop-ups).
 *
 * The picture (NW x NH): BMW's look on the glass. The maneuver arrow white, the road not taken dim, BMW's distance bar
 * beside it (emptying as the turn comes), the distance in the light face, the street under it. Black is see-through
 * on the HUD, so it is drawn on black and sent with alpha = brightness (straight alpha, as the protocol has it).
 *
 * Where (iDrive 7, an 800 x 480 scene of which about x 120..680, y 120..360 is seen): the bottom right corner of
 * the glass, clear of BMW's speed and limit sign at its bottom left - the place Redline (cauliflowermossgrape/idrive7-
 * apps) measured on a G21 and puts its directions. iDrive 8 (the hello names "hud:353x203", all of it seen): its
 * bottom right corner.
 *
 * When (setting hudArrows): "near" (default) only within NEAR_M of the next turn and at the arrival, "route" while
 * guidance runs, "off". Never:
 *   - while the car is in reverse (src.reversing());
 *   - while BMW's own navigation, CarPlay or Android Auto guides (Guidance.guidanceState ACTIVE,
 *     projectedGuidanceActive): their turns are on the HUD already;
 *   - while cruise control shows on the HUD (DisplayDataServer.functionalLibraryData), unless setting hudCruise is
 *     "keep": on an X3 G01 any app layer on the HUD put the cluster in its speech-dialog layout, which hides BMW's
 *     cruise-control readout and moves its speed (nhocleopro/hud-widgets, idrive-apps#142). So the layer is made only
 *     while it is due and dropped as soon as it is not: those moments are all it costs.
 * Pixels go only when the picture changed, at most FPS a second. Not connected while nothing is due for a minute.
 * Never throws: an app that exits twice is removed by MainApp.
 *
 *   const hud = new HudTurns(ctx, { turn() -> { m, dist, name, arrived, title } | null, reversing() -> bool });
 *   hud.tick()     (main.js calls it with every position; it runs its own slow timer too)
 *   hud.status()   one line for the menu;   hud.stop()
 */
const { Canvas } = require('./kit/canvas');
const { Recorder, play } = require('./kit/record');
const { ClusterRender } = require('./crclient');
const H = require('./hud');

const NW = 220, NH = 80;
const NEAR_M = 1000;
const NEAR_OFF_M = 1150;              // shown: it goes only past this (a distance hovering round 1 km does not flicker it)
// a reason to go that may come and go within moments (the cruise-control readout's data, a distance past 1 km after a
// new route): the picture goes only once it has held this long. In and out again would flip the cluster's HUD layout
// each time (BMW's speed jumps) and make cluster-render ask for the HUD's slot again and again
const SOFT_HOLD_MS = { far: 5000, cruise: 1500 };
// the cruise-control readout counts as on once it has said so for CRUISE_ON_MS, off once it has said off for CRUISE_OFF_MS
const CRUISE_ON_MS = 1000, CRUISE_OFF_MS = 3000;
const FPS = 4;
const IDLE_CLOSE_MS = 60000;
// iDrive 7: the corner Redline's directions use (NAV_RIGHT 672, NAV_BOTTOM 356 in its hud.js)
const ID7 = { w: 800, h: 480, right: 672, bottom: 356 };
const GUIDANCE = 'de.bmw.infotainment.navigation.guiding.Guidance';
const CARPLAY = 'de.bmw.infotainment.a4a.carplay.CarPlayManager';
const AA = 'de.bmw.infotainment.sdi.aap.androidautoprojectedmanager.AndroidAutoProjectedManager';
const DDS = 'de.bmw.infotainment.displaydataserver.DisplayDataServer';

const isNum = (x) => typeof x === 'number' && isFinite(x);
const enumName = (v) => (v && typeof v === 'object' ? (v.name !== undefined ? v.name : v.value) : v);

/** Where the picture goes in the HUD's scene (cluster-render's hello: "...,hud:WxH,..."). */
function placeOf(targets) {
    const m = /(?:^|,)\s*hud:(\d+)x(\d+)/.exec(String(targets || ''));
    const w = m ? Number(m[1]) : ID7.w, h = m ? Number(m[2]) : ID7.h;
    if (w === ID7.w && h === ID7.h) return { x: ID7.right - NW, y: ID7.bottom - NH, w: NW, h: NH };
    // another scene (iDrive 8: 353 x 203, all of it seen): its bottom right corner, as large as fits
    const k = Math.min(1, (w - 8) / NW, (h - 8) / NH);
    const pw = Math.round(NW * k), ph = Math.round(NH * k);
    return { x: Math.max(0, w - pw - 4), y: Math.max(0, h - ph - 4), w: pw, h: ph };
}

/** Cruise control shown on the HUD, from DisplayDataServer.functionalLibraryData (as hud-widgets reads it). */
function cruiseShown(v) {
    if (!v || typeof v !== 'object') return false;
    const acc = v.activeCruiseControl || {};
    const sym = enumName(acc.symbolACC), bars = enumName(acc.barsColorACC), sp = v.cruiseCtrlSpeedHUD, lim = enumName(v.statusLimiter);
    return !!(sym && sym !== 'LDM_CAR_OFF' && sym !== 0) || !!(bars && bars !== 'LDM_OFF' && bars !== 0) || !!(acc.accBarsHUD > 0)
        || (isNum(sp) && sp > 0 && sp < 65535) || !!(lim && lim !== 'STATUS_INACTIVE' && lim !== 0);
}

/**
 * The picture for a turn t ({ m, dist, name, arrived, title }) into r (a Recorder NW x NH, on black). imperial: ft / mi.
 */
function drawTurn(r, t, imperial, lang) {
    r.clear('#000000');
    const W = '#ffffff', DIM = '#585858', T = H.tr(lang);
    const as = 56, ax = 36, ay = NH / 2 + 2;
    if (t.arrived || t.m.type === 'arrive') {
        H.arrow(r, ax, ay, as, { type: 'arrive' }, W, '#000000');
        r.text(fitText(r, T.arrived, NW - 90, 17, 'bold'), 84, 36, 17, W, { literal: true, font: 'bold' });
        if (t.title) r.text(fitText(r, t.title, NW - 90, 15), 84, 62, 15, '#c8c8c8', { literal: true });
        return;
    }
    H.arrow(r, ax, ay, as, t.m, W, DIM);
    if (t.m.type === 'roundabout' && t.m.exit) {
        r.circle(12, 13, 10, W);
        r.text(String(t.m.exit), 12, 18, 14, '#000000', { literal: true, font: 'bold', align: 'center' });
    }
    // BMW's distance bar: full at 300 m and more, empty at the turn
    const f = Math.max(0, Math.min(1, t.dist / 300)), bx = 80, bh = NH - 16, fh = Math.max(4, bh * f);
    r.roundRect(bx, 8, 5, bh, 2.5, '#2a2a2a');
    r.roundRect(bx, 8 + bh - fh, 5, fh, 2.5, W);
    const d = H.fmtDist(t.dist, imperial), ds = 34;
    const dw = r.textWidth(d[0], ds, { literal: true, font: 'light' });
    r.text(d[0], 96, 40, ds, W, { literal: true, font: 'light' });
    r.text(d[1], 100 + dw, 40, 16, '#c8c8c8', { literal: true });
    const nm = t.name || H.phrase(t.m, lang);
    if (nm) r.text(fitText(r, nm, NW - 100, 15, 'bold'), 96, 66, 15, W, { literal: true, font: 'bold' });
}
function fitText(r, s, w, size, font) {
    s = String(s);
    const o = { literal: true, font: font || 'label' };
    if (r.textWidth(s, size, o) <= w) return s;
    while (s.length > 1 && r.textWidth(s + '..', size, o) > w) s = s.slice(0, -1);
    return s + '..';
}

/** Black is see-through on the glass: RGBA on black -> straight alpha, alpha = the brightest channel. */
function toHud(src, out) {
    for (let i = 0; i < src.length; i += 4) {
        const r = src[i], g = src[i + 1], b = src[i + 2], a = r > g ? (r > b ? r : b) : (g > b ? g : b);
        if (!a) { out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0; continue; }
        out[i] = Math.min(255, Math.round(r * 255 / a)); out[i + 1] = Math.min(255, Math.round(g * 255 / a)); out[i + 2] = Math.min(255, Math.round(b * 255 / a));
        out[i + 3] = a;
    }
    return out;
}

class HudTurns {
    constructor(ctx, src, opts) {
        this.ctx = ctx; this.src = src; this.log = ctx.log;
        this.opts = opts || {};
        this.cr = null; this.layer = 0; this.place = null;
        this.others = { bmw: false, carplay: false, aa: false };
        this.cruise = false; this.cruiseRaw = false; this.cruiseRawAt = 0;
        this.softAt = 0;
        this.subs = [];
        this.subscribed = false;
        this.lastKey = ''; this.lastSent = 0; this.lastDue = 0;
        this.why = '';
        this.layerState = ''; this.targetState = '';
        this.rec = new Recorder(NW, NH);
        this.cv = new Canvas(NW, NH);
        this.px = Buffer.alloc(NW * NH * 4);
        this.timer = setInterval(() => this.tick(), 1000);
        if (this.timer.unref) this.timer.unref();
    }

    mode() { const m = this.ctx.settings.get('hudArrows'); return m === 'off' || m === 'route' ? m : 'near'; }

    /** The car's own signals this needs, subscribed the first time a turn could be due (all optional). */
    _subscribe() {
        if (this.subscribed || !this.ctx.signals || !this.ctx.signals.watch) return;
        this.subscribed = true;
        const w = (iface, inst, h, what) => this.ctx.signals.watch(iface, inst, h, this.log).then((s) => {
            this.subs.push(s);
            this.log.info('hud: ' + what + (s.error ? ' error: ' + s.error : ' subscribed'));
        }).catch((e) => this.log.warn('hud: ' + what + ': ' + e));
        w(GUIDANCE, 'Main_Instance', { guidanceState: (v) => { const n = enumName(v); this.others.bmw = n === 'ACTIVE' || n === 2; } }, 'BMW guidance state');
        w(CARPLAY, 'CarPlayManagerInst1', { projectedGuidanceActive: (v) => { this.others.carplay = v === true || v === 1; } }, 'CarPlay guidance');
        w(AA, 'AndroidAutoProjectedManagerInst1', { projectedGuidanceActive: (v) => { this.others.aa = v === true || v === 1; } }, 'Android Auto guidance');
        w(DDS, '1', { functionalLibraryData: (v) => { const c = cruiseShown(v); if (c !== this.cruiseRaw) { this.cruiseRaw = c; this.cruiseRawAt = Date.now(); } } }, 'cruise control on the HUD');
    }

    /** The cruise-control readout's state, once it has held (CRUISE_ON_MS / CRUISE_OFF_MS). */
    _cruise(now) {
        if (this.cruiseRaw !== this.cruise && now - this.cruiseRawAt >= (this.cruiseRaw ? CRUISE_ON_MS : CRUISE_OFF_MS)) {
            this.cruise = this.cruiseRaw;
            this.log.info('hud: cruise control ' + (this.cruise ? 'shown on the HUD' : 'off the HUD'));
        }
        return this.cruise;
    }

    /** What is due now: { t } the turn, or { why } nothing (soft: a reason that may pass in a moment, SOFT_HOLD_MS). */
    _due(now) {
        const mode = this.mode();
        if (mode === 'off') return { why: 'off' };
        if (process.platform !== 'linux' && !process.env.CLUSTER_RENDER_SOCK && !this.opts.path) return { why: 'not on a head unit' };
        let t = null;
        try { t = this.src.turn(); } catch (e) { t = null; }
        if (!t) return { why: 'no route' };
        this._subscribe();
        if (this.src.reversing && this.src.reversing()) return { why: 'reversing' };
        if (this.others.bmw || this.others.carplay || this.others.aa) return { why: 'another navigation guides on the HUD' };
        if (this._cruise(now || Date.now()) && this.ctx.settings.get('hudCruise') !== 'keep') return { why: 'cruise control is on the HUD', soft: 'cruise' };
        if (mode === 'near' && !t.arrived && t.m.type !== 'arrive' && !(t.dist <= (this.layer ? NEAR_OFF_M : NEAR_M))) return { why: 'next turn over 1 km away', soon: true, soft: 'far' };
        return { t };
    }

    tick() {
        try { this._tick(Date.now()); } catch (e) { this.log.warn('hud: ' + (e && e.message)); }
    }

    _tick(now) {
        const due = this._due(now);
        this.why = due.why || '';
        if (!due.t) {
            // a soft reason keeps the last picture until it has held; reverse, another navigation, Off, the route's end: at once
            if (due.soft && this.layer) {
                if (!this.softAt) this.softAt = now;
                if (now - this.softAt < SOFT_HOLD_MS[due.soft]) return;
            }
            this.softAt = 0;
            this._dropLayer();
            // a route that runs keeps the connection (the next turn comes); else it goes after a minute
            if (this.cr && !due.soon && now - this.lastDue > IDLE_CLOSE_MS) this._close();
            return;
        }
        this.lastDue = now; this.softAt = 0;
        if (!this.cr) this._open();
        if (!this.cr.ready) return;
        if (!this.layer) {
            this.place = placeOf(this.cr.targets);
            this.layer = this.cr.image({ target: 'hud', class: 'overlay', z: 5, x: this.place.x, y: this.place.y, w: this.place.w, h: this.place.h, iw: NW, ih: NH, fps: FPS, sampling: 'bilinear' });
            this.lastKey = '';
            this.log.info('hud: turn arrows on the HUD at ' + this.place.x + ',' + this.place.y + ' (' + this.place.w + 'x' + this.place.h + ')');
        }
        const t = due.t, imperial = this.src.imperial ? this.src.imperial() : false, lang = this.src.lang ? this.src.lang() : 'en';
        const d = H.fmtDist(t.dist, imperial);
        const key = [t.arrived ? 'A' : t.m.type + ':' + (t.m.mod || '') + ':' + Math.round(t.m.angle || 0) + ':' + (t.m.exit || ''), d.join(''),
            Math.round(Math.min(300, t.dist) / 10), t.name || '', imperial ? 1 : 0, lang].join('|');
        if (key === this.lastKey || now - this.lastSent < 1000 / FPS) return;
        this.lastKey = key; this.lastSent = now;
        drawTurn(this.rec.reset ? this.rec.reset() : this.rec, t, imperial, lang);
        play(this.rec.words(), this.cv);
        this.cr.pixels(this.layer, toHud(this.cv.d, this.px));
    }

    _open() {
        this.cr = new ClusterRender('osm_nav', this.log, this.opts.path ? { path: this.opts.path, check: this.opts.check } : null);
        this.cr.on('ready', () => { this.place = null; });
        this.cr.on('down', () => { this.layerState = ''; this.targetState = ''; });
        this.cr.on('layer', (m) => { if (m.ref === this.layer && m.state !== this.layerState) { this.layerState = m.state; this.log.info('hud: layer ' + m.state + (m.reason ? ' (' + m.reason + ')' : '')); } });
        this.cr.on('target', (m) => {
            if (m.target !== 'hud') return;
            const s = m.state + (m.holder ? ' behind ' + m.holder : '') + (m.disabled ? ', disabled by its guard' : '');
            if (s !== this.targetState) { this.targetState = s; this.log.info('hud: target ' + s); }
        });
        this.cr.on('refused', (m) => this.log.warn('hud: cluster-render refused ' + m.op + ': ' + m.reason));
        this.cr.on('unsupported', (text) => { this.why = text; });
        this.cr.start();
    }

    _dropLayer() {
        if (this.layer && this.cr) { this.cr.drop(this.layer); this.log.info('hud: turn arrows off the HUD (' + (this.why || '-') + ')'); }
        this.layer = 0; this.lastKey = ''; this.layerState = '';
    }

    _close() {
        this._dropLayer();
        if (this.cr) { this.cr.close(); this.cr = null; }
        this.targetState = '';
    }

    /** One line for the menu. */
    status() {
        if (this.mode() === 'off') return 'Off';
        if (this.cr && this.cr.unsupported) return 'cluster-render: ' + this.cr.unsupported.split('\n')[0];
        if (this.layer && this.cr && this.cr.ready) return 'Showing' + (this.targetState && !/^shown/.test(this.targetState) ? ' (HUD ' + this.targetState + ')' : '');
        if (this.cr && !this.cr.ready) return 'Waiting for cluster-render (MGU Store)';
        return this.why ? 'Ready: ' + this.why : 'Ready';
    }

    stop() {
        clearInterval(this.timer);
        this._close();
        this.subs.forEach((s) => { try { s.shutdown(); } catch (e) { /* gone */ } });
        this.subs = [];
    }
}

module.exports = { HudTurns, placeOf, cruiseShown, drawTurn, toHud, NW, NH, NEAR_M };
