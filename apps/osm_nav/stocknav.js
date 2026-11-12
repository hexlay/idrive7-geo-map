'use strict';
/**
 * stocknav.js - open Navigation over the stock BMW map whenever the HMI shows it (the left menu bar's NAV icon, the
 * Navigation tile, voice ...), without ever trapping the driver there. Node 8. Read only: it only watches.
 *
 * Sources (main.js feeds them in):
 *   - mgu-render's surface lines on @mgu-nav-buttons (kit/renderd/src/navwatch.c, nav_watch = 1):
 *       "<ms> surface <id> <visible> <x> <y> <w> <h> <y|-> <process>"  ->  parseSurface()
 *   - a SOME/IP field (app.json config.stockNav.iface / field / match): active or not -> follower.state('someip', on)
 * The stock map is a surface learned on the car (learn(): open the stock map once from the left menu bar while
 * Navigation watches) or named in app.json (config.stockNav.surfaceId / proc), at least minW x minH on the screen
 * (a home-screen widget's small surface never counts).
 *
 * When to open (follower.surface() / state() return 'open'):
 *   - rising edge only: the stock map goes from not shown to shown, while Navigation is not in front;
 *   - after Navigation leaves the screen (appVisible(false)) it is disarmed: BACK from Navigation lands on the stock
 *     map underneath, and that must not open Navigation again (a loop). It is armed again when the stock map is seen
 *     hidden after that, or when it stays hidden for settleMs after Navigation left (left by HOME / MENU);
 *   - never while a yield surface (reversing camera, video) is shown;
 *   - at most once per debounce (the physical NAV button opens it too: main.js shares one debounce).
 */

const DEFAULTS = { minW: 800, minH: 400, settleMs: 4000, learnMs: 20000 };

/** A surface line from mgu-render: { t, id, vis, x, y, w, h, yield, proc } or null. */
function parseSurface(line) {
    const f = String(line || '').trim().split(' ');
    if (f.length < 10 || f[1] !== 'surface') return null;
    const n = f.slice(2, 8).map(Number);
    if (n.some((v) => !isFinite(v))) return null;
    return { t: Number(f[0]), id: n[0], vis: n[1] ? 1 : 0, x: n[2], y: n[3], w: n[4], h: n[5], yield: f[8] === 'y', proc: f.slice(9).join(' ') };
}

class StockNavFollower {
    /** opts: { surfaceId, proc, minW, minH, settleMs } (surfaceId or proc: the stock map; none: learn it first) */
    constructor(opts) {
        this.o = Object.assign({}, DEFAULTS, opts || {});
        this.surfaces = new Map();       // id -> last report
        this.active = false;             // the stock map shown now (any source)
        this.sources = {};               // source -> active
        this.armed = true;
        this.closedAt = 0;
        this.mainVisible = false;
        this.learning = null;            // { until, cands: Map(id -> report) }
    }

    /** Is a report the stock map (as configured or learned), shown and big enough? */
    _isStock(r) {
        const o = this.o;
        if (o.surfaceId == null && !o.proc) return false;
        if (o.surfaceId != null && r.id !== Number(o.surfaceId)) return false;
        if (o.proc && r.proc !== o.proc) return false;
        return true;
    }
    _shownBig(r) { return !!(r && r.vis && r.w >= this.o.minW && r.h >= this.o.minH); }
    /** A yield surface (reversing camera, video) is shown now: nothing opens Navigation then (main.js asks too). */
    yieldShown() {
        for (const r of this.surfaces.values()) if (r.yield && r.vis && r.w > 0 && r.h > 0) return true;
        return false;
    }
    _yieldShown() { return this.yieldShown(); }

    /** Navigation came to the screen or left it. Leaving disarms (BACK lands on the stock map underneath). */
    appVisible(v, now) {
        this.mainVisible = !!v;
        if (!v) { this.armed = false; this.closedAt = now; }
    }

    /**
     * Armed again (rule B): the stock map hidden for settleMs in a row since Navigation left (left by HOME / MENU: the
     * stock map was never shown again). Rule A, the stock map seen hiding after Navigation left, is in state().
     */
    _rearm(now) {
        if (this.armed || this.mainVisible || this.active) return;
        if (now - Math.max(this.closedAt, this.changedAt || 0) >= this.o.settleMs) this.armed = true;
    }
    /** Called now and then (main.js: every second): rule B, and the end of learning. */
    tick(now) {
        this._rearm(now);
        if (this.learning && !this.learning.result && now > this.learning.until) this.learning.result = this._learnPick();
    }

