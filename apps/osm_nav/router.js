'use strict';
/**
 * router.js - low-RAM offline turn-by-turn routing on a map pack's road graph (mappack.js). Node 8.
 *
 * Memory-optimized for BMW iDrive 7 (MGU):
 *   - Edge entry/exit bearings are stored as 1-byte angles (Uint8Array, 1.4 deg resolution, 1.5 MB total).
 *   - Source nodes are looked up via CSR binary search (0 MB) instead of a 3 MB array.
 *   - Edge travel times are computed inline in A* (0 MB) instead of a 3 MB Float32Array.
 *   - A* working buffers (Float32 cost, Int32 parent, Uint16 stamp = 7.5 MB) are allocated lazily on first route.
 */
const fs = require('fs');
const path = require('path');
const { F, groundScale } = require('./mappack');

const DEG = 180 / Math.PI;
const B_SCALE = 360 / 256;

class Heap {
    constructor() { this.k = new Float32Array(1024); this.v = new Int32Array(1024); this.n = 0; }
    clear() { this.n = 0; }
    push(key, val) {
        if (this.n === this.k.length) {
            const k = new Float32Array(this.n * 2), v = new Int32Array(this.n * 2);
            k.set(this.k); v.set(this.v); this.k = k; this.v = v;
        }
        let i = this.n++;
        const K = this.k, V = this.v;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (K[p] <= key) break;
            K[i] = K[p]; V[i] = V[p]; i = p;
        }
        K[i] = key; V[i] = val;
    }
    /** smallest value (its key in this.top) */
    pop() {
        const K = this.k, V = this.v, out = V[0];
        this.top = K[0];
        const n = --this.n, key = K[n], val = V[n];
        let i = 0;
        while (true) {
            let c = 2 * i + 1;
            if (c >= n) break;
            if (c + 1 < n && K[c + 1] < K[c]) c++;
            if (K[c] >= key) break;
            K[i] = K[c]; V[i] = V[c]; i = c;
        }
        K[i] = key; V[i] = val;
        return out;
    }
}

/** compass bearing (degrees, 0 = north, clockwise) of a step dx, dy */
function bearing(dx, dy) { const b = Math.atan2(dx, dy) * DEG; return b < 0 ? b + 360 : b; }
/** signed turn from bearing a to b, -180..180 (+ = right) */
function turnAngle(a, b) { let d = b - a; while (d > 180) d -= 360; while (d <= -180) d += 360; return d; }

class Router {
    /** opts.cacheDir: where the per-edge bearings and twins are kept between starts (the app's data folder). */
    constructor(pack, opts) {
        this.pack = pack;
        this.cacheDir = (opts && opts.cacheDir) || null;
        const g = this.g = pack.graph, m = g.m;
        this.cost = null;
        this.par = null;
        this.stamp = null;
        this.run = 0;
        this.heap = new Heap();
        this.b0u8 = new Uint8Array(m);
        this.b1u8 = new Uint8Array(m);
        this.twinOf = new Int32Array(m);
        let vmax = 10;
        for (let e = 0; e < m; e++) {
            const sp = g.speedMax[e] & 255;
            if (sp > vmax) vmax = sp;
        }
        this.vmax = vmax / 3.6;
        this.gs = groundScale((pack.mbox[1] + pack.mbox[3]) / 2);
        this._initTopology();
    }

