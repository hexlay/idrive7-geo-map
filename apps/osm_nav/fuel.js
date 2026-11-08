'use strict';
/**
 * fuel.js - the car's fuel level and range (read only) and what navigation makes of them. Node 8.
 *
 *   KombiIF.statusRangeTankStatus      fluidLevelFuelTank (litres), range (km, the cluster's own estimate),
 *                                      mileageKilometre (odometer). 255 / 4095 / 16777215: not known.
 *   KombiIF.statusBordcomputerAverage  consumptionAverage1BC1 (0.1 a step, in the cluster's unit),
 *                                      statusUnitOfMeasurementConsumptionBC.
 * The same fields m_copilot reads. Nothing is written to the car. A unit without KombiIF installs and runs
 * without fuel (app.json "_optional"); the demo drive has a simulated tank so the preview shows it all.
 *
 *   const fuel = new Fuel(ctx);  fuel.start() / fuel.stop()  (with the position: foreground or guidance)
 *   fuel.state() -> { litres, rangeKm, cons: { value, unit }, odoKm, source: 'car' | 'demo', at } | null
 *   arrivalKm(rangeKm, leftM)                    range left at the destination (km, may be < 0)
 *   stationsAlong(route, fromS, stations, opts)  fuel stations near the route ahead, by route distance
 *   pickStop(along, rangeKm, fromS)              the station to stop at: the last one reached with a reserve
 */

const CONS_UNITS = { VERBRAUCH_IN_L_S_100KM: 'l/100 km', VERBRAUCH_IN_MPG_UK: 'mpg (UK)', VERBRAUCH_IN_MPG_US: 'mpg (US)', VERBRAUCH_IN_KM_S_L: 'km/l',
    1: 'l/100 km', 2: 'mpg (UK)', 3: 'mpg (US)', 4: 'km/l' };
const IFACE = 'de.bmw.infotainment.KombiIF';
const RESERVE_KM = 50;          // arrive with less than this: a fuel stop is suggested
const LOW_KM = 60;              // range below this (no route): low fuel, the nearest stations are offered
const STOP_RESERVE_KM = 30;     // a stop is picked so the car gets there with at least this much

class Fuel {
    constructor(ctx) {
        this.ctx = ctx;
        this.log = ctx.log;
        this.car = null;            // { litres, rangeKm, odoKm, at }
        this.cons = null;           // { value, unit }
        this.subs = null;
        this.stopped = true;
        // the demo drive's tank: 41 l in it, 7.9 l/100 km (OSM_NAV_DEMO_FUEL=<litres> for the preview)
        const dl = Number(process.env.OSM_NAV_DEMO_FUEL);
        this.demo = { litres: dl > 4 && dl < 120 ? dl : 41, l100: 7.9 };
        this.listeners = [];
        this.base = undefined;      // refuel check: tank level when the car stopped (null while driving)
        this.parked = undefined;    // unknown until the position says
    }

    start() {
        if (!this.stopped) return;
        this.stopped = false;
        const S = this.ctx.signals;
        if (!S || !S.watch || this.subs) return;
        this.subs = [];
        const h = {
            statusRangeTankStatus: (v) => {
                v = v || {};
                const litres = typeof v.fluidLevelFuelTank === 'number' && v.fluidLevelFuelTank < 255 ? v.fluidLevelFuelTank : null;
                const rangeKm = typeof v.range === 'number' && v.range < 4095 ? v.range : null;
                const odoKm = typeof v.mileageKilometre === 'number' && v.mileageKilometre > 0 && v.mileageKilometre < 16777215 ? v.mileageKilometre : null;
                if (litres === null && rangeKm === null) return;
                this.car = { litres, rangeKm, odoKm, at: Date.now() };
                this._checkRefuel(litres);
            },
            statusBordcomputerAverage: (v) => {
                const r = v && v.consumptionAverage1BC1, unit = v && CONS_UNITS[v.statusUnitOfMeasurementConsumptionBC];
                this.cons = typeof r === 'number' && r > 0 && r < 65535 && unit ? { value: r * 0.1, unit } : null;
            },
        };
        S.watch(IFACE, '1', h, this.log).then((s) => {
            if (this.stopped || !this.subs) { try { s.shutdown(); } catch (e) { /* ignore */ } return; }
            this.subs.push(s);
            if (s.error) this.log.info('fuel: ' + IFACE + ' ' + s.error + ' (running without fuel data)');
            else this.log.info('fuel: ' + IFACE + ' subscribed');
        }).catch((e) => this.log.warn('fuel: ' + e));
    }

    stop() {
        if (this.stopped) return;
        this.stopped = true;
        (this.subs || []).forEach((s) => { try { s.shutdown(); } catch (e) { /* ignore */ } });
        this.subs = null;
        this._saveLevel();
    }

    onEvent(fn) { this.listeners.push(fn); }

    /** The car's speed (km/h), from the position: a refuel only counts while the car stands. */
    setSpeed(kmh) {
        const parked = typeof kmh === 'number' && kmh < 3;
        if (parked && !this.parked && this.car && typeof this.car.litres === 'number' && this.base === null) this.base = this.car.litres;
        if (!parked) { this.base = null; this.filled = false; }     // driving: fuel sloshes on hills, nothing counts
        this.parked = parked;
    }