    /**
     * A source's state: 'surface' (from the surface lines) or 'someip'. Returns 'open' on a rising edge that counts.
     * initial: the first report since Navigation started (mgu-render tells every surface once when it starts to
     * listen; a SOME/IP field's first value): where things stand, not something the driver just opened.
     */
    state(source, on, now, initial) {
        if (!(source in this.sources) && initial === undefined) initial = true;   // a SOME/IP field's first value
        this.sources[source] = !!on;
        const was = this.active;
        this.active = Object.keys(this.sources).some((k) => this.sources[k]);
        if (initial) { if (this.active !== was) this.changedAt = now; return null; }
        if (this.active === was) { this._rearm(now); return null; }
        this.changedAt = now;
        // rule A: the stock map hid after Navigation left (BACK, then away from it too): the next showing counts
        if (!this.active && !this.mainVisible) this.armed = true;
        if (this.active && this.armed && !this.mainVisible && !this._yieldShown()) return 'open';
        return null;
    }

    /** A surface line (parseSurface()). Returns 'open' when Navigation should open now. */
    surface(r, now) {
        if (!r) return null;
        const first = !this.surfaces.has(r.id);
        this.surfaces.set(r.id, r);
        if (this.learning) { this._learnSeen(r, now, first); return null; }
        if (!this._isStock(r)) return null;
        // more than one surface may match a process name: the stock map is shown if any of them is
        let on = false;
        for (const s of this.surfaces.values()) if (this._isStock(s) && this._shownBig(s)) on = true;
        // the first report of the stock map's surface is where it stands (shown since before Navigation started),
        // unless it is a new surface turning up shown: a stock map that makes its surface when it opens
        return this.state('surface', on, now, first && !this._fresh);
    }
    /** From now on new surfaces are new (mgu-render's snapshot is in): a surface first seen shown was just made. */
    settled() { this._fresh = true; }

    /* ---------- learning: open the stock map once (left menu bar) while Navigation watches ---------- */
    learn(now) {
        // what is shown when learning starts does not count (the HMI's own surface, a widget): only a surface that
        // turns shown and big afterwards, while Navigation is not in front, is a candidate
        const before = new Map();
        for (const r of this.surfaces.values()) before.set(r.id, this._shownBig(r));
        this.learning = { until: now + this.o.learnMs, before, cands: new Map(), result: null };
    }
    _learnSeen(r, now, first) {
        const L = this.learning;
        if (now > L.until || r.yield) return;               // never the reversing camera or video
        const big = this._shownBig(r);
        if (first && !this._fresh) { L.before.set(r.id, big); return; }   // mgu-render's snapshot: as it stood
        if (!big) { L.before.set(r.id, false); return; }   // hidden (again): its next showing would count
        if (L.before.get(r.id)) return;                     // shown since before learning: not what the driver opened
        L.before.set(r.id, true);
        if (!this.mainVisible) L.cands.set(r.id, r);
    }
    _learnPick() {
        const c = Array.from(this.learning.cands.values());
        if (!c.length) return { error: 'none' };
        if (c.length > 1) {
            // several turned shown: the biggest; two of the same size from different processes is too vague
            c.sort((a, b) => b.w * b.h - a.w * a.h);
            if (c[0].w * c[0].h === c[1].w * c[1].h && c[0].proc !== c[1].proc) return { error: 'vague', count: c.length };
        }
        return { surfaceId: c[0].id, proc: c[0].proc, w: c[0].w, h: c[0].h };
    }
    /** End learning now (Navigation came back to the screen): { surfaceId, proc } or { error: 'none' | 'vague' }. */
    learnDone() {
        if (!this.learning) return null;
        const r = this.learning.result || this._learnPick();
        this.learning = null;
        if (!r.error) { this.o.surfaceId = r.surfaceId; this.o.proc = r.proc; }
        return r;
    }
    configured() { return this.o.surfaceId != null || !!this.o.proc; }
}

module.exports = { StockNavFollower, parseSurface, DEFAULTS };