    _initTopology() {
        const P = this.pack, g = this.g, m = g.m;
        // in the data folder (the app's own source folder may be read-only on the car); the name carries the
        // pack's size and time, so a new map never reads an old cache
        let cacheFile = null;
        try {
            const st = fs.statSync(P.file);
            if (this.cacheDir) cacheFile = path.join(this.cacheDir, 'osm_nav_' + path.basename(P.file).replace(/[^A-Za-z0-9_.-]/g, '_') + '.' + st.size + '.' + Math.floor(st.mtimeMs) + '.rtr');
        } catch (e) { cacheFile = null; }
        const wantBytes = m * 6;
        if (cacheFile) {
            try {
                const stC = fs.statSync(cacheFile);
                if (stC.size === wantBytes) {
                    const fd = fs.openSync(cacheFile, 'r');
                    fs.readSync(fd, Buffer.from(this.b0u8.buffer), 0, m, 0);
                    fs.readSync(fd, Buffer.from(this.b1u8.buffer), 0, m, m);
                    fs.readSync(fd, Buffer.from(this.twinOf.buffer), 0, m * 4, m * 2);
                    fs.closeSync(fd);
                    return;
                }
            } catch (e) {}
        }
        const E = P.sec.GEDG.off, G = P.sec.GGEO.off;
        const at = (k) => E + 4 + k * m * 4;
        const geomArr = P._u32a(at(4), m);
        const infoArr = P._u32a(at(5), m);
        // the shape points, read once for this (~13 MB for all of Georgia, freed afterwards) instead of a
        // read per point: seconds on the head unit otherwise, with the event loop blocked
        const geo = P._i32a(G + 4, P.u32(G) * 2);
        const readGeoPt = (j) => [geo[j * 2], geo[j * 2 + 1]];
        for (let v = 0; v < g.n; v++) {
            const sx = g.x[v], sy = g.y[v];
            for (let e = g.first[v]; e < g.first[v + 1]; e++) {
                const t = g.target[e], tx = g.x[t], ty = g.y[t];
                const geom = geomArr[e], start = geom & 0x7fffffff, rev = geom >>> 31, cnt = infoArr[e] & 0xffff;
                let fx = tx, fy = ty, lx = sx, ly = sy;
                if (cnt) {
                    const j0 = rev ? start + cnt - 1 : start, j1 = rev ? start : start + cnt - 1;
                    const p0 = readGeoPt(j0);
                    fx = p0[0]; fy = p0[1];
                    if (j1 === j0) { lx = fx; ly = fy; }
                    else { const p1 = readGeoPt(j1); lx = p1[0]; ly = p1[1]; }
                }
                this.b0u8[e] = Math.round(bearing(fx - sx, fy - sy) / B_SCALE) & 255;
                this.b1u8[e] = Math.round(bearing(tx - lx, ty - ly) / B_SCALE) & 255;
                this.twinOf[e] = -1;
                const gm = geom & 0x7fffffff;
                for (let f = g.first[t]; f < g.first[t + 1]; f++) {
                    if (f !== e && g.target[f] === v && (geomArr[f] & 0x7fffffff) === gm && (infoArr[f] & 0xffff) === cnt) {
                        this.twinOf[e] = f;
                        break;
                    }
                }
            }
        }
        if (cacheFile) {
            try {
                const fd = fs.openSync(cacheFile + '.tmp', 'w');
                fs.writeSync(fd, Buffer.from(this.b0u8.buffer), 0, m);
                fs.writeSync(fd, Buffer.from(this.b1u8.buffer), 0, m);
                fs.writeSync(fd, Buffer.from(this.twinOf.buffer), 0, m * 4);
                fs.closeSync(fd);
                fs.renameSync(cacheFile + '.tmp', cacheFile);
                // the caches of this map's older versions go (the data folder has a size limit)
                const stem = path.basename(cacheFile).split('.').slice(0, -3).join('.') + '.';
                fs.readdirSync(this.cacheDir).forEach((f) => {
                    if (f !== path.basename(cacheFile) && f.indexOf(stem) === 0 && /\.rtr(\.tmp)?$/.test(f)) { try { fs.unlinkSync(path.join(this.cacheDir, f)); } catch (e) { /* in use */ } }
                });
            } catch (e) { /* no cache: built again next time */ }
        }
    }

    b0(e) { return this.b0u8[e] * B_SCALE; }
    b1(e) { return this.b1u8[e] * B_SCALE; }
    secsOf(e) { return this.g.len[e] * 0.36 / Math.max(5, this.g.speedMax[e] & 255); }

