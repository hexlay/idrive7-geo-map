'use strict';
/**
 * relay_stream.js - one long-lived subscription to an ntfy.sh channel instead of polling it.
 *
 * ntfy.sh limits requests per internet address (a burst of 60, then one every 5 s). A car, an
 * emulator and the phone often share one address, and polling every few seconds used that up:
 * the phone's sends were then refused (Safari: "Load failed"). A stream is one request: ntfy
 * keeps it open, sends each message as it arrives and a keepalive about every 45 s.
 *
 *   const s = new RelayStream({ get: tlsDates.get, log });
 *   s.start(channel, since, onItem, onTime)   since: a message id, 'all', a unix time or null
 *   s.stop()
 * onItem(item) for every ntfy message event ({ id, time, message, ... }); onTime(ms) with the
 * relay's clock (its Date header and each event's time). A dropped stream reconnects (3 s,
 * doubling to 60 s; 60 s after a 429) from the last message seen, so nothing is missed or
 * delivered twice. A stream silent for 110 s (no keepalive) is taken as dead and reopened.
 */
const HOST = 'ntfy.sh';
const SILENT_MS = 110 * 1000;
const MAX_LINE = 64 * 1024;

class RelayStream {
    constructor(opts) {
        this.get = opts.get;
        this.log = opts.log || console;
        this.want = null;
        this.req = null;
        this.retryTimer = null;
        this.watchdog = null;
        this.backoff = 3000;
        this.lastData = 0;
        this.openedAt = 0;          // when the current subscription first opened (for "history" decisions)
        this.connects = 0;
    }

    start(channel, since, onItem, onTime) {
        this.stop();
        this.want = { channel, since: since === undefined ? null : since, onItem, onTime };
        this.backoff = 3000;
        this.openedAt = 0;
        this._connect();
        this.watchdog = setInterval(() => {
            if (this.req && this.lastData && Date.now() - this.lastData > SILENT_MS) {
                this.log.warn('relay: no keepalive for ' + Math.round(SILENT_MS / 1000) + ' s: reconnecting');
                this._restart();
            }
        }, 30000);
    }

    stop() {
        this.want = null;
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
        this._drop(true);
    }

    get running() { return !!this.want; }

    _drop(quiet) {
        const r = this.req;
        this.req = null;
        if (r) { r._dropped = !!quiet || r._dropped; try { r.destroy(); } catch (e) { /* gone */ } }
    }

    /** Drop the current stream and reconnect after the backoff. */
    _restart() {
        this._drop(true);
        this._retry();
    }

    _retry(ms) {
        if (!this.want || this.retryTimer) return;
        const delay = ms || this.backoff;
        this.backoff = Math.min(this.backoff * 2, 60000);
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this._connect(); }, delay);
    }

    _connect() {
        const w = this.want;
        if (!w || this.req) return;
        const q = w.since !== null && w.since !== '' ? '?since=' + encodeURIComponent(String(w.since)) : '';
        let req;
        const ended = () => {
            if (this.req !== req) return;          // replaced or stopped
            this.req = null;
            this._retry();
        };
        try {
            req = this.get({ hostname: HOST, port: 443, path: '/' + w.channel + '/json' + q, timeout: 100000 }, (res) => {
                const date = Date.parse(res.headers && res.headers.date);
                if (isFinite(date) && w.onTime) w.onTime(date);
                if (res.statusCode !== 200) {
                    res.resume();
                    if (this.req === req) this.req = null;
                    this.log.warn('relay: subscription answered ' + res.statusCode);
                    this._retry(res.statusCode === 429 ? 60000 : 0);
                    return;
                }
                this.connects++;
                if (!this.openedAt) this.openedAt = Date.now();
                this.lastData = Date.now();
                this.backoff = 3000;
                let buf = '';
                if (res.setEncoding) res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    if (this.req !== req || this.want !== w) return;
                    this.lastData = Date.now();
                    buf += chunk;
                    let i;
                    while ((i = buf.indexOf('\n')) >= 0) {
                        const line = buf.slice(0, i).trim();
                        buf = buf.slice(i + 1);
                        if (!line) continue;
                        let item;
                        try { item = JSON.parse(line); } catch (e) { continue; }
                        if (!item || typeof item !== 'object') continue;
                        if (typeof item.time === 'number' && w.onTime) w.onTime(item.time * 1000);
                        if (item.event !== 'message') continue;
                        if (typeof item.id === 'string') w.since = item.id;     // a reconnect resumes after it
                        try { w.onItem(item); } catch (e) { this.log.warn('relay: message handler: ' + e.message); }
                        if (this.want !== w) return;                            // the handler stopped or moved the stream
                    }
                    if (buf.length > MAX_LINE) { this.log.warn('relay: oversized line: reconnecting'); this._restart(); }
                });
                res.on('end', ended);
                res.on('close', ended);
                res.on('error', ended);
            });
        } catch (e) {
            this.log.warn('relay: ' + e.message);
            this._retry();
            return;
        }
        this.req = req;
        req.on('error', () => { if (!req._dropped) ended(); });
        req.on('timeout', () => { try { req.destroy(); } catch (e) { /* gone */ } ended(); });
    }
}

module.exports = { RelayStream };
