'use strict';
/**
 * crclient.js - a small client for cluster-render, the MGU Store service that draws apps' layers on the instrument
 * cluster and the head-up display (robertnisipeanu/idrive-apps, native/cluster-render). Written from its
 * PROTOCOL.md (version 1, MPL-2.0 documentation); none of the service's own client code is used. Node 8.
 *
 * What it does, and no more: one stream socket (/dev/shm/cluster-render/render.sock), "hello", image layers, their
 * pixels sent whole (straight-alpha RGBA rows), "set", "drop", "status"; the service's events read back. It
 * connects again by itself (2 s, doubling to 30 s) and makes its layers again with their last pixels. Nothing is
 * read or written anywhere else. Never throws: an app that exits twice is removed by MainApp.
 *
 * Message framing (both ways): u32 length (little-endian: the bytes after it) | u8 type | body.
 *   J (0x4A) a flat JSON object; F (0x46) u32 ref, u64 frame id, u16 rect count (0: the whole image), pixels.
 *
 *   const cr = new ClusterRender('osm_nav', log).start();
 *   cr.on('ready', (hello) => ...)            hello.targets: "map:1088x480,panel:1920x720,hud:800x480" (iDrive 7)
 *   cr.on('layer', ({ ref, state, reason }))   shown, waiting, suspended, stalled, hidden, error
 *   cr.on('target', ({ target, state, holder, disabled }))
 *   cr.on('refused', ({ op, ref, reason }))   (cluster-render's "error" event; an EventEmitter "error" would throw)
 *   cr.on('unsupported', (text))              "not supported on this car (head unit: ...)": it stays quiet after
 *   const ref = cr.image({ target: 'hud', class: 'overlay', z: 5, x, y, w, h, iw, ih, fps: 5 });
 *   cr.pixels(ref, buf)                       buf: iw * ih * 4 bytes; kept, and sent again after a reconnect
 *   cr.set(ref, { visible: 0 }); cr.drop(ref); cr.close();
 */
const fs = require('fs');
const net = require('net');
const EventEmitter = require('events');

const SOCK = '/dev/shm/cluster-render/render.sock';
const MAX_MSG = 5529664;              // a whole 1920x720 RGBA image (PROTOCOL.md)
const MAX_BUF = 1 << 20;              // events waiting: more is not this client's to keep

class ClusterRender extends EventEmitter {
    /** opts: { path (the socket), check (false: connect without looking for the socket file first: tests) } */
    constructor(app, log, opts) {
        super();
        this.app = app;
        this.log = log || { info() {}, warn() {} };
        this.path = (opts && opts.path) || process.env.CLUSTER_RENDER_SOCK || SOCK;
        this.check = !(opts && opts.check === false);
        this.layers = new Map();      // ref -> { spec, px (Buffer or null) }
        this.nextRef = 1;
        this.fid = 1;
        this.s = null;
        this.buf = Buffer.alloc(0);
        this.ready = false;
        this.closed = false;
        this.busy = false;            // the socket's buffer is full: frames wait for 'drain' (only the newest is sent)
        this.retry = null;
        this.backoff = 2000;
        this.targets = '';
        this.backend = '';
        this.unsupported = '';
        this.said = {};
    }

    start() { this._connect(); return this; }

    _say(key, text) { if (this.said[key]) return; this.said[key] = true; this.log.info('cluster-render: ' + text); }

    _connect() {
        if (this.closed || this.s || this.unsupported) return;
        if (this.check) {
            let there = false;
            try { there = fs.existsSync(this.path); } catch (e) { there = false; }
            if (!there) { this._say('absent', 'not installed (no ' + this.path + '): looking again now and then'); this._later(); return; }
        }
        let s;
        try { s = net.createConnection(this.path); } catch (e) { this._later(); return; }
        this.s = s;
        s.on('connect', () => {
            this.backoff = 2000;
            this._send({ op: 'hello', app: this.app, proto: 1 });
            // no hello within 3 s: a head unit the service refuses answers a status request with why
            clearTimeout(this.helloTimer);
            this.helloTimer = setTimeout(() => { if (!this.ready && this.s === s) this._send({ op: 'status' }); }, 3000);
            if (this.helloTimer.unref) this.helloTimer.unref();
        });
        s.on('data', (d) => { try { this._data(d); } catch (e) { this.log.warn('cluster-render: ' + e.message); try { s.destroy(); } catch (e2) { /* gone */ } } });
        s.on('drain', () => { this.busy = false; this._flush(); });
        s.on('error', (e) => this._say('err:' + e.code, 'socket: ' + e.message));
        s.on('close', () => {
            if (this.s !== s) return;
            this.s = null;
            const was = this.ready;
            this.ready = false; this.busy = false; this.buf = Buffer.alloc(0);
            clearTimeout(this.helloTimer);
            if (was) { this.log.info('cluster-render: connection closed'); this.emit('down'); }
            this._later();
        });
    }