    /**
     * The nearest point on the road network to x, y: { edge, t (0..1 along the edge), x, y, dist (m),
     * bearing } or null (nothing within maxM).
     */
    snap(x, y, headingDeg, maxM) {
        const P = this.pack, gs = this.gs, lim = maxM || 400;
        let best = null;
        for (let pass = 0; pass < 2 && !best; pass++) {
            const near = P.edgesNear(x, y, (pass ? lim : Math.min(lim, 120)) / gs);
            for (const e of near) {
                const iso = P.edgeFlags(e) & F.ISOLATED;
                const hit = this.project(e, x, y);
                const d = hit.d * gs;
                let score = d + (iso ? 60 : 0);
                let edge = e, t = hit.t, brg = hit.b;
                if (headingDeg != null) {
                    const diff = Math.abs(turnAngle(headingDeg, hit.b));
                    const tw = this.twinOf[e];
                    if (diff > 90 && tw >= 0) { edge = tw; t = 1 - hit.t; brg = (hit.b + 180) % 360; score += (180 - diff) * 0.25; } else score += Math.min(diff, 180) * (diff > 90 ? 0.6 : 0.25);
                }
                if (!best || score < best.score) best = { edge, t, x: hit.x, y: hit.y, dist: d, bearing: brg, score };
            }
        }
        return best && best.dist <= lim ? best : null;
    }

    /** Nearest point of edge e to x, y: { d (mercator m), t (by length), x, y, b (bearing there) }. */
    project(e, x, y) {
        const s = this.pack.shape(e);
        let total = 0;
        for (let i = 2; i < s.length; i += 2) total += Math.hypot(s[i] - s[i - 2], s[i + 1] - s[i - 1]);
        let best = Infinity, bt = 0, bx = s[0], by = s[1], bb = 0, acc = 0;
        for (let i = 2; i < s.length; i += 2) {
            const ax = s[i - 2], ay = s[i - 1], dx = s[i] - ax, dy = s[i + 1] - ay;
            const l2 = dx * dx + dy * dy, l = Math.sqrt(l2);
            let u = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
            u = u < 0 ? 0 : u > 1 ? 1 : u;
            const px = ax + dx * u, py = ay + dy * u, d = Math.hypot(x - px, y - py);
            if (d < best) { best = d; bx = px; by = py; bt = total ? (acc + l * u) / total : 0; bb = bearing(dx, dy); }
            acc += l;
        }
        return { d: best, t: bt, x: bx, y: by, b: bb };
    }

    /** Seconds of a turn from edge e onto edge f (right-hand traffic: a left turn waits for oncoming cars). */
    turnCost(e, f) {
        const fl = this.pack.edgeFlags(f);
        if (fl & F.ROUNDABOUT && this.pack.edgeFlags(e) & F.ROUNDABOUT) return 0;
        const a = turnAngle(this.b1(e), this.b0(f)), d = Math.abs(a);
        if (d < 30) return 0;
        if (d < 60) return 2;
        if (d < 125) return a > 0 ? 5 : 11;
        if (d < 165) return 20;
        return 45;
    }

    /**
     * Fastest route from a to b (snap() results), through opts.vias in order. Returns a Route or null.
     * opts.avoid: 'tolls' | 'motorways' (taken only when there is nothing else, at 4x their time).
     */
    route(a, b, opts) {
        if (!a || !b) return null;
        if (!this.cost) {
            const m = this.g.m;
            this.cost = new Float32Array(m);
            this.par = new Int32Array(m);
            this.stamp = new Uint16Array(m);
        }
        opts = opts || {};
        const stops = [a].concat(opts.vias || [], [b]);
        let edges = [], t0 = a.t, t1 = 0, ms = 0;
        const t = Date.now();
        for (let i = 1; i < stops.length; i++) {
            const leg = this._leg(stops[i - 1], stops[i], opts, i === 1);
            if (!leg) return null;
            if (edges.length && edges[edges.length - 1] === leg.edges[0]) edges = edges.concat(leg.edges.slice(1));
            else edges = edges.concat(leg.edges);
            t1 = leg.t1;
        }
        ms = Date.now() - t;
        const r = new Route(this, edges, t0, t1, a, b);
        r.searchMs = ms;
        // Free A* working buffers (7.5 MB) after a short idle window so steady-state RAM stays minimal
        if (this._freeTimer) clearTimeout(this._freeTimer);
        this._freeTimer = setTimeout(() => {
            this.cost = null; this.par = null; this.stamp = null;
            this.heap = new Heap();
            this._freeTimer = null;
        }, 5000);
        if (this._freeTimer.unref) this._freeTimer.unref();
        return r;
    }

