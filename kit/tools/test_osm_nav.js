'use strict';
// Navigation (apps/osm_nav) without a car: the NAV button's learning and matching (navkey.js), the car GPS
// field's encoding chosen by the installed map (gps.js), and routing, guidance and search on the map pack.
//   node kit/tools/test_osm_nav.js [map.pack]
const assert = require('assert');
const fs = require('fs');
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
// the map: the one given, else the built package's, else app.json's download in kit/tools/.osm-cache (build.py fetches it)
const mapSpec = require(path.join(APP, 'app.json')).maps[0];
const file = process.argv[2] || [path.join(ROOT, 'dist', 'osm_nav', 'source', 'javascript', mapSpec.file),
    path.join(ROOT, 'kit', 'tools', '.osm-cache', mapSpec.gzSha256 + '.pack.gz')].find((p) => fs.existsSync(p));
if (!file) { console.error('no map: run python3 kit/tools/build.py osm_nav first (it downloads it)'); process.exit(2); }
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

// ---- fuel: the cluster's tank and range (read only), range on arrival, a stop on a long route ----
const FU = require(path.join(APP, 'fuel'));
let fuelH = null;
const fctx = { log: { info() {}, warn() {} }, signals: { watch: (iface, inst, h) => { assert.strictEqual(iface, 'de.bmw.infotainment.KombiIF'); fuelH = h; return Promise.resolve({ shutdown() {} }); } } };
const fuel = new FU.Fuel(fctx);
let refuelled = 0;
fuel.onEvent((e) => { if (e === 'refuelled') refuelled++; });
fuel.start();
assert.strictEqual(fuel.state(false), null, 'nothing from the car yet, no demo: no fuel data');
fuelH.statusRangeTankStatus({ fluidLevelFuelTank: 255, range: 4095, mileageKilometre: 0 });
assert.strictEqual(fuel.state(false), null, 'not-known values are not data');
fuelH.statusRangeTankStatus({ fluidLevelFuelTank: 22, range: 280, mileageKilometre: 81234 });
fuelH.statusBordcomputerAverage({ consumptionAverage1BC1: 79, statusUnitOfMeasurementConsumptionBC: 1 });
let fs0 = fuel.state(false);
assert(fs0.litres === 22 && fs0.rangeKm === 280 && fs0.source === 'car' && Math.abs(fs0.cons.value - 7.9) < 1e-9 && fs0.cons.unit === 'l/100 km', 'tank, range, consumption: ' + JSON.stringify(fs0));
const tank = (l) => fuelH.statusRangeTankStatus({ fluidLevelFuelTank: l, range: l * 12, mileageKilometre: 81240 });
fuel.setSpeed(70);
tank(28); tank(21); tank(29);
assert.strictEqual(refuelled, 0, 'fuel sloshing on a hill while driving is no refuel');
fuel.setSpeed(0);
tank(22);
[23, 24, 26, 28, 31, 40, 58].forEach(tank);
assert.strictEqual(refuelled, 1, 'parked, the pump filling it step by step: one refuel');
fuel.stop();
// the engine off at the pump (the app not running): the level at the last shutdown is the base
const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-fuel-'));
fs.writeFileSync(path.join(fdir, 'osm_nav_fuel.json'), JSON.stringify({ litres: 9 }));
const fuel2 = new FU.Fuel(Object.assign({}, fctx, { dataDir: fdir }));
let refuelled2 = 0;
fuel2.onEvent((e) => { if (e === 'refuelled') refuelled2++; });
fuel2.start();
fuelH.statusRangeTankStatus({ fluidLevelFuelTank: 55, range: 700, mileageKilometre: 81250 });
assert.strictEqual(refuelled2, 1, 'filled up while the app was off: seen at the next start');
fuel2.stop();
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(fdir, 'osm_nav_fuel.json'), 'utf8')).litres, 55, 'the level is kept at shutdown');
assert(FU.arrivalKm(280, far.length) < 0, 'Tbilisi - Batumi on 280 km: short (' + Math.round(FU.arrivalKm(280, far.length)) + ' km)');
const stations = s.near([10], here, 100000);
assert(stations.length > 50, 'fuel stations in the map: ' + stations.length);
let t0 = Date.now();
const along = FU.stationsAlong(far, 0, stations);
const alongMs = Date.now() - t0;
assert(along.length > 10, 'stations along Tbilisi - Batumi: ' + along.length + ' in ' + alongMs + ' ms');
assert(along.every((x, i) => x.off <= 1500 && (!i || x.s >= along[i - 1].s)), 'within 1.5 km of the road, in route order');
const stop = FU.pickStop(along, 280, 0);
assert(stop && stop.s <= (280 - FU.STOP_RESERVE_KM) * 1000 && stop.s > 100000, 'the stop: the last one reached with a reserve, ' + Math.round(stop.s / 1000) + ' km in');
const via = router.snap(stop.st.x, stop.st.y, null, 400);
const viaRoute = router.route(a, at(41.6168, 41.6367), { vias: [via] });
assert(viaRoute && viaRoute.length >= far.length - 50 && viaRoute.length < far.length + 5000, 'the route through the stop is about as long: ' + Math.round(viaRoute.length / 1000) + ' km');
const late = FU.pickStop(along, 280, along[along.length - 1].s + 1);assert.strictEqual(late, null, 'every station already passed: none picked (never one behind the car)');const mid = along[Math.floor(along.length / 2)].s;assert(FU.pickStop(along, 280, mid).s >= mid, 'part way along: a station ahead');
assert.strictEqual(FU.pickStop(along, 25, 0), along[0], 'too little for any with the reserve: the first one ahead');
const ahead = FU.nearestAhead(s.near([10], here, 8), { x: here.x, y: here.y, heading: 0, speed: 0 }, 0.75);
assert(ahead && ahead.kind === 10, 'parked, low fuel: the nearest station');

