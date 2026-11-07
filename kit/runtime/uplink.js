'use strict';
/**
 * uplink.js - name resolution and connectivity for apps that get internet through
 * the MGU Store's mgu-uplink (package.json "mguInternet": true).
 *
 * The contract (mgu-store native/mgu-uplink/README.md): only the allowed apps' uids are
 * routed out through the uplink, and the unit's own resolver does NOT reach the internet;
 * allowed processes resolve names through the lease's `dns` servers. The lease is
 *   <data dir>/uplink.json            for each allowed app
 *   /run/mgu-uplink/lease.json        for everyone
 * { interface, ip, prefix, router, dns[], leaseSeconds, updated }, present only while online.
 * The store's own updater does the same (mgu-updater js/fetch.js lookupVia()).
 *
 * init() replaces dns.lookup process-wide, so every http/https request of the app resolves
 * through those servers (public resolvers as a fallback, then the unit's resolver).
 * Node 8: dns.Resolver has no timeout option, so each lookup gets its own timer.
 */
const dns = require('dns');
const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');

const PUBLIC_DNS = ['1.1.1.1', '8.8.8.8'];
const LOOKUP_TIMEOUT_MS = 12000;    // per resolve4/resolve6; c-ares waits 5 s per server, so one failover fits
const CACHE_MAX = 256;
const CACHE_MIN_MS = 30 * 1000, CACHE_MAX_MS = 5 * 60 * 1000;
const SYSTEM_LEASE = '/run/mgu-uplink/lease.json';

let initialized = false;
let appDataDir = null;
const origLookup = dns.lookup;
let resolver = null, resolverKey = '';
const cache = new Map();             // hostname|family -> { list: [{address, family}], expires }
let leaseMemo = null, leaseMemoAt = 0;

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

/** The app's own lease (only present when mgu-uplink routes this app and is online). */
function getOwnLease() {
    return appDataDir ? readJson(path.join(appDataDir, 'uplink.json')) : null;
}

/** Any lease (own first, then the system-wide one), memoised for 2 s. */
function getLease() {
    const now = Date.now();
    if (now - leaseMemoAt < 2000) return leaseMemo;
    leaseMemoAt = now;
    leaseMemo = getOwnLease() || readJson(SYSTEM_LEASE);
    return leaseMemo;
}

function getActiveDnsServers() {
    const lease = getLease();
    const out = [];
    if (lease && Array.isArray(lease.dns)) lease.dns.forEach((ip) => { if (net.isIP(ip) && out.indexOf(ip) < 0) out.push(ip); });
    PUBLIC_DNS.forEach((ip) => { if (out.indexOf(ip) < 0) out.push(ip); });
    return out;
}

/** A resolver on the current servers; a server change (new network) also drops the cache. */
function getResolver() {
    if (typeof dns.Resolver !== 'function') return null;
    const servers = getActiveDnsServers();
    const key = servers.join(',');
    if (!resolver || key !== resolverKey) {
        try {
            const r = new dns.Resolver();
            r.setServers(servers);
            resolver = r;
            if (resolverKey) cache.clear();
            resolverKey = key;
        } catch (e) { /* keep the previous one */ }
    }
    return resolver;
}

/** resolve4/resolve6 with a deadline; cb(err, addresses). */
function resolveWithTimeout(r, family, hostname, cb) {
    let done = false;
    const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { r.cancel(); } catch (e) {}
        const err = new Error('queryA ETIMEOUT ' + hostname);
        err.code = 'ETIMEOUT';
        cb(err);
    }, LOOKUP_TIMEOUT_MS);
    const fn = family === 6 ? r.resolve6 : r.resolve4;
    fn.call(r, hostname, { ttl: true }, (err, recs) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) return cb(err);
        cb(null, (recs || []).map((x) => ({ address: typeof x === 'string' ? x : x.address, family, ttl: x && x.ttl })));
    });
}

function cachePut(key, list) {
    const ttl = list.reduce((m, x) => (typeof x.ttl === 'number' ? Math.min(m, x.ttl * 1000) : m), CACHE_MAX_MS);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { list: list.map((x) => ({ address: x.address, family: x.family })), expires: Date.now() + Math.max(CACHE_MIN_MS, Math.min(CACHE_MAX_MS, ttl)) });
}

