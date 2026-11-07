'use strict';
// kit/tools/nav-recon-diff.js on two made-up reports: a base run and one with "CarPlay in the cluster":
// a surface turning visible, a new busy process, and a SOME/IP service (UDP, Linux cooked capture, as
// tcpdump -i any writes it) sent to the cluster only in the second run, plus a Service Discovery offer.
//   node kit/tools/test_nav_recon_diff.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('./nav-recon-diff');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-recon-diff-'));
const mk = (name, files) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(d);
    Object.keys(files).forEach((f) => fs.writeFileSync(path.join(d, f), files[f]));
    return d;
};

/** a SOME/IP message: service, method, client/session, type, payload */
function someipMsg(svc, meth, type, payload) {
    const h = Buffer.alloc(16);
    h.writeUInt16BE(svc, 0); h.writeUInt16BE(meth, 2); h.writeUInt32BE(8 + payload.length, 4);
    h.writeUInt16BE(0x1234, 8); h.writeUInt16BE(1, 10); h[12] = 1; h[13] = 1; h[14] = type; h[15] = 0;
    return Buffer.concat([h, payload]);
}
/** Linux cooked (SLL, linktype 113) + IPv4 + UDP around a payload */
function sllUdp(src, dst, sport, dport, payload) {
    const sll = Buffer.alloc(16); sll.writeUInt16BE(0x0800, 14);
    const ip = Buffer.alloc(20); ip[0] = 0x45; ip[9] = 17; ip.writeUInt16BE(28 + payload.length, 2);
    src.split('.').forEach((v, i) => { ip[12 + i] = Number(v); }); dst.split('.').forEach((v, i) => { ip[16 + i] = Number(v); });
    const udp = Buffer.alloc(8); udp.writeUInt16BE(sport, 0); udp.writeUInt16BE(dport, 2); udp.writeUInt16BE(8 + payload.length, 4);
    return Buffer.concat([sll, ip, udp, payload]);
}
function pcap(pkts) {
    const g = Buffer.alloc(24);
    g.writeUInt32LE(0xa1b2c3d4, 0); g.writeUInt16LE(2, 4); g.writeUInt16LE(4, 6); g.writeUInt32LE(65535, 16); g.writeUInt32LE(113, 20);
    const parts = [g];
    pkts.forEach((p, i) => {
        const h = Buffer.alloc(16);
        h.writeUInt32LE(1000 + Math.floor(i / 10), 0); h.writeUInt32LE((i % 10) * 100000, 4); h.writeUInt32LE(p.length, 8); h.writeUInt32LE(p.length, 12);
        parts.push(h, p);
    });
    return Buffer.concat(parts);
}
const HU = '160.48.199.99', KOMBI = '160.48.199.16';
const common = () => {
    const out = [];
    for (let i = 0; i < 100; i++) out.push(sllUdp(HU, KOMBI, 30501, 30501, someipMsg(0x1001, 0x8001, 2, Buffer.from([1, 2, 3, 4]))));
    return out;
};
const base = common();
const other = common();
for (let i = 0; i < 60; i++) other.push(sllUdp(HU, KOMBI, 30502, 30502, someipMsg(0x2b07, 0x8005, 2, Buffer.alloc(24))));
// SD: offer of service 0x2b07 instance 1 (entries: type 1, ttl 3)
const entry = Buffer.alloc(16); entry[0] = 1; entry.writeUInt16BE(0x2b07, 4); entry.writeUInt16BE(1, 6); entry[8] = 1; entry.writeUIntBE(3, 9, 3);
const sdPayload = Buffer.concat([Buffer.from([0xc0, 0, 0, 0]), Buffer.from([0, 0, 0, 16]), entry, Buffer.from([0, 0, 0, 0])]);
other.push(sllUdp(HU, '224.244.224.245', 30490, 30490, someipMsg(0xffff, 0x8100, 2, sdPayload)));

const ivi = (vis) => '3 screens, 4 layers, 5 surfaces\n  screen 1\n  surface 2000(0x7d0)\n    surface 2000(0x7d0) visibility 1\n    surface 2000(0x7d0) dst 0,0 1920x720\n    surface 2000(0x7d0) pid 812 (HmiMain3D)\n'
    + '  surface 4100(0x1004)\n    surface 4100(0x1004) visibility ' + vis + '\n    surface 4100(0x1004) dst 0,0 1280x480\n    surface 4100(0x1004) pid 990 (CarPlayStreamer)\n';
const a = mk('base', {
    'label.txt': 'base 1', 'ivi-list.txt': ivi(0), 'processes.txt': '812  210000kB  /usr/bin/HmiMain3D\n',
    'cpu.txt': '# cpu% over 10 s, whole unit 30% busy\n25.0 812 210000kB /usr/bin/HmiMain3D\n', 'someip.pcap': pcap(base),
    'someip-interfaces.json': JSON.stringify({ interfaces: { 'de.bmw.infotainment.TurnByTurnHud': { serviceId: '0x2b07' } } }),
});
const b = mk('carplay', {
    'label.txt': 'carplay 1', 'ivi-list.txt': ivi(1),
    'processes.txt': '812  212000kB  /usr/bin/HmiMain3D\n990  60000kB  /opt/carplay/CarPlayStreamer --cluster\n',
    'cpu.txt': '# cpu% over 10 s, whole unit 45% busy\n24.0 812 212000kB /usr/bin/HmiMain3D\n18.5 990 60000kB /opt/carplay/CarPlayStreamer --cluster\n', 'someip.pcap': pcap(other),
});

const r = D.report(a, b);
assert(/~ surface 4100: visibility 0 -> 1/.test(r), 'the surface turning visible: ' + r);
assert(/\+ \/opt\/carplay\/CarPlayStreamer/.test(r), 'the new process');
assert(/\+18\.5\s+\/opt\/carplay\/CarPlayStreamer/.test(r), 'its CPU');
assert(/0\.00 \| \S+\s+160\.48\.199\.99 -> 160\.48\.199\.16 0x2b07\.0x8005 notification \(udp 30502\).*TurnByTurnHud/.test(r), 'the new service to the cluster, named: ' + r);
assert(!/0x1001\.0x8001/.test(r), 'an unchanged flow is not listed');
assert(/offered only in the other run: 160\.48\.199\.99 offers 0x2b07\.1/.test(r), 'the SD offer');
const cap = D.readPcap(path.join(b, 'someip.pcap'));
assert.strictEqual(cap.link, 113);
assert.strictEqual(D.someip(cap).n, 161, 'every SOME/IP message counted');
fs.writeFileSync(path.join(a, 'someip.pcap'), Buffer.from([0x0a, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
assert(/pcapng/.test(D.report(a, b)), 'a pcapng file is named, not misread');
console.log('nav-recon-diff: all checks passed');