    _leg(a, b, opts, first) {
        const g = this.g, P = this.pack, H = this.heap, cost = this.cost, par = this.par, stamp = this.stamp;
        let run = (this.run + 1) & 0xffff;
        if (run === 0) { stamp.fill(0); run = 1; }
        this.run = run;
        H.clear();
        const avoidFlag = opts.avoid === 'tolls' ? F.TOLL : 0, avoidMotor = opts.avoid === 'motorways';
        const mult = (e) => {
            const cf = g.clsFlags[e], fl = (cf >>> 8) & 255;
            return (avoidFlag && (fl & avoidFlag)) || (avoidMotor && (cf & 255) === 0) ? 4 : 1;
        };
        const secs = (e) => g.len[e] * 0.36 / Math.max(5, g.speedMax[e] & 255);
        const gx = b.x, gy = b.y, inv = this.gs / this.vmax;
        const h = (v) => Math.hypot(g.x[v] / 10 - gx, g.y[v] / 10 - gy) * inv;
        const eb = b.edge, tb = b.t, ebt = this.twinOf[eb];
        let best = Infinity, bestEnd = -1, bestPar = -1, bestT = 0;
        const seed = (e, c) => {
            if (stamp[e] === run && cost[e] <= c) return;
            stamp[e] = run; cost[e] = c; par[e] = -1;
            H.push(c + h(g.target[e]), e);
        };
        seed(a.edge, (1 - a.t) * secs(a.edge) * mult(a.edge));
        const at = this.twinOf[a.edge];
        if (at >= 0) seed(at, a.t * secs(at) * mult(at) + (first ? 40 : 15));
        if (a.edge === eb && tb >= a.t) { best = (tb - a.t) * secs(eb); bestEnd = eb; bestPar = -2; bestT = tb; }
        if (at >= 0 && at === eb && tb >= 1 - a.t) {
            const c = (tb - (1 - a.t)) * secs(eb) + 40;
            if (c < best) { best = c; bestEnd = eb; bestPar = -3; bestT = tb; }
        }
        let pops = 0;
        while (H.n) {
            const e = H.pop();
            if (H.top >= best) break;
            if (++pops > 3000000) break;
            const ce = cost[e], v = g.target[e], tw = this.twinOf[e];
            const f0 = g.first[v], f1 = g.first[v + 1];
            const dead = f1 - f0 <= 1;
            for (let f = f0; f < f1; f++) {
                if (f === tw && !dead) continue;
                const c = ce + this.turnCost(e, f);
                if (f === eb) {
                    const cand = c + tb * secs(eb) * mult(eb);
                    if (cand < best) { best = cand; bestEnd = eb; bestPar = e; bestT = tb; }
                }
                if (f === ebt) {
                    const cand = c + (1 - tb) * secs(ebt) * mult(ebt);
                    if (cand < best) { best = cand; bestEnd = ebt; bestPar = e; bestT = 1 - tb; }
                }
                const nc = c + secs(f) * mult(f);
                if (stamp[f] !== run || nc < cost[f]) {
                    stamp[f] = run; cost[f] = nc; par[f] = e;
                    H.push(nc + h(g.target[f]), f);
                }
            }
        }
        if (bestEnd < 0) return null;
        const edges = [bestEnd];
        if (bestPar >= 0) {
            let e = bestPar;
            for (let guard = 0; e >= 0 && guard < 200000; guard++) { edges.unshift(e); e = par[e]; }
        }
        return { edges, t1: bestT, secs: best, startTwin: edges[0] !== a.edge };
    }
}