function answer(list, opts, cb) {
    if (opts.all) return cb(null, list.map((x) => ({ address: x.address, family: x.family })));
    cb(null, list[0].address, list[0].family);
}

function notFound(hostname, cause) {
    const err = new Error('getaddrinfo ENOTFOUND ' + hostname);
    err.code = 'ENOTFOUND'; err.errno = 'ENOTFOUND'; err.syscall = 'getaddrinfo'; err.hostname = hostname;
    if (cause) err.cause = cause;
    return err;
}

/** dns.lookup replacement (same signature and callback shapes). */
function patchedLookup(hostname, options, callback) {
    let cb = callback, opts = options;
    if (typeof options === 'function') { cb = options; opts = {}; }
    else if (typeof options === 'number') opts = { family: options };
    else if (!opts || typeof opts !== 'object') opts = {};
    const family = opts.family === 6 ? 6 : opts.family === 4 ? 4 : 0;

    const ipFam = typeof hostname === 'string' ? net.isIP(hostname) : 0;
    if (ipFam) return process.nextTick(() => answer([{ address: hostname, family: ipFam }], opts, cb));
    if (!hostname || typeof hostname !== 'string' || hostname === 'localhost' || /\.local$/i.test(hostname)) {
        return origLookup(hostname, opts, cb);
    }
    const r = getResolver();
    if (!r) return origLookup(hostname, opts, cb);

    const key = hostname.toLowerCase() + '|' + family;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return process.nextTick(() => answer(hit.list, opts, cb));

    const fallback = (cause) => origLookup(hostname, opts, (err, address, fam) => {
        if (err) return cb(cause && err.code === 'ENOTFOUND' ? notFound(hostname, cause) : err);
        const list = opts.all ? address.map((x) => ({ address: x.address, family: x.family })) : [{ address, family: fam }];
        if (list.length) cachePut(key, list);
        if (opts.all) return cb(null, list);
        cb(null, address, fam);
    });
    const order = family === 6 ? [6] : family === 4 ? [4] : [4, 6];
    const tryNext = (i, lastErr) => {
        if (i >= order.length) return fallback(lastErr);
        resolveWithTimeout(r, order[i], hostname, (err, list) => {
            if (err || !list.length) return tryNext(i + 1, err);
            cachePut(key, list);
            answer(list, opts, cb);
        });
    };
    tryNext(0, null);
}

function init(dataDir) {
    if (dataDir) appDataDir = dataDir;
    if (initialized) return;
    initialized = true;
    dns.lookup = patchedLookup;
}

/** HEAD over HTTPS; resolves true once any HTTP response arrives. No secrets are sent. */
function probe(host, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        let req;
        try {
            req = https.request({ hostname: host, port: 443, path: '/', method: 'HEAD', timeout: timeoutMs, rejectUnauthorized: false }, (res) => { res.resume(); done(true); });
        } catch (e) { return done(false); }
        req.on('error', () => done(false));
        req.on('timeout', () => { req.abort(); done(false); });
        req.end();
    });
}

/**
 * Internet reachable for this app: an HTTPS answer from a public address (no DNS needed),
 * or from a named host through the uplink resolver. A DNS answer alone does not count
 * (captive portals and networks that block 443 still answer DNS).
 */
async function checkInternet(opts) {
    const timeout = (opts && opts.timeout) || 3500;
    if (await probe('1.1.1.1', timeout)) return true;
    if (await probe('8.8.8.8', timeout)) return true;
    if (await probe('www.google.com', timeout + LOOKUP_TIMEOUT_MS)) return true;
    return false;
}

/** Online per this app's own lease file (the system-wide lease says nothing about this app's routing). */
function isOnlineSync() {
    const lease = getOwnLease();
    return !!(lease && lease.ip);
}

function describe() {
    const own = getOwnLease();
    if (own && own.ip) return 'lease ' + own.ip + ' via ' + (own.interface || '?') + ' router ' + own.router + '; dns ' + getActiveDnsServers().join(',');
    const sys = readJson(SYSTEM_LEASE);
    return 'no lease in ' + appDataDir + ' (' + (sys && sys.ip ? 'uplink is online but this app is not routed: is it in apps.d?' : 'uplink offline or not installed') + '); dns ' + getActiveDnsServers().join(',');
}

module.exports = { init, checkInternet, isOnlineSync, getLease, getActiveDnsServers, describe, dnsCache: cache, _patchedLookup: patchedLookup };
