'use strict';
/**
 * navkey.js - recognise the console's NAV button, so Navigation can open itself when it is pressed. Node 8.
 *
 * Nothing here blocks or changes a button: the HMI always gets NAV as well (the stock screen opens, and
 * this app's screen is opened over it). With the app not running, NAV works exactly as stock.
 *
 * A button event is a sample: { key: value } pairs. From the controller gate's read-only feed (raw
 * FrontCCU 0x8001 payload) the pairs are the bytes ("0" -> "01", "1" -> "a4", ...) and the length; from a
 * SOME/IP field, the flattened fields of its value ("button" -> "NAVI", "state" -> "PRESSED", ...).
 *
 * A pattern is the pairs that must all be there: "len=6 1=a4 2=01" (bytes), "button=NAVI" (fields). The
 * hand-written form "xx a4 01 xx xx xx" (hex bytes, xx = any) is accepted too.
 *
 * Learning: the person presses NAV three times; the samples of the most common shape are kept, and the
 * pairs that are the same in all of them (not a sequence counter, not a time) become the pattern. A pattern
 * that pins down too little (it would take other buttons for NAV) is refused.
 */

/** "0012a401" (payload hex) -> sample { len: '4', 0: '00', 1: '12', 2: 'a4', 3: '01' } */
function fromHex(hex) {
    const h = String(hex || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    const s = { len: String(h.length >> 1) };
    for (let i = 0; i + 1 < h.length; i += 2) s[String(i >> 1)] = h.slice(i, i + 2);
    return s;
}

/** a SOME/IP value -> sample: its scalar fields by dotted path (at most 64, 4 levels deep) */
function fromValue(v) {
    const s = {};
    let n = 0;
    const walk = (o, p, d) => {
        if (n >= 64 || d > 4) return;
        if (o === null || o === undefined) return;
        if (typeof o !== 'object') { s[p || 'value'] = String(o); n++; return; }
        Object.keys(o).forEach((k) => walk(o[k], p ? p + '.' + k : k, d + 1));
    };
    walk(v, '', 0);
    return s;
}

/** pattern text -> [[key, value], ...] (null for an empty or unreadable one) */
function parse(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (/^(xx|[0-9a-f]{2})(\s+(xx|[0-9a-f]{2}))*$/i.test(t)) {
        // "xx a4 01": byte positions from 0, xx = any
        const out = [];
        t.split(/\s+/).forEach((b, i) => { if (!/^xx$/i.test(b)) out.push([String(i), b.toLowerCase()]); });
        return out.length ? out : null;
    }
    const out = [];
    t.split(/\s+/).forEach((kv) => {
        const i = kv.indexOf('=');
        if (i > 0) out.push([kv.slice(0, i), kv.slice(i + 1)]);
    });
    return out.length ? out : null;
}

function format(pairs) { return (pairs || []).map((p) => p[0] + '=' + p[1]).join(' '); }

/** does sample s have every pair of the pattern? */
function matches(pairs, s) {
    if (!pairs || !pairs.length || !s) return false;
    for (const p of pairs) if (s[p[0]] !== p[1]) return false;
    return true;
}

/**
 * The pattern of samples (the most common shape, at least `min` of them): { pairs, text } or { error }.
 * Refused when fewer than 2 pairs, or fewer than half of the sample's pairs, stay fixed.
 */
function learn(samples, min) {
    min = min || 3;
    const groups = {};
    samples.forEach((s) => {
        const shape = Object.keys(s).sort().join(',') + '|' + (s.len || '');
        (groups[shape] = groups[shape] || []).push(s);
    });
    const best = Object.keys(groups).map((k) => groups[k]).sort((a, b) => b.length - a.length)[0];
    if (!best || best.length < min) return { error: 'few', count: best ? best.length : 0 };
    const keys = Object.keys(best[0]);
    const pairs = keys.filter((k) => best.every((s) => s[k] === best[0][k])).map((k) => [k, best[0][k]]);
    // raw bytes: at least two fixed bytes besides the length; a SOME/IP value: one fixed field (its button id) will do
    const bytes = keys.every((k) => k === 'len' || /^\d+$/.test(k));
    const informative = pairs.filter((p) => !(bytes && p[0] === 'len'));
    if (informative.length < (bytes ? 2 : 1) || pairs.length * 2 < keys.length) return { error: 'vague', count: best.length };
    return { pairs, text: format(pairs), count: best.length };
}

module.exports = { fromHex, fromValue, parse, format, matches, learn };
