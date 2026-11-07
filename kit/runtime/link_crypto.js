'use strict';
/**
 * link_crypto.js - the phone <-> car link's message security (Node 8).
 *
 * The pairing key K (32 random bytes, in the car and in the QR code's #k= fragment) protects
 * both directions on the public ntfy.sh channel, with a different key per direction:
 *   phone -> car   AES-256-GCM with K itself (the original format, so older pages still pair)
 *   car -> phone   AES-256-GCM with HKDF-SHA256(K, info "idrive7 car->phone v1")
 * A message the car sends can never be taken for one the phone sent (it would not decrypt),
 * and nothing on the channel is acted on unless it authenticates.
 *
 * Replays: anyone who knows a channel name can post an old ciphertext again. Every message
 * carries its own send time (inside the encryption), and ntfy stamps when it really arrived:
 * a message whose inner time is more than FRESH_MS away from its ntfy time is a re-post, and
 * one seen before (same IV) is dropped too. The car's own clock is never used for this.
 */
let crypto;
try { crypto = require('crypto'); } catch (e) { crypto = null; }

const FRESH_MS = 15 * 60 * 1000;
const C2P_INFO = 'idrive7 car->phone v1';

function hmac(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest();
}

/** RFC 5869 HKDF-SHA256 with an empty salt, up to 32 bytes. */
function hkdf(ikm, info, len) {
    const prk = hmac(Buffer.alloc(0), ikm);
    return hmac(prk, Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([1])])).slice(0, len || 32);
}

function keyBytes(keyHex) {
    if (typeof keyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(keyHex)) return null;
    return Buffer.from(keyHex, 'hex');
}

/** The car -> phone key for a pairing key (hex). */
function carToPhoneKey(keyHex) {
    const k = keyBytes(keyHex);
    return k ? hkdf(k, C2P_INFO, 32) : null;
}

/** A random hex string of n bytes. */
function nonce(n) {
    return crypto.randomBytes(n || 12).toString('hex');
}

/**
 * Encrypt obj for the phone: { type: wireType, iv, tag, data } (hex), or null without crypto/key.
 * obj gets its send time and a random nonce, inside the encryption.
 */
function sealForPhone(keyHex, wireType, obj) {
    if (!crypto) return null;
    const key = carToPhoneKey(keyHex);
    if (!key) return null;
    const body = Object.assign({}, obj, { time: Date.now(), n: nonce(8) });
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(body), 'utf8'), c.final()]);
    return { type: wireType, iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') };
}

/** Decrypt a phone -> car message ({ iv, tag, data } hex) with the pairing key; null if it doesn't authenticate. */
function openFromPhone(keyHex, wire) {
    if (!crypto || !wire || typeof wire.data !== 'string' || typeof wire.iv !== 'string' || typeof wire.tag !== 'string') return null;
    const key = keyBytes(keyHex);
    if (!key || !/^[0-9a-f]*$/i.test(wire.data) || wire.data.length % 2) return null;
    const iv = Buffer.from(wire.iv, 'hex'), tag = Buffer.from(wire.tag, 'hex');
    // Node 8 accepts truncated GCM tags; only a full 128-bit tag authenticates
    if (iv.length !== 12 || tag.length !== 16) return null;
    try {
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(tag);
        const text = d.update(wire.data, 'hex', 'utf8') + d.final('utf8');
        const obj = JSON.parse(text);
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
    } catch (e) {
        return null;
    }
}

/**
 * Fresh-message check for one channel: inner send time within FRESH_MS of the ntfy arrival
 * time (seconds), and an IV not seen before. Remembers the last 256 IVs.
 */
class Freshness {
    constructor() { this.seen = []; }
    reset() { this.seen = []; }
    accept(inner, wire, ntfyTimeSec) {
        if (!inner || typeof inner.time !== 'number' || !isFinite(inner.time)) return false;
        if (typeof ntfyTimeSec !== 'number' || !isFinite(ntfyTimeSec)) return false;
        if (Math.abs(inner.time - ntfyTimeSec * 1000) > FRESH_MS) return false;
        const iv = String(wire && wire.iv).toLowerCase();
        if (this.seen.indexOf(iv) >= 0) return false;
        this.seen.push(iv);
        if (this.seen.length > 256) this.seen.shift();
        return true;
    }
}

/** The channel name rules: <prefix><24 hex> (96 random bits). */
function validChannel(ch, prefix) {
    return typeof ch === 'string' && ch.length === prefix.length + 24 && ch.indexOf(prefix) === 0 && /^[0-9a-f]{24}$/.test(ch.slice(prefix.length));
}

module.exports = { hkdf, carToPhoneKey, sealForPhone, openFromPhone, Freshness, validChannel, nonce, FRESH_MS, C2P_INFO };
