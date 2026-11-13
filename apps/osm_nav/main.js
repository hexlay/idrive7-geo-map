'use strict';
/**
 * Navigation (osm_nav) - standalone offline OpenStreetMap navigation for BMW iDrive 7 (MGU). Node 8.
 *
 * Looks and works like iDrive 7's own Navigation. Native where the HMI allows it: Navigation's menu and its
 * lists (destination, Home / Work, favourites, recent, points of interest, the route's maneuvers, status)
 * and the settings are the HMI's own screens (app.json NAV_MENU, NAV_LIST, nativeSettings). Drawn where it
 * has nothing an app can use: the map and the speller (iDrive 7 offers apps no map view and no text entry).
 *
 * Pages (header tabs): Map, Search, Menu (native; the drawn Route page with setting "menus": drawn).
 *   Map     the GPU vector map (map_view.js), heading-up or north-up round the car, with the maneuver
 *           card, the speed limit sign, the trip bar and the map buttons (hud.js). A finger pans it, a tap
 *           picks a place (Go / Save / Home / Work / I'm here), + and - zoom; the controller: turn to zoom
 *           while on the map, press for the crosshair, push to move it, press again to pick that place.
 *   Search  offline search (search.js) with an on-screen keyboard in Latin, Georgian and coordinates,
 *           quick categories (fuel, charging, parking ...), Home, Work, favourites and recent places.
 *   Route   turn-by-turn maneuver step list, route preferences (Fastest / Avoid tolls / Avoid motorways),
 *           saved places, GPS/Dead-Reckoning status, and one-tap physical NAV button binding.
 *
 * Fuel (fuel.js, the car's tank level and range, read only): range on arrival in the trip bar, a fuel stop
 * on the route when the range is short (the furthest station reached with a reserve), and the nearest
 * station ahead when the tank is low with no route.
 *
 * Routes (router.js) are planned on the car from the map pack (kit/tools/pack_osm.py), followed with
 * off-route detection and a new plan when the car leaves them. Position (gps.js): the car's signals
 * with map matching and dead reckoning, or the Tbilisi demo drive (VM, emulator, preview).
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { writeWhole } = require('./kit/write_whole');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { MapPack, merc, unmerc, groundScale } = require('./mappack');
const { Router, Guidance, turnAngle } = require('./router');
const { MapView, poiIcon } = require('./map_view');
const { Position, TOUR } = require('./gps');
const { Search, CATEGORIES, kindName, KIND } = require('./search');
const navkey = require('./navkey');
const { StockNavFollower, parseSurface } = require('./stocknav');
const { DriveGuard, keyboardLocked } = require('./guard');
const FU = require('./fuel');
const H = require('./hud');
const { HudTurns } = require('./hudturn');

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
        const fuel = new FU.Fuel(ctx);
        // the position and the fuel level are followed together: on screen, with guidance or the widget
        const track = (on) => { if (on) { pos.start(); fuel.start(); } else { pos.stop(); fuel.stop(); } };
        pos.onFix((f) => { if (f.source !== 'demo') fuel.setSpeed(f.speed); });
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
            stop: null, fuelFor: null, fuelAlong: null, lowWarned: false,
            lastFrame: Date.now(), arrivedAt: 0, confirmClear: 0,
        };
        let hudTurns = null;                  // the next turn on the HUD (made once the reverse guard is there)
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
            let vias = opts.vias;
            if (!vias && S.stop) { const v = R.snap(S.stop.x, S.stop.y, null, 400); if (v) vias = [v]; else S.stop = null; }
            const route = R.route(a, b, { avoid: settings.get('avoid'), vias });
            if (!route) { toast(H.tr(ulang()).noRoute); return false; }
            log.info('route: ' + (route.length / 1000).toFixed(1) + ' km, ' + Math.round(route.duration / 60) + ' min, ' + route.maneuvers.length + ' maneuvers, planned in ' + (Date.now() - t) + ' ms (search ' + route.searchMs + ' ms)');
            S.route = route; S.guide = new Guidance(R, route); S.g = null; S.dest = place; S.lastPlan = Date.now(); S.arrivedAt = 0; S.routeScroll = 0;
            if (!opts.quiet) {
                S.follow = true; S.overview = false; S.sel = null; S.crosshair = false;
                const fp = fuelPlan();
                if (fp && fp.need) toast(ulang() === 'ka' ? 'საწვავი არ ეყოფა: დაამატეთ გაჩერება ბენზინგასამართ სადგურზე' : 'Not enough fuel for this trip: add a fuel stop', 6000);
            }
            return true;
        }
        function navigateTo(place) {
            S.stop = null;
            if (!plan(place)) return false;
            if (search && !place.tour) search.addRecent(Search.place(place.title, place.sub, place.x, place.y));
            page = 0;
            return true;
        }
        function cancelRoute() {
            if (S.dest && S.dest.tour) S.cancelledTour = true;
            S.route = null; S.guide = null; S.g = null; S.dest = null; S.routeScroll = 0; S.stop = null;
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

        /* ---------- fuel: range on arrival, a fuel stop on the route, the nearest station when low ---------- */
        let allFuel = null;
        const fuelStations = () => {
            if (!allFuel) allFuel = search ? search.near([KIND.FUEL], { x: view.camera.x, y: view.camera.y }, 100000) : [];
            return allFuel;
        };
        /** { f, arr (km at the destination), need (no stop yet and arr below the reserve), along, s0 } or null */
        function fuelPlan() {
            const f = fuel.state(demo());
            if (!f || typeof f.rangeKm !== 'number' || !S.route) return null;
            const s0 = S.g ? S.g.s : 0, left = S.g ? S.g.left : S.route.length;
            const arr = FU.arrivalKm(f.rangeKm, left);
            const need = !S.stop && arr < FU.RESERVE_KM;
            if (need && S.fuelFor !== S.route) { S.fuelFor = S.route; S.fuelAlong = FU.stationsAlong(S.route, s0, fuelStations()); }
            return { f, arr, need, along: need ? S.fuelAlong : null, s0 };
        }
        const stopTitle = (st) => (typeof st.title === 'function' ? st.title(lang()) : st.title) || (ulang() === 'ka' ? 'ბენზინგასამართი' : 'Fuel station');
        /** Stop for fuel on the way: the station fuel.js picks (or st), the route planned again through it. */
        function addFuelStop(st) {
            const fp = fuelPlan();
            if (!st && fp) { const a = FU.pickStop(fp.along, fp.f.rangeKm, fp.s0); st = a && a.st; }
            const L = ulang() === 'ka';
            if (!st) { toast(L ? 'მარშრუტის გასწვრივ ბენზინგასამართი ვერ მოიძებნა' : 'No fuel station along the route'); return; }
            S.stop = { title: stopTitle(st), x: st.x, y: st.y };
            if (!S.dest || !plan(S.dest, { quiet: true })) { S.stop = null; return; }
            toast((L ? 'გაჩერება: ' : 'Fuel stop: ') + S.stop.title, 4000);
        }
        function removeFuelStop() { S.stop = null; if (S.dest) plan(S.dest, { quiet: true }); }
        /** Low fuel, no route: to the nearest station roughly ahead. */
        function goFuel() {
            const fix = pos.fix(), at = fix || { x: view.camera.x, y: view.camera.y };
            const st = FU.nearestAhead(search ? search.near([KIND.FUEL], at, 8) : [], fix, groundScale(at.y));
            if (!st) { toast(ulang() === 'ka' ? 'ბენზინგასამართი ვერ მოიძებნა' : 'No fuel station found'); return; }
            navigateTo({ title: stopTitle(st), sub: typeof st.sub === 'function' ? st.sub(lang()) : '', x: st.x, y: st.y });
        }
        fuel.onEvent((e) => {
            if (e !== 'refuelled') return;
            S.lowWarned = false;
            if (S.stop) { toast(ulang() === 'ka' ? 'საწვავი შევსებულია: მარშრუტი განახლდა' : 'Refuelled: route updated', 4000); removeFuelStop(); }
            kick();
        });
        const kmText = (km) => String(Math.round(imperial() ? km / 1.609 : km));
        const kmUnit = () => (imperial() ? 'mi' : (ulang() === 'ka' ? 'კმ' : 'km'));

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
        // the third tab is Navigation's menu: native (opened over the map), or the drawn Route page
        ui.onClick('BTN_PAGE', () => {
            const next = (page + 1) % PAGES.length;
            S.sel = null;
            if (next === 2 && nativeOn()) { page = 0; return openMenu(); }
            page = next; return render();
        });
        ctx.onTab((i) => { S.sel = null; S.crosshair = false; if (i === 2) return openMenu(); page = i; return render(); });
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
        /*
         * The iDrive 7 look (hud.js ID7): dark blue-grey panels with small corners, BMW blue for what is
         * selected or primary, regular-weight text in white and two greys, big numbers in the light face.
         */
        const C = H.ID7;
        const panel = (cv, x, y, w, h, rad, alpha) => H.panel(cv, x, y, w, h, Math.min(rad, Math.round(6 * kOf(cv))), alpha);
        /** The page's own background: the HMI's near-black, a little lighter at the top. */
        const pageBg = (cv, y, h) => cv.gradientRect(0, y, W, h, [[0, '#121820'], [1, '#05070a']]);
        /** A section heading on a page: grey, regular, with the HMI's thin rule under it. */
        const heading = (cv, text, x, y, w, size) => {
            cv.text(text, x, y, size, C.text2, { literal: true });
            cv.fillRect(x, y + Math.round(size * 0.55), w, 1, C.line);
        };
        /**
         * A button. opts: primary (BMW blue, or o.color), danger (dark, its text red), on (a selected choice: a
         * blue line under it), size (text size).
         */
        const button = (cv, t, x, y, w, h, label, run, key, opts) => {
            const o = opts || {};
            const rad = Math.max(3, Math.round(h * 0.12));
            if (o.primary) {
                const c = o.color || C.blue;
                cv.card(x, y, w, h, rad, [[0, o.color ? c : '#2a7be6'], [1, o.color ? c : C.blueDeep]]);
                cv.fillRect(x + rad, y, w - rad * 2, 1, withAlpha('#ffffff', 0.25));
            } else {
                cv.roundRect(x, y + 2, w, h, rad, '#00000040');
                cv.card(x, y, w, h, rad, [[0, withAlpha('#262e38', 0.96)], [1, withAlpha('#171c23', 0.96)]]);
                cv.fillRect(x + rad, y, w - rad * 2, 1, withAlpha('#ffffff', 0.12));
                if (o.on) cv.fillRect(x + rad, y + h - 3, w - rad * 2, 3, C.blue);
            }
            const sz = o.size || Math.round(h * 0.38);
            const col = o.primary ? '#ffffff' : o.danger ? '#ff6a5c' : t.text;
            cv.text(fit(cv, label, w - 16, sz), x + w / 2, y + h / 2 + sz * 0.36, sz, col, { literal: true, align: 'center' });
            if (run) cv.target(x, y, w, h, run, key, rad);
        };

        /* ---------- the map page ---------- */
        /*
         * Laid out as the BMW map of iDrive 7: with guidance a column on the left (the maneuver arrow with its
         * distance bar, the distance, the street, the arrival), the map beside it; the speed limit at the map's
         * top left, the map tiles down the right edge, the current street at the bottom, the actions at the
         * bottom right.
         */
        function drawMap(cv, t, fix, dt) {
            const k = kOf(cv), sz = (n) => Math.round(n * k);
            const bottom = PH + (cv.extra || 0), mh = bottom - TOP;
            const hu = headUp() && S.follow && !S.overview;
            const hasCard = !!(S.route && S.g);
            const colX = sz(10), colY = TOP + sz(10), colW = hasCard ? Math.min(sz(250), 400) : 0, colH = mh - sz(20);
            const left = hasCard ? colX + colW : 0;
            const vp = { x: 0, y: TOP, w: W, h: mh, cx: (left + W) / 2, cy: TOP + mh * (hu ? 0.7 : 0.52) };
            if (!S.follow && !S.overview) vp.cx = W / 2;
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
            // what is drawn over the map (labels keep out of it)
            const rowH = sz(44), rowY = bottom - rowH - sz(12);
            const avoid = [{ x: W - sz(72), y: TOP, w: sz(72), h: mh }, { x: 0, y: rowY - sz(56), w: W, h: bottom - rowY + sz(56) }];
            if (hasCard) avoid.push({ x: 0, y: TOP, w: left + sz(8), h: mh });
            avoid.push({ x: left, y: TOP, w: sz(96), h: sz(170) });       // the speed limit sign and the speed
            const routeS = S.g ? S.g.s : 0;
            view.draw(cv, vp, {
                route: S.route, routeS, car: fix ? { x: fix.x, y: fix.y, heading: fix.heading } : null,
                dest: S.dest, avoid, scale: Math.max(1, k / 1.2),
                pins: [S.sel ? { x: S.sel.x, y: S.sel.y, color: C.blue } : null, S.stop ? { x: S.stop.x, y: S.stop.y, color: '#d98b0b' } : null].filter(Boolean),
            });
            // read the tiles ahead one a frame while driving (no burst of reads when a new area comes into view)
            if (S.follow && fix && fix.speed > 5) view.prefetch(fix.x, fix.y, fix.heading, 1);
            if (S.crosshair) {
                const c = '#ffffff';
                cv.arc(vp.cx, vp.cy, sz(14), sz(16), 0, 360, withAlpha('#000000', 0.35));
                cv.arc(vp.cx, vp.cy, sz(14.5), sz(15.5), 0, 360, c);
                cv.line(vp.cx - sz(24), vp.cy, vp.cx - sz(8), vp.cy, 2, c); cv.line(vp.cx + sz(8), vp.cy, vp.cx + sz(24), vp.cy, 2, c);
                cv.line(vp.cx, vp.cy - sz(24), vp.cx, vp.cy - sz(8), 2, c); cv.line(vp.cx, vp.cy + sz(8), vp.cx, vp.cy + sz(24), 2, c);
                cv.circle(vp.cx, vp.cy, sz(2.5), C.blue);
            }
            const T = H.tr(ulang());
            if (hasCard) drawGuide(cv, colX, colY, colW, colH, k, T, fix);
            // the speed limit sign (the road the car is on) and the car's speed under it, at the map's top left
            const lim = fix && fix.maxspeed ? fix.maxspeed : 0, rr = sz(30), sx = left + sz(14) + rr;
            let sy = TOP + sz(12);
            if (lim && lim < 200) {
                H.sli(cv, sx, sy + rr, rr, lim, fix.speed > lim + 3, imperial());
                sy += rr * 2 + sz(10);
            }
            if (fix) {
                const v = String(Math.round(imperial() ? fix.speed / 1.609 : fix.speed)), over = fix.maxspeed && fix.speed > fix.maxspeed + 3;
                const cw = sz(64), ch = sz(50);
                panel(cv, sx - cw / 2, sy, cw, ch, sz(5));
                cv.text(v, sx, sy + sz(30), sz(26), over ? '#ff5a4f' : '#ffffff', { literal: true, font: 'light', align: 'center' });
                cv.text(imperial() ? 'mph' : 'km/h', sx, sy + sz(44), sz(11), C.text2, { literal: true, align: 'center' });
            }
            // map tiles (right): compass, zoom, back to the car
            const br = sz(22), bx = W - sz(14) - br;
            let by = TOP + sz(12) + br;
            H.compass(cv, bx, by, br, view.camera.heading, headUp());
            cv.target(bx - br, by - br, br * 2, br * 2, () => { settings.set('orientation', headUp() ? 'north' : 'heading'); kick(); }, 'compass', br * 0.32);
            by += br * 2 + sz(10);
            H.roundButton(cv, bx, by, br, t, '+');
            cv.target(bx - br, by - br, br * 2, br * 2, () => zoomBy(-1), 'zin', br * 0.32);
            by += br * 2 + sz(6);
            H.roundButton(cv, bx, by, br, t, '-');
            cv.target(bx - br, by - br, br * 2, br * 2, () => zoomBy(1), 'zout', br * 0.32);
            if (!S.follow) {
                by += br * 2 + sz(10);
                H.roundButton(cv, bx, by, br, t, 'locate');
                cv.target(bx - br, by - br, br * 2, br * 2, () => { S.follow = true; S.overview = false; S.crosshair = false; S.userZoomAt = 0; kick(); }, 'recenter', br * 0.32);
            }
            // the bottom row: what the position and the tank say (no guidance), the actions; the street between
            const ends = drawBottom(cv, t, fix, left + sz(12), rowY, rowH, k);
            if (fix && fix.name) {
                const nm = pack.label(fix.name, lang());
                if (nm) {
                    const s2 = sz(17), w2 = Math.min((W - left) * 0.5, cv.textWidth(nm, s2, { literal: true }) + sz(40)), h2 = sz(36);
                    let lx = (left + W) / 2 - w2 / 2, ly = rowY + (rowH - h2) / 2;
                    if (lx < ends[0] + sz(10) || lx + w2 > ends[1] - sz(10)) { lx = Math.max(left + sz(12), Math.min(lx, W - sz(80) - w2)); ly = rowY - h2 - sz(10); }
                    panel(cv, lx, ly, w2, h2, sz(5));
                    cv.text(fit(cv, nm, w2 - sz(24), s2), lx + w2 / 2, ly + h2 / 2 + s2 * 0.36, s2, '#ffffff', { literal: true, align: 'center' });
                }
            }
            if (S.sel) drawSel(cv, t, k, left, rowY);
        }

        /** BMW's guidance column: the maneuver with its distance bar, the distance, the street; the arrival at the foot. */
        function drawGuide(cv, x, y, w, h, k, T, fix) {
            const sz = (n) => Math.round(n * k), L = ulang() === 'ka';
            const M = S.route.maneuvers, g = S.g, m = M[g.next] || { type: 'arrive' }, arrived = g.arrived;
            panel(cv, x, y, w, h, sz(6), 0.95);
            const pad = sz(16), iw = w - pad * 2;
            // the arrow, white on the dark, centred in the column; the bar on its right
            const as = sz(84), top = y + sz(14), ax = x + pad + (iw - sz(14)) / 2, ay = top + as / 2;
            H.arrow(cv, ax, ay, as, arrived ? { type: 'arrive' } : m, '#ffffff', withAlpha('#ffffff', 0.28));
            if (!arrived && m.type === 'roundabout') {
                const ex = ax + as * 0.42, ey = top + sz(10);
                cv.circle(ex, ey, sz(12), C.blue);
                cv.text(String(m.exit), ex, ey + sz(5), sz(15), '#ffffff', { literal: true, font: 'bold', align: 'center' });
            }
            if (!arrived) H.distBar(cv, x + w - pad - sz(7), top + sz(4), sz(7), as - sz(8), g.dist, 300);
            // and then: a second maneuver close behind the first, small, at the arrow's lower left
            const n2 = M[g.next + 1];
            if (!arrived && n2 && n2.at - m.at < 220 && m.type !== 'arrive') {
                H.arrow(cv, x + pad + sz(14), top + as - sz(26), sz(26), n2, C.text2, withAlpha('#ffffff', 0.18));
                cv.text(T.then, x + pad + sz(14), top + as - sz(2), sz(11), C.text3, { literal: true, align: 'center' });
            }
            let ty = top + as + sz(8);
            if (arrived) {
                cv.text(fit(cv, T.arrived, iw, sz(22), { font: 'bold' }), x + pad, ty + sz(26), sz(22), '#ffffff', { literal: true, font: 'bold' });
                cv.text(fit(cv, S.dest ? S.dest.title : '', iw, sz(15)), x + pad, ty + sz(50), sz(15), C.text2, { literal: true });
                return;
            }
            const dd = H.fmtDist(g.dist, imperial()), ds = sz(44);
            const dw = cv.textWidth(dd[0], ds, { literal: true, font: 'light' });
            cv.text(dd[0], x + pad, ty + sz(38), ds, '#ffffff', { literal: true, font: 'light' });
            cv.text(dd[1], x + pad + dw + sz(6), ty + sz(38), sz(19), C.text2, { literal: true });
            ty += sz(48);
            const nm = m.type === 'arrive' ? (S.dest ? S.dest.title : '') : (pack.label(m.name, lang()) || pack.label(m.ref, lang() === 'en' ? 'en' : 'ka').split(';')[0] || '');
            cv.text(fit(cv, nm || H.phrase(m, ulang()), iw, sz(18), { font: 'bold' }), x + pad, ty + sz(18), sz(18), '#ffffff', { literal: true, font: 'bold' });
            if (nm) cv.text(fit(cv, H.phrase(m, ulang()), iw, sz(14)), x + pad, ty + sz(40), sz(14), C.text2, { literal: true });
            // the arrival: the flag and the time; distance and time to go; the fuel on arrival or the fuel stop
            const fp = fuelPlan();
            let fuelTxt = null;
            if (S.stop) {
                const ds2 = H.fmtDist(fix ? Math.hypot(S.stop.x - fix.x, S.stop.y - fix.y) * groundScale(S.stop.y) : 0, imperial());
                fuelTxt = [(L ? 'საწვავის გაჩერება ' : 'Fuel stop in ') + ds2.join(' '), C.amber];
            } else if (fp) {
                fuelTxt = [(L ? 'მისვლისას ' : 'Range on arrival ') + (fp.arr < 0 ? '-' : '') + kmText(Math.abs(fp.arr)) + ' ' + kmUnit(), fp.arr < 0 ? '#ff5a4f' : fp.arr < FU.RESERVE_KM ? C.amber : C.text2];
            }
            const bb = sz(fuelTxt ? 92 : 72), fy = y + h - bb;
            if (fy < ty + sz(48)) return;
            cv.fillRect(x + pad, fy, iw, 1, C.line);
            const eta = H.clock(new Date(Date.now() + g.secs * 1000)), es = sz(30);
            H.glyph(cv, x + pad + sz(8), fy + sz(26), sz(16), 'flag', '#ffffff');
            cv.text(eta, x + pad + sz(26), fy + sz(38), es, '#ffffff', { literal: true, font: 'light' });
            const ew = cv.textWidth(eta, es, { literal: true, font: 'light' });
            cv.text(fit(cv, T.eta, iw - sz(34) - ew, sz(13)), x + pad + sz(34) + ew, fy + sz(37), sz(13), C.text2, { literal: true });
            const d = H.fmtDist(g.left, imperial()), du = H.fmtDur(g.secs);
            cv.text(fit(cv, d.join(' ') + '  ·  ' + du.join(' '), iw, sz(15)), x + pad, fy + sz(62), sz(15), C.text2, { literal: true });
            if (fuelTxt) cv.text(fit(cv, fuelTxt[0], iw, sz(14)), x + pad, fy + sz(84), sz(14), fuelTxt[1], { literal: true });
        }

        /**
         * The bottom row of the map: with no guidance, where the car is and its range (left); the actions from the
         * right. Returns [right edge of the left part, left edge of the actions].
         */
        function drawBottom(cv, t, fix, x0, y, h, k) {
            const sz = (n) => Math.round(n * k), L = ulang() === 'ka';
            let infoEnd = x0;
            if (!S.route) {
                const ll = fix ? unmerc(fix.x, fix.y) : null, f = fuel.state(demo());
                const pos0 = ll ? ll[0].toFixed(4) + ', ' + ll[1].toFixed(4) : (L ? 'მდებარეობა უცნობია' : 'No position');
                const rng = f && typeof f.rangeKm === 'number' ? kmText(f.rangeKm) : null;
                const s1 = sz(15), rs = sz(22);
                const w1 = cv.textWidth(pos0, s1, { literal: true }) + sz(32);
                const w2 = rng ? cv.textWidth(rng, rs, { literal: true, font: 'light' }) + cv.textWidth(kmUnit(), sz(12), { literal: true }) + sz(36) : 0;
                const bw = w1 + w2;
                panel(cv, x0, y, bw, h, sz(5));
                cv.text(pos0, x0 + sz(16), y + h / 2 + s1 * 0.36, s1, ll ? C.text2 : '#ff5a4f', { literal: true });
                if (rng) {
                    const rx0 = x0 + w1;
                    cv.fillRect(rx0, y + sz(10), 1, h - sz(20), C.line);
                    const rw = cv.textWidth(rng, rs, { literal: true, font: 'light' });
                    cv.text(rng, rx0 + sz(14), y + h / 2 + rs * 0.36, rs, f.rangeKm < FU.LOW_KM ? C.amber : '#ffffff', { literal: true, font: 'light' });
                    cv.text(kmUnit(), rx0 + sz(18) + rw, y + h / 2 + rs * 0.36, sz(12), C.text2, { literal: true });
                }
                infoEnd = x0 + bw;
            }
            // the actions, from the right
            let rx = W - sz(12);
            const btn = (label, run, key, o) => {
                const bw = Math.max(sz(96), cv.textWidth(label, Math.round(h * 0.38), { literal: true }) + sz(32));
                rx -= bw;
                button(cv, t, rx, y, bw, h, label, run, key, o);
                rx -= sz(8);
            };
            if (S.route) {
                btn(L ? 'გაუქმება' : 'Stop guidance', () => { cancelRoute(); kick(); }, 'cancel', { danger: true });
                const fp = fuelPlan();
                if (fp && fp.need) btn(L ? 'საწვავის გაჩერება' : 'Add fuel stop', () => { addFuelStop(); kick(); }, 'fuelstop', { color: '#c27c0e', primary: true });
                btn(S.overview ? (L ? 'მიყოლა' : 'Follow') : (L ? 'მიმოხილვა' : 'Overview'), () => { if (S.overview) { S.follow = true; S.overview = false; } else overview(); kick(); }, 'overview');
            } else {
                const P = search && search.places;
                if (P && P.work) btn(L ? 'სამსახური' : 'Work', () => navigateTo(P.work), 'work');
                if (P && P.home) btn(L ? 'სახლი' : 'Home', () => navigateTo(P.home), 'home');
                const f = fuel.state(demo());
                if (f && typeof f.rangeKm === 'number' && f.rangeKm < FU.LOW_KM) btn(L ? 'საწვავი' : 'Fuel', () => { goFuel(); kick(); }, 'gofuel', { color: '#c27c0e', primary: true });
                if (demo() && S.cancelledTour) btn(L ? 'დემო ტური' : 'Demo tour', () => { S.cancelledTour = false; startTour(); kick(); }, 'tour');
            }
            btn(L ? 'ძიება' : 'Search', () => { page = 1; kick(); }, 'search', { primary: true });
            return [infoEnd, rx + sz(8)];
        }

        /** The place picked on the map (or in Search): Go, Save, Home, Work, I'm here. */
        function drawSel(cv, t, k, left, rowY) {
            const sz = (n) => Math.round(n * k), L = ulang() === 'ka';
            const x = left + sz(12), w = Math.min(sz(560), W - x - sz(80)), h = sz(126), y = rowY - h - sz(12);
            panel(cv, x, y, w, h, sz(6));
            cv.fillRect(x, y + sz(6), sz(3), h - sz(12), C.blue);
            const sel = S.sel, fix = pos.fix();
            cv.text(fit(cv, sel.title, w - sz(70), sz(20), { font: 'bold' }), x + sz(18), y + sz(32), sz(20), '#ffffff', { literal: true, font: 'bold' });
            let sub = sel.sub || '';
            if (fix) { const d = H.fmtDist(Math.hypot(sel.x - fix.x, sel.y - fix.y) * groundScale(fix.y), imperial()); sub += (sub ? '  ·  ' : '') + d[0] + ' ' + d[1]; }
            cv.text(fit(cv, sub, w - sz(30), sz(14)), x + sz(18), y + sz(56), sz(14), C.text2, { literal: true });
            // close
            H.glyph(cv, x + w - sz(24), y + sz(24), sz(16), 'close', C.text2);
            cv.target(x + w - sz(48), y, sz(48), sz(48), () => { S.sel = null; kick(); }, 'selclose', sz(5));
            const bh = sz(40), by = y + h - bh - sz(12);
            let bx = x + sz(16);
            const b = (label, run, key, o) => {
                const bw = Math.max(sz(84), cv.textWidth(label, Math.round(bh * 0.38), { literal: true }) + sz(26));
                button(cv, t, bx, by, bw, bh, label, run, key, o);
                bx += bw + sz(8);
            };
            const place = Search.place(sel.title, sel.sub, sel.x, sel.y);
            b(L ? 'წასვლა' : 'Start guidance', () => { navigateTo(Object.assign({}, sel)); kick(); }, 'go', { primary: true });
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
        /*
         * The speller, after iDrive 7's: the entry line on top (faint field, a blue line under it, the cursor in
         * blue), flat dark keys in a grid, the results beside it as BMW list rows. The HMI has no text entry an
         * app can use, so this page is drawn; its categories and saved places are in the native menu too.
         */
        function drawSearch(cv, t, fix) {
            const k = kOf(cv), sz = (n) => Math.round(n * k), L = ulang() === 'ka';
            const bottom = PH + (cv.extra || 0), top = TOP + sz(8);
            pageBg(cv, TOP, bottom - TOP);
            // the car's own speed too: with no position (no fix) the keyboard must still lock (guard.js)
            const moving = keyboardLocked(fix, pos.carSpeed());
            const kw = Math.round(W * 0.55), lx = sz(12);
            // the entry line
            const qh = sz(52);
            cv.card(lx, top, kw - lx, qh, sz(4), [[0, withAlpha('#ffffff', 0.08)], [1, withAlpha('#ffffff', 0.04)]]);
            cv.fillRect(lx, top + qh - 2, kw - lx, 2, C.blue);
            H.glyph(cv, lx + sz(24), top + qh / 2, sz(16), 'search', C.text2);
            const q = S.query, qs = sz(22);
            if (q) {
                const shown = fit(cv, q, kw - lx - sz(150), qs);
                const qw = cv.text(shown, lx + sz(46), top + qh / 2 + qs * 0.36, qs, '#ffffff', { literal: true });
                if (Math.floor(Date.now() / 530) % 2 === 0) cv.fillRect(lx + sz(48) + qw, top + sz(12), 2, qh - sz(24), C.blueLight);
            } else cv.text(L ? 'ქუჩა, ადგილი, ქალაქი ან კოორდინატები...' : 'Street, place, city, or lat, lon...', lx + sz(46), top + qh / 2 + qs * 0.36, qs, C.text3, { literal: true });
            if (q) button(cv, t, kw - sz(96), top + sz(8), sz(80), qh - sz(16), L ? 'წაშლა' : 'Clear', () => { S.query = ''; runSearch(); kick(); }, 'qclear');
            // the keys (locked while driving)
            const ky = top + qh + sz(12), kh = bottom - ky - sz(10);
            if (moving) {
                panel(cv, lx, ky, kw - lx, kh, sz(6));
                cv.text(L ? 'კლავიატურა მოძრაობისას დაბლოკილია' : 'The keyboard is locked while driving', lx + (kw - lx) / 2, ky + kh / 2 - sz(8), sz(19), '#ffffff', { literal: true, align: 'center' });
                cv.text(L ? 'გამოიყენეთ კატეგორიები ან შენახული ადგილები' : 'Use the categories or saved places on the right', lx + (kw - lx) / 2, ky + kh / 2 + sz(22), sz(14), C.text2, { literal: true, align: 'center' });
            } else {
                const rows = KEYS[S.kbd].concat(['__bottom']);
                const rh = Math.floor(kh / rows.length), gap = sz(4), kr = sz(3);
                const key = (x, y, w, hh, label, size, run, id, dark) => {
                    cv.card(x, y, w, hh, kr, dark ? [[0, C.keyDark], [1, '#101419']] : [[0, C.keyTop], [1, C.key]]);
                    cv.fillRect(x + kr, y, w - kr * 2, 1, withAlpha('#ffffff', dark ? 0.06 : 0.1));
                    if (label === '<') H.glyph(cv, x + w / 2, y + hh / 2, sz(20), 'back', '#ffffff');
                    else cv.text(label, x + w / 2, y + hh / 2 + size * 0.36, size, '#ffffff', { literal: true, align: 'center' });
                    cv.target(x, y, w, hh, () => { run(); kick(); }, id, kr);
                };
                rows.forEach((row, ri) => {
                    const y = ky + ri * rh;
                    if (row === '__bottom') {
                        const keys = [[S.kbd === 'ka' ? 'ABC' : 'ქართ', 1.4, () => { S.kbd = S.kbd === 'ka' ? 'en' : 'ka'; }, true], [L ? 'ჰარი' : 'Space', 4.2, () => { S.query += ' '; runSearch(); }],
                            ['<', 1.4, () => { S.query = S.query.slice(0, -1); runSearch(); }, true]];
                        const tot = keys.reduce((a, b) => a + b[1], 0), unit = (kw - lx - gap * (keys.length - 1)) / tot;
                        let x = lx;
                        keys.forEach((kk) => {
                            const w = unit * kk[1];
                            key(x, y, w, rh - gap, kk[0], sz(18), kk[2], 'kb_' + kk[0], kk[3]);
                            x += w + gap;
                        });
                        return;
                    }
                    const chars = Array.from(row), n = Math.max(10, chars.length), kwid = (kw - lx - gap * (n - 1)) / n;
                    const x0 = lx + (n - chars.length) * (kwid + gap) / 2;
                    chars.forEach((c, i) => {
                        key(x0 + i * (kwid + gap), y, kwid, rh - gap, S.kbd === 'en' ? c.toUpperCase() : c, sz(21), () => { S.query += c; runSearch(); }, 'k_' + c);
                    });
                });
            }
            // results, or the categories and the saved places
            const rx = kw + sz(14), rw = W - rx - sz(12), ry = top, rh2 = bottom - ry - sz(10);
            panel(cv, rx, ry, rw, rh2, sz(6));
            let list = [];
            let title = '';
            if (S.cat) { list = S.cat.res; title = L ? S.cat.c.ka : S.cat.c.en; } else if (S.query.trim()) { list = S.results; title = list.length ? '' : (L ? 'ვერაფერი მოიძებნა' : 'Nothing found'); }
            const at = fix ? { x: fix.x, y: fix.y } : null;
            if (!S.query.trim() && !S.cat) {
                // categories (2 x 3) as iDrive tiles, then Home / Work / favourites / recent
                const cw = (rw - sz(36)) / 3, chh = sz(54);
                CATEGORIES.forEach((c, i) => {
                    const cx = rx + sz(12) + (i % 3) * (cw + sz(6)), cy = ry + sz(12) + Math.floor(i / 3) * (chh + sz(6));
                    cv.card(cx, cy, cw, chh, sz(4), [[0, withAlpha('#ffffff', 0.07)], [1, withAlpha('#ffffff', 0.03)]]);
                    poiIcon(cv, cx + sz(24), cy + chh / 2, sz(10), c.kinds[0]);
                    cv.text(fit(cv, L ? c.ka : c.en, cw - sz(52), sz(15)), cx + sz(44), cy + chh / 2 + sz(5), sz(15), '#ffffff', { literal: true });
                    cv.target(cx, cy, cw, chh, () => { S.cat = { c, res: search.near(c.kinds, at || { x: view.camera.x, y: view.camera.y }, 25) }; S.scroll = 0; kick(); }, 'cat_' + c.id, sz(4));
                });
                const P = search ? search.places : { favs: [], recent: [] };
                list = [];
                if (P.home) list.push(Object.assign({ icon: 'home' }, P.home, { title: (L ? 'სახლი: ' : 'Home: ') + P.home.title }));
                if (P.work) list.push(Object.assign({ icon: 'work' }, P.work, { title: (L ? 'სამსახური: ' : 'Work: ') + P.work.title }));
                (P.favs || []).forEach((f) => list.push(Object.assign({ icon: 'fav' }, f)));
                (P.recent || []).forEach((f) => list.push(Object.assign({ icon: 'recent' }, f)));
                const ly = ry + sz(12) + 2 * (chh + sz(6)) + sz(10);
                heading(cv, L ? 'შენახული და ბოლო ადგილები' : 'Saved and recent places', rx + sz(16), ly + sz(14), rw - sz(32), sz(14));
                if (!list.length) cv.text(L ? 'ჯერ არაფერია: აირჩიეთ ადგილი და "შენახვა"' : 'None yet: pick a place on the map or in Search and Save it', rx + sz(16), ly + sz(46), sz(14), C.text3, { literal: true });
                drawList(cv, t, list, rx, ly + sz(26), rw, ry + rh2 - ly - sz(32), at, k);
                return;
            }
            if (title) {
                if (S.cat) H.glyph(cv, rx + sz(24), ry + sz(24), sz(14), 'close', C.text2);
                heading(cv, title, rx + (S.cat ? sz(40) : sz(16)), ry + sz(30), rw - (S.cat ? sz(56) : sz(32)), sz(16));
            }
            if (S.cat) cv.target(rx, ry, rw, sz(44), () => { S.cat = null; kick(); }, 'catback', sz(4));
            drawList(cv, t, list, rx, ry + (title ? sz(44) : sz(8)), rw, rh2 - (title ? sz(52) : sz(16)), at, k);
        }
        /** BMW list rows: icon, title, grey second line, distance on the right, thin rules between. */
        function drawList(cv, t, list, x, y, w, h, at, k) {
            const sz = (n) => Math.round(n * k);
            const rowH = sz(58), rows = Math.max(1, Math.floor(h / rowH));
            resultsGeo.rows = rows; resultsGeo.rowH = rowH; resultsGeo.count = list.length;
            cv.scroll = { y, bar: null };
            const first = Math.min(S.scroll, Math.max(0, list.length - rows));
            for (let i = 0; i < rows && first + i < list.length; i++) {
                const r = list[first + i], ry = y + i * rowH;
                const title = typeof r.title === 'function' ? r.title(lang()) : r.title, sub = typeof r.sub === 'function' ? r.sub(lang()) : r.sub || '';
                cv.fillRect(x + sz(14), ry + rowH - 1, w - sz(28), 1, C.line);
                if (r.kind) poiIcon(cv, x + sz(30), ry + rowH / 2, sz(10), r.kind === KIND.STREET ? 18 : r.kind <= 5 ? 14 : r.kind);
                else H.glyph(cv, x + sz(30), ry + rowH / 2, sz(16), r.icon, C.text2);
                const dist = at ? Math.hypot(r.x - at.x, r.y - at.y) * groundScale(at.y) : null;
                const dtx = dist != null ? H.fmtDist(dist, imperial()).join(' ') : '';
                const dw = dtx ? cv.textWidth(dtx, sz(14), { literal: true }) + sz(16) : 0;
                cv.text(fit(cv, title, w - sz(70) - dw, sz(17)), x + sz(54), ry + sz(25), sz(17), '#ffffff', { literal: true });
                cv.text(fit(cv, sub, w - sz(70) - dw, sz(13)), x + sz(54), ry + sz(45), sz(13), C.text2, { literal: true });
                if (dtx) cv.text(dtx, x + w - sz(16), ry + sz(35), sz(14), C.text2, { literal: true, align: 'right' });
                cv.target(x + sz(6), ry, w - sz(12), rowH, () => choose(r), 'row_' + (first + i), sz(4));
            }
            if (list.length > rows) {
                const th = Math.max(sz(30), h * rows / list.length), ty = y + (h - th) * first / Math.max(1, list.length - rows);
                cv.roundRect(x + w - sz(7), ty, sz(3), th, sz(1.5), withAlpha('#ffffff', 0.35));
                cv.scroll = { y, bar: { x: x + w - sz(7), y: ty, w: sz(3), h: th } };
            }
        }

        /* ---------- the route & guidance page ---------- */
        /** The learned NAV pattern, kept in the app's own data folder only ('' forgets it). */
        function saveNavKey(text, source) {
            const pairs = navkey.parse(text);
            S.navKey = pairs ? { text, pairs, source: source || '' } : null;
            try {
                if (pairs) writeWhole(navBtnFile, JSON.stringify({ match: text, source: source || '', at: Date.now() }));
                else fs.unlinkSync(navBtnFile);
            } catch (e) { /* read-only (preview) */ }
        }

        function fuelLine() {
            const f = fuel.state(demo()), L = ulang() === 'ka';
            if (!f) return L ? 'მანქანიდან მონაცემი არ არის (KombiIF)' : 'No data from the car (KombiIF)';
            const parts = [];
            if (typeof f.litres === 'number') parts.push(f.litres + (L ? ' ლ' : ' l'));
            if (typeof f.rangeKm === 'number') parts.push(kmText(f.rangeKm) + ' ' + kmUnit() + (L ? ' მარაგი' : ' range'));
            if (f.cons) parts.push(f.cons.value.toFixed(1) + ' ' + f.cons.unit);
            return parts.join('  ·  ') + (f.source === 'demo' ? (L ? '  (დემო)' : '  (demo)') : '');
        }
        /** The drawn Route page (setting "menus": drawn; the native menu has the same in BMW's own lists). */
        function drawRoute(cv, t, fix) {
            const k = kOf(cv), sz = (n) => Math.round(n * k), L = ulang() === 'ka';
            const bottom = PH + (cv.extra || 0), top = TOP + sz(8);
            pageBg(cv, TOP, bottom - TOP);
            const lx = sz(12), lw = Math.round(W * 0.58), rx = lx + lw + sz(12), rw = W - rx - sz(12), h = bottom - top - sz(10);
            const curAvoid = settings.get('avoid') || 'none', avoidOpts = avoidOptions();
            // a status line: grey label, white value, the HMI's thin rule under it
            const statRow = (x, y, w, label, value, col) => {
                cv.text(label, x, y, sz(14), C.text2, { literal: true });
                cv.text(fit(cv, value, w - sz(170), sz(14)), x + sz(164), y, sz(14), col || '#ffffff', { literal: true });
                cv.fillRect(x, y + sz(12), w, 1, C.line);
            };

            // left: the route and its maneuvers (or the route preference and status with no route)
            panel(cv, lx, top, lw, h, sz(6));
            if (S.route && S.dest) {
                const T = H.tr(ulang());
                const g = S.g || { s: 0, next: 0, left: S.route.length, secs: S.route.duration };
                const fp = fuelPlan(), fuelBtn = !!(S.stop || (fp && fp.need));
                const tw0 = lw - sz(fuelBtn ? 400 : 260);
                H.glyph(cv, lx + sz(26), top + sz(26), sz(16), 'flag', '#ffffff');
                cv.text(fit(cv, S.dest.title || (L ? 'დანიშნულება' : 'Destination'), tw0, sz(20), { font: 'bold' }), lx + sz(44), top + sz(32), sz(20), '#ffffff', { literal: true, font: 'bold' });
                const d = H.fmtDist(g.left, imperial()), du = H.fmtDur(g.secs), eta = H.clock(new Date(Date.now() + g.secs * 1000));
                // fuel before the arrival time: a long line loses the time, not the fuel
                let sub = d[0] + ' ' + d[1] + '  ·  ' + du[0] + ' ' + du[1];
                if (S.stop) sub += '  ·  ' + (L ? 'გაჩერება: ' : 'via ') + S.stop.title;
                else if (fp) sub += '  ·  ' + (L ? 'მისვლისას ' : 'arrive with ') + (fp.arr < 0 ? '-' : '') + kmText(Math.abs(fp.arr)) + ' ' + kmUnit();
                sub += '  ·  ' + T.eta + ' ' + eta;
                cv.text(fit(cv, sub, tw0 + sz(30), sz(14)), lx + sz(16), top + sz(56), sz(14), fp && fp.need ? C.amber : C.text2, { literal: true });
                const bh = sz(38);
                let bx = lx + lw - sz(14);
                const tb = (label, run, key, o, bw) => { bx -= bw; button(cv, t, bx, top + sz(14), bw, bh, label, run, key, o); bx -= sz(8); };
                tb(L ? 'გაუქმება' : 'Stop guidance', () => { cancelRoute(); kick(); }, 'rt_cancel', { danger: true }, sz(132));
                tb(L ? 'რუკაზე' : 'Overview', () => { overview(); page = 0; kick(); }, 'rt_ov', null, sz(100));
                if (fuelBtn) {
                    tb(S.stop ? (L ? 'გაჩერების მოხსნა' : 'Remove stop') : (L ? '+ საწვავი' : '+ Fuel stop'),
                        () => { if (S.stop) removeFuelStop(); else addFuelStop(); kick(); }, 'rt_fuel', S.stop ? null : { primary: true, color: '#c27c0e' }, sz(130));
                }
                // the route preference: three choices, the chosen one underlined in blue
                const py = top + sz(70), ph = sz(36), pw = (lw - sz(40)) / 3;
                avoidOpts.forEach((o, idx) => {
                    button(cv, t, lx + sz(14) + idx * (pw + sz(6)), py, pw, ph, o[1], () => {
                        settings.set('avoid', o[0]);
                        if (S.dest) plan(S.dest, { quiet: true });
                        kick();
                    }, 'av_' + o[0], { on: curAvoid === o[0] });
                });
                // the maneuvers ahead: BMW's list rows, the next one marked with a blue bar
                const sy = py + ph + sz(12), sh = top + h - sy - sz(8);
                const M = S.route.maneuvers || [];
                const steps = M.slice(Math.max(0, Math.min(M.length - 1, g.next || 0)));
                const rowH = sz(54), rows = Math.max(1, Math.floor(sh / rowH));
                routeGeo.rows = rows; routeGeo.rowH = rowH; routeGeo.count = steps.length;
                cv.scroll = { y: sy, bar: null };
                const first = Math.min(S.routeScroll, Math.max(0, steps.length - rows));
                for (let i = 0; i < rows && first + i < steps.length; i++) {
                    const m = steps[first + i], ry = sy + i * rowH, next = first + i === 0;
                    cv.fillRect(lx + sz(14), ry + rowH - 1, lw - sz(28), 1, C.line);
                    if (next) cv.fillRect(lx + sz(14), ry + sz(8), sz(3), rowH - sz(16), C.blue);
                    H.arrow(cv, lx + sz(44), ry + rowH / 2, sz(32), m, '#ffffff', withAlpha('#ffffff', 0.28));
                    const dtx = H.fmtDist(Math.max(0, m.at - g.s), imperial()).join(' ');
                    const dw = cv.textWidth(dtx, sz(15), { literal: true }) + sz(18);
                    cv.text(fit(cv, stepName(m), lw - sz(96) - dw, sz(17)), lx + sz(76), ry + sz(24), sz(17), '#ffffff', { literal: true });
                    cv.text(fit(cv, H.phrase(m, ulang()), lw - sz(96) - dw, sz(13)), lx + sz(76), ry + sz(44), sz(13), C.text2, { literal: true });
                    cv.text(dtx, lx + lw - sz(18), ry + sz(33), sz(15), next ? C.blueLight : C.text2, { literal: true, align: 'right' });
                    cv.target(lx + sz(6), ry, lw - sz(12), rowH, () => showStep(m), 'step_' + (first + i), sz(4));
                }
                if (steps.length > rows) {
                    const th = Math.max(sz(28), sh * rows / steps.length), ty = sy + (sh - th) * first / Math.max(1, steps.length - rows);
                    cv.roundRect(lx + lw - sz(7), ty, sz(3), th, sz(1.5), withAlpha('#ffffff', 0.35));
                    cv.scroll = { y: sy, bar: { x: lx + lw - sz(7), y: ty, w: sz(3), h: th } };
                }
            } else {
                routeGeo.rows = 0; routeGeo.count = 0;
                heading(cv, L ? 'მარშრუტის ტიპი' : 'Route preference', lx + sz(16), top + sz(30), lw - sz(32), sz(16));
                const py = top + sz(50), ph = sz(40), pw = (lw - sz(40)) / 3;
                avoidOpts.forEach((o, idx) => {
                    button(cv, t, lx + sz(14) + idx * (pw + sz(6)), py, pw, ph, o[1], () => { settings.set('avoid', o[0]); kick(); }, 'av_' + o[0], { on: curAvoid === o[0] });
                });
                let y = py + ph + sz(40);
                heading(cv, L ? 'სტატუსი' : 'Status', lx + sz(16), y, lw - sz(32), sz(16));
                y += sz(32);
                const ll = fix ? unmerc(fix.x, fix.y) : null;
                const roadName = fix && fix.name && pack ? pack.label(fix.name, lang()) : '';
                [
                    [L ? 'პოზიციის წყარო' : 'Position source', srcLabelOf(fix)],
                    [L ? 'კოორდინატები' : 'Coordinates', ll ? ll[0].toFixed(5) + ', ' + ll[1].toFixed(5) + '  (' + Math.round(fix.heading || 0) + '°)' : '—'],
                    [L ? 'მიმდინარე გზა' : 'Current road', roadName || '—'],
                    [L ? 'საწვავი' : 'Fuel', fuelLine()],
                    [L ? 'დაყენებული რუკა' : 'Installed map', packs.map((p) => p.meta.region + ' (' + p.meta.counts.nodes + ' nodes, ' + p.meta.counts.edges + ' roads)').join(', ')],
                ].forEach((ln) => { statRow(lx + sz(16), y, lw - sz(32), ln[0], ln[1]); y += sz(30); });
                const bh = sz(42), by = top + h - bh - sz(14);
                button(cv, t, lx + sz(14), by, sz(190), bh, L ? 'დანიშნულების შეყვანა' : 'Enter destination', () => { page = 1; kick(); }, 'rt_search', { primary: true });
                button(cv, t, lx + sz(214), by, sz(190), bh, L ? 'დემო ტური' : 'Start demo tour', () => { S.cancelledTour = false; startTour(); page = 0; kick(); }, 'rt_demo');
            }

            // right: Home, Work, favourites and recent; opening in place of the BMW map; the console NAV button
            panel(cv, rx, top, rw, h, sz(6));
            heading(cv, L ? 'შენახული დანიშნულებები' : 'Saved destinations', rx + sz(16), top + sz(30), rw - sz(32), sz(16));
            const P = search ? search.places : { home: null, work: null, favs: [], recent: [] };
            const qbh = sz(44), qbw = (rw - sz(36)) / 2, qby = top + sz(48);
            button(cv, t, rx + sz(14), qby, qbw, qbh, P.home ? (L ? 'სახლი' : 'Home') : (L ? '+ სახლი' : '+ Home'), () => {
                if (P.home) { navigateTo(P.home); kick(); } else { page = 1; toast(L ? 'აირჩიეთ ადგილი და დააჭირეთ "სახლი"' : 'Pick a place and tap Home to set it'); kick(); }
            }, 'rt_home', P.home ? { primary: true } : null);
            button(cv, t, rx + sz(22) + qbw, qby, qbw, qbh, P.work ? (L ? 'სამსახური' : 'Work') : (L ? '+ სამსახური' : '+ Work'), () => {
                if (P.work) { navigateTo(P.work); kick(); } else { page = 1; toast(L ? 'აირჩიეთ ადგილი და დააჭირეთ "სამსახური"' : 'Pick a place and tap Work to set it'); kick(); }
            }, 'rt_work', P.work ? { primary: true } : null);
            // favourites and recent (as many rows as fit above the BMW map / NAV controls)
            let ry = qby + qbh + sz(10);
            const rRowH = sz(44), ctlTop = top + h - sz(196);
            const quickList = (P.favs || []).map((f) => Object.assign({ icon: 'fav' }, f)).concat((P.recent || []).map((r) => Object.assign({ icon: 'recent' }, r)))
                .slice(0, Math.max(0, Math.min(4, Math.floor((ctlTop - ry - sz(6)) / rRowH))));
            if (!quickList.length) {
                if (ry + sz(30) < ctlTop) cv.text(L ? 'შენახული ადგილები გამოჩნდება აქ' : 'Saved and recent places appear here', rx + sz(16), ry + sz(26), sz(13), C.text3, { literal: true });
            } else {
                quickList.forEach((item, idx) => {
                    H.glyph(cv, rx + sz(30), ry + rRowH / 2, sz(15), item.icon, C.text2);
                    cv.text(fit(cv, item.title, rw - sz(70), sz(16)), rx + sz(52), ry + rRowH / 2 + sz(6), sz(16), '#ffffff', { literal: true });
                    cv.fillRect(rx + sz(14), ry + rRowH - 1, rw - sz(28), 1, C.line);
                    cv.target(rx + sz(6), ry, rw - sz(12), rRowH, () => { navigateTo(item); kick(); }, 'qitem_' + idx, sz(4));
                    ry += rRowH;
                });
            }
            // the stock BMW map: Navigation opens in its place (left menu bar's NAV, the tile, voice): learn / forget
            const half = Math.round(rw * 0.56), mode = openMode();
            const mapBoxY = ctlTop, sLearning = !!follower.learning;
            cv.text(fit(cv, stockStatus(), rw - sz(32), sz(13)), rx + sz(16), mapBoxY + sz(24), sz(13), sLearning ? C.amber : S.stockNav && mode === 'both' ? C.green : C.text2, { literal: true });
            const mby = mapBoxY + sz(36), mbh = sz(40);
            button(cv, t, rx + sz(14), mby, half, mbh, sLearning ? (L ? 'გაუქმება' : 'Stop learning') : (L ? 'BMW რუკის სწავლა' : 'Learn BMW map'),
                () => toggleStockLearn(), 'learn_stock', sLearning ? { primary: true, color: '#c27c0e' } : null);
            if (S.stockNav) {
                button(cv, t, rx + sz(22) + half, mby, rw - sz(36) - half, mbh,
                    L ? 'დავიწყება' : 'Forget', () => { forgetStockNav(); toast(L ? 'BMW-ის რუკა დავიწყებულია' : 'BMW map forgotten: it opens as stock'); kick(); }, 'forget_stock');
            }
            // the console NAV button
            const navBoxY = top + h - sz(106), learning = !!S.learn;
            cv.fillRect(rx + sz(14), navBoxY, rw - sz(28), 1, C.line);
            cv.text(fit(cv, navStatus(), rw - sz(32), sz(13)), rx + sz(16), navBoxY + sz(24), sz(13), learning ? C.amber : S.navKey ? C.green : C.text2, { literal: true });
            const bby = top + h - sz(56), bbh = sz(42);
            button(cv, t, rx + sz(14), bby, half, bbh, learning ? (L ? 'გაუქმება' : 'Stop learning') : (L ? 'NAV-ის სწავლა' : 'Learn NAV button'),
                () => toggleNavLearn(), 'bind_nav', learning ? { primary: true, color: '#c27c0e' } : null);
            if (S.navKey) {
                button(cv, t, rx + sz(22) + half, bby, rw - sz(36) - half, bbh,
                    L ? 'დავიწყება' : 'Forget', () => { saveNavKey('', ''); toast(L ? 'NAV ღილაკი დავიწყებულია' : 'NAV button forgotten: NAV is stock only'); kick(); }, 'unbind_nav');
            } else if (search && (P.recent || []).length) {
                button(cv, t, rx + sz(22) + half, bby, rw - sz(36) - half, bbh,
                    L ? 'ისტორიის წაშლა' : 'Clear history', () => { search.places.recent = []; search.save(); kick(); }, 'clear_rec');
            }
        }

        /* ---------- shared by the drawn Route page and the native menu ---------- */
        const srcLabelOf = (fix) => {
            const L = ulang() === 'ka';
            return !fix ? (L ? 'უცნობია' : 'No fix') : fix.source === 'gnss' ? (L ? 'მანქანის GPS (SOME/IP)' : 'Car GPS (SOME/IP)')
                : fix.source === 'dr' ? (L ? 'ინერციული (Dead Reckoning)' : 'Dead Reckoning (Speed + Gyro)') : (L ? 'დემო სიმულაცია' : 'Demo Drive');
        };
        const avoidOptions = () => {
            const L = ulang() === 'ka';
            return [['none', L ? 'უსწრაფესი' : 'Fastest'], ['tolls', L ? 'უფასო გზა' : 'Avoid tolls'], ['motorways', L ? 'მაგისტრალის გარეშე' : 'No motorways']];
        };
        /** What the stock-map follower is doing, in words. */
        function stockStatus() {
            const L = ulang() === 'ka', mode = openMode();
            return follower.learning ? (L ? 'გახსენით BMW-ის რუკა გვერდითი მენიუდან (NAV)...' : 'Now open the BMW map from the side menu (NAV)...')
                : mode !== 'both' ? (L ? 'BMW-ის რუკის მიყოლა გამორთულია (პარამეტრები)' : 'Following the BMW map is off (Settings)')
                    : S.stockNav ? (L ? 'BMW-ის რუკის ნაცვლად იხსნება ეს ნავიგაცია' : 'Opens in place of the BMW map (surface ' + S.stockNav.surfaceId + ')')
                        : surfSeen ? (L ? 'BMW-ის რუკა: დააჭირეთ "სწავლა"' : 'BMW map (side menu, tile, voice): tap Learn')
                            : (L ? 'ეკრანების სიგნალი ჯერ არ მოსულა (mgu-render nav_watch)' : 'No screen feed yet (mgu-render nav_watch)');
        }
        function toggleStockLearn() {
            const L = ulang() === 'ka';
            if (follower.learning) { follower.learning = null; if (snLearnTimer) { clearTimeout(snLearnTimer); snLearnTimer = null; } } else {
                follower.learn(Date.now());
                toast(L ? 'გახსენით BMW-ის რუკა გვერდითი მენიუდან: ნავიგაცია თავად დაბრუნდება' : 'Open the BMW map from the side menu (NAV): Navigation comes back by itself', 7000);
            }
            kick();
        }
        /** What the NAV button learning is doing, in words. */
        function navStatus() {
            const L = ulang() === 'ka', heard = S.learn ? S.learn.samples.length : 0;
            return S.learn ? (L ? 'დააჭირეთ NAV ღილაკს 3-ჯერ... (' + heard + ')' : 'Press the console NAV button 3 times... (' + heard + ' events)')
                : S.navKey ? (L ? 'NAV ხსნის ამ ნავიგაციას (სტანდარტული ეკრანიც რჩება)' : 'NAV opens this Navigation (over the stock screen)')
                    : navSeen ? (L ? 'NAV ღილაკი: დააჭირეთ "სწავლა"' : 'Console NAV button: tap Learn')
                        : (L ? 'ღილაკების სიგნალი ჯერ არ მოსულა (იხ. nav-recon.sh)' : 'No console button feed yet (see nav-recon.sh)');
        }
        function toggleNavLearn() {
            const L = ulang() === 'ka';
            if (S.learn) { S.learn = null; if (learnTimer) { clearTimeout(learnTimer); learnTimer = null; } } else {
                S.learn = { samples: [] };
                // nothing heard within 20 s: give up
                learnTimer = setTimeout(finishLearning, 20000);
                toast(L ? 'დააჭირეთ NAV ღილაკს 3-ჯერ (სტანდარტული ეკრანი გაიხსნება, დაბრუნდით აქ)' : 'Press NAV 3 times (the stock screen opens: come back here after)', 6000);
            }
            kick();
        }
        /** A maneuver's street (or what to do there) for a list row. */
        const stepName = (m) => (m.type === 'arrive' ? ((S.dest && S.dest.title) || H.tr(ulang()).arrived)
            : (pack.label(m.name, lang()) || pack.label(m.ref, lang() === 'en' ? 'en' : 'ka').split(';')[0] || H.phrase(m, ulang())));
        /** Show maneuver m on the map. */
        function showStep(m) {
            view.camera.x = m.x; view.camera.y = m.y;
            zoomWant = Math.log2(1.0 / groundScale(m.y));
            S.follow = false; S.overview = false; S.lastTouch = Date.now(); S.userZoomAt = Date.now();
            page = 0; kick();
        }

        /*
         * ---------- the native iDrive menus (setting "menus": native, the default) ----------
         * Navigation's menu and its lists are the HMI's own (app.json NAV_MENU and NAV_LIST, BMW's two-line rows in
         * the wide state): BMW's font, focus, scrolling and sounds. Only the map and the speller are drawn (the HMI
         * has no map an app can show and no text entry). While a native screen is open the drawn screen hides and
         * the controller is the HMI's (display.js nativeOver). The rows are fixed, named components shown or
         * hidden (as ambient-drive does), so a click never depends on a row index from the HMI. Texts go to the
         * HMI only when they change. "drawn": the Route page instead, as before.
         */
        const NL_ROWS = 20;
        let hasNativeMenu = null;             // the HMI made NAV_MENU (looked up once: it does not change while the app runs)
        const nativeOn = () => {
            if (hasNativeMenu === null) { try { hasNativeMenu = !!(ui.rhmi && ui.rhmi.getByName && ui.rhmi.getByName('NAV_MENU')); } catch (e) { hasNativeMenu = false; } }
            return hasNativeMenu && settings.get('menus') !== 'drawn';
        };
        const sent = {};
        const nText = (name, t1, t2) => {
            const key = t2 === undefined ? String(t1) : t1 + '\u0001' + t2;
            if (sent[name] === key) return;
            sent[name] = key;
            if (t2 === undefined) ui.text(name, t1); else ui.cells(name, 0, { Text1stRow: String(t1), Text2ndRow: String(t2) });
        };
        const nShow = (name, on) => { if (sent['v:' + name] === on) return; sent['v:' + name] = on; ui.visible(name, on); };
        const nativeOver = () => !!(ctx.display && ctx.display.nativeOver && ctx.display.nativeOver());
        /*
         * Back to the map: every native state this app opened, the list first. Not only those the HMI says are visible: a
         * state under another one can be reported hidden while it is still open (it would show again when the list closes).
         */
        const nativeOpened = {};
        const openNative = (n) => { nativeOpened[n] = true; return ui.open(n); };
        function closeNative() {
            const open = ['NAV_LIST', 'NAV_MENU'].filter((n) => nativeOpened[n] || ui.isVisible(n));
            open.forEach((n) => { nativeOpened[n] = false; });
            return open.reduce((p, n) => p.then(() => ui.close(n)), Promise.resolve()).then(() => kick());
        }
        const placeRow = (r, at) => {
            const title = typeof r.title === 'function' ? r.title(lang()) : r.title, sub = typeof r.sub === 'function' ? r.sub(lang()) : r.sub || '';
            const d = at ? H.fmtDist(Math.hypot(r.x - at.x, r.y - at.y) * groundScale(at.y), imperial()).join(' ') : '';
            return { t1: title || '', t2: [d, sub].filter(Boolean).join('  ·  '), run: () => closeNative().then(() => choose(r)) };
        };
        const here = () => { const f = pos.fix(); return f ? { x: f.x, y: f.y } : null; };

        /* the list: up to NL_ROWS rows a time, "More" for the next ones */
        let nl = { title: '', items: [], first: 0, empty: null };
        function fillList() {
            const L = ulang() === 'ka';
            nText('NAV_LIST_TITLE', nl.title);
            const items = nl.items.length ? nl.items : [nl.empty || { t1: L ? 'აქ ჯერ არაფერია' : 'Nothing here yet', t2: '' }];
            for (let i = 0; i < NL_ROWS; i++) {
                const it = items[nl.first + i];
                nShow('NL_' + i, !!it);
                if (it) nText('NL_' + i, it.t1, it.t2 || '');
            }
            const left = items.length - nl.first - NL_ROWS;
            nShow('NL_MORE', left > 0 || nl.first > 0);
            nText('NL_MORE', left > 0 ? (L ? 'მეტი (' + left + ')' : 'More (' + left + ' more)') : (L ? 'სიის დასაწყისში' : 'Back to the top'));
        }
        function showList(title, items, empty) {
            nl = { title, items, first: 0, empty: empty || null };
            if (ui.isVisible('NAV_LIST')) { fillList(); return Promise.resolve(); }
            return openNative('NAV_LIST');               // (its onVisible fills the rows)
        }
        for (let i = 0; i < NL_ROWS; i++) {
            ui.onClick('NL_' + i, () => { const it = nl.items[nl.first + i]; return it && it.run ? it.run() : null; });
        }
        ui.onClick('NL_MORE', () => { nl.first = nl.items.length - nl.first - NL_ROWS > 0 ? nl.first + NL_ROWS : 0; fillList(); });

        /* the menu: BMW's Navigation menu (destination, saved places, route, then the app's own status) */
        function fillMenu() {
            const L = ulang() === 'ka', P = search ? search.places : { favs: [], recent: [] }, fix = pos.fix();
            const notSet = (w) => (L ? 'არ არის: აირჩიეთ ადგილი რუკაზე და "' + w + '"' : 'Not set: pick a place on the map and choose ' + w);
            nText('NAV_MENU_TITLE', L ? 'ნავიგაცია' : 'Navigation');
            nText('NM_SEARCH', L ? 'დანიშნულების შეყვანა' : 'Enter destination');
            nText('NM_HOME', L ? 'სახლი' : 'Home', P.home ? P.home.title : notSet(L ? 'სახლი' : 'Home'));
            nText('NM_WORK', L ? 'სამსახური' : 'Work', P.work ? P.work.title : notSet(L ? 'სამსახური' : 'Work'));
            const nf = (P.favs || []).length, nr = (P.recent || []).length;
            nText('NM_FAVS', L ? 'რჩეული ადგილები' : 'Favourites', nf ? String(nf) + (L ? ' ადგილი' : nf === 1 ? ' place' : ' places') : (L ? 'ჯერ არაფერია' : 'None yet'));
            nText('NM_RECENT', L ? 'ბოლო დანიშნულებები' : 'Recent destinations', nr ? String(nr) + (L ? ' ადგილი' : nr === 1 ? ' place' : ' places') : (L ? 'ჯერ არაფერია' : 'None yet'));
            nText('NM_POI', L ? 'ინტერესის ობიექტები' : 'Points of interest');
            const route = !!(S.route && S.dest);
            nShow('NM_ROUTE', route); nShow('NM_STOP', route);
            const fp = route ? fuelPlan() : null, fuelRow = route && !!(S.stop || (fp && fp.need));
            nShow('NM_FUELSTOP', fuelRow);
            if (route) {
                const g = S.g || { left: S.route.length, secs: S.route.duration };
                const d = H.fmtDist(g.left, imperial()), du = H.fmtDur(g.secs), eta = H.clock(new Date(Date.now() + g.secs * 1000));
                nText('NM_ROUTE', (L ? 'მარშრუტი: ' : 'Route: ') + (S.dest.title || ''), d.join(' ') + '  ·  ' + du.join(' ') + '  ·  ' + H.tr(ulang()).eta + ' ' + eta);
                nText('NM_STOP', L ? 'მარშრუტის გაუქმება' : 'Stop guidance');
            }
            if (fuelRow) {
                nText('NM_FUELSTOP', S.stop ? (L ? 'საწვავის გაჩერების მოხსნა' : 'Remove the fuel stop') : (L ? 'საწვავის გაჩერების დამატება' : 'Add a fuel stop'),
                    S.stop ? S.stop.title : (L ? 'საწვავი არ ეყოფა ამ მგზავრობას' : 'Not enough fuel for this trip'));
            }
            const av = avoidOptions().find((o) => o[0] === (settings.get('avoid') || 'none')) || avoidOptions()[0];
            nText('NM_AVOID', L ? 'მარშრუტის ტიპი' : 'Route preference', av[1]);
            nShow('NM_DEMO', !!(demo() && S.cancelledTour && !route));
            nText('NM_DEMO', L ? 'დემო ტურის დაწყება' : 'Start the demo tour');
            const ll = fix ? unmerc(fix.x, fix.y) : null;
            nText('NM_POS', L ? 'მდებარეობა' : 'Position', srcLabelOf(fix) + (ll ? '  ·  ' + ll[0].toFixed(5) + ', ' + ll[1].toFixed(5) : ''));
            nText('NM_FUEL', L ? 'საწვავი' : 'Fuel', fuelLine());
            nText('NM_STOCK', L ? 'BMW-ის რუკის ნაცვლად გახსნა' : 'Open in place of the BMW map', (follower.learning ? '' : (L ? 'სწავლა: დააჭირეთ  ·  ' : 'Press to learn  ·  ')) + stockStatus());
            nShow('NM_STOCK_FORGET', !!S.stockNav);
            nText('NM_STOCK_FORGET', L ? 'BMW-ის რუკის დავიწყება' : 'Forget the BMW map');
            nText('NM_NAVBTN', L ? 'კონსოლის NAV ღილაკი' : 'Console NAV button', (S.learn ? '' : (L ? 'სწავლა: დააჭირეთ  ·  ' : 'Press to learn  ·  ')) + navStatus());
            nShow('NM_NAVBTN_FORGET', !!S.navKey);
            nText('NM_NAVBTN_FORGET', L ? 'NAV ღილაკის დავიწყება' : 'Forget the NAV button');
            const hm = settings.get('hudArrows') || 'near';
            nText('NM_HUD', L ? 'მობრუნებები HUD-ზე' : 'Turn arrows on the HUD', (hm === 'off' ? (L ? 'გამორთულია' : 'Off') : hm === 'route' ? (L ? 'მთელი მარშრუტი' : 'Whole route') : (L ? 'მობრუნებამდე 1 კმ' : 'Within 1 km of a turn')) + '  ·  ' + (hudTurns ? hudTurns.status() : '—'));
            nText('NM_MAP', L ? 'დაყენებული რუკა' : 'Installed map', packs.map((p) => p.meta.region + ' (' + p.meta.counts.edges + ' roads)').join(', ') || '—');
            nShow('NM_CLEAR', nr > 0);
            nText('NM_CLEAR', L ? 'ბოლო დანიშნულებების წაშლა' : 'Clear recent destinations');
        }
        /** Open Navigation's menu: native, or the drawn Route page. */
        function openMenu() {
            if (!nativeOn()) { page = 2; S.sel = null; S.crosshair = false; return render(); }
            fillMenu();
            return openNative('NAV_MENU');
        }
        let menuTimer = null;
        ui.onVisible((name, v) => {
            if (name !== 'NAV_MENU' && name !== 'NAV_LIST') return;
            // the HMI keeps what it was given; asked again after it rebuilt the screen
            if (v) Object.keys(sent).forEach((k) => { delete sent[k]; });
            if (v && name === 'NAV_MENU') fillMenu();
            if (v && name === 'NAV_LIST') fillList();
            if (!v) kick();                       // back on the map: draw at once
            // the map in front again: whatever of ours was over it is closed (BACK, HOME, or closeNative)
            if (!v) setImmediate(() => { if (ui.isVisible('MAIN') && !nativeOver()) { nativeOpened.NAV_LIST = false; nativeOpened.NAV_MENU = false; } });
            // the menu's status lines (route, position, learning) follow while it is open
            const any = ui.isVisible('NAV_MENU') || ui.isVisible('NAV_LIST');
            if (any && !menuTimer) {
                // (a timer's throw would reach the kit's uncaughtException handler, which exits the app: caught here)
                menuTimer = setInterval(() => { try { if (ui.isVisible('NAV_MENU')) fillMenu(); } catch (e) { log.warn('menu: ' + e.message); } }, 2000);
                if (menuTimer.unref) menuTimer.unref();
            } else if (!any && menuTimer) { clearInterval(menuTimer); menuTimer = null; }
        });
        const onMenu = (name, fn) => ui.onClick(name, () => { const r = fn(); if (ui.isVisible('NAV_MENU')) fillMenu(); return r; });
        onMenu('NM_SEARCH', () => closeNative().then(() => { page = 1; S.sel = null; kick(); }));
        const savedPlace = (w) => {
            const P = search && search.places, p = P && P[w], L = ulang() === 'ka';
            if (p) return closeNative().then(() => navigateTo(p));
            return closeNative().then(() => { page = 0; toast(L ? 'აირჩიეთ ადგილი რუკაზე ან ძიებაში და დააჭირეთ "' + (w === 'home' ? 'სახლი' : 'სამსახური') + '"' : 'Pick a place on the map or in Search and choose ' + (w === 'home' ? 'Home' : 'Work')); });
        };
        onMenu('NM_HOME', () => savedPlace('home'));
        onMenu('NM_WORK', () => savedPlace('work'));
        onMenu('NM_FAVS', () => { const L = ulang() === 'ka', at = here(); return showList(L ? 'რჩეული ადგილები' : 'Favourites', ((search && search.places.favs) || []).map((r) => placeRow(r, at)), { t1: L ? 'ჯერ არაფერია' : 'None yet', t2: L ? 'აირჩიეთ ადგილი და "შენახვა"' : 'Pick a place on the map or in Search and choose Save' }); });
        onMenu('NM_RECENT', () => { const L = ulang() === 'ka', at = here(); return showList(L ? 'ბოლო დანიშნულებები' : 'Recent destinations', ((search && search.places.recent) || []).map((r) => placeRow(r, at))); });
        onMenu('NM_POI', () => {
            const L = ulang() === 'ka';
            return showList(L ? 'ინტერესის ობიექტები' : 'Points of interest', CATEGORIES.map((c) => ({
                t1: L ? c.ka : c.en, t2: L ? 'ახლოს' : 'Nearby',
                run: () => {
                    const at = here() || { x: view.camera.x, y: view.camera.y };
                    return showList(L ? c.ka : c.en, (search ? search.near(c.kinds, at, 25) : []).map((r) => placeRow(r, at)), { t1: L ? 'ახლოს ვერაფერი მოიძებნა' : 'Nothing found nearby', t2: '' });
                },
            })));
        });
        onMenu('NM_ROUTE', () => {
            if (!S.route) return null;
            const g = S.g || { s: 0, next: 0 }, M = S.route.maneuvers || [];
            const steps = M.slice(Math.max(0, Math.min(M.length - 1, g.next || 0)));
            return showList((ulang() === 'ka' ? 'მარშრუტი: ' : 'Route: ') + (S.dest ? S.dest.title : ''), steps.map((m) => ({
                t1: stepName(m), t2: H.fmtDist(Math.max(0, m.at - g.s), imperial()).join(' ') + '  ·  ' + H.phrase(m, ulang()),
                run: () => closeNative().then(() => showStep(m)),
            })));
        });
        onMenu('NM_FUELSTOP', () => { if (S.stop) removeFuelStop(); else addFuelStop(); kick(); });
        onMenu('NM_STOP', () => { cancelRoute(); return closeNative(); });
        onMenu('NM_AVOID', () => {
            const o = avoidOptions().map((x) => x[0]), i = o.indexOf(settings.get('avoid') || 'none');
            settings.set('avoid', o[(i + 1) % o.length]);
            if (S.dest) plan(S.dest, { quiet: true });
        });
        onMenu('NM_DEMO', () => { S.cancelledTour = false; startTour(); page = 0; return closeNative(); });
        onMenu('NM_STOCK', () => toggleStockLearn());
        onMenu('NM_STOCK_FORGET', () => { forgetStockNav(); toast(ulang() === 'ka' ? 'BMW-ის რუკა დავიწყებულია' : 'BMW map forgotten: it opens as stock'); });
        onMenu('NM_NAVBTN', () => toggleNavLearn());
        onMenu('NM_NAVBTN_FORGET', () => { saveNavKey('', ''); toast(ulang() === 'ka' ? 'NAV ღილაკი დავიწყებულია' : 'NAV button forgotten: NAV is stock only'); });
        onMenu('NM_CLEAR', () => { if (search) { search.places.recent = []; search.save(); } });
        onMenu('NM_POS', () => null);
        onMenu('NM_FUEL', () => null);
        onMenu('NM_MAP', () => null);
        onMenu('NM_HUD', () => { const o = ['near', 'route', 'off'], i = o.indexOf(settings.get('hudArrows') || 'near'); settings.set('hudArrows', o[(i + 1) % o.length]); if (hudTurns) hudTurns.tick(); });

        /*
         * Guidance one step on: where the car is on the route, a new route when it left it, the end after arriving.
         * From each frame while Navigation is shown, and from each position while it is not (another screen, a native
         * menu): the HUD's turn arrows follow the route either way.
         */
        function guideStep(fix, now) {
            if (!(S.route && S.guide && fix)) return;
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
        pos.onFix((f) => {
            if (S.route && (!ui.isVisible('MAIN') || nativeOver())) { try { guideStep(f, Date.now()); } catch (e) { log.warn('guidance: ' + e.message); } }
            if (hudTurns) hudTurns.tick();
        });

        /* ---------- the frame ---------- */
        let loopRef = null;
        const kick = () => { if (loopRef) loopRef.kick(); };
        async function render() {
            const now = Date.now(), dt = Math.min(0.25, (now - S.lastFrame) / 1000);
            S.lastFrame = now;
            if (standing()) {
                // reversing: the picture and the controller are the HMI's (display.standDown). One plain frame for the
                // HMI's own page, then nothing is drawn or sent until the car is out of reverse
                if (S.stoodFrame) return;
                S.stoodFrame = true;
                const sc = ctx.canvas(W, PH).clear('#07090c');
                sc.text(ulang() === 'ka' ? 'უკუსვლა: ნავიგაცია შემდეგ დაბრუნდება' : 'Reversing: Navigation comes back afterwards', W / 2, 280, 22, '#ffffff', { literal: true, align: 'center' });
                await ui.image('MAIN_GFX', sc);
                return;
            }
            S.stoodFrame = false;
            // a native menu is open over the screen: the HMI shows it, nothing to draw
            if (nativeOver()) return;
            const t = ctx.theme();
            const cv = ctx.canvas(W, PH).clear('#07090c');
            const fix = pos.fix();
            if (demo() && !S.route) startTour();
            if (fix && fix.source === 'demo') fuel.demoDrive(fix.speed * dt / 3600);
            if (S.stop && fix && Math.hypot(S.stop.x - fix.x, S.stop.y - fix.y) * groundScale(fix.y) < 60) {
                log.info('fuel stop reached: ' + S.stop.title);
                S.stop = null;
            }
            const f0 = fuel.state(demo());
            if (f0 && typeof f0.rangeKm === 'number' && f0.source === 'car') {
                if (f0.rangeKm < FU.LOW_KM && !S.lowWarned) {
                    S.lowWarned = true;
                    toast((ulang() === 'ka' ? 'საწვავი მთავრდება: ' : 'Low fuel: ') + kmText(f0.rangeKm) + ' ' + kmUnit(), 6000);
                } else if (f0.rangeKm > FU.LOW_KM + 20) S.lowWarned = false;
            }
            guideStep(fix, now);
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
            G.frame(cv, t, nativeOn() ? ['Map', 'Search', 'Menu'] : PAGES, page, [
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
        let navSrv = null, navSeen = 0, lastOpen = 0, learnTimer = null, lastShownAt = 0;
        /*
         * Never over the reversing camera, by two things that do not depend on each other: the car's own gear
         * (guard.js; no surface id needed) and the renderer's camera surfaces (yield_surfaces, told on the surface
         * feed). While either says so nothing opens Navigation, the NAV button and "learned" included (up to 1.0.2
         * only the stock-map follower asked, and only the surfaces). In reverse Navigation also stands down where it
         * is shown: the picture and the controller go back to the HMI, which then shows its camera as without us.
         * app.json config.reverseGuard false: the gear is not asked (the surfaces still are).
         */
        const guard = new DriveGuard();
        const reverseGuard = !(ctx.spec.config && ctx.spec.config.reverseGuard === false);
        const standing = () => reverseGuard && guard.reversing();
        /* ---------- the next turn on the head-up display (hudturn.js, through cluster-render) ---------- */
        hudTurns = new HudTurns(ctx, {
            turn: () => {
                if (!S.route || !S.g) return null;
                const m = S.route.maneuvers[S.g.next] || { type: 'arrive' };
                const name = m.type === 'arrive' ? (S.dest ? S.dest.title : '') : (pack.label(m.name, lang()) || pack.label(m.ref, lang() === 'en' ? 'en' : 'ka').split(';')[0] || '');
                return { m, dist: S.g.dist, name, arrived: !!S.g.arrived, title: S.dest ? S.dest.title : '' };
            },
            reversing: () => standing(),
            imperial,
            lang: ulang,
        });
        const openBlocked = () => (standing() ? 'the car is in reverse' : follower.yieldShown() ? 'the camera is shown' : '');
        let gearSub = null, gearSaid = false;
        const onGear = (changed) => {
            if (!gearSaid) { gearSaid = true; log.info('reverse guard: the car tells its gear' + (guard.reversing() ? ' (reverse now)' : '')); }
            if (!changed) return;
            const r = standing();
            log.info(r ? 'reverse: Navigation stands down (picture and controller back to the HMI)' : 'out of reverse: Navigation shows again');
            if (ctx.display && ctx.display.standDown) ctx.display.standDown(r);
            kick();
        };
        if (reverseGuard && ctx.signals && ctx.signals.watch) {
            // on for as long as the app runs (a gear change is one event): the NAV button and the stock-map follower
            // ask while Navigation is in the background, where the position's signals are off
            ctx.signals.watch('de.bmw.infrastructure.VehicleInformation', '1', {
                statusGearboxDrive: (v) => onGear(guard.gearbox(v, Date.now())),
                DataPowerTrain2: (v) => onGear(guard.selection(v, Date.now())),
            }, log).then((s) => {
                if (cleanedUp) { try { s.shutdown(); } catch (e) { /* ignore */ } return; }
                gearSub = s;
                log.info('reverse guard: VehicleInformation ' + (s.error ? 'error: ' + s.error + ' (no gear: the camera surfaces alone guard)' : 'subscribed'));
            }).catch((e) => log.warn('reverse guard: ' + e));
        }
        const openSelf = (tries, askedAt) => {
            const why = openBlocked();
            if (why) { log.info('nav button: not opening Navigation: ' + why); return; }
            try {
                const desc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'rhmiData', 'application.json'), 'utf8'));
                const ep = desc.application && desc.application.entryPoints && desc.application.entryPoints[0];
                if (ep && ui.rhmi && ui.rhmi.openEntryState) Promise.resolve(ui.rhmi.openEntryState(ep.uuid)).catch((e) => log.warn('nav button: open: ' + e));
            } catch (e) { log.warn('nav button: ' + e.message); return; }
            // the stock screen may come up after ours (the HMI handles NAV meanwhile): once more if ours never came to
            // the front since it was asked for (shown and left with BACK in between: that is the driver's choice)
            if (tries > 0) setTimeout(() => { if (!ui.isVisible('MAIN') && lastShownAt < askedAt) openSelf(tries - 1, askedAt); }, 1500);
        };
        // the "Open Navigation" setting: the NAV button and the stock map (both), the NAV button only, or off
        const openMode = () => settings.get('openOnNav') || 'both';
        /** Open Navigation over the stock screen: the NAV button and the stock-map follower share one debounce. */
        const requestOpen = (why, delay) => {
            const now = Date.now();
            if (now - lastOpen < 1500 || ui.isVisible('MAIN')) return;
            lastOpen = now;
            const blocked = openBlocked();
            if (blocked) { log.info(why + ': not opening Navigation: ' + blocked); return; }
            log.info(why + ': opening Navigation over the stock screen');
            page = 0; S.sel = null;
            setTimeout(() => openSelf(1, now), delay);
            kick();
        };

        /*
         * ---------- the stock BMW map: Navigation follows it (left menu bar's NAV, the tile, voice) ----------
         * stocknav.js: mgu-render's surface lines (nav_watch) and / or a SOME/IP field (app.json config.stockNav).
         * Rising edge only, disarmed after Navigation leaves (BACK lands on the stock map), never over the camera.
         * The stock map's surface is learned on the Route page (kept in the data folder) or named in app.json.
         */
        const snCfg = (ctx.spec.config && ctx.spec.config.stockNav) || {};
        const snFile = path.join(ctx.dataDir || '.', 'stock_nav.json');
        let snSaved = null;
        try { snSaved = JSON.parse(fs.readFileSync(snFile, 'utf8')); } catch (e) { /* not learned */ }
        const follower = new StockNavFollower({
            surfaceId: snSaved && snSaved.surfaceId != null ? snSaved.surfaceId : snCfg.surfaceId != null ? snCfg.surfaceId : null,
            proc: (snSaved && snSaved.proc) || snCfg.proc || '',
            minW: snCfg.minWidth || 800, minH: snCfg.minHeight || 400,
        });
        S.stockNav = follower.configured() ? { surfaceId: follower.o.surfaceId, proc: follower.o.proc, source: snSaved ? 'learned' : 'app.json' } : null;
        let surfSeen = 0, snLearnTimer = null;
        const finishStockLearn = () => {
            if (snLearnTimer) { clearTimeout(snLearnTimer); snLearnTimer = null; }
            const r = follower.learnDone(), L = ulang() === 'ka';
            if (!r) return;
            if (r.error) {
                toast(r.error === 'none' ? (L ? 'BMW-ის რუკა ვერ დავინახე: სცადეთ ისევ' : 'Did not see the BMW map open: try again (side menu > NAV)')
                    : (L ? 'რამდენიმე ეკრანი გაიხსნა: სცადეთ ისევ' : 'Several screens opened at once: try again'), 6000);
                log.info('stock map: learning: ' + r.error);
            } else {
                S.stockNav = { surfaceId: r.surfaceId, proc: r.proc, source: 'learned' };
                try { writeWhole(snFile, JSON.stringify({ surfaceId: r.surfaceId, proc: r.proc, w: r.w, h: r.h, at: Date.now() })); } catch (e) { /* read-only */ }
                log.info('stock map learned: surface ' + r.surfaceId + ' (' + r.proc + ', ' + r.w + 'x' + r.h + ')');
                toast(L ? 'BMW-ის რუკა ნასწავლია: ნავიგაცია ახლა მის ნაცვლად გაიხსნება' : 'BMW map learned: Navigation now opens in its place', 6000);
                requestOpen('stock map learned', 200);
            }
            kick();
        };
        const forgetStockNav = () => {
            follower.o.surfaceId = null; follower.o.proc = '';
            S.stockNav = null;
            try { fs.unlinkSync(snFile); } catch (e) { /* none */ }
        };
        const onStockEdge = (res, why) => { if (res === 'open' && openMode() === 'both') requestOpen(why, 150); };
        const onSurfaceLine = (line) => {
            const r = parseSurface(line);
            if (!r) return;
            if (surfSeen++ < 60 || follower.learning) log.info('surface: ' + line.trim());
            onStockEdge(follower.surface(r, Date.now()), 'stock map shown (surface ' + r.id + ')');
            // learning: the driver opened the stock map; a moment for the rest of the screen to settle, then done
            if (follower.learning && follower.learning.cands.size && !snLearnTimer) snLearnTimer = setTimeout(finishStockLearn, 1500);
        };
        const snTimer = setInterval(() => {
            follower.tick(Date.now());
            if (follower.learning && follower.learning.result) finishStockLearn();
        }, 1000);
        if (snTimer.unref) snTimer.unref();
        if (snCfg.iface && snCfg.field && ctx.signals && ctx.signals.watch) {
            const pairs = navkey.parse(snCfg.match || '');
            const h = {};
            h[snCfg.field] = (v) => {
                const on = pairs ? navkey.matches(pairs, navkey.fromValue(v)) : !!v;
                onStockEdge(follower.state('someip', on, Date.now()), 'stock map shown (' + snCfg.iface.split('.').pop() + '.' + snCfg.field + ')');
            };
            ctx.signals.watch(snCfg.iface, snCfg.instance || '1', h, log)
                .then((s) => log.info('stock map: ' + snCfg.iface + '.' + snCfg.field + (s.error ? ' error: ' + s.error : ' subscribed')));
        }
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
            // the physical NAV button opens Navigation whatever the stock-map follower's state (only "off" stops it)
            if (S.navKey && navkey.matches(S.navKey.pairs, sample) && openMode() !== 'off') requestOpen('NAV pressed', 400);
        };
        if (process.platform === 'linux') {
            navSrv = require('net').createServer((sock) => {
                let buf = '';
                sock.setEncoding('latin1');
                sock.on('data', (d) => { buf += d; if (buf.length > 1024) sock.destroy(); });
                sock.on('end', () => {
                    // one line a connection: the gate's button ("<ms> <len> <hex>") or mgu-render's surface line
                    buf.split('\n').forEach((line) => {
                        if (/^\d+ surface /.test(line)) { onSurfaceLine(line); return; }
                        const hex = (line.trim().split(' ')[2] || '').toLowerCase();
                        if (/^[0-9a-f]{2,128}$/.test(hex)) onButton(navkey.fromHex(hex), 'gate');
                    });
                });
                sock.on('error', () => {});
            });
            navSrv.on('error', (e) => log.warn('nav button listener: ' + e.message));
            navSrv.listen('\0mgu-nav-buttons', () => {
                log.info('nav button: listening on the controller gate feed' + (S.navKey ? ' (' + S.navKey.text + ')' : ' (not learned yet)'));
                // mgu-render sees us within 2 s and tells every surface's state once: after that, a surface first
                // seen shown is a new one (made when it opened), not one shown since before
                setTimeout(() => follower.settled(), 3000).unref();
            });
        }
        if (navCfg.iface && navCfg.field && ctx.signals && ctx.signals.watch) {
            const h = {};
            h[navCfg.field] = (v) => onButton(navkey.fromValue(v), 'someip');
            ctx.signals.watch(navCfg.iface, navCfg.instance || '1', h, log)
                .then((s) => log.info('nav button: ' + navCfg.iface + '.' + navCfg.field + (s.error ? ' error: ' + s.error : ' subscribed')));
        }

        /*
         * ---------- memory: the target is under 150 MB (MainApp's limit, app.json memoryKB, is 192 MB) ----------
         * Checked every minute and written to the log every 10 minutes (what the car really uses). Over 140 MB
         * the caches are cut back: map tiles, names, shapes and the drawing buffers fill again as needed.
         */
        let memLogAt = 0, memTrimAt = 0;
        const memCheck = () => {
            const m = process.memoryUsage(), mb = (v) => Math.round(v / 1048576), now = Date.now();
            if (now - memLogAt > 600000) {
                memLogAt = now;
                log.info('memory: rss ' + mb(m.rss) + ' MB, heap ' + mb(m.heapUsed) + ' MB, buffers ' + mb(m.external) + ' MB, tiles ' + packs.reduce((a, p) => a + p._tiles.size, 0));
            }
            if (m.rss > 140 * 1048576 && now - memTrimAt > 30000) {
                memTrimAt = now;
                packs.forEach((p) => p.trim());
                view.trim();
                log.warn('memory: rss ' + mb(m.rss) + ' MB is over 140 MB: caches cut back');
            }
        };
        const memTimer = setInterval(memCheck, 60000);
        if (memTimer.unref) memTimer.unref();
        setTimeout(memCheck, 5000).unref();

        /* ---------- car sleep / shutdown safety (zero battery drain) ---------- */
        let cleanedUp = false;
        const cleanup = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            clearInterval(memTimer);
            try { track(false); } catch (e) {}
            try { if (navSrv) navSrv.close(); } catch (e) {}
            try { if (gearSub) gearSub.shutdown(); } catch (e) {}
            clearInterval(snTimer);
            try { if (hudTurns) hudTurns.stop(); } catch (e) {}
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
                if (ctx.widget.active()) track(true);
                else if (!ui.isVisible('MAIN') && !S.route) track(false);
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
                r.clear('#07090c');
                wView.camera = { x: cx, y: cy, mpp: 2.2, heading: hd };
                const vp = { x: 0, y: 0, w: ww, h: wh, cx: ww / 2, cy: Math.round(wh * 0.62) };
                wView.draw(r, vp, {
                    route: S.route, routeS: S.g ? S.g.s : 0,
                    car: fix ? { x: fix.x, y: fix.y, heading: fix.heading } : null,
                    dest: S.dest, avoid: [{ x: 0, y: wh - 54, w: ww, h: 54 }], scale: 1.0,
                });
                H.panel(r, 10, wh - 48, ww - 20, 40, 5, 0.94);
                if (S.route && S.g) {
                    const m = S.route.maneuvers[S.g.next] || { type: 'arrive' };
                    H.arrow(r, 32, wh - 28, 26, m, '#ffffff', withAlpha('#ffffff', 0.28));
                    const d = H.fmtDist(S.g.dist, imperial()).join(' ');
                    const nm = (pack && pack.label(m.name, lang())) || (S.dest ? S.dest.title : '');
                    r.text(fit(r, d + (nm ? '  ·  ' + nm : ''), ww - 150, 16, { font: 'bold' }), 54, wh - 22, 16, '#ffffff', { literal: true, font: 'bold' });
                    const rem = H.fmtDist(S.g.left, imperial()).join(' ');
                    r.text(rem, ww - 22, wh - 22, 14, H.ID7.blueLight, { literal: true, align: 'right' });
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
            if (nativeOver()) return 2;
            const max = Number(settings.get('fps')) || 60, fix = pos.fix();
            const moving = (fix && fix.speed > 0.5) || Math.abs(zoomWant - zoomLog) > 0.01 || page === 1 || (S.toast && Date.now() < S.toast.until) || S.crosshair || !!S.learn || !!follower.learning;
            // the route overview and country zoom draw the most and change the least: 15 fps, unless a finger is on it
            const far = page === 0 && (S.overview || view.camera.mpp > 40) && Date.now() - S.lastTouch > 1500;
            return page === 2 && !moving ? 6 : moving ? (far ? Math.min(max, 15) : max) : 4;
        };
        let mainShown = ui.isVisible('MAIN');     // (shown before this was set up: its hiding still counts)
        const onMainVisible = (v) => {
            if (!v && !mainShown) return;
            mainShown = v;
            follower.appVisible(v, Date.now());
            if (v) { lastShownAt = Date.now(); S.stoodFrame = false; }      // the HMI builds its page afresh
            if (v) { track(true); pos._tick(); kick(); }
            else if (!S.route && !(ctx.widget && ctx.widget.active())) track(false);          // guidance / widget keeps track of the car off screen
        };
        // Navigation left the screen: MAIN hidden with none of our own states over it. The HMI may say MAIN is hidden when a
        // state of ours opens over it (its visibility events come one state at a time), so it is looked at once they have
        // all come; and leaving from our menu (HOME there) ends with the menu hidden after MAIN, so that is looked at too
        const nativeNames = (ctx.display && ctx.display.nativeNames) || ['NAV_MENU', 'NAV_LIST', 'SETTINGS'];
        const leftYet = () => setImmediate(() => { try { if (mainShown && !ui.isVisible('MAIN') && !nativeOver()) onMainVisible(false); } catch (e) { log.warn('visible: ' + e.message); } });
        ui.onVisible((name, v) => {
            if (name === 'MAIN') { if (v) onMainVisible(true); else leftYet(); return; }
            if (!v && nativeNames.indexOf(name) >= 0) leftYet();
        });
        if (ui.isVisible('MAIN') || (ctx.widget && ctx.widget.active()) || ctx.previewDemo) {
            track(true);
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