    /**
     * Refuelled: the tank more than 4 l above its level when the car stopped (or at the last shutdown: the
     * app usually is not running while the engine is off at the pump). A pump fills gradually, so it is the
     * rise since then that counts, not the step between two readings.
     */
    _checkRefuel(litres) {
        if (typeof litres !== 'number') return;
        if (this.base === undefined) {
            // the first reading of this run: the level saved at the last shutdown is the base
            const saved = this._loadLevel();
            this.base = saved !== null ? saved : litres;
        }
        if (this.parked === false || this.base === null || this.filled) return;
        if (litres - this.base > 4) {
            this.filled = true;             // once a stop: the pump goes on filling
            this.listeners.forEach((fn) => { try { fn('refuelled'); } catch (e) { /* ignore */ } });
        } else if (litres < this.base) this.base = litres;
    }

    _levelFile() { return this.ctx.dataDir ? require('path').join(this.ctx.dataDir, 'osm_nav_fuel.json') : null; }
    _loadLevel() {
        const f = this._levelFile();
        try { const j = JSON.parse(require('fs').readFileSync(f, 'utf8')); return typeof j.litres === 'number' ? j.litres : null; } catch (e) { return null; }
    }
    _saveLevel() {
        const f = this._levelFile();
        if (!f || !this.car || typeof this.car.litres !== 'number') return;
        try { require('fs').writeFileSync(f, JSON.stringify({ litres: this.car.litres, at: Date.now() })); } catch (e) { /* read-only (preview) */ }
    }

    /** The demo drive used dKm of fuel's worth of road (called each frame while the demo drives). */
    demoDrive(dKm) {
        const D = this.demo;
        if (!(dKm > 0)) return;
        D.litres = Math.max(4, D.litres - dKm * D.l100 / 100);
    }

    /** What is known now: the car's, else (demo drive) the simulated tank, else null. */
    state(demo) {
        if (this.car && Date.now() - this.car.at < 30 * 60000) {
            return { litres: this.car.litres, rangeKm: this.car.rangeKm, odoKm: this.car.odoKm, cons: this.cons, source: 'car', at: this.car.at };
        }
        if (demo) {
            const D = this.demo;
            return { litres: Math.round(D.litres * 10) / 10, rangeKm: Math.round((D.litres - 4) / D.l100 * 100), odoKm: null, cons: { value: D.l100, unit: 'l/100 km' }, source: 'demo', at: Date.now() };
        }
        return null;
    }
}

/** Range left at the destination (km): the cluster's range less the road still to drive. */
function arrivalKm(rangeKm, leftM) {
    if (typeof rangeKm !== 'number' || !isFinite(rangeKm)) return null;
    return rangeKm - leftM / 1000;
}

/**
 * Fuel stations near the route ahead of fromS: [{ st, s (route distance at the closest point), off (m from
 * the route) }] by s. stations: [{ x, y, ... }] (Web Mercator, as search.near returns). The route is
 * sampled every ~150 m into a 2 km grid, so a long route and every station in the country is a few ms.
 */
function stationsAlong(route, fromS, stations, opts) {
    const o = opts || {};
    const maxOff = o.maxOff || 1500;
    const gs = route.router && route.router.gs ? route.router.gs : 1;     // metres per map unit on this route
    const cell = 2000 / gs, R = maxOff / gs;
    const grid = new Map();
    const key = (cx, cy) => cx * 100003 + cy;
    const p = route.pts, c = route.cum;
    let lastS = -Infinity;
    for (let i = 0; i < c.length; i++) {
        if (c[i] < fromS - 200 || (c[i] - lastS < 150 && i !== c.length - 1)) continue;
        lastS = c[i];
        const x = p[i * 2], y = p[i * 2 + 1], k = key(Math.floor(x / cell), Math.floor(y / cell));
        let b = grid.get(k);
        if (!b) grid.set(k, b = []);
        b.push(x, y, c[i]);
    }
    const out = [];
    for (const st of stations) {
        const cx = Math.floor(st.x / cell), cy = Math.floor(st.y / cell);
        let best = Infinity, bs = 0;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const b = grid.get(key(cx + dx, cy + dy));
            if (!b) continue;
            for (let j = 0; j < b.length; j += 3) {
                const d = Math.hypot(b[j] - st.x, b[j + 1] - st.y);
                if (d < best) { best = d; bs = b[j + 2]; }
            }
        }
        if (best <= R && bs >= fromS) out.push({ st, s: bs, off: best * gs });
    }
    out.sort((a, b) => a.s - b.s);
    return out;
}

/**
 * The station to stop at: the furthest one the car reaches with STOP_RESERVE_KM still in the tank (fewer
 * stops), else the first one ahead (range too short for any with the reserve: the nearest is best).
 */
function pickStop(along, rangeKm, fromS) {
    // only stations still ahead (the list may have been made further back on the route)
    const ahead = (along || []).filter((a) => a.s >= fromS);
    if (!ahead.length) return null;
    const reach = fromS + (rangeKm - STOP_RESERVE_KM) * 1000;
    let pick = null;
    for (const a of ahead) if (a.s <= reach) pick = a;
    return pick || ahead[0];
}

/** Low-fuel pick with no route: the nearest station roughly ahead (or very close), else the nearest. */
function nearestAhead(stations, fix, gs) {
    if (!stations || !stations.length) return null;
    if (!fix) return stations[0];
    for (const st of stations) {
        const dx = st.x - fix.x, dy = st.y - fix.y, d = Math.hypot(dx, dy) * (gs || 1);
        if (d < 1500) return st;
        // Web Mercator y grows north: bearing 0 = north, clockwise (as router.js)
        const b = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
        const off = Math.abs(((b - (fix.heading || 0)) % 360 + 540) % 360 - 180);
        if (off < 75 || !(fix.speed > 5)) return st;
    }
    return stations[0];
}

module.exports = { Fuel, arrivalKm, stationsAlong, pickStop, nearestAhead, RESERVE_KM, LOW_KM, STOP_RESERVE_KM, CONS_UNITS };
