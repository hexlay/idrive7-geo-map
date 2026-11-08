'use strict';
/**
 * gps.js - where the car is: live SOME/IP signals, map matching, dead reckoning, and the Tbilisi demo
 * drive. Node 8.
 *
 *   const pos = new Position(ctx, nav);   nav: { pack, router, route() (the active route or null) }
 *   pos.start() / pos.stop()              (foreground only, unless guidance runs)
 *   pos.fix()  -> { x, y, heading, speed, gLong, gLat, gear, source, quality, edge, t }  or null
 *
 * Sources, best first:
 *   gnss   a positioning interface of the car, when app.json "config.positioning" names one (find it
 *          with deploy/car/nav-recon.sh; none is assumed, so the app installs on any firmware).
 *          Its fixes are snapped to the road the car is on (heading decides between nearby roads).
 *   dr     dead reckoning between (or without) fixes: speed (Vehicle2.statusCarSpeed2) along the road
 *          matched last, the turn rate from the lateral acceleration (CDS2) choosing the road at a
 *          junction (the route's when the car is on it). It starts from the last fix, the position
 *          kept from the last drive, or one set on the map ("I'm here").
 *   demo   the demo drive (setting "demo" on, or auto with no car): it drives the active route, or
 *          a tour of Tbilisi (Rustaveli Ave, Freedom Square, the Mtkvari embankment, Heroes' Square,
 *          Saburtalo), with speed limits, slowing for turns and a stop at a light.
 *
 * Speeds km/h, accelerations g, headings degrees (0 = north, clockwise), positions Web Mercator m.
 */
const fs = require('fs');
const path = require('path');
const { F, merc, groundScale } = require('./mappack');
const { bearing, turnAngle } = require('./router');

let Car = null;
try { Car = require('./kit/car'); } catch (e) { Car = null; }

/* The demo tour: start on Rustaveli Avenue near Rose Revolution Square, heading south-east to Freedom
   Square, out along Baratashvili Street to the embankment, north along the Mtkvari, over Heroes'
   Square into Saburtalo. */
const TOUR = {
    start: [41.7015, 44.7942], heading: 140,
    vias: [[41.6941, 44.8045], [41.7090, 44.7998]],
    dest: [41.7336, 44.7598], destName: { local: 'სითი მოლი საბურთალო', latin: 'City Mall Saburtalo' },
};

function dig(obj, p) {
    if (!p || p === 'auto') return undefined;
    return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Encodings a car may give a coordinate in, as multipliers to degrees: degrees, 1e-7 / 1e-6 / 1e-5 degrees,
 * milliarcseconds, and 2^31 "semicircles". Which one a field uses is not guessed from the number alone (they
 * overlap): auto mode takes the one that puts the fix inside the installed map (Position._autoFix).
 */
const SCALES = [1, 1e-7, 1e-6, 1e-5, 1 / 3600000, 180 / 2147483648];

function autoExtractFix(v, depth) {
    if (!v || typeof v !== 'object' || (depth || 0) > 4) return null;
    let lat = NaN, lon = NaN, heading = null, speed = null;
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i], val = v[k];
        if (typeof val === 'number' || typeof val === 'string') {
            if (/latitude|^lat$|latdeg|wgs84lat/i.test(k)) lat = Number(val);
            else if (/longitude|^lon$|^lng$|londeg|wgs84lon/i.test(k)) lon = Number(val);
            else if (/heading|course|bearing|orientation|yaw/i.test(k) && isFinite(Number(val))) heading = ((Number(val) % 360) + 360) % 360;
            else if (/^speed$|groundspeed|vehiclespeed/i.test(k) && isFinite(Number(val))) speed = Number(val);
        }
    }
    if (isFinite(lat) && isFinite(lon)) return { lat, lon, heading, speed };
    for (let i = 0; i < keys.length; i++) {
        const sub = v[keys[i]];
        if (sub && typeof sub === 'object') {
            const r = autoExtractFix(sub, (depth || 0) + 1);
            if (r) {
                if (r.heading == null && heading != null) r.heading = heading;
                if (r.speed == null && speed != null) r.speed = speed;
                return r;
            }
        }
    }
    return null;
}

