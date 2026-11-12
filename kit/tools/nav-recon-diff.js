#!/usr/bin/env node
'use strict';
/**
 * nav-recon-diff.js - what changes between two deploy/car/nav-recon.sh reports. Node 8 (runs on the PC
 * or the unit). Read only.
 *
 *   node kit/tools/nav-recon-diff.js <base report dir> <other report dir> [--all]
 *
 * Made for these questions, a base run against one other (SNIFF=60 each):
 *   LABEL=base / LABEL=cluster   how the head unit's picture reaches the cluster (the cluster on its map view: the BMW
 *                                map projected there, blank where it has no map)
 *   LABEL=base / LABEL=carplay   2021+ firmware: where CarPlay's cluster map and HUD arrows go (CarPlay guiding)
 *   LABEL=base / LABEL=stocknav  the stock BMW map's surface or SOME/IP state (the home screen against the BMW map
 *                                opened from the left menu bar): for osm_nav's app.json config.stockNav
 *   LABEL=base / LABEL=camera    the camera's surface (the camera view opened with the console's button, parked): its
 *                                id must be one of mgu-render.conf yield_surfaces
 * Compares:
 *   surfaces   ivi-list.txt: surfaces and layers that appear, go, or change visibility / size / place
 *   processes  processes.txt and cpu.txt: new processes, and the ones much busier
 *   SOME/IP    someip.pcap: messages a second per service.method between two addresses (named from
 *              the report's someip-interfaces.json where it has service ids), the ones new or 3x as
 *              frequent; Service Discovery: services offered only in the other run
 * --all lists every SOME/IP flow, not only the changes.
 */
const fs = require('fs');
const path = require('path');

const ALL = process.argv.indexOf('--all') >= 0;
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (e) { return null; } };
const hex4 = (n) => '0x' + ('000' + n.toString(16)).slice(-4);

/* ---------- surfaces (ivi-list, deploy/car) ---------- */
function parseIvi(text) {
    const objs = {};
    if (!text) return null;
    let cur = null;
    text.split('\n').forEach((ln) => {
        let m = /^\s{2}((?:surface|layer) \d+)\(0x[0-9a-f]+\)\s*$/.exec(ln);
        if (m) { cur = m[1]; objs[cur] = objs[cur] || {}; return; }
        m = /^\s{4}((?:surface|layer) \d+)\(0x[0-9a-f]+\) (\S+) (.*)$/.exec(ln);
        if (m) { const o = objs[m[1]] = objs[m[1]] || {}; o[m[2]] = o[m[2]] ? o[m[2]] + '; ' + m[3] : m[3]; }
    });
    return objs;
}
function diffIvi(a, b) {
    const out = [];
    if (!a || !b) { out.push('  (ivi-list.txt missing in ' + (!a ? 'the base' : 'the other') + ' report: copy ivi-list next to nav-recon.sh)'); return out; }
    const keys = Object.keys(Object.assign({}, a, b)).sort((x, y) => Number(x.split(' ')[1]) - Number(y.split(' ')[1]));
    keys.forEach((k) => {
        const A = a[k], B = b[k];
        const who = (o) => (o && o.pid ? '  [' + o.pid + ']' : '');
        const desc = (o) => ['visibility', 'dst', 'src', 'config', 'opacity', 'on'].filter((f) => o[f] !== undefined).map((f) => f + ' ' + o[f]).join(', ');
        if (!A) { out.push('  + ' + k + ' new: ' + desc(B) + who(B)); return; }
        if (!B) { out.push('  - ' + k + ' gone (was ' + desc(A) + ')' + who(A)); return; }
        const ch = ['visibility', 'dst', 'src', 'config', 'opacity', 'on', 'pid'].filter((f) => A[f] !== B[f]).map((f) => f + ' ' + (A[f] === undefined ? '-' : A[f]) + ' -> ' + (B[f] === undefined ? '-' : B[f]));
        if (ch.length) out.push('  ~ ' + k + ': ' + ch.join(', ') + who(B));
    });
    if (!out.length) out.push('  no change');
    return out;
}

