'use strict';
/**
 * search.js - zero-RAM on-demand offline search in the map pack (Georgian and Latin), quick categories,
 * and saved places (Home, Work, Favourites, Recent). Node 8.
 *
 * Uses pack.searchPrefix / searchEntry / searchKey directly on the on-disk STOK/SRCH/SKEY tables so
 * zero permanent heap memory is consumed for the 39,500+ search entries.
 */
const fs = require('fs');
const path = require('path');

const KA_LATIN = {
    'ა': 'a', 'ბ': 'b', 'გ': 'g', 'დ': 'd', 'ე': 'e', 'ვ': 'v', 'ზ': 'z', 'თ': 't', 'ი': 'i', 'კ': 'k', 'ლ': 'l',
    'მ': 'm', 'ნ': 'n', 'ო': 'o', 'პ': 'p', 'ჟ': 'zh', 'რ': 'r', 'ს': 's', 'ტ': 't', 'უ': 'u', 'ფ': 'p', 'ქ': 'k',
    'ღ': 'gh', 'ყ': 'q', 'შ': 'sh', 'ჩ': 'ch', 'ც': 'ts', 'ძ': 'dz', 'წ': 'ts', 'ჭ': 'ch', 'ხ': 'kh', 'ჯ': 'j', 'ჰ': 'h',
};