/* ---------- a route: its line, distances, times and maneuvers ---------- */
class Route {
    constructor(router, edges, t0, t1, a, b) {
        const P = router.pack, gs = router.gs;
        this.router = router; this.pack = P; this.edges = edges; this.dest = b; this.from = a;
        const pts = [], segEdge = [], cum = [0], time = [0];
        const startT = edges[0] === a.edge ? t0 : 1 - t0;
        const add = (x, y, e) => {
            const n = pts.length;
            if (n && Math.abs(pts[n - 2] - x) < 0.01 && Math.abs(pts[n - 1] - y) < 0.01) return;
            if (n) {
                const d = Math.hypot(x - pts[n - 2], y - pts[n - 1]) * gs;
                cum.push(cum[cum.length - 1] + d);
                const sp = Math.max(5, P.edgeSpeed(segEdge[segEdge.length - 1])) / 3.6;
                time.push(time[time.length - 1] + d / sp);
            }
            pts.push(x, y);
            segEdge.push(e);
        };
        this.nodeAt = [];
        for (let k = 0; k < edges.length; k++) {
            const e = edges[k], s = P.shape(e);
            const from = k === 0 ? startT : 0, to = k === edges.length - 1 ? t1 : 1;
            const part = cut(s, from, to);
            for (let i = 0; i < part.length; i += 2) add(part[i], part[i + 1], e);
            this.nodeAt.push(cum[cum.length - 1]);
        }
        if (pts.length < 4) { add(pts[0] + 0.5, pts[1], edges[0]); }
        this.pts = pts; this.segEdge = segEdge; this.cum = cum; this.time = time;
        this.length = cum[cum.length - 1];
        this.duration = time[time.length - 1];
        this.maneuvers = maneuvers(router, this);
    }
    /** Point at route distance s: { x, y, i (segment), bearing } */
    at(s) {
        const c = this.cum, p = this.pts;
        let lo = 0, hi = c.length - 1;
        if (s <= 0) lo = 0; else if (s >= c[hi]) lo = hi - 1;
        else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; } }
        lo = Math.max(0, Math.min(c.length - 2, lo));
        const seg = c[lo + 1] - c[lo] || 1, u = Math.max(0, Math.min(1, (s - c[lo]) / seg));
        const ax = p[lo * 2], ay = p[lo * 2 + 1], bx = p[lo * 2 + 2], by = p[lo * 2 + 3];
        return { x: ax + (bx - ax) * u, y: ay + (by - ay) * u, i: lo, bearing: bearing(bx - ax, by - ay) };
    }
    /** Seconds still to drive from route distance s. */
    timeLeft(s) {
        const q = this.at(s), c = this.cum, i = q.i;
        const u = (s - c[i]) / ((c[i + 1] - c[i]) || 1);
        return this.duration - (this.time[i] + (this.time[i + 1] - this.time[i]) * Math.max(0, Math.min(1, u)));
    }
}

/** The part of a shape [x, y, ...] from fraction a to b of its length. */
function cut(s, a, b) {
    if (a <= 0 && b >= 1) return s.slice();
    let total = 0;
    for (let i = 2; i < s.length; i += 2) total += Math.hypot(s[i] - s[i - 2], s[i + 1] - s[i - 1]);
    const A = a * total, B = b * total, out = [];
    let acc = 0;
    for (let i = 2; i < s.length; i += 2) {
        const ax = s[i - 2], ay = s[i - 1], bx = s[i], by = s[i + 1], l = Math.hypot(bx - ax, by - ay);
        const s0 = acc, s1 = acc + l;
        if (s1 >= A && s0 <= B && l > 0) {
            const u0 = Math.max(0, (A - s0) / l), u1 = Math.min(1, (B - s0) / l);
            if (!out.length) out.push(ax + (bx - ax) * u0, ay + (by - ay) * u0);
            out.push(ax + (bx - ax) * u1, ay + (by - ay) * u1);
        }
        acc = s1;
    }
    if (!out.length) out.push(s[0], s[1], s[0], s[1]);
    return out;
}

