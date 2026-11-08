'use strict';
/**
 * map_view.js - the vector map, drawn every frame on a record.js Recorder (GPU at 60 fps; canvas.js
 * on the software path and in the PC preview). Node 8.
 *
 *   const view = new MapView([pack, ...]);
 *   view.camera = { x, y, mpp, heading }       Web Mercator metres; metres per pixel; degrees (map up)
 *   view.draw(r, { x, y, w, h, cx, cy }, opts) the map into that rectangle, the camera's point at cx, cy
 *
 * What it draws (bottom to top): land, land use, parks and forests, water (pre-triangulated by
 * pack_osm.py: OP_TRIS, one command per colour), rivers and borders, roads in two passes (casing,
 * then fill, by class) with bridges over them, the route (passed part dimmed, chevrons ahead), POI
 * icons, road shields, street and place labels (upright, kept apart), the destination and the car.
 *
 * Heading-up rotates the map round the car: each tile's 16-bit coordinates go to the screen through
 * one affine transform (rotation, scale, offset) worked out per tile, so a vertex costs 4 multiplies.
 * Levels: macro (country, metres per pixel > 40), mid (city, > 3.2), street; roads of the smaller
 * classes come in as the map zooms in.
 */
const { F, groundScale } = require('./mappack');

/* road classes: 0 motorway .. 9 pedestrian; width in metres on the ground, and at least this many px */
const ROAD_M = [24, 21, 18, 15, 13, 10, 9, 7, 5.5, 4];
const ROAD_MIN = [3.2, 3, 2.6, 2.1, 1.7, 1.3, 1.2, 1, 0.9, 0.8];

