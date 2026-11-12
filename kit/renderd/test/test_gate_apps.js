'use strict';
/* foreground_gate.js readApps: which uid an app's RHMI uuid is, from the installed apps' folders. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readApps } = require('../js/foreground_gate.js');

// the gate runs on the head unit's Node 8 (8.9.4 / 8.16.2), so this test does too: no recursive mkdir or rmSync there
const mkdirp = (d) => { if (fs.existsSync(d)) return; mkdirp(path.dirname(d)); fs.mkdirSync(d); };
const rmrf = (p) => { let st; try { st = fs.lstatSync(p); } catch (e) { return; } if (st.isDirectory()) { fs.readdirSync(p).forEach((f) => rmrf(path.join(p, f))); fs.rmdirSync(p); } else fs.unlinkSync(p); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-apps-'));
const app = (uid, uuid) => {
    mkdirp(path.join(root, `oap_${uid}`, 'rhmiData'));
    fs.writeFileSync(path.join(root, `oap_${uid}`, 'rhmiData', 'application.json'), JSON.stringify({ application: { uuid } }));
};
const registered = (appId, uid) => {
    mkdirp(path.join(root, 'oap_12201', 'data', 'apps'));
    fs.writeFileSync(path.join(root, 'oap_12201', 'data', 'apps', `${appId}.json`), JSON.stringify({ userId: uid }));
};
const logs = [];
app(12301, 'u-one');
app(12302, 'u-two');
app(12303, 'u-two');            // an earlier install of the same app, its folder left behind
app(12304, 'u-three');
app(12305, 'u-three');          // two folders, neither registered
app(12306, 'u-four');
app(12307, 'u-four');           // two folders, both registered: an app claiming another's uuid
app(12308, 'u-five');
app(12309, 'u-five');
app(12310, 'u-five');           // two earlier installs left behind
registered('two', 12303);
registered('four-a', 12306);
registered('four-b', 12307);
registered('five', 12309);
const apps = readApps(root, (l) => logs.push(l));
assert.strictEqual(apps.get('u-one'), 12301, 'one folder: its uid');
assert.strictEqual(apps.get('u-two'), 12303, 'two folders: the one the app manager has registered');
assert.strictEqual(apps.get('u-five'), 12309, 'three folders: the one the app manager has registered');
assert.strictEqual(apps.has('u-three'), false, 'two folders, none registered: left out');
assert.strictEqual(apps.has('u-four'), false, 'two folders, both registered: left out');
assert.ok(logs.some((l) => /u-three/.test(l)) && logs.some((l) => /u-four/.test(l)), logs.join('\n'));
assert.ok(!logs.some((l) => /u-one|u-two|u-five/.test(l)), logs.join('\n'));
rmrf(root);
console.log('test_gate_apps: 6 checks pass');