/** As pack_osm.py normalize(): lower case, no accents, Mtavruli as Mkhedruli, punctuation as spaces. */
function normalize(s) {
    let t = '';
    for (const ch of String(s || '')) {
        const c = ch.codePointAt(0);
        t += c >= 0x1c90 && c <= 0x1cbf ? String.fromCodePoint(c - 0xbc0) : ch;
    }
    t = t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    return t.replace(/[^0-9a-zა-ჿЀ-ӿԱ-֏]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function translit(s) {
    let out = '';
    for (const ch of s) out += KA_LATIN[ch] !== undefined ? KA_LATIN[ch] : ch;
    return out;
}

const KIND = {
    CITY: 1, TOWN: 2, VILLAGE: 3, SUBURB: 4, HAMLET: 5, FUEL: 10, CHARGING: 11, HOSPITAL: 12, PARKING: 13, LANDMARK: 14,
    RESTAURANT: 15, HOTEL: 16, PHARMACY: 17, POLICE: 18, METRO: 19, AIRPORT: 20, MALL: 21, WORSHIP: 22, MUSEUM: 23, BANK: 24, CAFE: 25, STREET: 30,
};
const KIND_NAME = {
    1: ['City', 'ქალაქი'], 2: ['Town', 'ქალაქი'], 3: ['Village', 'სოფელი'], 4: ['District', 'უბანი'], 5: ['Place', 'ადგილი'],
    10: ['Fuel', 'საწვავი'], 11: ['EV charging', 'დამტენი'], 12: ['Hospital', 'საავადმყოფო'], 13: ['Parking', 'პარკინგი'],
    14: ['Sight', 'ღირსშესანიშნაობა'], 15: ['Restaurant', 'რესტორანი'], 16: ['Hotel', 'სასტუმრო'], 17: ['Pharmacy', 'აფთიაქი'],
    18: ['Police', 'პოლიცია'], 19: ['Station', 'სადგური'], 20: ['Airport', 'აეროპორტი'], 21: ['Shopping', 'სავაჭრო ცენტრი'],
    22: ['Church', 'ეკლესია'], 23: ['Museum', 'მუზეუმი'], 24: ['Bank', 'ბანკი'], 25: ['Cafe', 'კაფე'], 30: ['Street', 'ქუჩა'],
};
/** Quick categories on the search page. */
const CATEGORIES = [
    { id: 'fuel', kinds: [10], en: 'Fuel', ka: 'საწვავი' },
    { id: 'charging', kinds: [11], en: 'EV charging', ka: 'დამტენი' },
    { id: 'parking', kinds: [13], en: 'Parking', ka: 'პარკინგი' },
    { id: 'hospital', kinds: [12, 17], en: 'Hospital', ka: 'საავადმყოფო' },
    { id: 'sights', kinds: [14, 22, 23], en: 'Sights', ka: 'სანახაობები' },
    { id: 'airport', kinds: [20, 19], en: 'Airports & stations', ka: 'აეროპორტი' },
];

class Search {
    constructor(pack, dataDir) {
        this.pack = pack;
        this.file = path.join(dataDir || '.', 'osm_nav_places.json');
        this.places = { home: null, work: null, favs: [], recent: [] };
        try {
            const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (j && typeof j === 'object') Object.assign(this.places, j);
        } catch (e) { /* none yet */ }
    }

    result(e, at) {
        const P = this.pack;
        const r = { name: e.name, ctx: e.ctx, kind: e.kind, x: e.x, y: e.y, rank: e.rank };
        const ax = at && typeof at === 'object' ? at.x : typeof at === 'number' ? at : null;
        const ay = at && typeof at === 'object' ? at.y : null;
        r.dist = (ax != null && ay != null) ? Math.hypot(e.x - ax, e.y - ay) * require('./mappack').groundScale(ay) : null;
        r.title = (lang) => P.label(e.name, lang) || kindName(e.kind, lang);
        r.sub = (lang) => {
            const k = kindName(e.kind, lang), c = e.ctx ? P.label(e.ctx, lang) : '';
            return c ? k + ', ' + c : k;
        };
        return r;
    }

    /** Entries matching every word of the query (prefix of a word of the name), best first; at most n. */
    find(query, at, n) {
        if (typeof at === 'number' && typeof n === 'number') {
            at = { x: at, y: n };
            n = arguments[3] && typeof arguments[3] === 'object' ? arguments[3].limit : arguments[3];
        }
        n = n || 30;
        const raw = String(query || '').trim();
        const cm = raw.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
        const coordOut = [];
        if (cm) {
            const lat = parseFloat(cm[1]), lon = parseFloat(cm[2]);
            if (lat >= -85 && lat <= 85 && lon >= -180 && lon <= 180) {
                const M = require('./mappack');
                const xy = M.merc(lat, lon);
                const label = lat.toFixed(5) + ', ' + lon.toFixed(5);
                coordOut.push({
                    name: 0, ctx: 0, kind: KIND.LANDMARK, x: xy[0], y: xy[1], rank: 255,
                    dist: at && at.x != null ? Math.hypot(xy[0] - at.x, xy[1] - at.y) * M.groundScale(at.y) : null,
                    title: () => label,
                    sub: (lang) => lang === 'ka' ? 'კოორდინატები' : 'Coordinates',
                    score: 1000,
                });
            }
        }
        const q = normalize(query);
        if (!q) return coordOut;
        const P = this.pack;
        // the keys hold each name in Georgian, Latin and transliterated: a word is looked up as typed (a Georgian
        // word made Latin would find unrelated English names: "vak" for Vakhtang when looking for ვაკე)
        const words = q.split(' ').map((w) => [w, null]);
        let set = null;
        for (const [w, alt] of words) {
            const ids = new Set(P.searchPrefix(w));
            if (alt) P.searchPrefix(alt).forEach((i) => ids.add(i));
            if (set === null) set = ids;
            else { const keep = new Set(); set.forEach((i) => { if (ids.has(i)) keep.add(i); }); set = keep; }
            if (!set.size) break;
        }
        let ids = set ? Array.from(set) : [];
        // nothing starts so: anywhere in the names (the key table read in one go)
        if (!ids.length && q.length >= 3 && P.searchScan) ids = P.searchScan(q, 300);
        if (ids.length > 600) ids = ids.slice(0, 600);
        const res = ids.map((i) => {
            const e = P.searchEntry(i), key = P.searchKey(i);
            const r = this.result(e, at);
            let score = { 1: 60, 2: 45, 20: 40, 4: 35, 3: 25, 14: 22, 19: 18, 21: 18, 30: 15 }[e.kind] || 10;
            score += e.rank / 12;
            if (key.indexOf(q) === 0) score += 25;
            if ((' ' + key + ' ').indexOf(' ' + q + ' ') >= 0) score += 15;
            if (r.dist !== null) score -= Math.min(40, Math.log10(1 + r.dist / 200) * 14);
            r.score = score;
            return r;
        });
        res.sort((a, b) => b.score - a.score);
        const seen = new Set(), out = coordOut.slice();
        for (const r of res) {
            const k = r.name + ':' + r.kind + ':' + r.ctx;
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(r);
            if (out.length >= n) break;
        }
        return out;
    }

    /** The nearest entries of these kinds to at (POIs: fuel, charging ...), nearest first. */
    near(kinds, at, n) {
        const P = this.pack, total = P.searchCount(), out = [];
        const kset = new Set(kinds);
        const m = P._initSearchMeta();
        const step = 512;
        for (let i0 = 0; i0 < total; i0 += step) {
            const cnt = Math.min(step, total - i0);
            const b = P._readBuf(m.srchOff + i0 * 20, cnt * 20);
            for (let k = 0; k < cnt; k++) {
                const o = k * 20, kind = b[o + 8];
                if (!kset.has(kind)) continue;
                const e = {
                    i: i0 + k,
                    name: b.readUInt32LE(o),
                    ctx: b.readUInt32LE(o + 4),
                    kind,
                    rank: b[o + 9],
                    x: b.readInt32LE(o + 12) / 10,
                    y: b.readInt32LE(o + 16) / 10,
                };
                out.push(this.result(e, at));
            }
        }
        out.sort((a, b) => (a.dist || 0) - (b.dist || 0));
        return out.slice(0, n || 20);
    }

    /* ---------- saved places ---------- */
    save() {
        try {
            const tmp = this.file + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.places, null, 1));
            fs.renameSync(tmp, this.file);
        } catch (e) { /* read-only (preview) */ }
    }
    static place(title, sub, x, y) { return { title: String(title || '').slice(0, 120), sub: String(sub || '').slice(0, 120), x, y, at: Date.now() }; }
    setHome(p) { this.places.home = p; this.save(); }
    setWork(p) { this.places.work = p; this.save(); }
    addFav(p) {
        this.places.favs = [p].concat((this.places.favs || []).filter((q) => Math.hypot(q.x - p.x, q.y - p.y) > 30)).slice(0, 30);
        this.save();
    }
    removeFav(p) { this.places.favs = (this.places.favs || []).filter((q) => q !== p); this.save(); }
    addRecent(p) {
        this.places.recent = [p].concat((this.places.recent || []).filter((q) => Math.hypot(q.x - p.x, q.y - p.y) > 30)).slice(0, 20);
        this.save();
    }
}

function kindName(kind, lang) {
    const k = KIND_NAME[kind] || ['Place', 'ადგილი'];
    return lang === 'ka' ? k[1] : k[0];
}

module.exports = { Search, normalize, translit, CATEGORIES, KIND, kindName };
