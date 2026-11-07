'use strict';
/**
 * Navigation (osm_nav) - standalone offline OpenStreetMap navigation for BMW iDrive 7 (MGU). Node 8.
 *
 * Pages (header tabs): Map, Search, Route; Settings from the kit.
 *   Map     the GPU vector map (map_view.js), heading-up or north-up round the car, with the maneuver
 *           card, the speed limit sign, the trip bar and the map buttons (hud.js). A finger pans it, a tap
 *           picks a place (Go / Save / Home / Work / I'm here), + and - zoom; the controller: turn to zoom
 *           while on the map, press for the crosshair, push to move it, press again to pick that place.
 *   Search  offline search (search.js) with an on-screen keyboard in Latin, Georgian and coordinates,
 *           quick categories (fuel, charging, parking ...), Home, Work, favourites and recent places.
 *   Route   turn-by-turn maneuver step list, route preferences (Fastest / Avoid tolls / Avoid motorways),
 *           saved places, GPS/Dead-Reckoning status, and one-tap physical NAV button binding.
 *
 * Routes (router.js) are planned on the car from the map pack (kit/tools/pack_osm.py), followed with
 * off-route detection and a new plan when the car leaves them. Position (gps.js): the car's signals
 * with map matching and dead reckoning, or the Tbilisi demo drive (VM, emulator, preview).
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { MapPack, merc, unmerc, groundScale } = require('./mappack');
const { Router, Guidance, turnAngle } = require('./router');
const { MapView, poiIcon } = require('./map_view');
const { Position, TOUR } = require('./gps');
const { Search, CATEGORIES, kindName, KIND } = require('./search');
const navkey = require('./navkey');
const H = require('./hud');

const W = 1600, PH = 520;
const PAGES = ['Map', 'Search', 'Route'];
const TOP = 38;                       // the page below the tab strip (the header takes it on the GPU layout)
const KEYS = {
    en: ['1234567890.', 'qwertyuiop', 'asdfghjkl,', 'zxcvbnm-'],
    ka: ['1234567890.', 'ქწერტყუიოპ', 'ასდფგჰჯკლ,', 'ზხცვბნმ', 'ჭღთშჟძჩ'],
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        if (!ctx.app && settings.get('demo') === 'on') ctx.previewDemo = true;
        const kOf = (cv) => (cv.ui && cv.ui.k) || 1.44;

        /* ---------- map packs: the app's own and those downloaded into the data folder ---------- */
        const packs = [];
        const openPack = (f) => {
            try {
                const p = MapPack.open(f);
                packs.push(p);
                log.info('map ' + path.basename(f) + ': ' + p.meta.region + ', ' + p.meta.counts.nodes + ' nodes, ' + p.meta.counts.edges + ' edges (' + p.meta.source + ')');
                return p;
            } catch (e) { log.warn('map ' + path.basename(f) + ': ' + e.message); return null; }
        };
        try { fs.readdirSync(__dirname).filter((f) => /\.pack$/.test(f)).sort().forEach((f) => openPack(path.join(__dirname, f))); } catch (e) { /* none */ }
        try { fs.readdirSync(path.join(ctx.dataDir, 'maps')).filter((f) => /\.pack$/.test(f)).forEach((f) => openPack(path.join(ctx.dataDir, 'maps', f))); } catch (e) { /* none */ }
        if (!packs.length) log.error('no map pack: build one with kit/tools/pack_osm.py');
        const routers = new Map();
        const routerFor = (p) => { let r = routers.get(p); if (!r) { const t = Date.now(); r = new Router(p, { cacheDir: ctx.dataDir }); routers.set(p, r); log.info('router for ' + p.meta.region + ' ready in ' + (Date.now() - t) + ' ms'); } return r; };
        let pack = packs[0] || null;
        const packAt = (x, y) => packs.find((p) => p.covers(x, y, 2000)) || null;

        const view = new MapView(packs);
        const nav = { get pack() { return pack; }, get router() { return pack && routerFor(pack); }, route: () => S.route, packs: () => packs };
        const pos = new Position(ctx, nav);
        const search = pack ? new Search(pack, ctx.dataDir) : null;

        /* ---------- state ---------- */
        // the NAV button's pattern: learned on the car (data folder), else app.json config.navButton.match
        const navCfg = (ctx.spec.config && ctx.spec.config.navButton) || {};
        const navBtnFile = path.join(ctx.dataDir || '.', 'nav_button.json');
        let navKey = null;
        try {
            const nb = JSON.parse(fs.readFileSync(navBtnFile, 'utf8'));
            if (nb && nb.match && navkey.parse(nb.match)) navKey = { text: nb.match, pairs: navkey.parse(nb.match), source: nb.source || '' };
        } catch (e) { /* none learned yet */ }
        if (!navKey && navkey.parse(navCfg.match)) navKey = { text: navCfg.match, pairs: navkey.parse(navCfg.match), source: 'app.json' };

        const S = {
            route: null, guide: null, g: null, dest: null, cancelledTour: false, lastPlan: 0, toast: null,
            follow: true, lastTouch: 0, userZoomAt: 0, overview: false, crosshair: false, sel: null,
            query: '', kbd: settings.get('mapLang') === 'en' ? 'en' : 'ka', results: [], scroll: 0, cat: null,
            routeScroll: 0, learn: null, learnSource: '', navKey,
            lastFrame: Date.now(), arrivedAt: 0, confirmClear: 0,
        };
        const start0 = pack ? merc(41.7019, 44.7938) : [0, 0];
        view.camera = { x: start0[0], y: start0[1], mpp: 1.6, heading: 0 };
        let zoomLog = Math.log2(1.6);
        let zoomWant = zoomLog;
        const lang = () => settings.get('mapLang') || 'ka';
        const ulang = () => (lang() === 'ka' ? 'ka' : 'en');
        const imperial = () => settings.get('units') === 'imperial';
        const headUp = () => settings.get('orientation') !== 'north';
        const toast = (text, ms) => { S.toast = { text, until: Date.now() + (ms || 3500) }; };
        const demo = () => pos.wantDemo();

        /* ---------- routes ---------- */
        function plan(place, opts) {
            opts = opts || {};
            const fix = pos.fix();
            if (!fix) { toast(ulang() === 'ka' ? 'მდებარეობა უცნობია: მონიშნეთ რუკაზე ("მე აქ ვარ")' : 'Position unknown: tap the map and choose "I\'m here"'); return false; }
            const p = packAt(place.x, place.y);
            if (!p || !p.covers(fix.x, fix.y, 2000)) { toast(ulang() === 'ka' ? 'დანიშნულება დაყენებული რუკის გარეთაა' : 'That place is outside the installed map'); return false; }
            pack = p;
            const R = routerFor(p);
            const a = R.snap(fix.x, fix.y, fix.speed > 4 || fix.source !== 'dr' ? fix.heading : null, 500), b = R.snap(place.x, place.y, null, 3000);
            if (!a || !b) { toast(H.tr(ulang()).noRoute); return false; }
            const t = Date.now();
            const route = R.route(a, b, { avoid: settings.get('avoid'), vias: opts.vias });
            if (!route) { toast(H.tr(ulang()).noRoute); return false; }
            log.info('route: ' + (route.length / 1000).toFixed(1) + ' km, ' + Math.round(route.duration / 60) + ' min, ' + route.maneuvers.length + ' maneuvers, planned in ' + (Date.now() - t) + ' ms (search ' + route.searchMs + ' ms)');
            S.route = route; S.guide = new Guidance(R, route); S.g = null; S.dest = place; S.lastPlan = Date.now(); S.arrivedAt = 0; S.routeScroll = 0;
            if (!opts.quiet) { S.follow = true; S.overview = false; S.sel = null; S.crosshair = false; }
            return true;
        }
        function navigateTo(place) {
            if (!plan(place)) return false;
            if (search && !place.tour) search.addRecent(Search.place(place.title, place.sub, place.x, place.y));
            page = 0;
            return true;
        }
        function cancelRoute() {
            if (S.dest && S.dest.tour) S.cancelledTour = true;
            S.route = null; S.guide = null; S.g = null; S.dest = null; S.routeScroll = 0;
        }
        function startTour() {
            if (!pack || S.route || S.cancelledTour) return;
            const r = pos.tourRoute();
            if (!r) return;
            S.route = r; S.guide = new Guidance(routerFor(pack), r); S.g = null; S.arrivedAt = 0; S.routeScroll = 0;
            const end = r.at(r.length);
            S.dest = { title: lang() === 'en' ? TOUR.destName.latin : TOUR.destName.local, x: end.x, y: end.y, tour: true };
        }
        pos.onDemoEnd = () => { if (S.dest && S.dest.tour) { S.route = null; S.dest = null; startTour(); } };

        /* ---------- camera ---------- */
        function updateCamera(dt, fix, mh) {
            const cam = view.camera, now = Date.now();
            if (!S.follow && !S.crosshair && now - S.lastTouch > 20000) { S.follow = true; S.overview = false; }
            if (fix && !S.camInit) {
                // the first fix: straight there, no glide in from the map's default place
                S.camInit = true;
                cam.x = fix.x; cam.y = fix.y; cam.heading = headUp() ? fix.heading : 0;
            }
            if (S.follow && fix) {
                const k = Math.min(1, dt * 6);
                cam.x += (fix.x - cam.x) * (Math.hypot(fix.x - cam.x, fix.y - cam.y) > 3000 ? 1 : k * 1.5 > 1 ? 1 : k * 1.5);
                cam.y += (fix.y - cam.y) * (Math.hypot(fix.x - cam.x, fix.y - cam.y) > 3000 ? 1 : k * 1.5 > 1 ? 1 : k * 1.5);
                const want = headUp() ? fix.heading : 0;
                cam.heading = (cam.heading + turnAngle(cam.heading, want) * Math.min(1, dt * 3) + 360) % 360;
                // auto zoom: out with speed, in for a turn coming up
                if (settings.get('autoZoom') !== false && now - S.userZoomAt > 15000) {
                    let m = 0.75 + Math.max(0, fix.speed - 20) / 45;
                    if (S.g && S.route) {
                        const M = S.route.maneuvers[S.g.next];
                        if (M && M.type !== 'arrive' && S.g.dist < 300) m = Math.min(m, 0.7 + S.g.dist / 600);
                    }
                    zoomWant = Math.log2(Math.max(0.55, Math.min(6, m)) / groundScale(cam.y));
                }
            } else if (!headUp() || S.overview) cam.heading = (cam.heading + turnAngle(cam.heading, 0) * Math.min(1, dt * 4) + 360) % 360;
            zoomLog += (zoomWant - zoomLog) * Math.min(1, dt * 5);
            cam.mpp = Math.pow(2, zoomLog);
            void mh;
        }
        function zoomBy(steps) { zoomWant = Math.max(Math.log2(0.25), Math.min(Math.log2(3000), zoomWant + steps)); S.userZoomAt = Date.now(); kick(); }
        function overview() {
            if (!S.route) return;
            const p = S.route.pts;
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
            view.camera.x = (x0 + x1) / 2; view.camera.y = (y0 + y1) / 2;
            zoomWant = Math.log2(Math.max((x1 - x0) / 1100, (y1 - y0) / 330, 0.6));
            S.follow = false; S.overview = true; S.lastTouch = Date.now(); S.userZoomAt = Date.now();
        }

        /* ---------- input ---------- */
        let page = 0;
        let lastVp = null;
        function pickAt(sx, sy) {
            if (!lastVp || !pack) return;
            const w = view.toWorld(sx, sy);
            const P = packAt(w[0], w[1]) || pack;
            // a named place near the tap, else the street there
            let best = null, bd = 34 * view.camera.mpp;
            const D = P.searchData();
            for (const e of D.entries) {
                const d = Math.hypot(e.x - w[0], e.y - w[1]);
                if (d < bd && e.kind !== KIND.STREET && e.kind > KIND.HAMLET) { bd = d; best = e; }
            }
            let sel;
            if (best) {
                sel = { title: P.label(best.name, lang()) || kindName(best.kind, ulang()), sub: kindName(best.kind, ulang()) + (best.ctx ? ', ' + P.label(best.ctx, lang()) : ''), x: best.x, y: best.y, kind: best.kind };
            } else {
                const s = routerFor(P).snap(w[0], w[1], null, 80);
                const name = s ? P.label(P.graph.name[s.edge], lang()) : '';
                const ll = unmerc(w[0], w[1]);
                sel = { title: name || ll[0].toFixed(5) + ', ' + ll[1].toFixed(5), sub: name ? ll[0].toFixed(5) + ', ' + ll[1].toFixed(5) : (ulang() === 'ka' ? 'რუკაზე' : 'On the map'), x: s ? s.x : w[0], y: s ? s.y : w[1] };
            }
            S.sel = sel;
            kick();
        }
        ctx.onDrag((phase, dx, dy, x, y) => {
            if (page !== 0) return;
            if (phase === 'move') {
                const a = view.toWorld(x - dx, y - dy), b = view.toWorld(x, y);
                view.camera.x -= b[0] - a[0]; view.camera.y -= b[1] - a[1];
                S.follow = false; S.lastTouch = Date.now();
            }
        });
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; S.sel = null; return render(); });
        ctx.onTab((i) => { page = i; S.sel = null; S.crosshair = false; return render(); });
        const resultsGeo = { rows: 0, rowH: 1, count: 0 };
        const routeGeo = { rows: 0, rowH: 1, count: 0 };
        let scrollAcc = 0;
        ctx.onScroll((dy) => {
            if (page !== 1 && page !== 2) return false;
            const geo = page === 1 ? resultsGeo : routeGeo;
            const cur = page === 1 ? S.scroll : S.routeScroll;
            const max = Math.max(0, geo.count - geo.rows);
            scrollAcc += dy;
            const n = scrollAcc > 0 ? Math.floor(scrollAcc / geo.rowH) : Math.ceil(scrollAcc / geo.rowH);
            if (!n) return (dy > 0 && cur < max) || (dy < 0 && cur > 0);
            scrollAcc -= n * geo.rowH;
            const next = Math.max(0, Math.min(max, cur + n));
            if (page === 1) S.scroll = next; else S.routeScroll = next;
            return next !== cur;
        });

        /* ---------- drawing helpers ---------- */
        const fit = (cv, text, maxW, size, opt) => {
            const o = Object.assign({ literal: true }, opt || {});
            if (cv.textWidth(text, size, o) <= maxW) return text;
            let s = String(text);
            while (s.length > 1 && cv.textWidth(s + '..', size, o) > maxW) s = s.slice(0, -1);
            return s + '..';
        };
        const panel = (cv, x, y, w, h, rad) => {
            cv.roundRect(x, y + 3, w, h, rad, '#00000040');
            cv.roundRect(x, y, w, h, rad, withAlpha('#0e1218', 0.94));
            cv.strokeRoundRect(x, y, w, h, rad, 1.2, withAlpha('#ffffff', 0.12));
        };
        const button = (cv, t, x, y, w, h, label, run, key, opts) => {
            const o = opts || {};
            const fill = o.primary ? (o.color || '#1f6fd6') : withAlpha('#ffffff', 0.08);
            cv.roundRect(x, y, w, h, Math.min(h / 2, 14), fill);
            if (!o.primary) cv.strokeRoundRect(x, y, w, h, Math.min(h / 2, 14), 1.2, withAlpha('#ffffff', 0.25));
            const sz = o.size || Math.round(h * 0.36);
            cv.text(fit(cv, label, w - 16, sz, { font: 'bold' }), x + w / 2, y + h / 2 + sz * 0.36, sz, o.primary ? '#ffffff' : t.text, { literal: true, font: 'bold', align: 'center' });
            if (run) cv.target(x, y, w, h, run, key, Math.min(h / 2, 14));
        };

        /* ---------- the map page ---------- */
        function drawMap(cv, t, fix, dt) {
            const k = kOf(cv), sz = (n) => Math.round(n * k);
            const bottom = PH + (cv.extra || 0), mh = bottom - TOP;
            const hu = headUp() && S.follow && !S.overview;
            const vp = { x: 0, y: TOP, w: W, h: mh, cx: W / 2 + (S.route && S.follow ? sz(90) : 0), cy: TOP + mh * (hu ? 0.68 : 0.52) };
            if (!S.follow) vp.cx = W / 2;
            lastVp = vp;
            updateCamera(dt, fix, mh);
            const st = settings.get('mapStyle');
            const hr = new Date().getHours();
            view.style = st === 'day' ? 'day' : st === 'night' ? 'night' : hr >= 7 && hr < 19 ? 'day' : 'night';
            view.lang = lang();
            cv.drag = true;
            // the map itself: drags, taps; the controller zooms with the knob, pushes the crosshair
            cv.target(0, TOP, W, mh, (at) => {
                if (at) { pickAt(at.x, at.y + TOP); return; }
                if (S.crosshair) { pickAt(vp.cx, vp.cy); S.crosshair = false; } else { S.crosshair = true; S.follow = false; S.lastTouch = Date.now(); }
                kick();
            }, 'map', 0);
            const mt = cv.targets[cv.targets.length - 1];
            mt.drag = true;
            mt.knob = (d) => zoomBy(-d * 0.5);
            mt.tilt = (dir) => {
                if (!S.crosshair) return false;
                const step = 80, dx = dir === 'E' ? step : dir === 'W' ? -step : 0, dy = dir === 'S' ? step : dir === 'N' ? -step : 0;
                const a = view.toWorld(vp.cx, vp.cy), b = view.toWorld(vp.cx + dx, vp.cy + dy);
                view.camera.x += b[0] - a[0]; view.camera.y += b[1] - a[1];
                S.lastTouch = Date.now();
                return true;
            };
            // HUD boxes (labels keep out of them)
            const cardW = Math.min(sz(330), 520), cardX = sz(12), cardY = TOP + sz(10);
            const tripH = sz(58), tripY = bottom - tripH - sz(10);
            const avoid = [{ x: W - sz(80), y: TOP, w: sz(80), h: mh }, { x: 0, y: tripY - 10, w: W, h: tripH + 20 }];
            const hasCard = !!(S.route && S.g);
            if (hasCard) avoid.push({ x: cardX, y: cardY, w: cardW, h: sz(200) });
            avoid.push({ x: 0, y: cardY, w: sz(96), h: sz(300) });      // the speed limit sign under the card
            const routeS = S.g ? S.g.s : 0;
            view.draw(cv, vp, {
                route: S.route, routeS, car: fix ? { x: fix.x, y: fix.y, heading: fix.heading } : null,
                dest: S.dest, avoid, scale: Math.max(1, k / 1.2), pins: S.sel ? [{ x: S.sel.x, y: S.sel.y, color: '#1f6fd6' }] : null,
            });
            if (S.crosshair) {
                const c = '#ffffff';
                cv.circle(vp.cx, vp.cy, sz(16), withAlpha('#000000', 0.25));
                cv.line(vp.cx - sz(22), vp.cy, vp.cx - sz(6), vp.cy, 2.5, c); cv.line(vp.cx + sz(6), vp.cy, vp.cx + sz(22), vp.cy, 2.5, c);
                cv.line(vp.cx, vp.cy - sz(22), vp.cx, vp.cy - sz(6), 2.5, c); cv.line(vp.cx, vp.cy + sz(6), vp.cx, vp.cy + sz(22), 2.5, c);
            }
            // maneuver card
            const T = H.tr(ulang());
            let sliY = cardY + sz(36);
            if (hasCard) {
                const M = S.route.maneuvers, m = M[S.g.next], g = S.g;
                const arrived = g.arrived;
                const ch = sz(arrived ? 112 : 150);
                panel(cv, cardX, cardY, cardW, ch, sz(16));
                const as = sz(86);
                cv.roundRect(cardX + sz(10), cardY + sz(10), as + sz(8), as + sz(8), sz(12), withAlpha('#1f6fd6', 0.95));
                H.arrow(cv, cardX + sz(14) + as / 2, cardY + sz(14) + as / 2, as * 0.86, arrived ? { type: 'arrive' } : m, '#ffffff', withAlpha('#ffffff', 0.35));
                if (m.type === 'roundabout' && !arrived) {
                    const bx = cardX + sz(10) + as + sz(8) - sz(14), by = cardY + sz(18);
                    cv.circle(bx, by, sz(13), '#ffffff');
                    cv.text(String(m.exit), bx, by + sz(6), sz(17), '#1f6fd6', { literal: true, font: 'bold', align: 'center' });
                }
                const tx = cardX + as + sz(30), tw = cardX + cardW - tx - sz(12);
                if (arrived) {
                    cv.text(fit(cv, T.arrived, tw, sz(24), { font: 'bold' }), tx, cardY + sz(46), sz(24), '#ffffff', { literal: true, font: 'bold' });
                    cv.text(fit(cv, S.dest ? S.dest.title : '', tw, sz(16)), tx, cardY + sz(76), sz(16), '#aeb6c1', { literal: true });
                } else {
                    const dd = H.fmtDist(g.dist, imperial());
                    const dw = cv.textWidth(dd[0], sz(38), { literal: true, font: 'bold' });
                    cv.text(dd[0], tx, cardY + sz(48), sz(38), '#ffffff', { literal: true, font: 'bold' });
                    cv.text(dd[1], tx + dw + sz(6), cardY + sz(48), sz(20), '#c9d1db', { literal: true, font: 'bold' });
                    cv.text(fit(cv, H.phrase(m, ulang()), tw, sz(15)), tx, cardY + sz(74), sz(15), '#aeb6c1', { literal: true });
                    const nm = m.type === 'arrive' ? (S.dest ? S.dest.title : '') : (pack.label(m.name, lang()) || pack.label(m.ref, lang() === 'en' ? 'en' : 'ka').split(';')[0] || '');
                    cv.text(fit(cv, nm, cardW - sz(24), sz(19), { font: 'bold' }), cardX + sz(14), cardY + sz(126), sz(19), '#ffffff', { literal: true, font: 'bold' });
                    // and then: a second maneuver close behind the first
                    const n2 = M[S.g.next + 1];
                    if (n2 && n2.at - m.at < 220 && m.type !== 'arrive') {
                        const y2 = cardY + ch + sz(6), h2 = sz(40);
                        panel(cv, cardX, y2, sz(170), h2, sz(12));
                        cv.text(T.then, cardX + sz(12), y2 + h2 / 2 + sz(5), sz(14), '#aeb6c1', { literal: true });
                        H.arrow(cv, cardX + sz(140), y2 + h2 / 2, sz(30), n2, '#ffffff', withAlpha('#ffffff', 0.35));
                        sliY = y2 + h2 + sz(10);
                    } else sliY = cardY + ch + sz(10);
                }
            }
            // speed limit sign (the road the car is on)
            const lim = fix && fix.maxspeed ? fix.maxspeed : 0;
            if (lim && lim < 200) {
                const rr = sz(31);
                H.sli(cv, cardX + rr + sz(4), sliY + rr + sz(2), rr, lim, fix.speed > lim + 3, imperial());
            }
            // the street the car is on, when there is no card
            if (!hasCard && fix && fix.name) {
                const nm = pack.label(fix.name, lang());
                if (nm) {
                    const s2 = sz(17), w2 = Math.min(W * 0.5, cv.textWidth(nm, s2, { literal: true, font: 'bold' }) + sz(36));
                    panel(cv, (W - w2) / 2, tripY - sz(50), w2, sz(38), sz(19));
                    cv.text(fit(cv, nm, w2 - sz(24), s2, { font: 'bold' }), W / 2, tripY - sz(50) + sz(25), s2, '#ffffff', { literal: true, font: 'bold', align: 'center' });
                }
            }
            // map buttons (right): compass, zoom, back to the car
            const br = sz(24), bx = W - sz(14) - br;
            let by = TOP + sz(14) + br;
            H.compass(cv, bx, by, br, view.camera.heading, headUp());
            cv.target(bx - br, by - br, br * 2, br * 2, () => { settings.set('orientation', headUp() ? 'north' : 'heading'); kick(); }, 'compass', br);
            by += br * 2 + sz(12);
            H.roundButton(cv, bx, by, br, t, '+');
            cv.target(bx - br, by - br, br * 2, br * 2, () => zoomBy(-1), 'zin', br);
            by += br * 2 + sz(10);
            H.roundButton(cv, bx, by, br, t, '-');
            cv.target(bx - br, by - br, br * 2, br * 2, () => zoomBy(1), 'zout', br);
            if (!S.follow) {
                by += br * 2 + sz(12);
                H.roundButton(cv, bx, by, br, t, 'locate');
                cv.target(bx - br, by - br, br * 2, br * 2, () => { S.follow = true; S.overview = false; S.crosshair = false; S.userZoomAt = 0; kick(); }, 'recenter', br);
            }
            // trip bar
            drawTrip(cv, t, fix, tripY, tripH, k);
            if (S.sel) drawSel(cv, t, k, tripY);
        }

        function drawTrip(cv, t, fix, y, h, k) {
            const sz = (n) => Math.round(n * k), T = H.tr(ulang());
            const x = sz(12), w = W - sz(24);
            panel(cv, x, y, w, h, sz(14));
            let cx = x + sz(18);
            const big = sz(22), small = sz(12), base = y + h / 2 + sz(4);
            const stat = (val, unit, label, color) => {
                const vw = cv.textWidth(val, big, { literal: true, font: 'bold' });
                cv.text(val, cx, base, big, color || '#ffffff', { literal: true, font: 'bold' });
                cv.text(unit, cx + vw + sz(4), base, small + 2, '#c9d1db', { literal: true, font: 'bold' });
                cv.text(label, cx, y + h - sz(7), small, '#8f99a6', { literal: true });
                cx += Math.max(vw + cv.textWidth(unit, small + 2, { literal: true, font: 'bold' }) + sz(30), sz(96));
            };
            if (S.route && S.g) {
                const eta = new Date(Date.now() + S.g.secs * 1000);
                stat(H.clock(eta), '', T.eta);
                const d = H.fmtDist(S.g.left, imperial());
                stat(d[0], d[1], T.left_);
                const du = H.fmtDur(S.g.secs);
                stat(du[0], du[1], '');
            } else {
                const ll = fix ? unmerc(fix.x, fix.y) : null;
                cv.text(ll ? ll[0].toFixed(4) + ', ' + ll[1].toFixed(4) : (ulang() === 'ka' ? 'მდებარეობა უცნობია' : 'No position'), cx, base, sz(16), '#c9d1db', { literal: true });
                cx += sz(230);
            }
            // speed (red over the limit)
            if (fix) {
                const v = imperial() ? fix.speed / 1.609 : fix.speed;
                const over = fix.maxspeed && fix.speed > fix.maxspeed + 3;
                stat(String(Math.round(v)), imperial() ? 'mph' : 'km/h', '', over ? '#ff4d4d' : '#ffffff');
            }
            // buttons, from the right
            const bh = h - sz(14), byy = y + sz(7);
            let rx = x + w - sz(8);
            const btn = (label, run, key, o) => {
                const bw = Math.max(sz(96), cv.textWidth(label, Math.round(bh * 0.36), { literal: true, font: 'bold' }) + sz(30));
                rx -= bw;
                button(cv, t, rx, byy, bw, bh, label, run, key, o);
                rx -= sz(8);
            };
            const L = ulang() === 'ka';
            if (S.route) {
                btn(L ? 'გაუქმება' : 'Cancel', () => { cancelRoute(); kick(); }, 'cancel', { color: '#b3261e', primary: true });
                btn(S.overview ? (L ? 'მიყოლა' : 'Follow') : (L ? 'მიმოხილვა' : 'Overview'), () => { if (S.overview) { S.follow = true; S.overview = false; } else overview(); kick(); }, 'overview');
            } else {
                const P = search && search.places;
                if (P && P.work) btn(L ? 'სამსახური' : 'Work', () => navigateTo(P.work), 'work');
                if (P && P.home) btn(L ? 'სახლი' : 'Home', () => navigateTo(P.home), 'home');
                if (demo() && S.cancelledTour) btn(L ? 'დემო ტური' : 'Demo tour', () => { S.cancelledTour = false; startTour(); kick(); }, 'tour');
            }
            btn(L ? 'ძიება' : 'Search', () => { page = 1; kick(); }, 'search', { primary: true });
        }

        /** The place picked on the map (or in Search): Go, Save, Home, Work, I'm here. */
        function drawSel(cv, t, k, tripY) {
            const sz = (n) => Math.round(n * k), L = ulang() === 'ka';
            const w = Math.min(sz(560), W - sz(140)), h = sz(126), x = sz(12), y = tripY - h - sz(12);
            panel(cv, x, y, w, h, sz(16));
            const sel = S.sel, fix = pos.fix();
            cv.text(fit(cv, sel.title, w - sz(70), sz(20), { font: 'bold' }), x + sz(16), y + sz(32), sz(20), '#ffffff', { literal: true, font: 'bold' });
            let sub = sel.sub || '';
            if (fix) { const d = H.fmtDist(Math.hypot(sel.x - fix.x, sel.y - fix.y) * groundScale(fix.y), imperial()); sub += (sub ? '  ·  ' : '') + d[0] + ' ' + d[1]; }
            cv.text(fit(cv, sub, w - sz(30), sz(14)), x + sz(16), y + sz(56), sz(14), '#aeb6c1', { literal: true });
            // close
            cv.text('x', x + w - sz(24), y + sz(30), sz(20), '#aeb6c1', { literal: true, font: 'bold', align: 'center' });
            cv.target(x + w - sz(48), y, sz(48), sz(48), () => { S.sel = null; kick(); }, 'selclose', sz(12));
            const bh = sz(42), by = y + h - bh - sz(12);
            let bx = x + sz(14);
            const b = (label, run, key, o) => {
                const bw = Math.max(sz(84), cv.textWidth(label, Math.round(bh * 0.36), { literal: true, font: 'bold' }) + sz(26));
                button(cv, t, bx, by, bw, bh, label, run, key, o);
                bx += bw + sz(8);
            };
            const place = Search.place(sel.title, sel.sub, sel.x, sel.y);
            b(L ? 'წასვლა' : 'Go', () => { navigateTo(Object.assign({}, sel)); kick(); }, 'go', { primary: true });
            b(L ? 'შენახვა' : 'Save', () => { search.addFav(place); toast(L ? 'შენახულია' : 'Saved to favourites'); S.sel = null; kick(); }, 'fav');
            b(L ? 'სახლი' : 'Home', () => { search.setHome(place); toast(L ? 'სახლი შენახულია' : 'Saved as Home'); S.sel = null; kick(); }, 'sethome');
            b(L ? 'სამსახური' : 'Work', () => { search.setWork(place); toast(L ? 'სამსახური შენახულია' : 'Saved as Work'); S.sel = null; kick(); }, 'setwork');
            if (!demo()) b(L ? 'მე აქ ვარ' : "I'm here", () => { if (pos.setHere(sel.x, sel.y)) toast(L ? 'მდებარეობა დაყენებულია' : 'Position set'); S.sel = null; S.follow = true; kick(); }, 'here');
        }

        /* ---------- the search page ---------- */
        function runSearch() {
            const fix = pos.fix();
            S.results = search && S.query.trim() ? search.find(S.query, fix ? { x: fix.x, y: fix.y } : { x: view.camera.x, y: view.camera.y }, 40) : [];
            S.scroll = 0; S.cat = null;
        }
        function choose(r) {
            S.sel = { title: r.title ? r.title(lang()) : r.title, sub: r.sub ? (typeof r.sub === 'function' ? r.sub(lang()) : r.sub) : '', x: r.x, y: r.y };
            if (typeof r.title === 'string') S.sel.title = r.title;
            page = 0; S.follow = false; S.overview = false; S.lastTouch = Date.now();
            view.camera.x = r.x; view.camera.y = r.y; zoomWant = Math.log2(1.2 / groundScale(r.y)); S.userZoomAt = Date.now();
            kick();
        }
        function drawSearch(cv, t, fix) {
            const k = kOf(cv), sz = (n) => Math.round(n * k), L = ulang() === 'ka';
            const bottom = PH + (cv.extra || 0), top = TOP + sz(6);
            cv.fillRect(0, TOP, W, bottom - TOP, '#0b0e13');
            const moving = fix && fix.source !== 'demo' && fix.speed > 8;
            const kw = Math.round(W * 0.55), lx = sz(12);
            // the query
            const qh = sz(52);
            panel(cv, lx, top, kw - lx, qh, sz(12));
            const q = S.query;
            const qs = sz(22);
            if (q) {
                const shown = fit(cv, q, kw - lx - sz(120), qs);
                const qw = cv.text(shown, lx + sz(18), top + qh / 2 + qs * 0.36, qs, '#ffffff', { literal: true });
                if (Math.floor(Date.now() / 530) % 2 === 0) cv.fillRect(lx + sz(20) + qw, top + sz(12), 2, qh - sz(24), '#2f8cff');
            } else cv.text(L ? 'ქუჩა, ადგილი, ქალაქი ან კოორდინატები...' : 'Street, place, city, or lat, lon...', lx + sz(18), top + qh / 2 + qs * 0.36, qs, '#6b7480', { literal: true });
            if (q) button(cv, t, kw - sz(96), top + sz(8), sz(80), qh - sz(16), L ? 'წაშლა' : 'Clear', () => { S.query = ''; runSearch(); kick(); }, 'qclear');
            // keyboard (locked while driving)
            const ky = top + qh + sz(10), kh = bottom - ky - sz(10);
            if (moving) {
                panel(cv, lx, ky, kw - lx, kh, sz(14));
                cv.text(L ? 'კლავიატურა მოძრაობისას დაბლოკილია' : 'The keyboard is locked while driving', lx + (kw - lx) / 2, ky + kh / 2 - sz(8), sz(19), '#ffffff', { literal: true, font: 'bold', align: 'center' });
                cv.text(L ? 'გამოიყენეთ კატეგორიები ან შენახული ადგილები' : 'Use the categories or saved places on the right', lx + (kw - lx) / 2, ky + kh / 2 + sz(22), sz(14), '#aeb6c1', { literal: true, align: 'center' });
            } else {
                const rows = KEYS[S.kbd].concat(['__bottom']);
                const rh = Math.floor(kh / rows.length), gap = sz(6);
                rows.forEach((row, ri) => {
                    const y = ky + ri * rh;
                    if (row === '__bottom') {
                        const keys = [[S.kbd === 'ka' ? 'ABC' : 'ქართ', 1.4, () => { S.kbd = S.kbd === 'ka' ? 'en' : 'ka'; }], [L ? 'ჰარი' : 'Space', 4.2, () => { S.query += ' '; runSearch(); }],
                            ['<', 1.4, () => { S.query = S.query.slice(0, -1); runSearch(); }]];
                        const tot = keys.reduce((a, b) => a + b[1], 0), unit = (kw - lx - gap * (keys.length - 1)) / tot;
                        let x = lx;
                        keys.forEach((kk, i) => {
                            const w = unit * kk[1];
                            cv.roundRect(x, y, w, rh - gap, sz(8), i === 2 ? '#3a2226' : '#232a33');
                            cv.text(kk[0], x + w / 2, y + (rh - gap) / 2 + sz(7), sz(18), '#ffffff', { literal: true, font: 'bold', align: 'center' });
                            cv.target(x, y, w, rh - gap, () => { kk[2](); kick(); }, 'kb_' + kk[0], sz(8));
                            x += w + gap;
                        });
                        return;
                    }
                    const chars = Array.from(row), n = Math.max(10, chars.length), kwid = (kw - lx - gap * (n - 1)) / n;
                    const x0 = lx + (n - chars.length) * (kwid + gap) / 2;
                    chars.forEach((c, i) => {
                        const x = x0 + i * (kwid + gap);
                        cv.roundRect(x, y, kwid, rh - gap, sz(8), '#1b2129');
                        cv.text(S.kbd === 'en' ? c.toUpperCase() : c, x + kwid / 2, y + (rh - gap) / 2 + sz(8), sz(21), '#ffffff', { literal: true, font: 'bold', align: 'center' });
                        cv.target(x, y, kwid, rh - gap, () => { S.query += c; runSearch(); kick(); }, 'k_' + c, sz(8));
                    });
                });
            }
            // results, or categories and saved places
            const rx = kw + sz(14), rw = W - rx - sz(12), ry = top, rh2 = bottom - ry - sz(10);
            panel(cv, rx, ry, rw, rh2, sz(14));
            let list = [];
            let title = '';
            if (S.cat) { list = S.cat.res; title = L ? S.cat.c.ka : S.cat.c.en; } else if (S.query.trim()) { list = S.results; title = list.length ? '' : (L ? 'ვერაფერი მოიძებნა' : 'Nothing found'); }
            const at = fix ? { x: fix.x, y: fix.y } : null;
            if (!S.query.trim() && !S.cat) {
                // categories (2 x 3), then Home / Work / favourites / recent
                const cw = (rw - sz(36)) / 3, chh = sz(56);
                CATEGORIES.forEach((c, i) => {
                    const cx = rx + sz(12) + (i % 3) * (cw + sz(6)), cy = ry + sz(12) + Math.floor(i / 3) * (chh + sz(6));
                    cv.roundRect(cx, cy, cw, chh, sz(10), '#1b2129');
                    poiIcon(cv, cx + sz(24), cy + chh / 2, sz(11), c.kinds[0]);
                    cv.text(fit(cv, L ? c.ka : c.en, cw - sz(52), sz(14), { font: 'bold' }), cx + sz(44), cy + chh / 2 + sz(5), sz(14), '#ffffff', { literal: true, font: 'bold' });
                    cv.target(cx, cy, cw, chh, () => { S.cat = { c, res: search.near(c.kinds, at || { x: view.camera.x, y: view.camera.y }, 25) }; S.scroll = 0; kick(); }, 'cat_' + c.id, sz(10));
                });
                const P = search ? search.places : { favs: [], recent: [] };
                list = [];
                if (P.home) list.push(Object.assign({ icon: 'home' }, P.home, { title: (L ? 'სახლი: ' : 'Home: ') + P.home.title }));
                if (P.work) list.push(Object.assign({ icon: 'work' }, P.work, { title: (L ? 'სამსახური: ' : 'Work: ') + P.work.title }));
                (P.favs || []).forEach((f) => list.push(Object.assign({ icon: 'fav' }, f)));
                (P.recent || []).forEach((f) => list.push(Object.assign({ icon: 'recent' }, f)));
                const ly = ry + sz(12) + 2 * (chh + sz(6)) + sz(8);
                cv.text(L ? 'შენახული და ბოლო ადგილები' : 'Saved and recent places', rx + sz(16), ly + sz(14), sz(13), '#8f99a6', { literal: true, font: 'bold' });
                if (!list.length) cv.text(L ? 'ჯერ არაფერია: აირჩიეთ ადგილი და "შენახვა"' : 'None yet: pick a place on the map or in Search and Save it', rx + sz(16), ly + sz(44), sz(13), '#6b7480', { literal: true });
                drawList(cv, t, list, rx, ly + sz(24), rw, ry + rh2 - ly - sz(30), at, k);
                return;
            }
            if (title) cv.text(title, rx + sz(16), ry + sz(28), sz(15), '#aeb6c1', { literal: true, font: 'bold' });
            if (S.cat) cv.target(rx, ry, rw, sz(40), () => { S.cat = null; kick(); }, 'catback', sz(10));
            drawList(cv, t, list, rx, ry + (title ? sz(40) : sz(8)), rw, rh2 - (title ? sz(48) : sz(16)), at, k);
        }
        function drawList(cv, t, list, x, y, w, h, at, k) {
            const sz = (n) => Math.round(n * k);
            const rowH = sz(56), rows = Math.max(1, Math.floor(h / rowH));
            resultsGeo.rows = rows; resultsGeo.rowH = rowH; resultsGeo.count = list.length;
            cv.scroll = { y, bar: null };
            const first = Math.min(S.scroll, Math.max(0, list.length - rows));
            for (let i = 0; i < rows && first + i < list.length; i++) {
                const r = list[first + i], ry = y + i * rowH;
                const title = typeof r.title === 'function' ? r.title(lang()) : r.title, sub = typeof r.sub === 'function' ? r.sub(lang()) : r.sub || '';
                if (i) cv.fillRect(x + sz(14), ry, w - sz(28), 1, withAlpha('#ffffff', 0.07));
                if (r.kind) poiIcon(cv, x + sz(30), ry + rowH / 2, sz(11), r.kind === KIND.STREET ? 18 : r.kind <= 5 ? 14 : r.kind);
                else {
                    cv.circle(x + sz(30), ry + rowH / 2, sz(12), r.icon === 'home' ? '#1f6fd6' : r.icon === 'work' ? '#7c3aed' : r.icon === 'fav' ? '#d97706' : '#475569');
                    cv.text(r.icon === 'home' ? 'H' : r.icon === 'work' ? 'W' : r.icon === 'fav' ? '*' : 'R', x + sz(30), ry + rowH / 2 + sz(5), sz(13), '#ffffff', { literal: true, font: 'bold', align: 'center' });
                }
                const dist = at ? Math.hypot(r.x - at.x, r.y - at.y) * groundScale(at.y) : null;
                const dtx = dist != null ? H.fmtDist(dist, imperial()).join(' ') : '';
                const dw = dtx ? cv.textWidth(dtx, sz(13), { literal: true }) + sz(16) : 0;
                cv.text(fit(cv, title, w - sz(70) - dw, sz(16), { font: 'bold' }), x + sz(54), ry + sz(24), sz(16), '#ffffff', { literal: true, font: 'bold' });
                cv.text(fit(cv, sub, w - sz(70) - dw, sz(12)), x + sz(54), ry + sz(44), sz(12), '#8f99a6', { literal: true });
                if (dtx) cv.text(dtx, x + w - sz(14), ry + sz(34), sz(13), '#aeb6c1', { literal: true, align: 'right' });
                cv.target(x, ry, w, rowH, () => choose(r), 'row_' + (first + i), sz(8));
            }
            if (list.length > rows) {
                const th = Math.max(sz(30), h * rows / list.length), ty = y + (h - th) * first / Math.max(1, list.length - rows);
                cv.roundRect(x + w - sz(7), ty, sz(4), th, sz(2), withAlpha('#2f8cff', 0.8));
                cv.scroll = { y, bar: { x: x + w - sz(7), y: ty, w: sz(4), h: th } };
            }
        }

        /* ---------- the route & guidance page ---------- */
        /** The learned NAV pattern, kept in the app's own data folder only ('' forgets it). */
        function saveNavKey(text, source) {
            const pairs = navkey.parse(text);
            S.navKey = pairs ? { text, pairs, source: source || '' } : null;
            try {
                if (pairs) fs.writeFileSync(navBtnFile, JSON.stringify({ match: text, source: source || '', at: Date.now() }));
                else fs.unlinkSync(navBtnFile);
            } catch (e) { /* read-only (preview) */ }
        }

        function drawRoute(cv, t, fix) {
            const k = kOf(cv), sz = (n) => Math.round(n * k), L = ulang() === 'ka';
            const bottom = PH + (cv.extra || 0), top = TOP + sz(6);
            cv.fillRect(0, TOP, W, bottom - TOP, '#0b0e13');
            const lx = sz(12), lw = Math.round(W * 0.58), rx = lx + lw + sz(12), rw = W - rx - sz(12), h = bottom - top - sz(10);

            // Left panel: Active Route & Turn-by-Turn Steps (or Route Setup when idle)
            panel(cv, lx, top, lw, h, sz(14));
            const curAvoid = settings.get('avoid') || 'none';
            const avoidOpts = [
                ['none', L ? 'უსწრაფესი' : 'Fastest'],
                ['tolls', L ? 'უფასო გზა' : 'Avoid tolls'],
                ['motorways', L ? 'მაგისტრალის გარეშე' : 'No motorways'],
            ];

            if (S.route && S.dest) {
                const T = H.tr(ulang());
                const g = S.g || { s: 0, next: 0, left: S.route.length, secs: S.route.duration };
                cv.text(fit(cv, S.dest.title || (L ? 'დანიშნულება' : 'Destination'), lw - sz(220), sz(20), { font: 'bold' }), lx + sz(16), top + sz(30), sz(20), '#ffffff', { literal: true, font: 'bold' });
                const d = H.fmtDist(g.left, imperial()), du = H.fmtDur(g.secs), eta = H.clock(new Date(Date.now() + g.secs * 1000));
                const sub = d[0] + ' ' + d[1] + '  ·  ' + du[0] + ' ' + du[1] + '  ·  ' + T.eta + ' ' + eta;
                cv.text(fit(cv, sub, lw - sz(220), sz(14)), lx + sz(16), top + sz(54), sz(14), '#aeb6c1', { literal: true });

                const bh = sz(36);
                button(cv, t, lx + lw - sz(102), top + sz(14), sz(90), bh, L ? 'გაუქმება' : 'Cancel', () => { cancelRoute(); kick(); }, 'rt_cancel', { primary: true, color: '#b3261e' });
                button(cv, t, lx + lw - sz(204), top + sz(14), sz(94), bh, L ? 'რუკაზე' : 'Overview', () => { overview(); page = 0; kick(); }, 'rt_ov');

                // Route preference pills
                const py = top + sz(64), ph = sz(34), pw = (lw - sz(40)) / 3;
                avoidOpts.forEach((o, idx) => {
                    const px = lx + sz(14) + idx * (pw + sz(6));
                    const active = curAvoid === o[0];
                    button(cv, t, px, py, pw, ph, o[1], () => {
                        settings.set('avoid', o[0]);
                        if (S.dest) plan(S.dest, { quiet: true });
                        kick();
                    }, 'av_' + o[0], active ? { primary: true } : null);
                });

                // Scrollable Turn-by-Turn Maneuver Step List
                const sy = py + ph + sz(10), sh = top + h - sy - sz(8);
                const M = S.route.maneuvers || [];
                const startIdx = Math.max(0, Math.min(M.length - 1, g.next || 0));
                const steps = M.slice(startIdx);
                const rowH = sz(52), rows = Math.max(1, Math.floor(sh / rowH));
                routeGeo.rows = rows; routeGeo.rowH = rowH; routeGeo.count = steps.length;
                cv.scroll = { y: sy, bar: null };
                const first = Math.min(S.routeScroll, Math.max(0, steps.length - rows));
                for (let i = 0; i < rows && first + i < steps.length; i++) {
                    const m = steps[first + i], ry = sy + i * rowH;
                    if (i) cv.fillRect(lx + sz(14), ry, lw - sz(28), 1, withAlpha('#ffffff', 0.07));
                    cv.roundRect(lx + sz(14), ry + sz(6), sz(40), sz(40), sz(8), first + i === 0 ? '#1f6fd6' : '#1b2129');
                    H.arrow(cv, lx + sz(34), ry + sz(26), sz(30), m, '#ffffff', withAlpha('#ffffff', 0.35));
                    const nm = m.type === 'arrive' ? (S.dest.title || T.arrived) : (pack.label(m.name, lang()) || pack.label(m.ref, lang() === 'en' ? 'en' : 'ka').split(';')[0] || H.phrase(m, ulang()));
                    const phr = H.phrase(m, ulang());
                    const distFromCar = Math.max(0, m.at - g.s);
                    const dtx = H.fmtDist(distFromCar, imperial()).join(' ');
                    const dw = cv.textWidth(dtx, sz(14), { literal: true, font: 'bold' }) + sz(18);
                    cv.text(fit(cv, nm, lw - sz(78) - dw, sz(16), { font: 'bold' }), lx + sz(66), ry + sz(23), sz(16), '#ffffff', { literal: true, font: 'bold' });
                    cv.text(fit(cv, phr, lw - sz(78) - dw, sz(12)), lx + sz(66), ry + sz(42), sz(12), '#8f99a6', { literal: true });
                    cv.text(dtx, lx + lw - sz(16), ry + sz(32), sz(14), first + i === 0 ? '#7fd1ff' : '#aeb6c1', { literal: true, font: 'bold', align: 'right' });
                    cv.target(lx, ry, lw, rowH, () => {
                        view.camera.x = m.x; view.camera.y = m.y;
                        zoomWant = Math.log2(1.0 / groundScale(m.y));
                        S.follow = false; S.overview = false; S.lastTouch = Date.now(); S.userZoomAt = Date.now();
                        page = 0; kick();
                    }, 'step_' + (first + i), sz(8));
                }
                if (steps.length > rows) {
                    const th = Math.max(sz(28), sh * rows / steps.length), ty = sy + (sh - th) * first / Math.max(1, steps.length - rows);
                    cv.roundRect(lx + lw - sz(7), ty, sz(4), th, sz(2), withAlpha('#2f8cff', 0.8));
                    cv.scroll = { y: sy, bar: { x: lx + lw - sz(7), y: ty, w: sz(4), h: th } };
                }
            } else {
                routeGeo.rows = 0; routeGeo.count = 0;
                cv.text(L ? 'მარშრუტის პარამეტრები და სტატუსი' : 'Route Preferences & System Status', lx + sz(16), top + sz(32), sz(20), '#ffffff', { literal: true, font: 'bold' });
                const py = top + sz(48), ph = sz(38), pw = (lw - sz(40)) / 3;
                avoidOpts.forEach((o, idx) => {
                    const px = lx + sz(14) + idx * (pw + sz(6));
                    button(cv, t, px, py, pw, ph, o[1], () => { settings.set('avoid', o[0]); kick(); }, 'av_' + o[0], curAvoid === o[0] ? { primary: true } : null);
                });

                let y = py + ph + sz(26);
                const ll = fix ? unmerc(fix.x, fix.y) : null;
                const srcLabel = !fix ? (L ? 'უცნობია' : 'No fix') : fix.source === 'gnss' ? (L ? 'მანქანის GPS (SOME/IP)' : 'Car GPS (SOME/IP)') : fix.source === 'dr' ? (L ? 'ინერციული (Dead Reckoning)' : 'Dead Reckoning (Speed + Gyro)') : (L ? 'დემო სიმულაცია' : 'Demo Drive');
                const roadName = fix && fix.name && pack ? pack.label(fix.name, lang()) : '';
                const lines = [
                    [L ? 'პოზიციის წყარო:' : 'Position source:', srcLabel],
                    [L ? 'კოორდინატები:' : 'Coordinates:', ll ? ll[0].toFixed(5) + ', ' + ll[1].toFixed(5) + '  (' + Math.round(fix.heading || 0) + ' deg)' : '—'],
                    [L ? 'მიმდინარე გზა:' : 'Current road:', roadName || '—'],
                    [L ? 'დაყენებული რუკა:' : 'Installed map:', packs.map((p) => p.meta.region + ' (' + p.meta.counts.nodes + ' nodes, ' + p.meta.counts.edges + ' roads)').join(', ')],
                ];
                lines.forEach((ln) => {
                    cv.text(ln[0], lx + sz(16), y, sz(14), '#8f99a6', { literal: true });
                    cv.text(fit(cv, ln[1], lw - sz(200), sz(14), { font: 'bold' }), lx + sz(180), y, sz(14), '#ffffff', { literal: true, font: 'bold' });
                    y += sz(28);
                });

                const bh = sz(42), by = top + h - bh - sz(14);
                button(cv, t, lx + sz(14), by, sz(170), bh, L ? 'ძიება' : 'Search Place', () => { page = 1; kick(); }, 'rt_search', { primary: true });
                button(cv, t, lx + sz(194), by, sz(170), bh, L ? 'დემო ტური' : 'Start Demo Tour', () => { S.cancelledTour = false; startTour(); page = 0; kick(); }, 'rt_demo');
            }

            // Right panel: Saved Places & Physical NAV Button Takeover
            panel(cv, rx, top, rw, h, sz(14));
            cv.text(L ? 'სწრაფი დანიშნულება' : 'Saved Destinations', rx + sz(16), top + sz(30), sz(18), '#ffffff', { literal: true, font: 'bold' });
            const P = search ? search.places : { home: null, work: null, favs: [], recent: [] };
            const qbh = sz(46), qbw = (rw - sz(36)) / 2, qby = top + sz(44);
            button(cv, t, rx + sz(14), qby, qbw, qbh, P.home ? (L ? 'სახლი' : 'Home') : (L ? '+ სახლი' : '+ Home'), () => {
                if (P.home) { navigateTo(P.home); kick(); } else { page = 1; toast(L ? 'აირჩიეთ ადგილი და დააჭირეთ "სახლი"' : 'Pick a place and tap Home to set it'); kick(); }
            }, 'rt_home', P.home ? { primary: true } : null);
            button(cv, t, rx + sz(22) + qbw, qby, qbw, qbh, P.work ? (L ? 'სამსახური' : 'Work') : (L ? '+ სამსახური' : '+ Work'), () => {
                if (P.work) { navigateTo(P.work); kick(); } else { page = 1; toast(L ? 'აირჩიეთ ადგილი და დააჭირეთ "სამსახური"' : 'Pick a place and tap Work to set it'); kick(); }
            }, 'rt_work', P.work ? { primary: true } : null);

            // Favourites & Recent list on right panel
            const quickList = (P.favs || []).map((f) => Object.assign({ icon: 'fav' }, f)).concat((P.recent || []).map((r) => Object.assign({ icon: 'recent' }, r))).slice(0, 4);
            let ry = qby + qbh + sz(14);
            const rRowH = sz(46);
            if (!quickList.length) {
                cv.text(L ? 'შენახული ადგილები გამოჩნდება აქ' : 'Saved & recent places appear here', rx + sz(16), ry + sz(26), sz(13), '#6b7480', { literal: true });
                ry += rRowH * 2;
            } else {
                quickList.forEach((item, idx) => {
                    if (idx) cv.fillRect(rx + sz(14), ry, rw - sz(28), 1, withAlpha('#ffffff', 0.07));
                    cv.circle(rx + sz(28), ry + rRowH / 2, sz(10), item.icon === 'fav' ? '#d97706' : '#475569');
                    cv.text(item.icon === 'fav' ? '*' : 'R', rx + sz(28), ry + rRowH / 2 + sz(4), sz(12), '#ffffff', { literal: true, font: 'bold', align: 'center' });
                    cv.text(fit(cv, item.title, rw - sz(64), sz(15), { font: 'bold' }), rx + sz(48), ry + rRowH / 2 + sz(5), sz(15), '#ffffff', { literal: true, font: 'bold' });
                    cv.target(rx, ry, rw, rRowH, () => { navigateTo(item); kick(); }, 'qitem_' + idx, sz(8));
                    ry += rRowH;
                });
            }

            // Console NAV Button Takeover controls at bottom of right panel
            const navBoxY = top + h - sz(106);
            cv.fillRect(rx + sz(14), navBoxY, rw - sz(28), 1, withAlpha('#ffffff', 0.1));
            const learning = !!S.learn;
            const heard = learning ? S.learn.samples.length : 0;
            const navStatus = learning
                ? (L ? 'დააჭირეთ NAV ღილაკს 3-ჯერ... (' + heard + ')' : 'Press the console NAV button 3 times... (' + heard + ' events)')
                : S.navKey
                    ? (L ? 'NAV ხსნის ამ ნავიგაციას (სტანდარტული ეკრანიც რჩება)' : 'NAV opens this Navigation (over the stock screen)')
                    : navSeen ? (L ? 'NAV ღილაკი: დააჭირეთ "სწავლა"' : 'Console NAV button: tap Learn')
                        : (L ? 'ღილაკების სიგნალი ჯერ არ მოსულა (იხ. nav-recon.sh)' : 'No console button feed yet (see nav-recon.sh)');
            cv.text(fit(cv, navStatus, rw - sz(32), sz(13), { font: 'bold' }), rx + sz(16), navBoxY + sz(24), sz(13), learning ? '#ffb020' : S.navKey ? '#22c55e' : '#aeb6c1', { literal: true, font: 'bold' });

            const bby = top + h - sz(56), bbh = sz(42);
            button(cv, t, rx + sz(14), bby, Math.round(rw * 0.56), bbh,
                learning ? (L ? 'გაუქმება' : 'Stop learning') : (L ? 'NAV-ის სწავლა' : 'Learn NAV button'),
                () => {
                    if (learning) { S.learn = null; if (learnTimer) { clearTimeout(learnTimer); learnTimer = null; } } else {
                        S.learn = { samples: [] };
                        // nothing heard within 20 s: give up
                        learnTimer = setTimeout(finishLearning, 20000);
                        toast(L ? 'დააჭირეთ NAV ღილაკს 3-ჯერ (სტანდარტული ეკრანი გაიხსნება, დაბრუნდით აქ)' : 'Press NAV 3 times (the stock screen opens: come back here after)', 6000);
                    }
                    kick();
                }, 'bind_nav', learning ? { primary: true, color: '#d97706' } : null);

            if (S.navKey) {
                button(cv, t, rx + sz(22) + Math.round(rw * 0.56), bby, rw - sz(36) - Math.round(rw * 0.56), bbh,
                    L ? 'დავიწყება' : 'Forget', () => { saveNavKey('', ''); toast(L ? 'NAV ღილაკი დავიწყებულია' : 'NAV button forgotten: NAV is stock only'); kick(); }, 'unbind_nav');
            } else if (search && (P.recent || []).length) {
                button(cv, t, rx + sz(22) + Math.round(rw * 0.56), bby, rw - sz(36) - Math.round(rw * 0.56), bbh,
                    L ? 'ისტორიის წაშლა' : 'Clear History', () => { search.places.recent = []; search.save(); kick(); }, 'clear_rec');
            }
        }

        /* ---------- the frame ---------- */
        let loopRef = null;
        const kick = () => { if (loopRef) loopRef.kick(); };
        async function render() {
            const now = Date.now(), dt = Math.min(0.25, (now - S.lastFrame) / 1000);
            S.lastFrame = now;
            const t = ctx.theme();
            const cv = ctx.canvas(W, PH).clear('#0b0e13');
            const fix = pos.fix();
            if (demo() && !S.route) startTour();
            if (S.route && S.guide && fix) {
                S.g = S.guide.update(fix, now);
                if (S.g.offRoute && now - S.lastPlan > 4000 && S.dest) {
                    log.info('off the route (' + Math.round(S.g.off) + ' m): planning again');
                    toast(H.tr(ulang()).recalc, 2500);
                    plan(S.dest, { quiet: true });
                }
                if (S.g && S.g.arrived) {
                    if (!S.arrivedAt) S.arrivedAt = now;
                    else if (now - S.arrivedAt > 15000 && !(S.dest && S.dest.tour)) cancelRoute();
                }
            }
            if (!packs.length) {
                cv.text('No map pack installed: build one with kit/tools/pack_osm.py', W / 2, 280, 22, '#ffffff', { literal: true, align: 'center' });
            } else if (page === 0) drawMap(cv, t, fix, dt);
            else if (page === 1) drawSearch(cv, t, fix);
            else drawRoute(cv, t, fix);
            if (S.toast && now < S.toast.until) {
                const k = kOf(cv), s = Math.round(16 * k), w = cv.textWidth(S.toast.text, s, { literal: true, font: 'bold' }) + Math.round(48 * k);
                const x = (W - w) / 2, y = TOP + Math.round(14 * k);
                panel(cv, x, y, w, Math.round(44 * k), Math.round(22 * k));
                cv.text(S.toast.text, W / 2, y + Math.round(28 * k), s, '#ffffff', { literal: true, font: 'bold', align: 'center' });
            }
            const src = fix ? fix.source : null;
            G.frame(cv, t, PAGES, page, [
                src === 'demo' ? { text: 'DEMO DRIVE', color: '#ffb020' } : src === 'gnss' ? { text: 'GPS', color: '#22c55e' } : src === 'dr' ? { text: 'DEAD RECKONING', color: '#7fd1ff' } : { text: 'NO POSITION', color: '#ef4444' },
                S.navKey ? { text: 'NAV', color: '#22c55e' } : null,
            ]);
            await ui.image('MAIN_GFX', cv);
        }

        /*
         * ---------- the console's NAV button: Navigation opens itself over the stock screen ----------
         * Nothing is blocked: the HMI gets NAV as always and opens its own screen; this app's screen is then
         * opened over it. Not running (or crashed): NAV is simply stock. Sources: the controller gate's
         * read-only feed (abstract socket @mgu-nav-buttons, kit/renderd/inputgate) and, when app.json names it,
         * the FrontCCU button field over SOME/IP. Learning and matching: navkey.js.
         */
        let navSrv = null, navSeen = 0, lastOpen = 0, learnTimer = null;
        const openSelf = (tries) => {
            try {
                const desc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'rhmiData', 'application.json'), 'utf8'));
                const ep = desc.application && desc.application.entryPoints && desc.application.entryPoints[0];
                if (ep && ui.rhmi && ui.rhmi.openEntryState) Promise.resolve(ui.rhmi.openEntryState(ep.uuid)).catch((e) => log.warn('nav button: open: ' + e));
            } catch (e) { log.warn('nav button: ' + e.message); return; }
            // the stock screen may come up after ours (the HMI handles NAV meanwhile): once more if ours is not in front
            if (tries > 0) setTimeout(() => { if (!ui.isVisible('MAIN')) openSelf(tries - 1); }, 1500);
        };
        const finishLearning = () => {
            learnTimer = null;
            const L = ulang() === 'ka', r = navkey.learn(S.learn ? S.learn.samples : []);
            S.learn = null;
            if (r.error) {
                toast(r.error === 'few' ? (L ? 'NAV ღილაკი ვერ დავინახე: სცადეთ ისევ (3-ჯერ)' : 'Did not see NAV three times: try again')
                    : (L ? 'სიგნალი არაერთგვაროვანია: სცადეთ ისევ, მხოლოდ NAV' : 'The presses differ too much: try again, NAV only'), 6000);
            } else {
                saveNavKey(r.text, S.learnSource);
                log.info('NAV button learned from ' + r.count + ' events (' + S.learnSource + '): ' + r.text);
                toast(L ? 'NAV ღილაკი მიბმულია: დააჭირეთ შესამოწმებლად' : 'NAV button learned: press it to try', 6000);
            }
            kick();
        };
        const onButton = (sample, source) => {
            if (navSeen++ < 40) log.info('console button (' + source + '): ' + navkey.format(Object.keys(sample).map((k) => [k, sample[k]])));
            if (S.learn) {
                S.learn.samples.push(sample);
                S.learnSource = source;
                // done 2.5 s after the last press (each press may send a press and a release event)
                if (learnTimer) clearTimeout(learnTimer);
                learnTimer = setTimeout(finishLearning, 2500);
                kick();
                return;
            }
            if (S.navKey && navkey.matches(S.navKey.pairs, sample) && Date.now() - lastOpen > 1500) {
                lastOpen = Date.now();
                log.info('NAV pressed: opening Navigation over the stock screen');
                page = 0; S.sel = null;
                setTimeout(() => openSelf(1), 400);
                kick();
            }
        };
        if (process.platform === 'linux') {
            navSrv = require('net').createServer((sock) => {
                let buf = '';
                sock.setEncoding('latin1');
                sock.on('data', (d) => { buf += d; if (buf.length > 1024) sock.destroy(); });
                sock.on('end', () => {
                    const hex = (buf.trim().split(' ')[2] || '').toLowerCase();
                    if (/^[0-9a-f]{2,128}$/.test(hex)) onButton(navkey.fromHex(hex), 'gate');
                });
                sock.on('error', () => {});
            });
            navSrv.on('error', (e) => log.warn('nav button listener: ' + e.message));
            navSrv.listen('\0mgu-nav-buttons', () => log.info('nav button: listening on the controller gate feed' + (S.navKey ? ' (' + S.navKey.text + ')' : ' (not learned yet)')));
        }
        if (navCfg.iface && navCfg.field && ctx.signals && ctx.signals.watch) {
            const h = {};
            h[navCfg.field] = (v) => onButton(navkey.fromValue(v), 'someip');
            ctx.signals.watch(navCfg.iface, navCfg.instance || '1', h, log)
                .then((s) => log.info('nav button: ' + navCfg.iface + '.' + navCfg.field + (s.error ? ' error: ' + s.error : ' subscribed')));
        }

        /* ---------- car sleep / shutdown safety (zero battery drain) ---------- */
        let cleanedUp = false;
        const cleanup = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            try { pos.stop(); } catch (e) {}
            try { if (navSrv) navSrv.close(); } catch (e) {}
            try { packs.forEach((p) => p && p.close && p.close()); } catch (e) {}
        };
        if (ctx.app && ctx.app.on) ctx.app.on('shutdown', cleanup);
        ['SIGTERM', 'SIGINT', 'exit'].forEach((sig) => process.on(sig, cleanup));

        /* ---------- iDrive 7 Home Screen Widget (rhmiDataStartWidget, zero-allocation & idle-skip) ---------- */
        if (ctx.widget && ctx.widget.loop) {
            const { Recorder, play } = require('./kit/record');
            const { Canvas } = require('./kit/canvas');
            const wView = new MapView(packs);
            const wBufs = {};
            const wLastKey = {};
            ctx.widget.onChange(() => {
                Object.keys(wLastKey).forEach((k) => { delete wLastKey[k]; });
                if (ctx.widget.active()) pos.start();
                else if (!ui.isVisible('MAIN') && !S.route) pos.stop();
            });
            ctx.widget.loop(1.0, (inst) => {
                if (!packs.length) return null;
                // Do not software-rasterize the widget when full-screen Navigation covers the screen or widget is hidden
                if (ui.isVisible('MAIN') || (inst.visible === false && wLastKey[inst.spawnId])) return null;
                const ww = 560, wh = inst.big ? 430 : 210;
                const fix = pos.fix();
                const st = settings.get('mapStyle');
                const hr = new Date().getHours();
                wView.style = st === 'day' ? 'day' : st === 'night' ? 'night' : hr >= 7 && hr < 19 ? 'day' : 'night';
                wView.lang = lang();
                const cx = fix ? fix.x : view.camera.x, cy = fix ? fix.y : view.camera.y;
                const hd = headUp() && fix ? fix.heading : 0;
                const stateKey = [
                    inst.big ? 1 : 0, wView.style, wView.lang,
                    Math.round(cx / 2), Math.round(cy / 2), Math.round(hd / 2),
                    fix ? Math.round(fix.speed) : -1,
                    S.route ? S.route.length : 0, S.g ? S.g.next + ':' + Math.round(S.g.dist / 5) : '',
                ].join('|');
                if (wLastKey[inst.spawnId] === stateKey) return null;
                wLastKey[inst.spawnId] = stateKey;
                let wb = wBufs[wh];
                if (!wb) wb = wBufs[wh] = { rec: new Recorder(ww, wh), cv: new Canvas(ww, wh) };
                const r = wb.rec;
                r.clear('#0b0e13');
                wView.camera = { x: cx, y: cy, mpp: 2.2, heading: hd };
                const vp = { x: 0, y: 0, w: ww, h: wh, cx: ww / 2, cy: Math.round(wh * 0.62) };
                wView.draw(r, vp, {
                    route: S.route, routeS: S.g ? S.g.s : 0,
                    car: fix ? { x: fix.x, y: fix.y, heading: fix.heading } : null,
                    dest: S.dest, avoid: [{ x: 0, y: wh - 54, w: ww, h: 54 }], scale: 1.0,
                });
                r.roundRect(10, wh - 48, ww - 20, 40, 10, withAlpha('#0e1218', 0.92));
                if (S.route && S.g) {
                    const m = S.route.maneuvers[S.g.next] || { type: 'arrive' };
                    H.arrow(r, 32, wh - 28, 26, m, '#2f8cff', withAlpha('#ffffff', 0.35));
                    const d = H.fmtDist(S.g.dist, imperial()).join(' ');
                    const nm = (pack && pack.label(m.name, lang())) || (S.dest ? S.dest.title : '');
                    r.text(fit(r, d + (nm ? '  ·  ' + nm : ''), ww - 150, 16, { font: 'bold' }), 54, wh - 22, 16, '#ffffff', { literal: true, font: 'bold' });
                    const rem = H.fmtDist(S.g.left, imperial()).join(' ');
                    r.text(rem, ww - 22, wh - 22, 14, '#7fd1ff', { literal: true, font: 'bold', align: 'right' });
                } else {
                    const road = fix && fix.name && pack ? pack.label(fix.name, lang()) : (ulang() === 'ka' ? 'OpenStreetMap ნავიგაცია' : 'OpenStreetMap Navigation');
                    r.text(fit(r, road, ww - 120, 16, { font: 'bold' }), 22, wh - 22, 16, '#ffffff', { literal: true, font: 'bold' });
                    if (fix) r.text(Math.round(imperial() ? fix.speed / 1.609 : fix.speed) + (imperial() ? ' mph' : ' km/h'), ww - 22, wh - 22, 15, '#c9d1db', { literal: true, font: 'bold', align: 'right' });
                }
                return play(r.words(), wb.cv);
            });
        }

        /* ---------- foreground / background lifecycle ---------- */
        const fps = () => {
            const max = Number(settings.get('fps')) || 60, fix = pos.fix();
            const moving = (fix && fix.speed > 0.5) || Math.abs(zoomWant - zoomLog) > 0.01 || page === 1 || (S.toast && Date.now() < S.toast.until) || S.crosshair || !!S.learn;
            return page === 2 && !moving ? 6 : moving ? max : 4;
        };
        ui.onVisible((name, v) => {
            if (name !== 'MAIN') return;
            if (v) { pos.start(); pos._tick(); kick(); }
            else if (!S.route && !(ctx.widget && ctx.widget.active())) pos.stop();          // guidance / widget keeps track of the car off screen
        });
        if (ui.isVisible('MAIN') || (ctx.widget && ctx.widget.active()) || ctx.previewDemo) {
            pos.start();
            pos._tick();
        }
        // a first frame for the PC preview and the emulator (on the car the screen opens later and draws then)
        settings.onChange((key) => { if (key === 'demo') { S.cancelledTour = false; if (!demo() && S.dest && S.dest.tour) cancelRoute(); } kick(); });
        loopRef = ctx.loop('MAIN', 8, render, { maxFps: fps });
        if (demo() && (ui.isVisible('MAIN') || ctx.previewDemo)) startTour();
        if (ui.isVisible('MAIN') || ctx.previewDemo) { pos._tick(); await render(); }
        log.info('navigation ready: ' + packs.length + ' map(s), position ' + (pos.fix() ? pos.fix().source : 'idle'));
    },
});
