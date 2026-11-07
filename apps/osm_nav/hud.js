'use strict';
/**
 * hud.js - what is drawn over the map: the maneuver card (arrow, distance, street), the speed limit
 * sign (BMW Speed Limit Info style: white disc, red ring), the trip bar (arrival time, distance and
 * time left, speed) and the round map buttons. Node 8; draws on a record.js Recorder.
 */
const { withAlpha } = require('./kit/canvas');

const TXT = {
    en: {
        depart: 'Head', straight: 'Continue', 'slight-right': 'Bear right', right: 'Turn right', 'sharp-right': 'Sharp right',
        'slight-left': 'Bear left', left: 'Turn left', 'sharp-left': 'Sharp left', uturn: 'Make a U-turn', arrive: 'Arrive at destination',
        keepRight: 'Keep right', keepLeft: 'Keep left', ramp: 'Take the ramp', merge: 'Merge', roundabout: 'At the roundabout, exit', then: 'Then',
        onto: 'onto', eta: 'Arrival', left_: 'to go', arrived: 'You have arrived', recalc: 'Recalculating...', noRoute: 'No route',
    },
    ka: {
        depart: 'დაიძარით', straight: 'პირდაპირ', 'slight-right': 'ოდნავ მარჯვნივ', right: 'მოუხვიეთ მარჯვნივ', 'sharp-right': 'მკვეთრად მარჯვნივ',
        'slight-left': 'ოდნავ მარცხნივ', left: 'მოუხვიეთ მარცხნივ', 'sharp-left': 'მკვეთრად მარცხნივ', uturn: 'შემობრუნდით', arrive: 'დანიშნულების ადგილი',
        keepRight: 'დაიჭირეთ მარჯვენა მხარე', keepLeft: 'დაიჭირეთ მარცხენა მხარე', ramp: 'გადადით შესასვლელზე', merge: 'შეუერთდით', roundabout: 'წრეზე, გასასვლელი', then: 'შემდეგ',
        onto: '', eta: 'მისვლა', left_: 'დარჩა', arrived: 'მიხვედით', recalc: 'მარშრუტის გადათვლა...', noRoute: 'მარშრუტი ვერ მოიძებნა',
    },
};
const tr = (lang) => TXT[lang === 'ka' ? 'ka' : 'en'];

/** "Turn right" / "მოუხვიეთ მარჯვნივ" for a maneuver */
function phrase(m, lang) {
    const T = tr(lang);
    if (m.type === 'arrive') return T.arrive;
    if (m.type === 'roundabout') return T.roundabout + ' ' + m.exit;
    if (m.type === 'fork') return m.mod === 'slight-left' ? T.keepLeft : m.mod === 'slight-right' ? T.keepRight : T.straight;
    if (m.type === 'ramp') return T.ramp;
    if (m.type === 'merge') return T.merge;
    if (m.type === 'uturn') return T.uturn;
    if (m.type === 'depart') return T.depart;
    return T[m.mod] || T.straight;
}