function maneuvers(router, route) {
    const P = router.pack, g = router.g, E = route.edges, out = [];
    const nameCache = new Map(), refCache = new Map();
    const nameOf = (e) => { if (!nameCache.has(e)) nameCache.set(e, P.edgeName(e)); return nameCache.get(e); };
    const refOf = (e) => { if (!refCache.has(e)) refCache.set(e, P.edgeRef(e)); return refCache.get(e); };
    const RB = (e) => !!(P.edgeFlags(e) & F.ROUNDABOUT), LINK = (e) => !!(P.edgeFlags(e) & F.LINK);
    const pos = (k) => { const p = route.at(route.nodeAt[k]); return { x: p.x, y: p.y }; };
    const first = route.at(0);
    out.push({ type: 'depart', mod: 'straight', name: nameOf(E[0]), ref: refOf(E[0]), at: 0, x: first.x, y: first.y, angle: 0 });
    for (let k = 0; k < E.length - 1; k++) {
        const e = E[k], f = E[k + 1], v = g.target[e];
        if (!RB(e) && RB(f)) {
            let exit = 0, j = k + 1;
            while (j < E.length && RB(E[j])) {
                const node = g.target[E[j]];
                const next = E[j + 1];
                for (let x = g.first[node]; x < g.first[node + 1]; x++) {
                    if (!RB(x) && x !== router.twinOf[E[j]]) { exit++; break; }
                }
                if (next === undefined || !RB(next)) break;
                j++;
            }
            const outE = E[j + 1] !== undefined ? E[j + 1] : E[j];
            const p = pos(k);
            out.push({ type: 'roundabout', mod: dirMod(turnAngle(router.b1(e), router.b0(outE))), exit: Math.max(1, exit), name: nameOf(outE), ref: refOf(outE),
                at: route.nodeAt[k], x: p.x, y: p.y, angle: turnAngle(router.b1(e), router.b0(outE)) });
            k = j;
            continue;
        }
        if (RB(e)) continue;
        const a = turnAngle(router.b1(e), router.b0(f));
        const outs = [];
        for (let x = g.first[v]; x < g.first[v + 1]; x++) if (x !== router.twinOf[e]) outs.push(x);
        const others = outs.filter((x) => x !== f).map((x) => turnAngle(router.b1(e), router.b0(x)));
        const named = nameOf(e) !== nameOf(f) && nameOf(f) !== 0;
        const p = pos(k);
        const m = { name: nameOf(f), ref: refOf(f), at: route.nodeAt[k], x: p.x, y: p.y, angle: a };
        if (Math.abs(a) > 165 && f === router.twinOf[e]) { out.push(Object.assign(m, { type: 'uturn', mod: 'uturn' })); continue; }
        if (!others.length) continue;
        const clsOf = (x) => P.edgeClass(x), cf = clsOf(f);
        const sideways = outs.filter((x) => x !== f && !(nameOf(x) === nameOf(f) && nameOf(f)) && !(clsOf(x) > cf + 1 && nameOf(e) === nameOf(f)));
        const near = sideways.map((x) => turnAngle(router.b1(e), router.b0(x))).filter((o) => Math.abs(o) < 40 && Math.abs(o - a) < 45);
        if (!LINK(e) && LINK(f) && Math.abs(a) < 60) { out.push(Object.assign(m, { type: 'ramp', mod: near.some((o) => o < a) ? 'slight-right' : 'slight-left' })); continue; }
        if (LINK(e) && !LINK(f) && Math.abs(a) < 45) { out.push(Object.assign(m, { type: 'merge', mod: 'straight' })); continue; }
        if (Math.abs(a) < 25) {
            if (near.length) out.push(Object.assign(m, { type: 'fork', mod: near.every((o) => o < a) ? 'slight-right' : near.every((o) => o > a) ? 'slight-left' : 'straight' }));
            else if (named && others.some((o) => Math.abs(o) < 70)) out.push(Object.assign(m, { type: 'continue', mod: 'straight' }));
            continue;
        }
        out.push(Object.assign(m, { type: 'turn', mod: dirMod(a) }));
    }
    const end = route.at(route.length);
    out.push({ type: 'arrive', mod: 'straight', name: 0, ref: 0, at: route.length, x: end.x, y: end.y, angle: 0 });
    for (let i = out.length - 2; i > 0; i--) {
        if (out[i + 1].type !== 'arrive' && out[i + 1].at - out[i].at < 12 && out[i].type === 'turn' && out[i + 1].type === 'turn') {
            out[i].angle += out[i + 1].angle;
            out[i].mod = Math.abs(out[i].angle) > 165 ? 'uturn' : dirMod(out[i].angle);
            if (out[i].mod === 'uturn') out[i].type = 'uturn';
            out[i].name = out[i + 1].name; out[i].ref = out[i + 1].ref;
            out.splice(i + 1, 1);
        }
    }
    return out;
}