const STYLES = {
    night: {
        bg: '#1d2228', residential: '#21262d', industrial: '#24242a', commercial: '#26232a', water: '#163049', park: '#1b3025',
        forest: '#18291f', grass: '#1c2f24', cemetery: '#1f2c27', building: '#2a3038', pedestrian: '#262b31', land: '#1d2228',
        river: '#204264', rail: '#3a4048', border: '#9b5876', region: '#5a4a5a',
        road: ['#e0973c', '#d2ae55', '#b8c0ca', '#9aa3ad', '#89919b', '#737b85', '#6a727c', '#5c636c', '#535a63', '#474d55'],
        casing: '#0c0f12', casingMajor: '#3a2410', bridge: '#05070a',
        route: '#2f8cff', routeCasing: '#0a2856', routePast: '#5a6474', chevron: '#ffffff',
        text: '#e8ebef', textDim: '#a7afb9', halo: '#11151a', place: '#f4f6f8', suburb: '#9ea7b2',
        car: '#2f8cff', carRing: '#ffffff',
    },
    day: {
        bg: '#ebe8e1', residential: '#e3dfd6', industrial: '#ddd7d6', commercial: '#e6d9d6', water: '#a6c8e6', park: '#c4deb0',
        forest: '#b1d29c', grass: '#cbe3b8', cemetery: '#c6d8bf', building: '#d8d0c4', pedestrian: '#e8e3dc', land: '#ebe8e1',
        river: '#8db8dd', rail: '#a9a39b', border: '#a2507a', region: '#b693a8',
        road: ['#f0a043', '#f6c55c', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#f7f6f3', '#f5f3ef', '#efebe5'],
        casing: '#b7afa3', casingMajor: '#c0803d', bridge: '#8f877b',
        route: '#1a73e8', routeCasing: '#0b3d91', routePast: '#9aa3ad', chevron: '#ffffff',
        text: '#2a2e35', textDim: '#5d646d', halo: '#ffffff', place: '#1d2127', suburb: '#56606b',
        car: '#1a73e8', carRing: '#ffffff',
    },
};
const AREA_KEY = [null, 'water', 'park', 'forest', 'residential', 'industrial', 'building', 'grass', 'land', 'commercial', 'cemetery', 'pedestrian'];
// drawing order of area kinds (land use first, water over parks, buildings last)
const AREA_ORDER = [4, 5, 9, 11, 10, 7, 3, 2, 8, 1, 6];
const LINE = { 1: 'river', 2: 'river', 3: 'rail', 4: 'border', 5: 'region', 6: 'river', 7: 'rail' };

/* POI kinds (pack_osm.py) */
const POI = {
    10: { c: '#2563eb', g: 'fuel' }, 11: { c: '#16a34a', g: 'bolt' }, 12: { c: '#dc2626', g: 'cross' }, 13: { c: '#1d4ed8', g: 'P' },
    14: { c: '#9333ea', g: 'star' }, 15: { c: '#ea580c', g: 'dot' }, 16: { c: '#0891b2', g: 'H' }, 17: { c: '#059669', g: 'cross' },
    18: { c: '#1e40af', g: 'dot' }, 19: { c: '#e11d48', g: 'M' }, 20: { c: '#475569', g: 'plane' }, 21: { c: '#c026d3', g: 'bag' },
    22: { c: '#7c3aed', g: 'dot' }, 23: { c: '#9333ea', g: 'star' }, 24: { c: '#0f766e', g: 'dot' }, 25: { c: '#b45309', g: 'dot' },
};

class MapView {
    constructor(packs) {
        this.packs = packs || [];
        this.camera = { x: 0, y: 0, mpp: 2, heading: 0 };
        this.style = 'night';
        this.lang = 'ka';
        this.tri = {};                 // per colour: screen-space triangle buffer (reused)
        this.stats = { roads: 0, segs: 0, tris: 0, labels: 0 };
    }

    level(mpp) { return mpp > 40 ? 0 : mpp > 3.2 ? 1 : 2; }

    /** Memory is short: the per-colour triangle buffers go (the next frame makes them again, as big as it needs). */
    trim() { this.tri = {}; }

    /** World point -> screen (into out[0], out[1]) with the current frame's transform. */
    toScreen(x, y, out) {
        const T = this.T;
        const ex = (x - T.camx) / T.mpp, ny = (y - T.camy) / T.mpp;
        out[0] = T.cx + ex * T.c - ny * T.s;
        out[1] = T.cy - ex * T.s - ny * T.c;
        return out;
    }
    /** Screen -> world [x, y]. */
    toWorld(sx, sy) {
        const T = this.T || this._t(this.lastVp || { cx: 0, cy: 0 });
        const u = sx - T.cx, v = T.cy - sy;
        const ex = u * T.c + v * T.s, ny = -u * T.s + v * T.c;
        return [T.camx + ex * T.mpp, T.camy + ny * T.mpp];
    }
    _t(vp) {
        const cam = this.camera, h = cam.heading * Math.PI / 180;
        return { camx: cam.x, camy: cam.y, mpp: cam.mpp, c: Math.cos(h), s: Math.sin(h), cx: vp.cx, cy: vp.cy };
    }

    /**
     * Draw the map. opts: { route, routeS (m driven), car: { x, y, heading }, dest: { x, y }, avoid: [{x,y,w,h}] (HUD
     * boxes labels keep out of), poi: true, scale (text size factor) }.
     */
    draw(r, vp, opts) {
        opts = opts || {};
        const S = STYLES[this.style] || STYLES.night;
        this.S = S;
        this.lastVp = vp;
        const T = this.T = this._t(vp);
        const mpp = T.mpp, gs = groundScale(T.camy);
        this.gs = gs;
        const lv = this.level(mpp);
        this.stats = { roads: 0, segs: 0, tris: 0, labels: 0, level: lv };
        if (this.cullOverride === undefined) this.cullArea = lv === 0 ? 2.5 : mpp > 20 ? 1.5 : 0;
        r.clip(vp.x, vp.y, vp.w, vp.h);
        r.fillRect(vp.x, vp.y, vp.w, vp.h, S.bg);
        // the world box the viewport shows (rotated: the box round its four corners)
        const cs = [[vp.x, vp.y], [vp.x + vp.w, vp.y], [vp.x, vp.y + vp.h], [vp.x + vp.w, vp.y + vp.h]].map((p) => this.toWorld(p[0], p[1]));
        const wx0 = Math.min.apply(null, cs.map((p) => p[0])), wx1 = Math.max.apply(null, cs.map((p) => p[0]));
        const wy0 = Math.min.apply(null, cs.map((p) => p[1])), wy1 = Math.max.apply(null, cs.map((p) => p[1]));
        this.view = { x0: vp.x - 40, y0: vp.y - 40, x1: vp.x + vp.w + 40, y1: vp.y + vp.h + 40 };
        const tilesOf = (level) => {
            const out = [];
            for (const P of this.packs) {
                const L = P.levels[level], size = L.size;
                if (wx1 < P.mbox[0] - size * 2 || wx0 > P.mbox[2] + size * 2 || wy1 < P.mbox[1] - size * 2 || wy0 > P.mbox[3] + size * 2) continue;
                const c0 = Math.floor(wx0 / size) - 1, c1 = Math.floor(wx1 / size) + 1, r0 = Math.floor(wy0 / size) - 1, r1 = Math.floor(wy1 / size) + 1;
                if ((c1 - c0 + 1) * (r1 - r0 + 1) > 400) continue;
                for (let row = r0; row <= r1; row++) {
                    for (let col = c0; col <= c1; col++) {
                        const t = P.tile(level, col, row);
                        if (t) out.push({ t, P, aff: this._aff(t) });
                    }
                }
            }
            return out;
        };
        const tiles = tilesOf(lv);
        // areas: the street level draws the mid level's large areas under its own
        const areaTiles = lv === 2 ? tilesOf(1).concat(tiles) : tiles;
        this._areas(r, areaTiles);
        this._lines(r, tiles, mpp);
        const labels = [];
        this._roads(r, tiles, mpp, gs, lv, labels);
        if (opts.route) this._route(r, opts.route, opts.routeS || 0, mpp, gs);
        const placed = (opts.avoid || []).map((b) => ({ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h }));
        if (opts.car) {
            const p = this.toScreen(opts.car.x, opts.car.y, [0, 0]);
            placed.push({ x0: p[0] - 40, y0: p[1] - 40, x1: p[0] + 40, y1: p[1] + 40 });
        }
        const k = opts.scale || 1;
        this._places(r, tiles, lv, placed, k, true);
        this._labels(r, labels, placed, k, lv);
        if (lv === 2 && mpp < 2.6 && opts.poi !== false) this._pois(r, tiles, placed, k, mpp);
        this._places(r, tiles, lv, placed, k, false);
        if (opts.dest) this._pin(r, opts.dest, k);
        if (opts.pins) opts.pins.forEach((p) => this._pin(r, p, k * 0.8, p.color));
        if (opts.car) this._car(r, opts.car, k);
        r.noclip();
        return this.stats;
    }

    /**
     * Read ahead: the tiles just past the edge of the view in the way the car drives, at most max a call
     * (one a frame), so driving into a new area does not read half a dozen tiles in one frame (a stutter).
     * Returns how many were read.
     */
    prefetch(x, y, heading, max) {
        const lv = this.level(this.camera.mpp), vp = this.lastVp;
        if (!vp) return 0;
        const h = (heading || 0) * Math.PI / 180, reach = Math.hypot(vp.w, vp.h) * 0.6 * this.camera.mpp;
        let n = 0;
        for (const P of this.packs) {
            const size = P.levels[lv].size;
            // two points ahead: the view's edge, and one tile past it
            for (const d of [reach, reach + size]) {
                const px = x + Math.sin(h) * d, py = y + Math.cos(h) * d;
                const c0 = Math.floor(px / size), r0 = Math.floor(py / size);
                for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                    if (n >= (max || 1)) return n;
                    if (!P.hasTile(lv, c0 + dc, r0 + dr)) { P.tile(lv, c0 + dc, r0 + dr); n++; }
                }
            }
        }
        return n;
    }

    /** Affine transform of a tile's coordinates to the screen: sx = A qx + B qy + C, sy = D qx + E qy + F. */
    _aff(t) {
        const T = this.T, k = t.unit / T.mpp, ox = (t.x0 - T.camx) / T.mpp, oy = (t.y0 - T.camy) / T.mpp;
        return { A: T.c * k, B: -T.s * k, C: T.cx + T.c * ox - T.s * oy, D: -T.s * k, E: -T.c * k, F: T.cy - T.s * ox - T.c * oy };
    }

    _areas(r, tiles) {
        const S = this.S, V = this.view;
        const bufs = {};
        // zoomed out, most land-use triangles are smaller than a pixel (country: ~280k of forest): those are
        // left out (twice the area in px^2 below this), which cuts what goes to the renderer several times
        const cull = this.cullArea || 0;
        for (const { t, aff } of tiles) {
            const { A, B, C, D, E } = aff, Fo = aff.F;
            for (const a of t.areas) {
                const key = AREA_KEY[a.kind] || 'land';
                let b = bufs[a.kind];
                if (!b) b = bufs[a.kind] = { key, xy: this.tri[key] || (this.tri[key] = new Float32Array(6 * 4096)), n: 0 };
                const q = a.tris;
                for (let i = 0; i < q.length; i += 6) {
                    const x0 = A * q[i] + B * q[i + 1] + C, y0 = D * q[i] + E * q[i + 1] + Fo;
                    const x1 = A * q[i + 2] + B * q[i + 3] + C, y1 = D * q[i + 2] + E * q[i + 3] + Fo;
                    const x2 = A * q[i + 4] + B * q[i + 5] + C, y2 = D * q[i + 4] + E * q[i + 5] + Fo;
                    if ((x0 < V.x0 && x1 < V.x0 && x2 < V.x0) || (x0 > V.x1 && x1 > V.x1 && x2 > V.x1) ||
                        (y0 < V.y0 && y1 < V.y0 && y2 < V.y0) || (y0 > V.y1 && y1 > V.y1 && y2 > V.y1)) continue;
                    if (cull) { const ar = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0); if (ar < cull && ar > -cull) continue; }
                    if (b.n * 6 + 6 > b.xy.length) {
                        const nb = new Float32Array(b.xy.length * 2); nb.set(b.xy); b.xy = nb; this.tri[key] = nb;
                    }
                    const o = b.n * 6;
                    b.xy[o] = x0; b.xy[o + 1] = y0; b.xy[o + 2] = x1; b.xy[o + 3] = y1; b.xy[o + 4] = x2; b.xy[o + 5] = y2;
                    b.n++;
                }
            }
        }
        for (const kind of AREA_ORDER) {
            const b = bufs[kind];
            if (!b || !b.n) continue;
            // the renderer takes up to 100000 triangles a command
            for (let s = 0; s < b.n; s += 20000) r.tris(s ? b.xy.subarray(s * 6) : b.xy, S[b.key] || S.land, Math.min(20000, b.n - s));
            this.stats.tris += b.n;
        }
    }

    _lines(r, tiles, mpp) {
        const S = this.S, out = [0, 0];
        for (const { t, aff } of tiles) {
            for (const l of t.lines) {
                const key = LINE[l.kind];
                if (!key) continue;
                const w = key === 'river' ? (l.kind === 1 ? Math.max(1.5, Math.min(14, 45 / this.gs / mpp)) : 1.2) : key === 'border' ? 2 : 1.2;
                if (key === 'rail' && mpp > 30) continue;
                this._poly(r, l.pts, aff, w, S[key], key === 'border' || key === 'region' ? 9 : 0, out);
            }
        }
    }

    /** A tile polyline to the screen: segments (dash > 0: dashed, every other dash px). */
    _poly(r, pts, aff, w, col, dash, out) {
        const { A, B, C, D, E } = aff, Fo = aff.F, V = this.view;
        let px = A * pts[0] + B * pts[1] + C, py = D * pts[0] + E * pts[1] + Fo, on = true, run = 0;
        const n = pts.length;
        for (let i = 2; i < n; i += 2) {
            const x = A * pts[i] + B * pts[i + 1] + C, y = D * pts[i] + E * pts[i + 1] + Fo;
            const dx = x - px, dy = y - py;
            if (dx * dx + dy * dy < 1.4 && i < n - 2) continue;
            if (!((px < V.x0 && x < V.x0) || (px > V.x1 && x > V.x1) || (py < V.y0 && y < V.y0) || (py > V.y1 && y > V.y1))) {
                if (dash) {
                    const len = Math.sqrt(dx * dx + dy * dy);
                    let s = 0;
                    while (s < len) {
                        const step = Math.min(len - s, dash - run);
                        if (on) r.line(px + dx * s / len, py + dy * s / len, px + dx * (s + step) / len, py + dy * (s + step) / len, w, col);
                        s += step; run += step;
                        if (run >= dash - 1e-6) { run = 0; on = !on; }
                    }
                } else r.line(px, py, x, y, w, col);
                this.stats.segs++;
            }
            px = x; py = y;
        }
    }

    _roads(r, tiles, mpp, gs, lv, labels) {
        const S = this.S;
        // which classes this zoom shows
        const maxCls = lv === 0 ? 2 : lv === 1 ? (mpp > 15 ? 3 : 4) : mpp > 2.4 ? 6 : mpp > 1.2 ? 8 : 9;
        const list = [];
        for (const tt of tiles) {
            for (const rd of tt.t.roads) {
                if (rd.cls > maxCls) continue;
                list.push({ rd, aff: tt.aff, P: tt.P });
            }
        }
        // minor classes first, so the major ones are drawn over them; bridges last of all
        list.sort((a, b) => ((a.rd.flags & F.BRIDGE) - (b.rd.flags & F.BRIDGE)) || (b.rd.cls - a.rd.cls));
        const width = (cls) => Math.min(40, Math.max(ROAD_MIN[cls] * (lv === 0 ? 0.9 : 1), ROAD_M[cls] / gs / mpp));
        const out = [0, 0];
        const passes = [['casing', true], ['fill', false]];
        let start = 0;
        // non-bridges: all casings, then all fills; each bridge: its casing then its fill (over what it crosses)
        const nb = list.findIndex((x) => x.rd.flags & F.BRIDGE);
        const ground = nb < 0 ? list : list.slice(0, nb), bridges = nb < 0 ? [] : list.slice(nb);
        const draw = (x, casing) => {
            const rd = x.rd, w = width(rd.cls);
            if (casing) {
                if (w < 2.2 && lv < 2) return;
                const cw = w + (w > 4 ? 2.6 : 1.6);
                this._poly(r, rd.pts, x.aff, cw, rd.flags & F.BRIDGE ? S.bridge : rd.cls <= 1 && this.style === 'day' ? S.casingMajor : S.casing, 0, out);
            } else {
                const col = S.road[rd.cls];
                if (rd.flags & F.TUNNEL) r.alpha(0.45);
                this._poly(r, rd.pts, x.aff, w, col, rd.cls === 9 ? Math.max(4, w * 2) : 0, out);
                if (rd.flags & F.TUNNEL) r.alpha(1);
            }
        };
        for (const p of passes) for (const x of ground) draw(x, p[1]);
        for (const x of bridges) { draw(x, true); draw(x, false); }
        void start;
        this.stats.roads = list.length;
        // label candidates: named roads, major first
        for (const x of list) {
            if (x.rd.name || (x.rd.ref && x.rd.cls <= 3)) labels.push(x);
        }
    }

    _route(r, route, sDone, mpp, gs) {
        const S = this.S, p = route.pts, cum = route.cum, V = this.view;
        const w = Math.max(5, Math.min(26, 16 / gs / mpp + 4));
        const out = [0, 0];
        const sc = [];
        for (let i = 0; i < p.length; i += 2) { this.toScreen(p[i], p[i + 1], out); sc.push(out[0], out[1]); }
        const seg = (i, col, wid) => {
            const x0 = sc[i * 2], y0 = sc[i * 2 + 1], x1 = sc[i * 2 + 2], y1 = sc[i * 2 + 3];
            if ((x0 < V.x0 && x1 < V.x0) || (x0 > V.x1 && x1 > V.x1) || (y0 < V.y0 && y1 < V.y0) || (y0 > V.y1 && y1 > V.y1)) return;
            r.line(x0, y0, x1, y1, wid, col);
        };
        const n = cum.length - 1;
        let split = 0;
        while (split < n && cum[split + 1] <= sDone) split++;
        // where the car is on its segment: the passed part ends there
        const ds = cum[split + 1] - cum[split] || 1, u = Math.max(0, Math.min(1, (sDone - cum[split]) / ds));
        const mx = sc[split * 2] + (sc[split * 2 + 2] - sc[split * 2]) * u, my = sc[split * 2 + 1] + (sc[split * 2 + 3] - sc[split * 2 + 1]) * u;
        for (let i = 0; i < split; i++) seg(i, S.routeCasing, w + 3);
        for (let i = 0; i < split; i++) seg(i, S.routePast, w * 0.7);
        r.line(sc[split * 2], sc[split * 2 + 1], mx, my, w * 0.7, S.routePast);
        r.line(mx, my, sc[split * 2 + 2], sc[split * 2 + 3], w + 3, S.routeCasing);
        for (let i = split + 1; i < n; i++) seg(i, S.routeCasing, w + 3);
        r.line(mx, my, sc[split * 2 + 2], sc[split * 2 + 3], w, S.route);
        for (let i = split + 1; i < n; i++) seg(i, S.route, w);
        // chevrons ahead of the car, every so many px along the line
        const gap = Math.max(46, w * 4.5), cw = w * 0.42;
        let acc = gap * 0.6;
        let px = mx, py = my, i = split;
        let guard = 0;
        while (i < n && guard++ < 400) {
            const x1 = sc[i * 2 + 2], y1 = sc[i * 2 + 3], dx = x1 - px, dy = y1 - py, l = Math.sqrt(dx * dx + dy * dy);
            if (acc <= l && l > 0) {
                const t = acc / l, cx = px + dx * t, cy = py + dy * t, ux = dx / l, uy = dy / l;
                if (cx > V.x0 && cx < V.x1 && cy > V.y0 && cy < V.y1) {
                    const bx = cx - ux * cw, by = cy - uy * cw;
                    r.line(bx - uy * cw, by + ux * cw, cx + ux * cw * 0.4, cy + uy * cw * 0.4, Math.max(1.6, w * 0.16), S.chevron);
                    r.line(bx + uy * cw, by - ux * cw, cx + ux * cw * 0.4, cy + uy * cw * 0.4, Math.max(1.6, w * 0.16), S.chevron);
                }
                px = cx; py = cy; acc = gap;
                continue;
            }
            acc -= l; px = x1; py = y1; i++;
        }
    }

    /** Street names and road shields, upright, never on top of each other or the HUD. */
    _labels(r, list, placed, k, lv) {
        const S = this.S, V = this.view, lang = this.lang;
        const maxLabels = 26;
        const size = Math.round(15 * k), opt = { literal: true, font: 'label' };
        const named = new Map();
        // longest visible segment of each road, major roads first
        const cands = [];
        for (const x of list) {
            const { A, B, C, D, E } = x.aff, Fo = x.aff.F, q = x.rd.pts;
            let best = 0, bx = 0, by = 0;
            for (let i = 2; i < q.length; i += 2) {
                const ax = A * q[i - 2] + B * q[i - 1] + C, ay = D * q[i - 2] + E * q[i - 1] + Fo;
                const cx = A * q[i] + B * q[i + 1] + C, cy = D * q[i] + E * q[i + 1] + Fo;
                const mx = (ax + cx) / 2, my = (ay + cy) / 2;
                if (mx < V.x0 + 60 || mx > V.x1 - 60 || my < V.y0 + 60 || my > V.y1 - 60) continue;
                const l = Math.hypot(cx - ax, cy - ay);
                if (l > best) { best = l; bx = mx; by = my; }
            }
            if (best > 30) cands.push({ x, len: best, sx: bx, sy: by });
        }
        cands.sort((a, b) => (a.x.rd.cls - b.x.rd.cls) || (b.len - a.len));
        const hit = (b) => placed.some((q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0);
        let shields = 0;
        for (const c of cands) {
            if (this.stats.labels >= maxLabels) break;
            const rd = c.x.rd, P = c.x.P;
            // a shield for numbered roads (S1, E60 ...) at country and city zoom
            if (rd.ref && rd.cls <= 3 && shields < 8) {
                const refs = P.label(rd.ref, lang === 'en' ? 'en' : 'ka').split(';').slice(0, 2);
                const key = 'ref:' + refs.join(';');
                const prev = named.get(key);
                if (!prev || prev.every((p) => Math.hypot(p[0] - c.sx, p[1] - c.sy) > 360)) {
                    const sz = Math.round(13 * k), pad = 7 * k;
                    const ws = refs.map((t) => r.textWidth(t, sz, { literal: true, font: 'bold' }) + pad * 2);
                    const tw = ws.reduce((a, b) => a + b, 0) + (refs.length - 1) * 3, h = sz + 9 * k;
                    const b = { x0: c.sx - tw / 2 - 2, y0: c.sy - h / 2 - 2, x1: c.sx + tw / 2 + 2, y1: c.sy + h / 2 + 2 };
                    if (!hit(b)) {
                        let x = c.sx - tw / 2;
                        refs.forEach((t, i) => {
                            const intl = /^E\s?\d/.test(t);
                            r.roundRect(x, c.sy - h / 2, ws[i], h, 4 * k, intl ? '#0f7a3a' : '#c8102e');
                            r.strokeRoundRect(x + 1.5, c.sy - h / 2 + 1.5, ws[i] - 3, h - 3, 3 * k, 1.2, '#ffffff');
                            r.text(t, x + ws[i] / 2, c.sy + sz * 0.36, sz, '#ffffff', { literal: true, font: 'bold', align: 'center' });
                            x += ws[i] + 3;
                        });
                        placed.push(b);
                        named.set(key, (prev || []).concat([[c.sx, c.sy]]));
                        shields++; this.stats.labels++;
                        continue;
                    }
                }
            }
            if (!rd.name || lv === 0) continue;
            const text = P.label(rd.name, lang);
            if (!text) continue;
            const prev = named.get(text);
            if (prev && prev.some((p) => Math.hypot(p[0] - c.sx, p[1] - c.sy) < 420)) continue;
            const sz = rd.cls <= 2 ? size + 1 : rd.cls >= 6 ? size - 1 : size;
            const w = r.textWidth(text, sz, opt);
            if (w > c.len * 2.6 + 80) continue;
            const b = { x0: c.sx - w / 2 - 6, y0: c.sy - sz * 0.9, x1: c.sx + w / 2 + 6, y1: c.sy + sz * 0.5 };
            if (b.x0 < V.x0 + 40 || b.x1 > V.x1 - 40 || hit(b)) continue;
            this._halo(r, text, c.sx, c.sy + sz * 0.3, sz, S.text, S.halo, opt);
            placed.push(b);
            named.set(text, (prev || []).concat([[c.sx, c.sy]]));
            this.stats.labels++;
        }
    }

    _halo(r, text, x, y, size, col, halo, opt) {
        const o = Object.assign({ align: 'center' }, opt);
        const d = Math.max(1, size * 0.09);
        r.text(text, x - d, y, size, halo, o); r.text(text, x + d, y, size, halo, o);
        r.text(text, x, y - d, size, halo, o); r.text(text, x, y + d, size, halo, o);
        r.text(text, x, y, size, col, o);
    }

    /** Place names: cities and towns (big, first pass) or suburbs and villages (second). */
    _places(r, tiles, lv, placed, k, big) {
        const S = this.S, V = this.view, out = [0, 0];
        const seen = new Set();
        for (const { t, aff, P } of tiles) {
            for (const p of t.points) {
                if (p.kind > 5 || !p.name) continue;
                const major = p.kind <= 2;
                if (major !== big) continue;
                if (lv === 0 && p.kind === 2 && p.rank < 150) continue;
                if (lv === 2 && p.kind <= 2) continue;          // a city's name is no help in its streets
                if (lv === 1 && p.kind === 5) continue;
                const text = P.label(p.name, this.lang);
                if (!text || seen.has(text)) continue;
                seen.add(text);
                const sx = aff.A * p.x + aff.B * p.y + aff.C, sy = aff.D * p.x + aff.E * p.y + aff.F;
                if (sx < V.x0 + 50 || sx > V.x1 - 50 || sy < V.y0 + 50 || sy > V.y1 - 50) continue;
                const sz = Math.round((p.kind === 1 ? 21 : p.kind === 2 ? 17 : p.kind === 4 ? 15 : 14) * k);
                const font = p.kind <= 2 ? 'bold' : 'label';
                const w = r.textWidth(text, sz, { literal: true, font });
                const b = { x0: sx - w / 2 - 6, y0: sy - sz, x1: sx + w / 2 + 6, y1: sy + sz * 0.5 };
                if (placed.some((q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0)) continue;
                if (p.kind <= 3) r.circle(sx, sy + sz * 0.75, 3.5 * k, p.kind === 3 ? S.textDim : S.place);
                this._halo(r, text, sx, sy, sz, p.kind <= 2 ? S.place : S.suburb, S.halo, { literal: true, font });
                placed.push(b);
                this.stats.labels++;
            }
        }
        void out;
    }

    _pois(r, tiles, placed, k, mpp) {
        const V = this.view;
        let n = 0;
        for (const { t, aff } of tiles) {
            for (const p of t.points) {
                const st = POI[p.kind];
                if (!st || n > 24) continue;
                // a real map has thousands: what a driver needs first (fuel, charging, parking, hospitals,
                // stations), the rest only zoomed right in
                const minor = p.kind === 15 || p.kind === 25 || p.kind === 24 || p.kind === 22 || p.kind === 16 || p.kind === 17 || p.kind === 18;
                if (minor && mpp > 0.7) continue;
                if ((p.kind === 14 || p.kind === 23 || p.kind === 21) && mpp > 1.3) continue;
                const sx = aff.A * p.x + aff.B * p.y + aff.C, sy = aff.D * p.x + aff.E * p.y + aff.F;
                if (sx < V.x0 + 20 || sx > V.x1 - 20 || sy < V.y0 + 20 || sy > V.y1 - 20) continue;
                const rr = 10 * k;
                const b = { x0: sx - rr, y0: sy - rr, x1: sx + rr, y1: sy + rr };
                if (placed.some((q) => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0)) continue;
                poiIcon(r, sx, sy, rr, p.kind);
                placed.push(b);
                n++;
            }
        }
    }

    _pin(r, d, k, color) {
        const p = this.toScreen(d.x, d.y, [0, 0]), x = p[0], y = p[1];
        const V = this.view;
        if (x < V.x0 || x > V.x1 || y < V.y0 || y > V.y1) return;
        const c = color || '#e1001a', s = 15 * k;
        r.circle(x, y, 5 * k, '#00000066');
        r.tris([x - s * 0.55, y - s * 1.55, x + s * 0.55, y - s * 1.55, x, y], c);
        r.circle(x, y - s * 1.7, s * 0.72, c);
        r.circle(x, y - s * 1.7, s * 0.3, '#ffffff');
    }

    /** The car: an arrow in a ring, pointing the way it drives. */
    _car(r, car, k) {
        const S = this.S, p = this.toScreen(car.x, car.y, [0, 0]), x = p[0], y = p[1];
        const a = ((car.heading || 0) - this.camera.heading) * Math.PI / 180;
        const s = 17 * k, sin = Math.sin(a), cos = Math.cos(a);
        const P = (u, v) => [x + u * cos - v * sin, y + u * sin + v * cos];
        r.circle(x, y + 2, s * 1.25, '#00000055');
        r.circle(x, y, s * 1.12, S.carRing);
        r.circle(x, y, s * 0.98, S.car);
        // a dart: a long point ahead, short wings behind, a notch between them
        const t = P(0, -s * 0.78), lft = P(-s * 0.5, s * 0.52), m = P(0, s * 0.2), rgt = P(s * 0.5, s * 0.52);
        r.tris([t[0], t[1], lft[0], lft[1], m[0], m[1], t[0], t[1], m[0], m[1], rgt[0], rgt[1]], '#ffffff');
    }
}

/** A POI marker: a disc in its colour with a small white glyph. */
function poiIcon(r, x, y, rr, kind) {
    const st = POI[kind] || { c: '#64748b', g: 'dot' }, W = '#ffffff';
    r.circle(x, y + 1, rr + 1.5, '#00000055');
    r.circle(x, y, rr + 1.2, W);
    r.circle(x, y, rr, st.c);
    const u = rr / 10;
    switch (st.g) {
    case 'fuel':
        r.roundRect(x - 4 * u, y - 5 * u, 6 * u, 10 * u, 1 * u, W);
        r.fillRect(x - 3 * u, y - 4 * u, 4 * u, 3 * u, st.c);
        r.line(x + 2 * u, y - 2 * u, x + 5 * u, y + 2 * u, 1.4 * u, W);
        break;
    case 'bolt':
        r.tris([x + 1.5 * u, y - 6 * u, x - 4 * u, y + 1 * u, x + 0.5 * u, y + 1 * u, x - 1.5 * u, y + 6 * u, x + 4 * u, y - 1 * u, x - 0.5 * u, y - 1 * u], W);
        break;
    case 'cross':
        r.fillRect(x - 1.6 * u, y - 5.5 * u, 3.2 * u, 11 * u, W); r.fillRect(x - 5.5 * u, y - 1.6 * u, 11 * u, 3.2 * u, W);
        break;
    case 'star': {
        const pts = [];
        for (let i = 0; i < 5; i++) {
            const a0 = -Math.PI / 2 + i * 2 * Math.PI / 5, a1 = a0 + Math.PI / 5, a2 = a0 - Math.PI / 5;
            pts.push(x, y, x + Math.cos(a0) * 6 * u, y + Math.sin(a0) * 6 * u, x + Math.cos(a1) * 2.6 * u, y + Math.sin(a1) * 2.6 * u);
            pts.push(x, y, x + Math.cos(a2) * 2.6 * u, y + Math.sin(a2) * 2.6 * u, x + Math.cos(a0) * 6 * u, y + Math.sin(a0) * 6 * u);
        }
        r.tris(pts, W);
        break;
    }
    case 'plane':
        r.tris([x, y - 6 * u, x - 1.5 * u, y + 5 * u, x + 1.5 * u, y + 5 * u], W);
        r.tris([x - 6 * u, y + 1 * u, x + 6 * u, y + 1 * u, x, y - 2 * u], W);
        break;
    case 'bag':
        r.roundRect(x - 4.5 * u, y - 2.5 * u, 9 * u, 8 * u, 1.5 * u, W);
        r.arc(x, y - 2.5 * u, 2 * u, 3.2 * u, -90, 90, W);
        break;
    case 'dot':
        r.circle(x, y, 3.2 * u, W);
        break;
    default:
        r.text(st.g, x, y + 4.6 * u, 13 * u, W, { literal: true, font: 'bold', align: 'center' });
    }
}

module.exports = { MapView, STYLES, poiIcon };
