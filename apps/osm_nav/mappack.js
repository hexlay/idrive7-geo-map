'use strict';
/**
 * mappack.js - low-RAM on-demand reader for a map pack made by kit/tools/pack_osm.py. Node 8.
 *
 * Designed for the BMW iDrive 7 (MGU) Intel Atom head unit:
 *   - Tile payloads (TIL0/TIL1/TIL2, ~71 MB), road curve geometry (GGEO, ~13 MB), string tables
 *     (STRS/NAME, ~2 MB), spatial grid lists (GGRD, ~4 MB) and search indexes (SRCH/SKEY/STOK, ~6 MB)
 *     stay on disk and are paged on demand via fs.readSync with small bounded LRU caches.
 *   - Only the compact routing topology (GNOD + core GEDG arrays, ~13 MB for all of Georgia) is kept
 *     in typed arrays in RAM.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const F = { ONEWAY: 1, ROUNDABOUT: 2, BRIDGE: 4, TUNNEL: 8, TOLL: 16, LINK: 32, NOCAR: 64, ISOLATED: 128 };
const UNITS = 4096;

function ensureRawFile(file) {
    const head = Buffer.allocUnsafe(2);
    const fd0 = fs.openSync(file, 'r');
    const br = fs.readSync(fd0, head, 0, 2, 0);
    fs.closeSync(fd0);
    if (br < 2 || head[0] !== 0x1f || head[1] !== 0x8b) return file;
    // Gzipped pack in git repo: unpack once to a hidden .raw sibling (or /tmp fallback) for random-access paging
    const dir = path.dirname(file), base = path.basename(file);
    let raw = path.join(dir, '.' + base + '.raw');
    try {
        const stSrc = fs.statSync(file);
        if (fs.existsSync(raw)) {
            const stRaw = fs.statSync(raw);
            if (stRaw.size > 16 && stRaw.mtimeMs >= stSrc.mtimeMs) return raw;
        }
        const gunzipped = zlib.gunzipSync(fs.readFileSync(file));
        fs.writeFileSync(raw + '.tmp', gunzipped);
        fs.renameSync(raw + '.tmp', raw);
        return raw;
    } catch (e) {
        raw = path.join(require('os').tmpdir(), 'mgu_' + base + '.raw');
        if (!fs.existsSync(raw)) fs.writeFileSync(raw, zlib.gunzipSync(fs.readFileSync(file)));
        return raw;
    }
}

class MapPack {
    static open(file) {
        const rawFile = ensureRawFile(file);
        const fd = fs.openSync(rawFile, 'r');
        return new MapPack(null, file, fd);
    }

    constructor(buf, file, fd) {
        this.file = file || '';
        this.fd = fd != null ? fd : null;
        this._scratch = Buffer.allocUnsafe(64);
        if (this.fd != null) {
            const h0 = this._readBuf(0, 16);
            if (h0.length < 16 || h0.toString('latin1', 0, 4) !== 'OSMP') throw new Error('not a map pack: ' + file);
            const ver = h0.readUInt16LE(4), n = h0.readUInt16LE(6), ml = h0.readUInt32LE(8);
            if (ver !== 1) throw new Error('map pack version ' + ver + ' (this app reads 1): ' + file);
            const h1 = this._readBuf(16, n * 12 + ml);
            this.sec = {};
            for (let i = 0; i < n; i++) {
                const o = i * 12;
                this.sec[h1.toString('latin1', o, o + 4)] = { off: h1.readUInt32LE(o + 4), len: h1.readUInt32LE(o + 8) };
            }
            this.meta = JSON.parse(h1.toString('utf8', n * 12, n * 12 + ml));
        } else {
            if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
            if (buf.byteOffset % 8) { const ab = new ArrayBuffer(buf.length); new Uint8Array(ab).set(buf); buf = Buffer.from(ab); }
            this.buf = buf;
            this.ab = buf.buffer;
            this.base = buf.byteOffset;
            if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'OSMP') throw new Error('not a map pack: ' + file);
            const ver = buf.readUInt16LE(4), n = buf.readUInt16LE(6), ml = buf.readUInt32LE(8);
            if (ver !== 1) throw new Error('map pack version ' + ver + ' (this app reads 1): ' + file);
            this.sec = {};
            for (let i = 0; i < n; i++) {
                const o = 16 + i * 12;
                this.sec[buf.toString('latin1', o, o + 4)] = { off: buf.readUInt32LE(o + 4), len: buf.readUInt32LE(o + 8) };
            }
            this.meta = JSON.parse(buf.toString('utf8', 16 + n * 12, 16 + n * 12 + ml));
        }
        ['STRS', 'NAME', 'TIL0', 'TIL1', 'TIL2', 'GNOD', 'GEDG', 'GGEO', 'GGRD', 'SRCH', 'SKEY', 'STOK'].forEach((s) => {
            if (!this.sec[s]) throw new Error('map pack without section ' + s + ': ' + file);
        });
        this.levels = this.meta.levels;
        this._names = new Map();
        this._tiles = new Map();
        this.maxTiles = 160; // bounded tile cache (a few MB: a heading-up city view needs ~60 tiles of two levels)
        this._dirs = [0, 1, 2].map((lv) => this._dir(lv));
        this.graph = this._graph();
        this.mbox = this.meta.mbox;
    }

    /** Memory is short: the caches down to what the view in front needs (they fill again as it draws). */
    trim() {
        const keep = Math.floor(this.maxTiles / 2);
        while (this._tiles.size > keep) this._tiles.delete(this._tiles.keys().next().value);
        this._names.clear();
        if (this._shapes) this._shapes.clear();
    }

    close() {
        if (this.fd != null) {
            try { fs.closeSync(this.fd); } catch (e) {}
            this.fd = null;
        }
    }

    _readBuf(off, len) {
        if (this.fd == null) return this.buf.slice(off, off + len);
        const ab = new ArrayBuffer(len);
        const b = Buffer.from(ab);
        let got = 0;
        while (got < len) {
            const r = fs.readSync(this.fd, b, got, len - got, off + got);
            if (r <= 0) break;
            got += r;
        }
        return b;
    }

    u32(o) {
        if (this.fd == null) return this.buf.readUInt32LE(o);
        fs.readSync(this.fd, this._scratch, 0, 4, o);
        return this._scratch.readUInt32LE(0);
    }

    _u32a(o, n) {
        if (this.fd == null) return new Uint32Array(this.ab, this.base + o, n);
        const b = this._readBuf(o, n * 4);
        return new Uint32Array(b.buffer, b.byteOffset, n);
    }

    _i32a(o, n) {
        if (this.fd == null) return new Int32Array(this.ab, this.base + o, n);
        const b = this._readBuf(o, n * 4);
        return new Int32Array(b.buffer, b.byteOffset, n);
    }

    /* ---------- names (paged on demand, LRU capped at 1000) ---------- */
    _name(i) {
        let v = this._names.get(i);
        if (v !== undefined) return v;
        const nt = this.sec.NAME.off, st = this.sec.STRS.off;
        if (this._nameCount === undefined) this._nameCount = this.u32(nt);
        if (!i || i >= this._nameCount) v = { local: '', latin: '' };
        else {
            const o = nt + 4 + i * 12;
            let lo, ao, ll, al;
            if (this.fd == null) {
                const b = this.buf;
                lo = b.readUInt32LE(o); ao = b.readUInt32LE(o + 4); ll = b.readUInt16LE(o + 8); al = b.readUInt16LE(o + 10);
                v = { local: fold(b.toString('utf8', st + lo, st + lo + ll)), latin: fold(b.toString('utf8', st + ao, st + ao + al)) };
            } else {
                fs.readSync(this.fd, this._scratch, 0, 12, o);
                lo = this._scratch.readUInt32LE(0); ao = this._scratch.readUInt32LE(4);
                ll = this._scratch.readUInt16LE(8); al = this._scratch.readUInt16LE(10);
                const locStr = ll ? this._readBuf(st + lo, ll).toString('utf8') : '';
                const latStr = al ? (ao === lo && al === ll ? locStr : this._readBuf(st + ao, al).toString('utf8')) : '';
                v = { local: fold(locStr), latin: fold(latStr) };
            }
        }
        if (this._names.size > 8000) this._names.clear();
        this._names.set(i, v);
        return v;
    }

    /** The name in the map language: 'ka' (local script), 'en' (Latin), 'both' (local, Latin when it differs). */
    label(i, lang) {
        if (!i) return '';
        const n = this._name(i);
        if (lang === 'en') return n.latin || n.local;
        if (lang === 'both') return n.latin && n.latin !== n.local ? n.local + ' · ' + n.latin : n.local;
        return n.local || n.latin;
    }
    names(i) { return this._name(i); }

    /* ---------- tiles (directory in RAM, payloads paged on demand) ---------- */
    _dir(lv) {
        const s = this.sec['TIL' + lv];
        const n = this.u32(s.off);
        return { off: s.off, n, keys: this._u32a(s.off + 4, n * 3) };
    }
    /** Is this tile read already (or known empty)? (prefetching asks before it reads) */
    hasTile(lv, col, row) {
        const L = this.levels[lv];
        const c = col - L.col0, r = row - L.row0;
        if (c < 0 || r < 0 || c >= L.cols || r >= L.rows) return true;
        return this._tiles.has(lv * 1e9 + r * L.cols + c);
    }
    /** Tile col, row (absolute, Web Mercator / tile size) of level lv; null when the pack has none there. */
    tile(lv, col, row) {
        const L = this.levels[lv];
        const c = col - L.col0, r = row - L.row0;
        if (c < 0 || r < 0 || c >= L.cols || r >= L.rows) return null;
        const key = r * L.cols + c, ck = lv * 1e9 + key;
        let t = this._tiles.get(ck);
        if (t !== undefined) {
            this._tiles.delete(ck); this._tiles.set(ck, t);
            return t;
        }
        const d = this._dirs[lv], k = d.keys;
        let lo = 0, hi = d.n - 1, at = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1, v = k[mid * 3];
            if (v === key) { at = mid; break; }
            if (v < key) lo = mid + 1; else hi = mid - 1;
        }
        t = at < 0 ? null : this._parse(lv, col, row, d.off + k[at * 3 + 1], k[at * 3 + 2]);
        this._tiles.set(ck, t);
        if (this._tiles.size > this.maxTiles) this._tiles.delete(this._tiles.keys().next().value);
        return t;
    }
    _parse(lv, col, row, o, len) {
        const b = this._readBuf(o, len);
        const ab = b.buffer, base = b.byteOffset;
        const size = this.levels[lv].size;
        const t = { lv, col, row, x0: col * size, y0: row * size, unit: size / UNITS, roads: [], areas: [], lines: [], points: [] };
        const nr = b.readUInt32LE(0), na = b.readUInt32LE(4), nl = b.readUInt32LE(8), np = b.readUInt32LE(12);
        let p = 16;
        for (let i = 0; i < nr && p < len; i++) {
            const n = b.readUInt16LE(p + 12);
            t.roads.push({ cls: b[p], flags: b[p + 1], maxspeed: b[p + 2], layer: b[p + 3], name: b.readUInt32LE(p + 4), ref: b.readUInt32LE(p + 8),
                pts: new Int16Array(ab, base + p + 16, n * 2) });
            p += 16 + n * 4;
        }
        for (let i = 0; i < na && p < len; i++) {
            const n = b.readUInt32LE(p + 4);
            t.areas.push({ kind: b[p], tris: new Int16Array(ab, base + p + 8, n * 6) });
            p += 8 + n * 12;
        }
        for (let i = 0; i < nl && p < len; i++) {
            const n = b.readUInt16LE(p + 2);
            t.lines.push({ kind: b[p], name: b.readUInt32LE(p + 4), pts: new Int16Array(ab, base + p + 8, n * 2) });
            p += 8 + n * 4;
        }
        for (let i = 0; i < np && p < len; i++) {
            t.points.push({ kind: b[p], rank: b[p + 1], x: b.readInt16LE(p + 2), y: b.readInt16LE(p + 4), name: b.readUInt32LE(p + 8) });
            p += 12;
        }
        return t;
    }

    /* ---------- routing graph (compact in-RAM topology; cold attributes on demand) ---------- */
    _graph() {
        const N = this.sec.GNOD.off, E = this.sec.GEDG.off;
        const n = this.u32(N), m = this.u32(E);
        const at = (k) => E + 4 + k * m * 4;
        const x = this._i32a(N + 4, n);
        const y = this._i32a(N + 4 + n * 4, n);
        const first = this._u32a(N + 4 + n * 8, n + 1);
        const target = this._u32a(at(0), m);
        const len = this._u32a(at(1), m);
        // Pack class+flags (2 bytes/edge) and speed+maxspeed (2 bytes/edge) instead of keeping 20 MB of 32-bit columns
        const clsFlags = new Uint16Array(m);
        const speedMax = new Uint16Array(m);
        const infoTmp = this._u32a(at(5), m);
        const speedTmp = this._u32a(at(6), m);
        for (let e = 0; e < m; e++) {
            clsFlags[e] = (infoTmp[e] >>> 16) & 0xffff;
            speedMax[e] = speedTmp[e] & 0xffff;
        }
        return { n, m, x, y, first, target, len, clsFlags, speedMax, edgeBase: E + 4 };
    }

    /** Source node of edge e (CSR: the node whose range holds e). */
    source(e) {
        const f = this.graph.first;
        let lo = 0, hi = this.graph.n - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (f[mid] <= e) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    _edgeU32(col, e) {
        return this.u32(this.graph.edgeBase + (col * this.graph.m + e) * 4);
    }

    edgeName(e) { return e >= 0 ? this._edgeU32(2, e) : 0; }
    edgeRef(e) { return e >= 0 ? this._edgeU32(3, e) : 0; }
    edgeClass(e) { return this.graph.clsFlags[e] & 255; }
    edgeFlags(e) { return (this.graph.clsFlags[e] >>> 8) & 255; }
    edgeSpeed(e) { return this.graph.speedMax[e] & 255; }
    edgeMaxspeed(e) { return (this.graph.speedMax[e] >>> 8) & 255; }

    /**
     * Shape of edge e in Web Mercator metres, from its source to its target: [x0, y0, x1, y1, ...]
     * (paged from GGEO on demand, cached for the last 256 edges asked for).
     */
    shape(e) {
        if (!this._shapes) this._shapes = new Map();
        let s = this._shapes.get(e);
        if (s) return s;
        const g = this.graph, src = this.source(e), dst = g.target[e];
        const geom = this._edgeU32(4, e), info = this._edgeU32(5, e);
        const start = geom & 0x7fffffff, rev = geom >>> 31, cnt = info & 0xffff;
        s = [g.x[src] / 10, g.y[src] / 10];
        if (cnt > 0) {
            const G = this.sec.GGEO.off + 4 + start * 8;
            const b = this._readBuf(G, cnt * 8);
            for (let k = 0; k < cnt; k++) {
                const j = rev ? cnt - 1 - k : k;
                s.push(b.readInt32LE(j * 8) / 10, b.readInt32LE(j * 8 + 4) / 10);
            }
        }
        s.push(g.x[dst] / 10, g.y[dst] / 10);
        if (this._shapes.size > 256) this._shapes.clear();
        this._shapes.set(e, s);
        return s;
    }

    /** The reverse twin of edge e (the same piece of road the other way), or -1 (one-way). */
    twin(e) {
        const g = this.graph, src = this.source(e), dst = g.target[e];
        const geom = this._edgeU32(4, e) & 0x7fffffff, cnt = this._edgeU32(5, e) & 0xffff;
        for (let f = g.first[dst]; f < g.first[dst + 1]; f++) {
            if (f !== e && g.target[f] === src && (this._edgeU32(4, f) & 0x7fffffff) === geom && (this._edgeU32(5, f) & 0xffff) === cnt) return f;
        }
        return -1;
    }

    /** Edge ids with a part within r metres (Web Mercator) of x, y (the forward one of each two-way pair). */
    edgesNear(x, y, r) {
        if (!this._grid) {
            const s = this.sec.GGRD.off, n = this.u32(s);
            this._grid = { n, keys: this._u32a(s + 4, n), first: this._u32a(s + 4 + n * 4, n + 1), idsOff: s + 8 + n * 8 };
        }
        const G = this._grid, gp = this.meta.grid, cell = gp.cell;
        const out = [];
        const c0 = Math.floor((x - r) / cell) - gp.col0, c1 = Math.floor((x + r) / cell) - gp.col0;
        const r0 = Math.floor((y - r) / cell) - gp.row0, r1 = Math.floor((y + r) / cell) - gp.row0;
        const seen = new Set();
        for (let row = r0; row <= r1; row++) {
            for (let col = c0; col <= c1; col++) {
                if (col < 0 || row < 0 || col >= gp.cols) continue;
                const key = row * gp.cols + col;
                let lo = 0, hi = G.n - 1, at = -1;
                while (lo <= hi) {
                    const mid = (lo + hi) >> 1, v = G.keys[mid];
                    if (v === key) { at = mid; break; }
                    if (v < key) lo = mid + 1; else hi = mid - 1;
                }
                if (at < 0) continue;
                const f0 = G.first[at], cnt = G.first[at + 1] - f0;
                if (cnt <= 0) continue;
                const b = this._readBuf(G.idsOff + f0 * 4, cnt * 4);
                for (let k = 0; k < cnt; k++) {
                    const e = b.readUInt32LE(k * 4);
                    if (!seen.has(e)) { seen.add(e); out.push(e); }
                }
            }
        }
        return out;
    }

    /** Is x, y (Web Mercator metres) inside the pack's area (with a margin)? */
    covers(x, y, margin) {
        const b = this.mbox, m = margin || 0;
        return x >= b[0] - m && x <= b[2] + m && y >= b[1] - m && y <= b[3] + m;
    }

    /* ---------- on-demand zero-RAM search helpers ---------- */
    _initSearchMeta() {
        if (this._smeta) return this._smeta;
        const S = this.sec.SRCH.off, K = this.sec.SKEY.off, T = this.sec.STOK.off;
        const n = this.u32(S), nt = this.u32(T);
        this._smeta = {
            n, nt,
            srchOff: S + 4,
            skeyOffs: K + 4,
            skeyBase: K + 8 + (n + 1) * 4 - 4,
            stokOff: T + 4,
            postOff: T + 4 + nt * 16,
            textOff: T + this.meta.tokenText,
        };
        return this._smeta;
    }

    searchCount() {
        return this._initSearchMeta().n;
    }

    searchEntry(i) {
        const m = this._initSearchMeta();
        const b = this._readBuf(m.srchOff + i * 20, 20);
        return {
            i,
            name: b.readUInt32LE(0),
            ctx: b.readUInt32LE(4),
            kind: b[8],
            rank: b[9],
            x: b.readInt32LE(12) / 10,
            y: b.readInt32LE(16) / 10,
        };
    }

    searchKey(i) {
        const m = this._initSearchMeta();
        const b = this._readBuf(m.skeyOffs + i * 4, 8);
        const o0 = b.readUInt32LE(0), o1 = b.readUInt32LE(4);
        return o1 > o0 ? this._readBuf(m.skeyBase + o0, o1 - o0).toString('utf8') : '';
    }

    _tokenAt(idx) {
        const m = this._initSearchMeta();
        const b = this._readBuf(m.stokOff + idx * 16, 16);
        const toff = b.readUInt32LE(0), tlen = b.readUInt16LE(4);
        const tf = b.readUInt32LE(8), tc = b.readUInt32LE(12);
        const word = tlen ? this._readBuf(m.textOff + toff, tlen).toString('utf8') : '';
        return { word, tf, tc };
    }

    /** Entries whose search text contains q anywhere (a substring), at most max: the key table read once. */
    searchScan(q, max) {
        const m = this._initSearchMeta();
        const offs = this._u32a(m.skeyOffs, m.n + 1);
        const blob = this._readBuf(m.skeyBase, offs[m.n]);
        const needle = Buffer.from(q, 'utf8'), out = [];
        let at = blob.indexOf(needle);
        while (at >= 0 && out.length < (max || 300)) {
            // the entry whose key holds byte `at`
            let lo = 0, hi = m.n - 1;
            while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offs[mid] <= at) lo = mid; else hi = mid - 1; }
            if (!out.length || out[out.length - 1] !== lo) out.push(lo);
            at = blob.indexOf(needle, offs[lo + 1]);
        }
        return out;
    }

    /** Binary search on-disk STOK for tokens starting with w; returns matching entry IDs. */
    searchPrefix(w) {
        const m = this._initSearchMeta();
        let lo = 0, hi = m.nt;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            const tok = this._tokenAt(mid);
            if (tok.word < w) lo = mid + 1; else hi = mid;
        }
        const out = [];
        for (let i = lo; i < m.nt && out.length < 4000; i++) {
            const tok = this._tokenAt(i);
            if (tok.word.indexOf(w) !== 0) break;
            if (tok.tc > 0) {
                const cnt = Math.min(tok.tc, 4000 - out.length);
                const pb = this._readBuf(m.postOff + tok.tf * 4, cnt * 4);
                for (let k = 0; k < cnt; k++) out.push(pb.readUInt32LE(k * 4));
            }
        }
        return out;
    }
}

/** Latin letters with accents as plain ones (the fonts' Latin is ASCII); other scripts untouched. */
function fold(t) {
    return /[À-ɏ]/.test(t) ? t.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss') : t;
}

/* ---------- Web Mercator ---------- */
const R = 6378137;
function merc(lat, lon) {
    lat = Math.max(-85, Math.min(85, lat));
    return [R * lon * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
}
function unmerc(x, y) { return [(2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI, x / R * 180 / Math.PI]; }
/** metres on the ground per Web Mercator metre at y */
function groundScale(y) { return Math.cos(2 * Math.atan(Math.exp(y / R)) - Math.PI / 2); }

module.exports = { MapPack, F, UNITS, merc, unmerc, groundScale, fold };