/** distance as shown: 80 m, 350 m, 1.2 km, 12 km (or ft / mi) -> [number, unit] */
function fmtDist(m, imperial) {
    if (imperial) {
        const ft = m * 3.28084;
        if (ft < 1000) return [String(Math.max(0, Math.round(ft / 50) * 50)), 'ft'];
        const mi = m / 1609.34;
        return [mi < 10 ? mi.toFixed(1) : String(Math.round(mi)), 'mi'];
    }
    if (m < 1000) return [String(m < 100 ? Math.max(0, Math.round(m / 10) * 10) : Math.round(m / 50) * 50), 'm'];
    return [m < 10000 ? (m / 1000).toFixed(1) : String(Math.round(m / 1000)), 'km'];
}
function fmtDur(s) {
    const mins = Math.round(s / 60);
    if (mins < 60) return [String(Math.max(1, mins)), 'min'];
    return [Math.floor(mins / 60) + ':' + ('0' + (mins % 60)).slice(-2), 'h'];
}
function clock(d) { return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

/**
 * The maneuver arrow in a size x size box centred on cx, cy. For a turn: the way in from below and
 * the way out at the turn's angle; a roundabout: the ring with the exit to take; arrive: a flag.
 */
function arrow(r, cx, cy, size, m, col, dim) {
    const w = size * 0.13, s = size / 2;
    const P = (u, v) => [cx + u * s, cy + v * s];
    const head = (x, y, ang, len) => {
        const a = ang * Math.PI / 180, ux = Math.sin(a), uy = -Math.cos(a), nx = -uy, ny = ux;
        r.tris([x + ux * len, y + uy * len, x + nx * len * 0.75, y + ny * len * 0.75, x - nx * len * 0.75, y - ny * len * 0.75], col);
    };
    const poly = (pts, c, wd) => { for (let i = 1; i < pts.length; i++) r.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], wd || w, c || col); };
    if (m.type === 'arrive') {
        const x0 = cx - s * 0.35, y0 = cy - s * 0.75;
        r.line(x0, y0, x0, cy + s * 0.85, w * 0.7, col);
        const fw = s * 0.95, fh = s * 0.62, n = 4, q = fw / n;
        r.fillRect(x0, y0, fw, fh, col);
        for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) if ((i + j) % 2) r.fillRect(x0 + i * q, y0 + j * fh / 3, q, fh / 3, dim || '#11151a');
        return;
    }
    if (m.type === 'roundabout') {
        const rc = s * 0.42, ccx = cx, ccy = cy - s * 0.05;
        r.arc(ccx, ccy, rc - w / 2, rc + w / 2, 0, 360, dim || withAlpha(col, 0.35));
        // in from the bottom, round counter-clockwise (right-hand traffic) to the exit's bearing
        // the exit's place on the ring is the way out (its bearing, the way in being up); counter-clockwise
        // from the entry at the bottom (180) means decreasing bearings, down to the exit's
        let end = m.angle || 0;
        if (end >= 180) end -= 360;
        const steps = 18, pts = [P(0, 0.95), [ccx, ccy + rc]];
        for (let i = 0; i <= steps; i++) {
            const a = (180 - (180 - end) * i / steps) * Math.PI / 180;
            pts.push([ccx + Math.sin(a) * rc, ccy - Math.cos(a) * rc]);
        }
        const ea = end * Math.PI / 180, ex = ccx + Math.sin(ea) * rc, ey = ccy - Math.cos(ea) * rc;
        const ox = ex + Math.sin(ea) * s * 0.42, oy = ey - Math.cos(ea) * s * 0.42;
        pts.push([ox, oy]);
        poly(pts);
        head(ox, oy, end, w * 2.1);
        return;
    }
    let ang = m.type === 'uturn' || m.mod === 'uturn' ? 180 : m.angle || 0;
    if (m.type === 'fork') ang = m.mod === 'slight-left' ? -35 : m.mod === 'slight-right' ? 35 : 0;
    if (m.type === 'ramp') ang = m.mod === 'slight-left' ? -40 : 40;
    if (m.type === 'depart' || m.type === 'continue' || m.type === 'merge' || (m.mod === 'straight' && m.type !== 'fork')) ang = 0;
    ang = Math.max(-180, Math.min(180, ang));
    if (Math.abs(ang) >= 170) {
        // U-turn: up, round, back down (to the left: right-hand traffic)
        const R = s * 0.3, x1 = cx + s * 0.25, x0 = x1 - 2 * R, top = cy - s * 0.35;
        const pts = [[x1, cy + s * 0.9], [x1, top]];
        for (let i = 1; i <= 12; i++) { const a = Math.PI * i / 12; pts.push([x1 - R + Math.cos(a) * R, top - Math.sin(a) * R]); }
        pts.push([x0, cy + s * 0.2]);
        poly(pts);
        head(x0, cy + s * 0.2 + w, 180, w * 2.1);
        return;
    }
    // the road not taken at a fork, faint
    if (m.type === 'fork') {
        const oa = -ang * Math.PI / 180, b = P(0, 0.05);
        poly([P(0, 0.95), b, [b[0] + Math.sin(oa) * s * 0.75, b[1] - Math.cos(oa) * s * 0.75]], dim || withAlpha(col, 0.3));
    }
    const a = ang * Math.PI / 180, j = P(0, Math.abs(ang) > 100 ? 0.1 : 0.0);
    const bend = [j[0] + Math.sin(a) * s * 0.18, j[1] - Math.cos(a) * s * 0.18];
    const end = [j[0] + Math.sin(a) * s * (Math.abs(ang) > 100 ? 0.62 : 0.78), j[1] - Math.cos(a) * s * (Math.abs(ang) > 100 ? 0.62 : 0.78)];
    const mid = [j[0], j[1] + s * 0.12];
    poly([P(0, 0.95), mid, [(mid[0] + bend[0]) / 2, (mid[1] + bend[1]) / 2 - s * 0.02], bend, end]);
    head(end[0], end[1], ang, w * 2.2);
}

