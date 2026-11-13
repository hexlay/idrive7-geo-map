'use strict';
// Navigation's turn arrows on the HUD (apps/osm_nav/hudturn.js + crclient.js) against a stand-in cluster-render on a
// local socket: the protocol's framing, the layer's place and size, the pixels (black see-through), and when the
// arrows give way (far from the turn, cruise control on the HUD, another navigation guiding, reverse, off).
// The service's refusal on a car it does not support. Needs no map and no car.   node kit/tools/test_hudturn.js
const assert = require('assert');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'osm_nav');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.indexOf(APP) === 0) {
        const m = /^\.\/kit\/(.+)$/.exec(request);
        if (m) return origResolve.call(this, path.join(ROOT, 'kit', 'runtime', m[1]), parent, ...rest);
    }
    return origResolve.call(this, request, parent, ...rest);
};
const { HudTurns, placeOf, cruiseShown, NW, NH } = require(path.join(APP, 'hudturn'));

const sockPath = (name) => (process.platform === 'win32' ? '\\\\.\\pipe\\' + name + '-' + process.pid : path.join(os.tmpdir(), name + '-' + process.pid + '.sock'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms) {
    const t0 = Date.now();
    while (!fn()) { if (Date.now() - t0 > (ms || 3000)) throw new Error('timed out: ' + what); await wait(10); }
}

/** A stand-in cluster-render: reads the client's messages, answers hello (or, unsupported, only status). */
function standIn(p, opts) {
    const got = { json: [], frames: [] };
    const send = (sock, obj) => { const j = Buffer.from(JSON.stringify(obj)), h = Buffer.alloc(5); h.writeUInt32LE(j.length + 1, 0); h[4] = 0x4A; sock.write(Buffer.concat([h, j])); };
    const srv = net.createServer((sock) => {
        let buf = Buffer.alloc(0);
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 5) {
                const n = buf.readUInt32LE(0);
                if (buf.length < 4 + n) break;
                const type = buf[4], body = buf.slice(5, 4 + n);
                buf = buf.slice(4 + n);
                if (type === 0x4A) {
                    const m = JSON.parse(body.toString());
                    got.json.push(m);
                    if (m.op === 'hello' && !opts.unsupported) send(sock, { ev: 'hello', proto: 1, backend: opts.backend || 'id7', targets: opts.targets || 'map:1088x480,panel:1920x720,hud:800x480' });
                    if (m.op === 'status') send(sock, { ev: 'status', text: opts.unsupported ? 'not supported on this car (head unit: test)' : 'ok' });
                    if (m.op === 'layer') send(sock, { ev: 'layer', ref: m.ref, state: 'shown' });
                } else if (type === 0x46) {
                    got.frames.push({ ref: body.readUInt32LE(0), rects: body.readUInt16LE(12), px: body.slice(14) });
                }
            }
        });
        sock.on('error', () => {});
    });
    srv.listen(p);
    return { srv, got, close: () => new Promise((r) => srv.close(r)) };
}