/* ---------- processes and CPU ---------- */
const cmdKey = (cmd) => cmd.trim().split(/\s+/)[0].split('/').pop();
function parseProcs(text) {
    const m = {};
    (text || '').split('\n').forEach((ln) => { const p = /^(\d+)\s+(\S+)\s+(.+)$/.exec(ln.trim()); if (p) m[cmdKey(p[3])] = { pid: p[1], rss: p[2], cmd: p[3] }; });
    return m;
}
function parseCpu(text) {
    const m = {};
    let head = '';
    (text || '').split('\n').forEach((ln) => {
        if (ln[0] === '#') { head = ln; return; }
        const p = /^([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(ln.trim());
        if (!p) return;
        const k = cmdKey(p[4]);
        const o = m[k] || (m[k] = { pct: 0, rss: p[3], cmd: p[4] });
        o.pct += Number(p[1]);
    });
    return { m, head };
}
function diffProcs(dirA, dirB) {
    const out = [];
    const pa = parseProcs(read(dirA, 'processes.txt')), pb = parseProcs(read(dirB, 'processes.txt'));
    Object.keys(pb).filter((k) => !pa[k]).forEach((k) => out.push('  + ' + pb[k].cmd.slice(0, 110) + '  (' + pb[k].rss + ')'));
    Object.keys(pa).filter((k) => !pb[k]).forEach((k) => out.push('  - ' + pa[k].cmd.slice(0, 110)));
    const ca = parseCpu(read(dirA, 'cpu.txt')), cb = parseCpu(read(dirB, 'cpu.txt'));
    if (ca.head || cb.head) {
        out.push('  CPU (% of one core): base | other');
        if (ca.head) out.push('    base:  ' + ca.head.replace(/^#\s*/, ''));
        if (cb.head) out.push('    other: ' + cb.head.replace(/^#\s*/, ''));
        const rows = Object.keys(Object.assign({}, ca.m, cb.m)).map((k) => {
            const x = ca.m[k] ? ca.m[k].pct : 0, y = cb.m[k] ? cb.m[k].pct : 0;
            return { k, x, y, d: y - x, cmd: (cb.m[k] || ca.m[k]).cmd };
        }).filter((r) => Math.abs(r.d) >= 2 || (ALL && (r.x || r.y)));
        rows.sort((p, q) => Math.abs(q.d) - Math.abs(p.d));
        rows.slice(0, 30).forEach((r) => out.push('    ' + (r.x.toFixed(1) + '').padStart(6) + ' | ' + (r.y.toFixed(1) + '').padEnd(6) + ' ' + (r.d > 0 ? '+' : '') + r.d.toFixed(1) + '  ' + r.cmd.slice(0, 90)));
        if (!rows.length) out.push('    no process changed by 2% or more');
    }
    if (!out.length) out.push('  no change');
    return out;
}

/* ---------- SOME/IP from the capture ---------- */
/** Each packet of a classic pcap: { t (s), data (Buffer from the link header) }, linktype */
function readPcap(file) {
    let b;
    try { b = fs.readFileSync(file); } catch (e) { return null; }
    if (b.length < 24) return { error: 'empty capture' };
    const magic = b.readUInt32LE(0);
    let le, nano = false;
    if (magic === 0xa1b2c3d4) le = true; else if (magic === 0xd4c3b2a1) le = false;
    else if (magic === 0xa1b23c4d) { le = true; nano = true; } else if (magic === 0x4d3cb2a1) { le = false; nano = true; }
    else if (magic === 0x0a0d0d0a) return { error: 'pcapng: write it with tcpdump -w (classic pcap), or convert with editcap -F pcap' };
    else return { error: 'not a pcap file' };
    const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const link = u32(20), pkts = [];
    let o = 24;
    while (o + 16 <= b.length) {
        const ts = u32(o), tf = u32(o + 4), incl = u32(o + 8);
        if (o + 16 + incl > b.length) break;
        pkts.push({ t: ts + tf / (nano ? 1e9 : 1e6), data: b.slice(o + 16, o + 16 + incl) });
        o += 16 + incl;
    }
    return { link, pkts };
}
/** IP + UDP/TCP of one packet: { src, dst, proto, sport, dport, payload } or null */
function l4(link, d) {
    let off, et;
    if (link === 1) { off = 14; et = d.readUInt16BE(12); while (et === 0x8100 || et === 0x88a8) { et = d.readUInt16BE(off + 2); off += 4; } }
    else if (link === 113) { off = 16; et = d.readUInt16BE(14); }
    else if (link === 276) { off = 20; et = d.readUInt16BE(0); }
    else if (link === 101 || link === 12) { off = 0; et = (d[0] >> 4) === 6 ? 0x86dd : 0x0800; }
    else return null;
    let proto, src, dst, ip;
    if (et === 0x0800) {
        if (d.length < off + 20) return null;
        ip = (d[off] & 15) * 4; proto = d[off + 9];
        src = Array.from(d.slice(off + 12, off + 16)).join('.'); dst = Array.from(d.slice(off + 16, off + 20)).join('.');
    } else if (et === 0x86dd) {
        if (d.length < off + 40) return null;
        ip = 40; proto = d[off + 6];
        const a6 = (s) => { const w = []; for (let i = 0; i < 16; i += 2) w.push(d.readUInt16BE(s + i).toString(16)); return w.join(':').replace(/(^|:)0(:0)+(:|$)/, '::'); };
        src = a6(off + 8); dst = a6(off + 24);
    } else return null;
    const t = off + ip;
    if (proto === 17 && d.length >= t + 8) return { src, dst, proto: 'udp', sport: d.readUInt16BE(t), dport: d.readUInt16BE(t + 2), payload: d.slice(t + 8) };
    if (proto === 6 && d.length >= t + 20) return { src, dst, proto: 'tcp', sport: d.readUInt16BE(t), dport: d.readUInt16BE(t + 2), payload: d.slice(t + (d[t + 12] >> 4) * 4) };
    return null;
}
const MSG = { 0: 'request', 1: 'request-no-reply', 2: 'notification', 0x80: 'response', 0x81: 'error', 0x20: 'tp-request', 0x22: 'tp-notification', 0xa0: 'tp-response' };
/** SOME/IP messages of one capture: flows (src -> dst, service.method, type) with counts, and SD offers */
function someip(cap) {
    const flows = {}, offers = {};
    let t0 = Infinity, t1 = -Infinity, n = 0;
    cap.pkts.forEach((p) => {
        const x = l4(cap.link, p.data);
        if (!x || x.payload.length < 16) return;
        // a TCP segment may carry several messages: the ones whose headers are in the capture
        let o = 0;
        while (o + 16 <= x.payload.length) {
            const P = x.payload;
            const svc = P.readUInt16BE(o), meth = P.readUInt16BE(o + 2), len = P.readUInt32BE(o + 4), pv = P[o + 12], mt = P[o + 14];
            if (pv !== 1 || len < 8 || len > 1 << 24 || !(mt in MSG)) break;
            n++; t0 = Math.min(t0, p.t); t1 = Math.max(t1, p.t);
            if (svc === 0xffff && meth === 0x8100) {
                // Service Discovery: entries (16 bytes each) after flags (4) and the entries length (4)
                const e0 = o + 16 + 8, elen = P.length >= o + 24 ? P.readUInt32BE(o + 20) : 0;
                for (let e = e0; e + 16 <= Math.min(P.length, e0 + elen); e += 16) {
                    const type = P[e], sid = P.readUInt16BE(e + 4), inst = P.readUInt16BE(e + 6), ttl = P.readUIntBE(e + 9, 3);
                    if (type === 1 && ttl > 0) offers[x.src + ' offers ' + hex4(sid) + '.' + inst] = { src: x.src, sid, inst };
                }
            } else {
                const k = x.src + ' -> ' + x.dst + ' ' + hex4(svc) + '.' + hex4(meth) + ' ' + MSG[mt] + ' (' + x.proto + ' ' + x.dport + ')';
                const f = flows[k] || (flows[k] = { n: 0, svc, meth, bytes: 0 });
                f.n++; f.bytes += len + 8;
            }
            if (x.proto !== 'tcp') break;
            o += len + 8;
        }
    });
    return { flows, offers, secs: Math.max(1, t1 - t0), n };
}
/** service id -> interface name, from the report's catalog copy (and vsomeip configs) when they have ids */
function serviceNames(dirs) {
    const names = {};
    dirs.forEach((dir) => {
        const cat = read(dir, 'someip-interfaces.json');
        if (cat) {
            try {
                const db = JSON.parse(cat), I = db.interfaces || {};
                Object.keys(I).forEach((n) => {
                    const d = I[n], id = d.serviceId !== undefined ? d.serviceId : d.service_id !== undefined ? d.service_id : d.id;
                    const v = typeof id === 'string' ? parseInt(id, /^0x/i.test(id) ? 16 : 10) : id;
                    if (typeof v === 'number' && isFinite(v)) names[v] = n;
                });
            } catch (e) { /* not JSON */ }
        }
        let vs = [];
        try { vs = fs.readdirSync(path.join(dir, 'vsomeip')).filter((f) => /\.json$/.test(f)); } catch (e) { /* none */ }
        vs.forEach((f) => {
            const t = read(path.join(dir, 'vsomeip'), f) || '';
            const re = /"service"\s*:\s*"?(0x[0-9a-fA-F]+|\d+)"?[^}]*?"name"\s*:\s*"([^"]+)"/g;
            let m;
            while ((m = re.exec(t))) { const v = parseInt(m[1], /^0x/i.test(m[1]) ? 16 : 10); if (!names[v]) names[v] = m[2]; }
        });
    });
    return names;
}
function diffSomeip(dirA, dirB) {
    const out = [];
    const ca = readPcap(path.join(dirA, 'someip.pcap')), cb = readPcap(path.join(dirB, 'someip.pcap'));
    if (!ca || !cb) { out.push('  (someip.pcap missing in ' + (!ca ? 'the base' : 'the other') + ' report: run nav-recon.sh with SNIFF=60)'); return out; }
    if (ca.error || cb.error) { out.push('  ' + (ca.error || cb.error)); return out; }
    const A = someip(ca), B = someip(cb), names = serviceNames([dirA, dirB]);
    const nm = (svc) => (names[svc] ? '  ' + names[svc] : '');
    out.push('  base: ' + A.n + ' SOME/IP messages in ' + Math.round(A.secs) + ' s; other: ' + B.n + ' in ' + Math.round(B.secs) + ' s');
    if (!A.n && !B.n) out.push('  no SOME/IP in either capture: the cluster and HUD may talk over another interface (net-links.txt)');
    const rows = Object.keys(Object.assign({}, A.flows, B.flows)).map((k) => {
        const x = A.flows[k] ? A.flows[k].n / A.secs : 0, y = B.flows[k] ? B.flows[k].n / B.secs : 0;
        const f = B.flows[k] || A.flows[k];
        return { k, x, y, f, bpm: B.flows[k] ? B.flows[k].bytes / B.flows[k].n : 0 };
    });
    const changed = rows.filter((r) => ALL || (r.y > 0.05 && r.y >= 3 * r.x + 0.05) || (r.x > 0.05 && r.y === 0));
    changed.sort((p, q) => (q.y - q.x) - (p.y - p.x));
    if (changed.length) {
        out.push('  messages a second: base | other   flow (new or 3x more with the other run first)');
        changed.slice(0, ALL ? 400 : 60).forEach((r) => out.push('    ' + r.x.toFixed(2).padStart(6) + ' | ' + r.y.toFixed(2).padEnd(6) + ' ' + r.k + (r.bpm ? '  ~' + Math.round(r.bpm) + ' B' : '') + nm(r.f.svc)));
    } else out.push('  no SOME/IP flow new or 3x more often');
    const offB = Object.keys(B.offers).filter((k) => !A.offers[k]), offA = Object.keys(A.offers).filter((k) => !B.offers[k]);
    offB.forEach((k) => out.push('  + offered only in the other run: ' + k + nm(B.offers[k].sid)));
    offA.forEach((k) => out.push('  - offered only in the base run: ' + k + nm(A.offers[k].sid)));
    return out;
}

/* ---------- report ---------- */
function report(dirA, dirB) {
    const label = (d) => ((read(d, 'label.txt') || path.basename(d)).trim());
    const lines = ['nav-recon diff: base ' + label(dirA) + '  vs  other ' + label(dirB), ''];
    lines.push('Wayland surfaces and layers (ivi-list.txt):');
    diffIvi(parseIvi(read(dirA, 'ivi-list.txt')), parseIvi(read(dirB, 'ivi-list.txt'))).forEach((l) => lines.push(l));
    lines.push('', 'Processes (processes.txt, cpu.txt):');
    diffProcs(dirA, dirB).forEach((l) => lines.push(l));
    lines.push('', 'SOME/IP (someip.pcap):');
    diffSomeip(dirA, dirB).forEach((l) => lines.push(l));
    lines.push('', 'What to look for:',
        '  cluster: a surface that turns visible on a screen of its own (the cluster\'s), a process that gets busy,',
        '    or a service sent to the cluster\'s address only with its map view on: how the cluster\'s map gets there.',
        '  carplay (2021+ firmware): the same with CarPlay in the cluster, and a service sent to the HUD only while',
        '    CarPlay guides (the turn arrows).',
        '  stocknav: a surface that turns visible at full size (w >= 800, h >= 400) with the BMW map open: its id and',
        '    process go to osm_nav app.json config.stockNav (surfaceId, proc). None: the HMI draws the map itself; a',
        '    SOME/IP flow that appears with it is config.stockNav iface / field.',
        '  camera: the surface that turns visible with a size while the camera view is on. Its id must be one of the',
        '    renderer\'s yield_surfaces (mgu-render.conf: 0x197, 0x198, 0x19d, 0x19f); another id: add it there before',
        '    any app is shown on this car, or its picture could be drawn over the camera.',
        'Send both reports and this output back for the next step.');
    return lines.join('\n');
}

if (require.main === module) {
    const args = process.argv.slice(2).filter((a) => a !== '--all');
    if (args.length !== 2) {
        console.error('usage: node kit/tools/nav-recon-diff.js <base report dir> <other report dir> [--all]');
        process.exit(2);
    }
    console.log(report(args[0], args[1]));
}

module.exports = { report, parseIvi, diffIvi, readPcap, l4, someip };