    _later() {
        if (this.closed || this.retry || this.unsupported) return;
        this.retry = setTimeout(() => { this.retry = null; this._connect(); }, this.backoff);
        if (this.retry.unref) this.retry.unref();
        this.backoff = Math.min(30000, this.backoff * 2);
    }

    _data(d) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
        if (this.buf.length > MAX_BUF) throw new Error('more than 1 MiB of events unread');
        while (this.buf.length >= 5) {
            const n = this.buf.readUInt32LE(0);
            if (n < 1 || n > MAX_MSG) throw new Error('a message of ' + n + ' bytes');
            if (this.buf.length < 4 + n) break;
            const type = this.buf[4], body = this.buf.slice(5, 4 + n);
            this.buf = this.buf.slice(4 + n);
            if (type !== 0x4A) continue;                 // (the service sends JSON only)
            let m = null;
            try { m = JSON.parse(body.toString('utf8')); } catch (e) { m = null; }
            if (m && typeof m === 'object') this._event(m);
        }
    }

    _event(m) {
        if (m.ev === 'hello') {
            this.ready = true;
            this.targets = String(m.targets || '');
            this.backend = String(m.backend || '');
            this.log.info('cluster-render: connected (' + (this.backend || '?') + ', ' + this.targets + ')');
            this.layers.forEach((L, ref) => this._make(ref, L));
            this.emit('ready', m);
        } else if (m.ev === 'status') {
            const text = String(m.text || '');
            if (!this.ready && /not supported/i.test(text)) {
                this.unsupported = text;
                this.log.info('cluster-render: ' + text.split('\n')[0]);
                this.emit('unsupported', text);
                try { if (this.s) this.s.destroy(); } catch (e) { /* gone */ }
            } else this.emit('status', text);
        } else if (m.ev === 'layer') this.emit('layer', m);
        else if (m.ev === 'target') this.emit('target', m);
        else if (m.ev === 'budget') this.emit('budget', m);
        else if (m.ev === 'error') this.emit('refused', m);
    }

    _write(bufs) {
        if (!this.s || !this.ready && bufs[0][4] !== 0x4A) return false;
        try {
            const ok = this.s.write(bufs.length === 1 ? bufs[0] : Buffer.concat(bufs));
            if (!ok) this.busy = true;
            return true;
        } catch (e) { return false; }
    }

    _send(obj) {
        const j = Buffer.from(JSON.stringify(obj), 'utf8'), h = Buffer.alloc(5);
        h.writeUInt32LE(j.length + 1, 0);
        h[4] = 0x4A;
        return this._write([h, j]);
    }

    _frame(ref, px) {
        const h = Buffer.alloc(19);
        h.writeUInt32LE(1 + 4 + 8 + 2 + px.length, 0);
        h[4] = 0x46;
        h.writeUInt32LE(ref, 5);
        h.writeUInt32LE(this.fid >>> 0, 9);              // u64 frame id: low word, then 0
        h.writeUInt32LE(0, 13);
        h.writeUInt16LE(0, 17);                          // no rects: the whole image
        this.fid = (this.fid + 1) >>> 0 || 1;
        return this._write([h, px]);
    }

    _make(ref, L) {
        const msg = Object.assign({ op: 'layer', ref, kind: 'image' }, L.spec);
        if (!this._send(msg)) return;
        L.dirty = !!L.px;
        this._flush();
    }

    /** Send the newest pixels of every layer that has some waiting (not while the socket's buffer is full). */
    _flush() {
        if (!this.ready || this.busy) return;
        this.layers.forEach((L, ref) => {
            if (!L.dirty || !L.px || this.busy) return;
            if (this._frame(ref, L.px)) L.dirty = false;
        });
    }

    /** A new image layer (kept, and made again after a reconnect): its ref. */
    image(spec) {
        const ref = this.nextRef++;
        const L = { spec: Object.assign({}, spec), px: null, dirty: false };
        this.layers.set(ref, L);
        if (this.ready) this._make(ref, L);
        return ref;
    }

    pixels(ref, px) {
        const L = this.layers.get(ref);
        if (!L) return;
        L.px = px; L.dirty = true;
        this._flush();
    }

    set(ref, fields) {
        const L = this.layers.get(ref);
        if (!L) return;
        Object.assign(L.spec, fields);
        if (this.ready) this._send(Object.assign({ op: 'set', ref }, fields));
    }

    drop(ref) {
        if (!this.layers.has(ref)) return;
        this.layers.delete(ref);
        if (this.ready) this._send({ op: 'drop', ref });
    }

    status() { return this.ready ? this._send({ op: 'status' }) : false; }

    close() {
        this.closed = true;
        clearTimeout(this.retry); this.retry = null;
        clearTimeout(this.helloTimer);
        this.layers.clear();
        const s = this.s;
        this.s = null; this.ready = false;
        if (s) { try { s.end(); s.destroy(); } catch (e) { /* gone */ } }
        this.removeAllListeners();
    }
}

module.exports = { ClusterRender, SOCK };
