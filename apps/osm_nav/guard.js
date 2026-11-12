'use strict';
/**
 * guard.js - two things Navigation must not do, decided from the car's own signals (read only). Node 8.
 *
 *   keyboardLocked(fix, carKmh)   no keyboard while the car moves. The car's speed signal counts by itself: up to
 *                                 1.0.2 only the position fix was asked, and with no position (the state on a car
 *                                 until one is set) the keyboard stayed open at any speed.
 *   DriveGuard                    the car reverses: Navigation does not come to the front, and gives its picture
 *                                 and the controller back to the HMI while it does (main.js, display.standDown).
 *                                 The renderer already yields to the camera's surfaces (mgu-render.conf
 *                                 yield_surfaces), but that is one list of ids a car may not match; the selector's
 *                                 position is the car's own word and needs no surface.
 *
 * The gear comes from VehicleInformation, two fields that may each be missing on a car (kit/car.js reads the same):
 *   statusGearboxDrive   { statusActualGearDrive: G1..G10 | R | N_OR_P (wire: R = 1, N_OR_P = 2, G1 = 3 ...),
 *                          statusActualStageDrive: P | R | N | D (wire: 1..4) }
 *   DataPowerTrain2      { statusGearSelectionDrive: N | R | P | NP | _1.._9 (wire: N = 1, R = 2, P = 3, NP = 4, 5..13) }
 * A value that is none of these (initialising, invalid) says nothing. No gear ever told: not reversing (a car without
 * the signal behaves as before this guard).
 */

const KBD_KMH = 8;              // the keyboard locks above this
const STALE_MS = 3000;          // a field still saying R this long before the other said otherwise: dropped

function keyboardLocked(fix, carKmh) {
    if (typeof carKmh === 'number' && isFinite(carKmh) && carKmh > KBD_KMH) return true;
    return !!(fix && fix.source !== 'demo' && fix.speed > KBD_KMH);
}

const GEAR_NAME = /^(G([1-9]|10)|N_OR_P)$/;
function gearReverse(g) {
    if (g === 'R' || g === 1) return true;
    if (typeof g === 'number') return g >= 2 && g <= 12 ? false : undefined;
    return typeof g === 'string' && GEAR_NAME.test(g) ? false : undefined;
}
function stageReverse(s) {
    if (s === 'R' || s === 2) return true;
    return s === 'P' || s === 'N' || s === 'D' || s === 1 || s === 3 || s === 4 ? false : undefined;
}
/** statusGearboxDrive's value: true (reverse), false (another gear), undefined (says nothing). */
function gearboxReverse(v) {
    const a = gearReverse(v && v.statusActualGearDrive), b = stageReverse(v && v.statusActualStageDrive);
    if (a === undefined && b === undefined) return undefined;
    return a === true || b === true;
}
/** DataPowerTrain2's value: true, false or undefined, as gearboxReverse. */
function selectionReverse(v) {
    const x = v && v.statusGearSelectionDrive;
    if (x === 'R' || x === 2) return true;
    if (typeof x === 'number') return x === 1 || (x >= 3 && x <= 13) ? false : undefined;
    return typeof x === 'string' && /^(N|P|NP|_[1-9])$/.test(x) ? false : undefined;
}

class DriveGuard {
    constructor() { this.src = {}; }

    /** A field's word (true / false; undefined is ignored). Returns true when reversing() changed. */
    _set(name, rev, now) {
        if (rev === undefined) return false;
        const was = this.reversing();
        this.src[name] = { rev, at: now };
        // one field stuck on R while the other moved on (a car that stops sending one of them): the newer word counts
        if (!rev) Object.keys(this.src).forEach((k) => { const o = this.src[k]; if (k !== name && o.rev && now - o.at > STALE_MS) o.rev = false; });
        return this.reversing() !== was;
    }
    gearbox(v, now) { return this._set('gearbox', gearboxReverse(v), now); }
    selection(v, now) { return this._set('selection', selectionReverse(v), now); }

    /** The car is in reverse, by any field that says so. */
    reversing() { return Object.keys(this.src).some((k) => this.src[k].rev); }
    /** A gear was told at all (the guard works on this car). */
    known() { return Object.keys(this.src).length > 0; }
}

module.exports = { DriveGuard, keyboardLocked, gearboxReverse, selectionReverse, KBD_KMH, STALE_MS };