(async () => {
    // where the picture goes
    const p7 = placeOf('map:1088x480,panel:1920x720,hud:800x480');
    assert.deepStrictEqual(p7, { x: 672 - NW, y: 356 - NH, w: NW, h: NH }, 'iDrive 7: the glass\'s bottom right corner, clear of BMW\'s speed');
    const p8 = placeOf('map:874x749,hud:353x203,guide:702x213');
    assert(p8.x + p8.w <= 353 && p8.y + p8.h <= 203 && p8.w <= NW, 'iDrive 8: inside its 353x203 scene');
    assert.strictEqual(cruiseShown({ activeCruiseControl: { symbolACC: 'LDM_CAR_OFF', barsColorACC: 'LDM_OFF' }, cruiseCtrlSpeedHUD: 65535, statusLimiter: 'STATUS_INACTIVE' }), false, 'no cruise control');
    assert.strictEqual(cruiseShown({ activeCruiseControl: { symbolACC: 'LDM_CAR_WHITE' }, cruiseCtrlSpeedHUD: 90 }), true, 'cruise control on the HUD');

    const p = sockPath('cr-test');
    if (process.platform !== 'win32') { try { fs.unlinkSync(p); } catch (e) { /* none */ } }
    const S = standIn(p, {});
    const set = { hudArrows: 'near', hudCruise: 'yield' };
    const handlers = {};
    const log = { lines: [], info(s) { this.lines.push(s); }, warn(s) { this.lines.push('W ' + s); } };
    const ctx = {
        log, settings: { get: (k) => set[k] },
        signals: { watch: (iface, inst, h) => { handlers[iface] = h; return Promise.resolve({ shutdown() {} }); } },
    };
    let turn = { m: { type: 'turn', mod: 'right', angle: 90 }, dist: 450, name: 'Rustaveli Avenue', arrived: false, title: 'Home' };
    let rev = false;
    const hud = new HudTurns(ctx, { turn: () => turn, reversing: () => rev, imperial: () => false, lang: () => 'en' }, { path: p, check: false });

    // a turn 450 m ahead: connected, one image layer on the hud target, a whole frame of NW x NH RGBA
    hud.tick();
    await until(() => S.got.json.some((m) => m.op === 'hello'), 'hello');
    await until(() => hud.cr && hud.cr.ready, 'ready');
    hud.tick();
    await until(() => S.got.frames.length >= 1, 'the first frame');
    const hello = S.got.json.find((m) => m.op === 'hello');
    assert.strictEqual(hello.proto, 1); assert.strictEqual(hello.app, 'osm_nav');
    const layer = S.got.json.find((m) => m.op === 'layer');
    assert.strictEqual(layer.kind, 'image'); assert.strictEqual(layer.target, 'hud'); assert.strictEqual(layer.class, 'overlay');
    assert.deepStrictEqual([layer.x, layer.y, layer.w, layer.h, layer.iw, layer.ih], [p7.x, p7.y, NW, NH, NW, NH], 'the layer\'s place and image size');
    const fr = S.got.frames[0];
    assert.strictEqual(fr.ref, layer.ref); assert.strictEqual(fr.rects, 0, 'the whole image');
    assert.strictEqual(fr.px.length, NW * NH * 4, 'NW x NH RGBA');
    let clear = 0, lit = 0;
    for (let i = 3; i < fr.px.length; i += 4) { if (fr.px[i] === 0) clear++; else if (fr.px[i] === 255) lit++; }
    assert(clear > NW * NH * 0.6, 'mostly see-through (black is alpha 0): ' + clear);
    assert(lit > 300, 'the arrow and the text lit: ' + lit);
    assert(Object.keys(handlers).length === 4, 'the four give-way signals subscribed');

    // the same picture: nothing sent again; a new distance: one more frame (not before 1/FPS s)
    hud.tick(); await wait(50);
    assert.strictEqual(S.got.frames.length, 1, 'unchanged: no frame');
    turn = Object.assign({}, turn, { dist: 300 });
    await wait(260); hud.tick();
    await until(() => S.got.frames.length === 2, 'the next frame');

    const drops = () => S.got.json.filter((m) => m.op === 'drop').length;
    const layers = () => S.got.json.filter((m) => m.op === 'layer').length;
    const cycle = async (what, on, off, ms) => {
        const d0 = drops(), l0 = layers();
        on(); hud.tick();
        await until(() => drops() === d0 + 1, what + ': layer dropped', ms);
        assert(!hud.layer, what + ': no layer');
        off(); hud.tick();
        await until(() => layers() === l0 + 1, what + ': back');
    };
    // no flicker: a distance just past 1 km while shown (hysteresis), a cruise flag that comes and goes in a moment
    const DDS = handlers['de.bmw.infotainment.displaydataserver.DisplayDataServer'];
    turn = Object.assign({}, turn, { dist: 1100 }); hud.tick(); await wait(1200); hud.tick();
    assert(hud.layer, 'shown, 1100 m: still shown (it goes past 1150 m)');
    const dFlap = drops();
    DDS.functionalLibraryData({ activeCruiseControl: { symbolACC: 'LDM_CAR_WHITE' } }); hud.tick(); await wait(500);
    DDS.functionalLibraryData({ activeCruiseControl: { symbolACC: 'LDM_CAR_OFF' } }); hud.tick(); await wait(1500); hud.tick();
    assert.strictEqual(drops(), dFlap, 'cruise readout on for half a second: the picture stays');
    turn = Object.assign({}, turn, { dist: 400 });
    // a far turn and cruise control: the picture goes once the reason has held (5 s, 1 + 1.5 s)
    await cycle('far from the turn', () => { turn = Object.assign({}, turn, { dist: 2500 }); }, () => { turn = Object.assign({}, turn, { dist: 400 }); }, 9000);
    await cycle('cruise control on the HUD', () => DDS.functionalLibraryData({ activeCruiseControl: { symbolACC: 'LDM_CAR_WHITE' } }),
        () => { set.hudCruise = 'keep'; }, 6000);
    set.hudCruise = 'yield';
    DDS.functionalLibraryData({ activeCruiseControl: { symbolACC: 'LDM_CAR_OFF' } });
    await wait(3200); hud.tick();
    assert(!hud.cruise, 'cruise off once it has said so for 3 s');
    await cycle('BMW navigation guiding', () => handlers['de.bmw.infotainment.navigation.guiding.Guidance'].guidanceState('ACTIVE'), () => handlers['de.bmw.infotainment.navigation.guiding.Guidance'].guidanceState('INACTIVE'));
    await cycle('CarPlay guiding', () => handlers['de.bmw.infotainment.a4a.carplay.CarPlayManager'].projectedGuidanceActive(true), () => handlers['de.bmw.infotainment.a4a.carplay.CarPlayManager'].projectedGuidanceActive(false));
    await cycle('reverse', () => { rev = true; }, () => { rev = false; });
    await cycle('setting off', () => { set.hudArrows = 'off'; }, () => { set.hudArrows = 'route'; });
    // "route": a turn far ahead still shows; the arrival shows in "near" too
    turn = Object.assign({}, turn, { dist: 5000 }); hud.tick(); await wait(30);
    assert(hud.layer, 'whole route: shown 5 km before the turn');
    set.hudArrows = 'near'; turn = { m: { type: 'arrive' }, dist: 0, arrived: true, title: 'Home', name: '' };
    await wait(260); hud.tick(); assert(hud.layer, 'the arrival shows');
    // the route ends: the layer goes
    turn = null; const d1 = drops(); hud.tick();
    await until(() => drops() === d1 + 1, 'route over: dropped');
    assert(/Ready|no route/.test(hud.status()), 'status: ' + hud.status());
    hud.stop();
    await S.close();

    // a head unit cluster-render does not support: no hello, the status says why; the client stays quiet after
    const p2 = sockPath('cr-test-unsupported');
    if (process.platform !== 'win32') { try { fs.unlinkSync(p2); } catch (e) { /* none */ } }
    const U = standIn(p2, { unsupported: true });
    turn = { m: { type: 'turn', mod: 'left', angle: -90 }, dist: 200, name: 'X', arrived: false };
    const hud2 = new HudTurns(ctx, { turn: () => turn, reversing: () => false }, { path: p2, check: false });
    hud2.tick();
    await until(() => hud2.cr && hud2.cr.unsupported, 'unsupported', 6000);
    assert(/not supported/.test(hud2.status()), 'status names it: ' + hud2.status());
    assert.strictEqual(U.got.json.filter((m) => m.op === 'layer').length, 0, 'no layer asked for');
    hud2.stop();
    await U.close();
    console.log('hudturn: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
