'use strict';
// Navigation (apps/osm_nav) without a car: the NAV button's learning and matching (navkey.js), the car GPS
// field's encoding chosen by the installed map (gps.js), and routing, guidance and search on the map pack.
//   node kit/tools/test_osm_nav.js [map.pack]
const assert = require('assert');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'osm_nav');
// the app requires './kit/<x>' (copied from kit/runtime by the build)
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.indexOf(APP) === 0) {
        const m = /^\.\/kit\/(.+)$/.exec(request);
        if (m) return origResolve.call(this, path.join(ROOT, 'kit', 'runtime', m[1]), parent, ...rest);
    }
    return origResolve.call(this, request, parent, ...rest);
};
const navkey = require(path.join(APP, 'navkey'));
const { MapPack, merc } = require(path.join(APP, 'mappack'));
const { Router, Guidance } = require(path.join(APP, 'router'));
const { Search } = require(path.join(APP, 'search'));
const { Position } = require(path.join(APP, 'gps'));

// ---- the NAV button: learned from three presses, a counter byte left out ----
const nav = (seq, state) => navkey.fromHex(('0' + seq.toString(16)).slice(-2) + 'a4' + state + '00');
const press = [nav(1, '01'), nav(2, '00'), nav(3, '01'), nav(4, '00'), nav(5, '01'), nav(6, '00')];
let r = navkey.learn(press);
assert(!r.error, 'three NAV presses (press + release each) give a pattern: ' + JSON.stringify(r));
assert(!/\b0=/.test(r.text), 'the sequence counter is not part of it: ' + r.text);
assert(navkey.matches(r.pairs, nav(77, '01')), 'a later NAV press matches');
assert(!navkey.matches(r.pairs, navkey.fromHex('4dd101' + '00')), 'another button does not');
assert(!navkey.matches(r.pairs, navkey.fromHex('4da4')), 'a shorter event does not');
assert.strictEqual(navkey.learn(press.slice(0, 2)).error, 'few', 'one press is not enough');
const mixed = [navkey.fromHex('01a10100'), navkey.fromHex('02b20200'), navkey.fromHex('03c30300')];
assert.strictEqual(navkey.learn(mixed).error, 'vague', 'three different buttons: refused (it would take any button for NAV)');
assert.deepStrictEqual(navkey.parse('xx a4 xx 00'), [['1', 'a4'], ['3', '00']], 'hand-written hex with xx');
assert.strictEqual(navkey.parse(''), null, 'empty: no pattern (NAV stays stock only)');
// a SOME/IP field's value
const sv = (n) => navkey.fromValue({ seq: n, key: { id: 'NAVI', state: n % 2 ? 'PRESSED' : 'RELEASED' }, len: 3 });
r = navkey.learn([sv(1), sv(2), sv(3), sv(4)]);
assert(!r.error && navkey.matches(r.pairs, sv(9)) && !navkey.matches(r.pairs, navkey.fromValue({ seq: 9, key: { id: 'MEDIA', state: 'PRESSED' }, len: 3 })),
    'from a SOME/IP field: NAV matches, MEDIA does not (' + r.text + ')');

// ---- the map pack ----
const file = process.argv[2] || path.join(APP, 'georgia.pack');
const pack = MapPack.open(file);
const router = new Router(pack, { cacheDir: os.tmpdir() });
const at = (la, lo, h) => { const p = merc(la, lo); return router.snap(p[0], p[1], h, 500); };
const a = at(41.7015, 44.7942, 140), b = at(41.7336, 44.7598);
assert(a && b, 'Tbilisi snaps to roads');
const route = router.route(a, b);
assert(route && route.length > 1000 && route.length < 20000, 'a route across Tbilisi: ' + (route && route.length));
assert(route.maneuvers[0].type === 'depart' && route.maneuvers[route.maneuvers.length - 1].type === 'arrive', 'depart ... arrive');
const far = router.route(a, at(41.6168, 41.6367));
assert(far && far.length > 300000, 'Tbilisi - Batumi: ' + (far && Math.round(far.length / 1000)) + ' km in ' + (far && far.searchMs) + ' ms');
const g = new Guidance(router, route), p0 = route.at(0);
let u = g.update({ x: p0.x, y: p0.y, heading: p0.bearing, speed: 30 }, 1000);
assert(u.off < 5 && !u.offRoute, 'on the route at its start');
u = g.update({ x: p0.x + 400, y: p0.y + 400, heading: 0, speed: 30 }, 2000);
u = g.update({ x: p0.x + 400, y: p0.y + 400, heading: 0, speed: 30 }, 7000);
assert(u.offRoute, 'half a kilometre off it for 5 s: plan again');
// speed limits shown are only signed ones (a class default is no sign)
let signed = 0, shown = 0;
for (let e = 0; e < pack.graph.m; e += 97) { const v = pack.edgeMaxspeed(e); if (v) { shown++; if (v % 5 === 0) signed++; } }
assert(shown === 0 || signed / shown > 0.95, 'speed limits look like signs');
// search
const s = new Search(pack, os.tmpdir()), here = { x: a.x, y: a.y };
const tbilisi = s.find('tbilisi', here, 5);
assert(tbilisi.length && /Tbilisi/.test(tbilisi[0].title('en')), 'finds Tbilisi');
assert(s.find('რუსთაველ', here, 5).length, 'Georgian prefix search');
assert(s.find('41.6934, 44.8015', here, 3)[0].title('en') === '41.69340, 44.80150', 'coordinates as a destination');

// ---- the car's GPS field: its encoding is the one that lands on the installed map ----
const ctx = { log: { info() {}, warn() {} }, dataDir: os.tmpdir(), spec: { config: {} }, settings: { get: () => 'off' } };
const pos = new Position(ctx, { pack, router, packs: () => [pack], route: () => null });
const close = (ll, la, lo) => ll && Math.abs(ll[0] - la) < 1e-4 && Math.abs(ll[1] - lo) < 1e-4;
assert(close(pos._autoScale(41.6934, 44.8015, 'deg'), 41.6934, 44.8015), 'degrees');
assert(close(pos._autoScale(416934000, 448015000, 'e7'), 41.6934, 44.8015), '1e-7 degrees');
assert(close(pos._autoScale(Math.round(41.6934 * 2147483648 / 180), Math.round(44.8015 * 2147483648 / 180), 'semi'), 41.6934, 44.8015), 'semicircles (not taken for 1e-7 degrees)');
assert.strictEqual(pos._autoScale(48.85, 2.35, 'paris'), null, 'a fix on no installed map: not used');
pack.close && pack.close();
console.log('osm_nav: all checks passed (Tbilisi - Batumi ' + Math.round(far.length / 1000) + ' km in ' + far.searchMs + ' ms)');