class Position {
    constructor(ctx, nav) {
        this.ctx = ctx; this.log = ctx.log; this.nav = nav;
        this.file = path.join(ctx.dataDir || '.', 'osm_nav_position.json');
        this.live = { speed: null, gLong: null, gLat: null, gear: null, at: 0 };
        this.gnss = null;           // last car fix { x, y, heading, speed, at }
        this.dr = null;             // { edge, t, heading, at }
        this.cur = null;
        this.demo = null;
        this.timer = null;
        this.active = false;
        this.listeners = [];
        const cfgObj = (ctx.spec && ctx.spec.config) || {};
        this.cfg = [].concat(cfgObj.positioning || [], (cfgObj.gps && cfgObj.gps.discover) || []);
        try {
            const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (typeof j.x === 'number' && typeof j.y === 'number') this.saved = j;
        } catch (e) { this.saved = null; }
    }

    /**
     * demo wanted: the setting "on", or "auto" off the car (PC preview, emulator) while no car signal has
     * come. On the car (MainApp runs the app: ctx.app) "auto" never starts it: a silent signal must
     * show "no position", not a simulated drive with guidance.
     */
    wantDemo() {
        const m = this.ctx.settings.get('demo');
        if (m === 'on') return true;
        if (m === 'off' || this.ctx.app) return false;
        const vis = this.ctx.ui && this.ctx.ui.isVisible && this.ctx.ui.isVisible('MAIN');
        return !!this.ctx.previewDemo || (vis && !this.carSeen && Date.now() - (this.t0 || Date.now()) > 3000);
    }

    _wake() {
        if (!this.active) return;
        this.lastMoveAt = Date.now();
        if (!this.timer) {
            this.last = Date.now();
            this._schedule(50);
        }
    }