// ---- the car's GPS field: its encoding is the one that lands on the installed map ----
const ctx = { log: { info() {}, warn() {} }, dataDir: os.tmpdir(), spec: { config: {} }, settings: { get: () => 'off' } };
const pos = new Position(ctx, { pack, router, packs: () => [pack], route: () => null });
const close = (ll, la, lo) => ll && Math.abs(ll[0] - la) < 1e-4 && Math.abs(ll[1] - lo) < 1e-4;
assert(close(pos._autoScale(41.6934, 44.8015, 'deg'), 41.6934, 44.8015), 'degrees');
assert(close(pos._autoScale(416934000, 448015000, 'e7'), 41.6934, 44.8015), '1e-7 degrees');
assert(close(pos._autoScale(Math.round(41.6934 * 2147483648 / 180), Math.round(44.8015 * 2147483648 / 180), 'semi'), 41.6934, 44.8015), 'semicircles (not taken for 1e-7 degrees)');
assert.strictEqual(pos._autoScale(48.85, 2.35, 'paris'), null, 'a fix on no installed map: not used');
// the demo drive: never by itself on the car (MainApp: ctx.app), only off the car or when chosenconst demoCtx = (app, mode) => ({ app, previewDemo: true, log: ctx.log, dataDir: os.tmpdir(), spec: { config: {} }, settings: { get: () => mode }, ui: { isVisible: () => true } });const mk = (app, mode) => new Position(demoCtx(app, mode), { pack, router, packs: () => [pack], route: () => null });assert.strictEqual(mk({ on() {} }, 'auto').wantDemo(), false, 'on the car, auto: no demo drive (no position instead)');assert.strictEqual(mk(null, 'auto').wantDemo(), true, 'PC preview, auto: the demo drive');assert.strictEqual(mk({ on() {} }, 'on').wantDemo(), true, 'on the car, chosen in Settings: the demo drive');