function dirMod(a) {
    const d = Math.abs(a), s = a > 0 ? 'right' : 'left';
    if (d < 25) return 'straight';
    if (d < 55) return 'slight-' + s;
    if (d < 130) return s;
    if (d < 170) return 'sharp-' + s;
    return 'uturn';
}

/* ---------- guidance: following a route ---------- */
const OFF_M = 35, OFF_FAR_M = 90, OFF_S = 3.5, ARRIVE_M = 25;

class Guidance {
    constructor(router, route) {
        this.router = router; this.route = route;
        this.s = 0; this.seg = 0; this.offSince = 0; this.arrived = false;
    }
    update(pos, now) {
        now = now || Date.now();
        const r = this.route, p = r.pts, gs = this.router.gs;
        let best = Infinity, bi = this.seg, bu = 0;
        const from = Math.max(0, this.seg - 6), to = Math.min(r.cum.length - 2, this.seg + 60);
        for (let i = from; i <= to; i++) {
            const ax = p[i * 2], ay = p[i * 2 + 1], dx = p[i * 2 + 2] - ax, dy = p[i * 2 + 3] - ay;
            const l2 = dx * dx + dy * dy;
            let u = l2 ? ((pos.x - ax) * dx + (pos.y - ay) * dy) / l2 : 0;
            u = u < 0 ? 0 : u > 1 ? 1 : u;
            let d = Math.hypot(pos.x - ax - dx * u, pos.y - ay - dy * u) * gs;
            if (pos.heading != null && pos.speed > 8 && l2) d += Math.abs(turnAngle(pos.heading, bearing(dx, dy))) > 100 ? 40 : 0;
            if (i < this.seg) d += 3;
            if (d < best) { best = d; bi = i; bu = u; }
        }
        if (best > OFF_M) {
            for (let i = 0; i < r.cum.length - 1; i++) {
                const ax = p[i * 2], ay = p[i * 2 + 1], dx = p[i * 2 + 2] - ax, dy = p[i * 2 + 3] - ay, l2 = dx * dx + dy * dy;
                let u = l2 ? ((pos.x - ax) * dx + (pos.y - ay) * dy) / l2 : 0;
                u = u < 0 ? 0 : u > 1 ? 1 : u;
                const d = Math.hypot(pos.x - ax - dx * u, pos.y - ay - dy * u) * gs;
                if (d < best - 5) { best = d; bi = i; bu = u; }
            }
        }
        this.seg = bi;
        const s = r.cum[bi] + (r.cum[bi + 1] - r.cum[bi]) * bu;
        if (s > this.s - 30) this.s = s;
        const off = best;
        if (off > OFF_M) { if (!this.offSince) this.offSince = now; } else this.offSince = 0;
        const offRoute = off > OFF_FAR_M || (this.offSince && now - this.offSince > OFF_S * 1000);
        const M = r.maneuvers;
        let next = M.length - 1;
        for (let i = 1; i < M.length; i++) if (M[i].at > this.s + 3) { next = i; break; }
        const left = Math.max(0, r.length - this.s);
        if (left < ARRIVE_M) this.arrived = true;
        return {
            s: this.s, off, next, dist: Math.max(0, M[next].at - this.s), left, secs: r.timeLeft(this.s),
            edge: r.segEdge[Math.min(bi, r.segEdge.length - 1)], offRoute: !!offRoute && !this.arrived, arrived: this.arrived,
        };
    }
}

module.exports = { Router, Route, Guidance, bearing, turnAngle, cut };