    _schedule(ms) {
        if (!this.active) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this._tick();
        }, ms);
    }

    start() {
        if (this.active) return;
        this.active = true;
        this.t0 = this.t0 || Date.now();
        this.lastMoveAt = Date.now();
        if (Car && !this.car && this.ctx.signals && this.ctx.signals.watch) {
            try {
                this.car = new Car(this.ctx, ['speed', 'accel', 'gear']);
                this.car.onSample((d) => {
                    if (d.demo) return;
                    this.carSeen = true;
                    const wasParked = !this.live.speed || this.live.speed < 0.3;
                    this.live = { speed: d.speed, gLong: d.gLong, gLat: d.gLat, gear: d.gear, stage: d.stage, at: Date.now() };
                    if (d.speed > 0.3 || wasParked) this._wake();
                });
            } catch (e) { this.log.warn('position: car signals: ' + e); }
        }
        this._watchGnss();
        this.last = Date.now();
        this._schedule(50);
    }
    stop() {
        this.active = false;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.car) { this.car.stop(); this.car = null; }
        (this.gnssSubs || []).forEach((s) => s.shutdown());
        this.gnssSubs = null;
        this._save();
    }

    /** A positioning interface from app.json config.positioning or config.gps.discover (auto-discovered at install). */
    _watchGnss() {
        if (this.gnssSubs || !this.cfg.length || !this.ctx.signals) return;
        this.gnssSubs = [];
        this.cfg.forEach((c) => {
            const iface = c.iface || c.interface, field = c.field || c.attribute;
            if (!iface || !field) return;
            const h = {};
            h[field] = (v) => {
                const sc = c.scale || {};
                let lat, lon, hd, sp;
                if (!c.lat || c.lat === 'auto') {
                    const ex = autoExtractFix(v, 0);
                    if (!ex) return;
                    const ll = this._autoScale(ex.lat, ex.lon, iface + '.' + field);
                    if (!ll) return;
                    lat = ll[0]; lon = ll[1];
                    hd = ex.heading != null ? ex.heading * (sc.heading || 1) : null;
                    sp = ex.speed != null ? ex.speed * (sc.speed || 1) : null;
                } else {
                    lat = Number(dig(v, c.lat)) * (sc.lat || 1);
                    lon = Number(dig(v, c.lon)) * (sc.lon || 1);
                    hd = c.heading ? Number(dig(v, c.heading)) * (sc.heading || 1) : null;
                    sp = c.speed ? Number(dig(v, c.speed)) * (sc.speed || 1) : null;
                }
                if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
                const p = merc(lat, lon);
                this.gnss = { x: p[0], y: p[1], heading: isFinite(hd) ? hd : null, speed: isFinite(sp) ? sp : null, at: Date.now() };
                this.carSeen = true;
                this._wake();
            };
            this.ctx.signals.watch(iface, c.instance || '1', h, this.log)
                .then((s) => { this.gnssSubs && this.gnssSubs.push(s); this.log.info('position: ' + iface + '.' + field + (s.error ? ' error: ' + s.error : ' subscribed')); });
        });
    }

    /**
     * A discovered field's raw latitude / longitude in degrees: the first encoding (SCALES) that puts it on an
     * installed map (50 km margin). None does: null, and the field is said once in the log, not used.
     */
    _autoScale(rlat, rlon, what) {
        if (!isFinite(rlat) || !isFinite(rlon) || (rlat === 0 && rlon === 0)) return null;
        const packs = this.nav.packs ? this.nav.packs() : [this.nav.pack];
        for (const k of SCALES) {
            const lat = rlat * k, lon = rlon * k;
            if (Math.abs(lat) > 85 || Math.abs(lon) > 180) continue;
            const p = merc(lat, lon);
            if (packs.some((P) => P && P.covers(p[0], p[1], 50000))) {
                if (!this._scaleSaid) { this._scaleSaid = true; this.log.info('position: ' + what + ' reads as degrees x ' + k); }
                return [lat, lon];
            }
        }
        this._offMap = this._offMap || {};
        if (!this._offMap[what]) { this._offMap[what] = true; this.log.warn('position: ' + what + ' gave ' + rlat + ', ' + rlon + ': on no installed map in any known encoding - not used'); }
        return null;
    }

    /** "I'm here": dead reckoning starts from this point (snapped to a road). */
    setHere(x, y, heading) {
        const s = this.nav.router.snap(x, y, heading == null ? null : heading, 300);
        if (!s) return false;
        this.dr = { edge: s.edge, t: s.t, heading: s.bearing, at: Date.now() };
        this.cur = this._onEdge(s.edge, s.t, 0, 'dr');
        this._save(true);
        return true;
    }

    onFix(fn) { this.listeners.push(fn); }
    fix() { return this.cur; }

    _tick() {
        const now = Date.now(), dt = Math.min(0.5, (now - this.last) / 1000);
        this.last = now;
        let f = null;
        const isDemo = this.wantDemo();
        if (isDemo) f = this._demo(now, dt);
        else {
            this.demo = null;
            if (this.gnss && now - this.gnss.at < 2500) f = this._fromGnss(now);
            else f = this._reckon(now, dt);
        }
        if (f) {
            this.cur = f;
            if (f.speed > 0.4 || isDemo) this.lastMoveAt = now;
            this.listeners.forEach((fn) => { try { fn(f); } catch (e) { this.log.warn('position: ' + e); } });
        }
        if (now - (this.savedAt || 0) > 30000) this._save();
        if (!this.active) return;
        const moving = isDemo || (f && f.speed > 0.4) || (this.live.speed != null && this.live.speed > 0.4);
        const vis = this.ctx.ui && this.ctx.ui.isVisible && this.ctx.ui.isVisible('MAIN');
        const idleMs = now - (this.lastMoveAt || now);
        // Battery & CPU safety: when parked/stationary off-screen for > 60s, pause polling until SOME/IP wakes us
        if (!moving && !vis && idleMs > 60000) return;
        this._schedule(moving ? (isDemo ? 50 : 100) : 1000);
    }

    /** A car fix, snapped to the road it fits best (within 30 m). */
    _fromGnss(now) {
        const g = this.gnss, R = this.nav.router;
        const sp = g.speed != null ? g.speed : this.live.speed || 0;
        let heading = g.heading;
        if (heading == null && this.prevG && Math.hypot(g.x - this.prevG.x, g.y - this.prevG.y) > 3) heading = bearing(g.x - this.prevG.x, g.y - this.prevG.y);
        this.prevG = { x: g.x, y: g.y };
        const s = R.snap(g.x, g.y, heading, 45);
        if (s && s.dist < 30) {
            this.dr = { edge: s.edge, t: s.t, heading: s.bearing, at: now };
            return this._onEdge(s.edge, s.t, sp, 'gnss', heading);
        }
        return { x: g.x, y: g.y, heading: heading || 0, speed: sp, gLong: this.live.gLong, gLat: this.live.gLat, gear: this.live.gear, source: 'gnss', quality: 'raw', edge: -1, t: 0 };
    }

    /** Dead reckoning: the car's speed along the matched road; at a junction the road its turning fits. */
    _reckon(now, dt) {
        if (!this.dr && this.saved) {
            const s = this.nav.router.snap(this.saved.x, this.saved.y, this.saved.heading, 300);
            if (s) this.dr = { edge: s.edge, t: s.t, heading: s.bearing, at: now };
            this.saved = null;
        }
        if (!this.dr) return null;
        const v = this.live.speed != null && now - this.live.at < 3000 ? this.live.speed : 0;
        // turning: yaw rate = lateral acceleration / speed (deg/s), integrated into the heading
        const ms = v / 3.6;
        if (ms > 2 && this.live.gLat != null) this.dr.heading = (this.dr.heading + (this.live.gLat * 9.81 / ms) * dt * 57.3 + 360) % 360;
        this._advance(this.dr, ms * dt);
        return this._onEdge(this.dr.edge, this.dr.t, v, 'dr');
    }

    /** Move state { edge, t, heading } d metres along the roads. */
    _advance(st, d) {
        const P = this.nav.pack, R = this.nav.router, g = P.graph;
        let guard = 0;
        while (d > 0 && guard++ < 20) {
            const len = g.len[st.edge] / 10 || 1;
            const left = (1 - st.t) * len;
            if (d < left) { st.t += d / len; return; }
            d -= left;
            // next edge: the route's when on it, else the one that fits the car's heading
            const v = g.target[st.edge];
            let next = -1;
            const route = this.nav.route && this.nav.route();
            if (route) { const k = route.edges.indexOf(st.edge); if (k >= 0 && k + 1 < route.edges.length) next = route.edges[k + 1]; }
            if (next < 0) {
                let best = 1e9;
                for (let f = g.first[v]; f < g.first[v + 1]; f++) {
                    if (f === R.twinOf[st.edge] && g.first[v + 1] - g.first[v] > 1) continue;
                    const diff = Math.abs(turnAngle(st.heading, R.b0(f)));
                    if (diff < best) { best = diff; next = f; }
                }
            }
            if (next < 0) { st.t = 1; return; }
            st.edge = next; st.t = 0;
            st.heading = R.b0(next);
        }
    }

    _onEdge(edge, t, speed, source, heading) {
        const P = this.nav.pack, R = this.nav.router, s = P.shape(edge);
        let total = 0;
        for (let i = 2; i < s.length; i += 2) total += Math.hypot(s[i] - s[i - 2], s[i + 1] - s[i - 1]);
        let want = t * total, x = s[0], y = s[1], b = R.b0(edge);
        for (let i = 2; i < s.length; i += 2) {
            const l = Math.hypot(s[i] - s[i - 2], s[i + 1] - s[i - 1]);
            if (want <= l || i === s.length - 2) {
                const u = l ? Math.min(1, want / l) : 0;
                x = s[i - 2] + (s[i] - s[i - 2]) * u; y = s[i - 1] + (s[i + 1] - s[i - 1]) * u;
                b = bearing(s[i] - s[i - 2], s[i + 1] - s[i - 1]);
                break;
            }
            want -= l;
        }
        return { x, y, heading: heading != null ? heading : b, speed: speed || 0, gLong: this.live.gLong, gLat: this.live.gLat, gear: this.live.gear,
            source, quality: 'matched', edge, t, maxspeed: P.edgeMaxspeed(edge), name: P.edgeName(edge), ref: P.edgeRef(edge) };
    }

    _save(force) {
        const c = this.cur;
        if (!c || (c.source === 'demo' && !force)) return;
        this.savedAt = Date.now();
        try { fs.writeFileSync(this.file, JSON.stringify({ x: c.x, y: c.y, heading: c.heading, at: Date.now() })); } catch (e) { /* read-only (preview) */ }
    }

    /* ---------- the demo drive ---------- */
    /** The tour as a route, from the pack (null when the pack is not Georgia). */
    tourRoute() {
        const R = this.nav.router;
        const p = (ll) => merc(ll[0], ll[1]);
        const a = p(TOUR.start), b = p(TOUR.dest);
        if (!this.nav.pack.covers(a[0], a[1]) || !this.nav.pack.covers(b[0], b[1])) return null;
        const sa = R.snap(a[0], a[1], TOUR.heading, 200), sb = R.snap(b[0], b[1], null, 300);
        if (!sa || !sb) return null;
        // the waypoints fit the built-in map's streets; on a real map they would land on side streets (loops)
        const builtin = this.nav.pack.meta.source === 'builtin Georgia';
        const vias = builtin ? TOUR.vias.map((v) => { const q = p(v); return R.snap(q[0], q[1], null, 200); }).filter(Boolean) : [];
        return R.route(sa, sb, { vias });
    }

    /**
     * The demo car on its track (the active route, else the tour): the speed limit of the road, slower
     * for a turn ahead (25 km/h for a turn, 30 in a roundabout), a red light at the second turn.
     */
    _demo(now, dt) {
        const route = (this.nav.route && this.nav.route()) || null;
        let D = this.demo;
        if (!D || (route && D.track !== route && !D.own) || (route && D.own && D.track !== route)) {
            const track = route || this.tourRoute();
            if (!track) return null;
            // the same route again (a new plan from where the car is): go on from there
            const s = D && this.cur ? 0 : 0;
            D = this.demo = { track, own: !!route, s, v: D ? D.v : 0, hold: 0, lit: false, heading: null };
        }
        const T = D.track, P = this.nav.pack;
        if (D.hold > 0) { D.hold -= dt; D.v = 0; } else {
            const at = T.at(D.s), e = T.segEdge[Math.min(at.i, T.segEdge.length - 1)];
            let lim = (P.edgeMaxspeed(e) || 50) * 0.96;
            // the next maneuver: brake for it in time (v^2 = v0^2 + 2 a d, a = 2.2 m/s^2)
            const M = T.maneuvers;
            for (let i = 1; i < M.length; i++) {
                const m = M[i], d = m.at - D.s;
                if (d < -5) continue;
                if (d > 400) break;
                const vt = m.type === 'arrive' ? 0 : m.type === 'roundabout' ? 28 : m.type === 'uturn' ? 12 : /sharp/.test(m.mod) ? 18 : /slight/.test(m.mod) || m.type === 'fork' || m.type === 'continue' ? 50 : 25;
                const vmax = Math.sqrt((vt / 3.6) * (vt / 3.6) + 2 * 2.2 * Math.max(0, d - 6)) * 3.6;
                if (vmax < lim) lim = vmax;
                // a red light at the second turn of the drive, once
                if (!D.lit && i === 2 && d < 8 && d > 0 && D.v < 8) { D.lit = true; D.hold = 6; }
            }
            const a = lim > D.v ? Math.min(2.0, (lim - D.v) / 3.6 / dt) : Math.max(-3.2, (lim - D.v) / 3.6 / dt);
            D.acc = a;
            D.v = Math.max(0, Math.min(lim + 0.5, D.v + a * dt * 3.6));
            if (D.s >= T.length - 0.5) {
                D.v = 0;
                D.done = (D.done || 0) + dt;
                if (D.done > 8) { this.demo = null; if (this.onDemoEnd) this.onDemoEnd(D); return this.cur; }
            }
            D.s = Math.min(T.length, D.s + D.v / 3.6 * dt);
        }
        const p = T.at(D.s), ahead = T.at(Math.min(T.length, D.s + 8));
        let hd = Math.hypot(ahead.x - p.x, ahead.y - p.y) > 0.5 ? bearing(ahead.x - p.x, ahead.y - p.y) : D.heading == null ? p.bearing : D.heading;
        if (D.heading != null) hd = (D.heading + turnAngle(D.heading, hd) * Math.min(1, dt * 6) + 360) % 360;
        D.heading = hd;
        const e = T.segEdge[Math.min(p.i, T.segEdge.length - 1)];
        return { x: p.x, y: p.y, heading: hd, speed: D.v, gLong: (D.acc || 0) / 9.81, gLat: 0, gear: D.v > 1 ? 'D' : 'P', source: 'demo', quality: 'matched',
            edge: e, t: 0, maxspeed: P.edgeMaxspeed(e), name: P.edgeName(e), ref: P.edgeRef(e), demoS: D.s };
    }
}

Position.TOUR = TOUR;
module.exports = { Position, TOUR, groundScale, F };