// ---- the stock BMW map: Navigation opens in its place, never a loop after BACK, never over the camera ----
const SN = require(path.join(APP, 'stocknav'));
const line = (t, id, vis, w, h, flag, proc) => SN.parseSurface(t + ' surface ' + id + ' ' + vis + ' 0 0 ' + w + ' ' + h + ' ' + (flag || '-') + ' ' + (proc || 'NaviMap'));
assert.deepStrictEqual(SN.parseSurface('104251 surface 4100 1 0 0 1920 720 - NaviMap'), { t: 104251, id: 4100, vis: 1, x: 0, y: 0, w: 1920, h: 720, yield: false, proc: 'NaviMap' }, 'a surface line');
assert.strictEqual(SN.parseSurface('104251 2 a401'), null, 'a button line is not a surface line');
let fl = new SN.StockNavFollower({});
assert.strictEqual(fl.surface(line(0, 4100, 1, 1920, 720), 0), null, 'not learned or configured: never opens');
fl = new SN.StockNavFollower({ surfaceId: 4100 });
let tt = 1000;
const snAt = (dt) => { tt += dt; return tt; };
assert.strictEqual(fl.surface(line(tt, 4100, 0, 1920, 720), tt), null, 'hidden at first');
assert.strictEqual(fl.surface(line(tt, 4200, 1, 560, 210, '-', 'HmiMain3D'), snAt(10)), null, 'another surface (a home widget): nothing');
assert.strictEqual(fl.surface(line(tt, 4100, 1, 560, 210), snAt(10)), null, 'the stock map at widget size (560x210): not the stock map screen');
assert.strictEqual(fl.surface(line(tt, 4100, 1, 1920, 720), snAt(10)), 'open', 'shown full size, Navigation not in front: open (rising edge)');
assert.strictEqual(fl.surface(line(tt, 4100, 1, 1910, 720), snAt(10)), null, 'shown again: no new edge');
// Navigation in front; the HMI may hide the stock map under it, or not
fl.appVisible(true, snAt(300));
assert.strictEqual(fl.surface(line(tt, 4100, 0, 1920, 720), snAt(50)), null, 'hidden under Navigation: nothing');
// BACK: Navigation leaves, the stock map shows again underneath: no loop
fl.appVisible(false, snAt(5000));
assert.strictEqual(fl.surface(line(tt, 4100, 1, 1920, 720), snAt(40)), null, 'BACK onto the stock map: Navigation does not open again');
assert.strictEqual(fl.surface(line(tt, 4100, 1, 1920, 720), snAt(40)), null, 'and not on a repeated report');
fl.tick(snAt(10000));
assert.strictEqual(fl.surface(line(tt, 4100, 1, 1920, 720), snAt(10)), null, 'the stock map used for a while: still not');
assert.strictEqual(fl.surface(line(tt, 4100, 0, 1920, 720), snAt(2000)), null, 'the driver leaves the stock map too');
assert.strictEqual(fl.surface(line(tt, 4100, 1, 1920, 720), snAt(3000)), 'open', 'the next time it opens (side menu NAV): Navigation opens');
// BACK when the HMI leaves the stock map shown under Navigation: no edge at all, so nothing
fl.appVisible(true, snAt(200));
fl.appVisible(false, snAt(8000));
assert.strictEqual(fl.surface(line(tt, 4100, 1, 1920, 720), snAt(30)), null, 'BACK with the stock map shown all along: nothing');
// HOME / MENU from Navigation: the stock map was hidden all along; armed again after settleMs
fl.surface(line(tt, 4100, 0, 1920, 720), snAt(500));
fl.appVisible(true, snAt(100));
fl.appVisible(false, snAt(6000));
fl.tick(snAt(1000));
assert.strictEqual(fl.armed, false, 'left by HOME one second ago: not armed yet (BACK may still bring the stock map back)');
fl.tick(snAt(3100));
assert.strictEqual(fl.surface(line(tt, 4100, 1, 1920, 720), snAt(100)), 'open', 'left by HOME, the stock map opened 4 s later (side menu NAV): open');
fl.appVisible(true, snAt(100));
fl.surface(line(tt, 4100, 0, 1920, 720), snAt(100));
fl.appVisible(false, snAt(6000));
assert.strictEqual(fl.surface(line(tt, 4100, 1, 1920, 720), snAt(500)), null, 'within settleMs of leaving, with no hiding seen after: not yet');
fl.surface(line(tt, 4100, 0, 1920, 720), snAt(500));
fl.appVisible(true, snAt(100));
fl.appVisible(false, snAt(6000));
fl.tick(snAt(4100));
assert.strictEqual(fl.armed, true, 'the stock map hidden for settleMs after Navigation left: armed again');
// never over the reversing camera or video (a yield surface shown)
fl.surface(line(tt, 0x197, 1, 1920, 720, 'y', 'camera'), snAt(100));
assert.strictEqual(fl.surface(line(tt, 4100, 1, 1920, 720), snAt(100)), null, 'the camera shown: never opens');
fl.surface(line(tt, 0x197, 0, 1920, 720, 'y', 'camera'), snAt(100));
fl.surface(line(tt, 4100, 0, 1920, 720), snAt(100));
assert.strictEqual(fl.surface(line(tt, 4100, 1, 1920, 720), snAt(100)), 'open', 'the camera gone: opens again');
// by process name, and a SOME/IP state as a second source
const fp = new SN.StockNavFollower({ proc: 'NaviMap' });
fp.settled();
assert.strictEqual(fp.surface(line(0, 4555, 1, 1920, 720, '-', 'NaviMap'), 10), 'open', 'matched by its process (a new surface id after a restart)');
const fs2 = new SN.StockNavFollower({ surfaceId: 1 });
assert.strictEqual(fs2.state('someip', true, 10), null, 'the first value of a SOME/IP field (on): where it stands, nothing opens');
assert.strictEqual(fs2.state('someip', false, 20), null, 'off');
assert.strictEqual(fs2.state('someip', true, 30), 'open', 'a SOME/IP state turning on: open');
assert.strictEqual(fs2.state('someip', true, 40), null, 'staying on: nothing');
// mgu-render tells every surface once when Navigation starts listening: the stock map shown since before does not
// open Navigation (a restart while the driver uses the stock map); hidden and shown again afterwards does
const fsnap = new SN.StockNavFollower({ surfaceId: 4100 });
assert.strictEqual(fsnap.surface(line(0, 4100, 1, 1920, 720), 100), null, 'the snapshot: the stock map shown since before Navigation started: nothing');
fsnap.settled();
assert.strictEqual(fsnap.surface(line(0, 4100, 0, 1920, 720), 5000), null, 'hidden');
assert.strictEqual(fsnap.surface(line(0, 4100, 1, 1920, 720), 6000), 'open', 'shown again: open');
const fnew = new SN.StockNavFollower({ proc: 'NaviMap' });
fnew.surface(line(0, 4100, 0, 1920, 720), 100);
fnew.settled();
assert.strictEqual(fnew.surface(line(0, 4777, 1, 1920, 720), 5000), 'open', 'after the snapshot, a new surface of the stock map turning up shown (made when it opens): open');
// learning on the car: the surface that turns shown, full size, while Navigation is not in front
const fl2 = new SN.StockNavFollower({});
fl2.surface(line(0, 1000, 1, 1920, 720, '-', 'HmiMain3D'), 0);
fl2.surface(line(0, 4100, 0, 1920, 720, '-', 'NaviMap'), 0);
fl2.settled();
fl2.learn(100);
fl2.appVisible(false, 200);
fl2.surface(line(0, 1000, 1, 1920, 720, '-', 'HmiMain3D'), 300);
fl2.surface(line(0, 4200, 1, 560, 210, '-', 'HmiMain3D'), 300);
fl2.surface(line(0, 0x197, 1, 1920, 720, 'y', 'camera'), 300);
fl2.surface(line(0, 4100, 1, 1920, 720, '-', 'NaviMap'), 400);
const learned = fl2.learnDone();
assert(learned && learned.surfaceId === 4100 && learned.proc === 'NaviMap', 'learned the stock map (not the HMI already shown, a widget or the camera): ' + JSON.stringify(learned));
assert(fl2.configured() && !fl2.learning, 'learned: follows it now');
const fl3 = new SN.StockNavFollower({});
fl3.settled();
fl3.learn(0); fl3.appVisible(false, 0);
assert.strictEqual(fl3.learnDone().error, 'none', 'nothing opened: not learned');
fl3.learn(0);
fl3.surface(line(0, 5001, 1, 1920, 720, '-', 'A'), 10);
fl3.surface(line(0, 5002, 1, 1920, 720, '-', 'B'), 10);
assert.strictEqual(fl3.learnDone().error, 'vague', 'two full-size screens of different processes at once: refused');
fl3.learn(0);
fl3.tick(25000);
assert(fl3.learning.result && fl3.learning.result.error === 'none', 'learning times out after 20 s');
pack.close && pack.close();
console.log('osm_nav: all checks passed (Tbilisi - Batumi ' + Math.round(far.length / 1000) + ' km in ' + far.searchMs + ' ms; '
    + along.length + ' of ' + stations.length + ' fuel stations along it in ' + alongMs + ' ms, stop at ' + Math.round(stop.s / 1000) + ' km)');