/** The speed limit sign at cx, cy (radius rr): white disc, red ring, the limit in black. Overspeed: the ring pulses. */
function sli(r, cx, cy, rr, limit, over, imperial) {
    const pulse = over ? 0.55 + 0.45 * Math.abs(Math.sin(Date.now() / 260)) : 1;
    r.circle(cx, cy + 2, rr + 3, '#00000066');
    r.circle(cx, cy, rr + 1.5, '#ffffff');
    r.arc(cx, cy, rr * 0.8, rr, 0, 360, withAlpha('#d0021b', pulse));
    const v = imperial ? Math.round(limit / 1.609 / 5) * 5 : limit;
    const t = String(v), sz = rr * (t.length >= 3 ? 0.8 : 0.98);
    r.text(t, cx, cy + sz * 0.36, sz, '#111111', { literal: true, font: 'bold', align: 'center' });
}

/** A round map button (zoom, compass ...) */
function roundButton(r, x, y, rr, t, glyph, dim) {
    r.circle(x, y + 2, rr + 2, '#00000055');
    r.circle(x, y, rr, withAlpha('#14181e', 0.92));
    r.arc(x, y, rr - 1.5, rr, 0, 360, withAlpha('#ffffff', 0.22));
    const c = dim ? withAlpha('#ffffff', 0.4) : '#ffffff', u = rr / 22;
    if (glyph === '+') { r.line(x - 9 * u, y, x + 9 * u, y, 3.2 * u, c); r.line(x, y - 9 * u, x, y + 9 * u, 3.2 * u, c); } else if (glyph === '-') r.line(x - 9 * u, y, x + 9 * u, y, 3.2 * u, c);
    else if (glyph === 'locate') { r.arc(x, y, 7 * u, 9.5 * u, 0, 360, c); r.circle(x, y, 3.4 * u, t.accent2 || c); r.line(x, y - 14 * u, x, y - 10 * u, 2.4 * u, c); r.line(x, y + 10 * u, x, y + 14 * u, 2.4 * u, c); r.line(x - 14 * u, y, x - 10 * u, y, 2.4 * u, c); r.line(x + 10 * u, y, x + 14 * u, y, 2.4 * u, c); }
}

/** The compass: a needle showing north (red half), with N/H for north-up / heading-up. */
function compass(r, x, y, rr, headingDeg, headUp) {
    r.circle(x, y + 2, rr + 2, '#00000055');
    r.circle(x, y, rr, withAlpha('#14181e', 0.92));
    r.arc(x, y, rr - 1.5, rr, 0, 360, withAlpha('#ffffff', 0.22));
    const a = -headingDeg * Math.PI / 180, l = rr * 0.62, ww = rr * 0.2;
    const ux = Math.sin(a), uy = -Math.cos(a), nx = -uy, ny = ux;
    r.tris([x + ux * l, y + uy * l, x + nx * ww, y + ny * ww, x - nx * ww, y - ny * ww], '#e1001a');
    r.tris([x - ux * l, y - uy * l, x + nx * ww, y + ny * ww, x - nx * ww, y - ny * ww], '#d8dde3');
    r.circle(x + rr * 0.78, y - rr * 0.62, rr * 0.36, '#2f8cff');
    r.text(headUp ? 'H' : 'N', x + rr * 0.78, y - rr * 0.62 + rr * 0.15, rr * 0.4, '#ffffff', { literal: true, font: 'bold', align: 'center' });
}

module.exports = { arrow, sli, roundButton, compass, phrase, fmtDist, fmtDur, clock, tr, TXT };
