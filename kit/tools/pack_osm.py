#!/usr/bin/env python3
"""pack_osm.py - compile OpenStreetMap data into an osm_nav map pack (apps/osm_nav/<region>.pack).

    python3 kit/tools/pack_osm.py --builtin-georgia -o apps/osm_nav/georgia.pack
    python3 kit/tools/pack_osm.py georgia-latest.osm.pbf -o georgia.pack --region Georgia
    python3 kit/tools/pack_osm.py tbilisi.osm.json -o tbilisi.pack          (Overpass JSON)
    python3 kit/tools/pack_osm.py map.osm[.bz2|.gz] -o map.pack                (OSM XML)
    python3 kit/tools/pack_osm.py --overpass 41.66,44.70,41.80,44.90 -o tbilisi.pack
    python3 kit/tools/pack_osm.py --fetch georgia -o georgia.pack              (Geofabrik extract)

--builtin-georgia makes the pack without any download: Georgia's highway network (S1-S12 with their
E-numbers), its cities, rivers, lakes, the Black Sea coast and border, and Tbilisi's main avenues,
squares (Freedom Square and Heroes' Square as roundabouts), bridges, embankments, parks, POIs and
metro stations at their approximate real places, filled in with generated residential streets
(Georgian + English names). It is a demo / starter map: compile a Geofabrik extract for the real one.

The pack is read by apps/osm_nav/mappack.js with Buffer slices and typed-array views (no parsing of
the whole file). Layout (little endian, every section 8-byte aligned):

  0   'OSMP'   u16 version (1)   u16 sections   u32 meta length   u32 0
  16  sections x { char[4] id, u32 offset, u32 length }
  ..  META: JSON (region, bbox, projection, level and grid parameters, counts, attribution)
  STRS  UTF-8 string blob
  NAME  u32 n, n x { u32 localOff, u32 latinOff, u16 localLen, u16 latinLen }   (0 = no name)
        local = name:ka (or name), latin = name:en / int_name / transliterated Georgian
  TIL0 TIL1 TIL2  map tiles of the three zoom levels (macro 64 km, mid 8 km, street 2 km tiles)
        u32 n, n x { u32 key (row * cols + col), u32 offset, u32 length }, then the tile blobs:
        u32 roads, areas, lines, points
        road:  u8 class, u8 flags, u8 maxspeed, u8 layer, u32 name, u32 ref, u16 n, u16 0, n x (i16 x, i16 y)
        area:  u8 kind, u8 0, u16 0, u32 triangles, triangles x 3 x (i16 x, i16 y)   (ear-clipped here)
        line:  u8 kind, u8 0, u16 n, u32 name, n x (i16 x, i16 y)
        point: u8 kind, u8 rank, i16 x, i16 y, u16 0, u32 name
        x, y: tile-local, 4096 units per tile edge (0..4095 inside the tile; a piece of a road may
        reach into the neighbouring tile, so they are signed), y grows north
  GNOD  routing graph nodes: u32 n, i32 x[n], i32 y[n] (Web Mercator, decimetres), u32 first[n + 1]
  GEDG  directed edges (CSR by source): u32 m, then u32 arrays target, length (decimetres on the
        ground), name, ref, geom (first shape point; bit 31: walk it backwards),
        info (shape points u16 | class << 16 | flags << 24), speed (km/h | maxspeed << 8)
  GGEO  edge shape points between the two nodes: u32 n, i32 xy[2n]
  GGRD  edges by 300 m cell for snapping: u32 cells, u32 key[cells], u32 first[cells + 1], u32 edge[]
  SRCH  search entries: u32 n, n x { u32 name, u32 context, u8 kind, u8 rank, u16 0, i32 x, i32 y }
  SKEY  normalised search text per entry: u32 n, u32 off[n + 1], UTF-8
  STOK  token index (sorted): u32 n, n x { u32 off, u16 len, u16 0, u32 first, u32 count }, u32 posting[]

Road classes: 0 motorway, 1 trunk, 2 primary, 3 secondary, 4 tertiary, 5 unclassified, 6 residential,
7 living_street, 8 service, 9 pedestrian/track (drawn, not routed). Flags: 1 oneway, 2 roundabout,
4 bridge, 8 tunnel, 16 toll, 32 link (ramp), 64 no cars, 128 isolated (not in the main network).
"""
import argparse
import bz2
import gzip
import io
import json
import math
import os
import re
import struct
import sys
import time
import unicodedata
import urllib.request
import zlib
from array import array

R_EARTH = 6378137.0
VERSION = 1
UNITS = 4096
LEVELS = [  # tile edge in Web Mercator metres, line simplification tolerance (m)
    {'size': 65536.0, 'tol': 24.0},
    {'size': 8192.0, 'tol': 3.0},
    {'size': 2048.0, 'tol': 0.4},
]
GRID_CELL = 300.0

# ---------------------------------------------------------------- classes and kinds
ROAD = {
    'motorway': 0, 'trunk': 1, 'primary': 2, 'secondary': 3, 'tertiary': 4, 'unclassified': 5,
    'residential': 6, 'living_street': 7, 'service': 8, 'road': 5,
    'motorway_link': 0, 'trunk_link': 1, 'primary_link': 2, 'secondary_link': 3, 'tertiary_link': 4,
    'pedestrian': 9, 'track': 9,
}
F_ONEWAY, F_ROUNDABOUT, F_BRIDGE, F_TUNNEL, F_TOLL, F_LINK, F_NOCAR, F_ISOLATED = 1, 2, 4, 8, 16, 32, 64, 128
# default speeds (km/h) by class when no maxspeed is tagged, and the travel speed assumed on it
DEFAULT_MAX = [110, 90, 80, 60, 60, 50, 40, 20, 20, 10]
TRAVEL = [100, 80, 62, 50, 42, 35, 28, 12, 14, 5]

A_WATER, A_PARK, A_FOREST, A_RESIDENTIAL, A_INDUSTRIAL, A_BUILDING, A_GRASS, A_LAND, A_COMMERCIAL, A_CEMETERY, A_PEDESTRIAN = range(1, 12)
L_RIVER, L_STREAM, L_RAIL, L_BORDER, L_REGION, L_COAST, L_FERRY = range(1, 8)
P_CITY, P_TOWN, P_VILLAGE, P_SUBURB, P_HAMLET = 1, 2, 3, 4, 5
P_FUEL, P_CHARGING, P_HOSPITAL, P_PARKING, P_LANDMARK, P_RESTAURANT, P_HOTEL, P_PHARMACY, P_POLICE, P_METRO, P_AIRPORT, P_MALL, P_WORSHIP, P_MUSEUM, P_BANK, P_CAFE = range(10, 26)
K_STREET = 30

POI_TAGS = [
    ('amenity', 'fuel', P_FUEL), ('amenity', 'charging_station', P_CHARGING), ('amenity', 'hospital', P_HOSPITAL),
    ('amenity', 'clinic', P_HOSPITAL), ('amenity', 'parking', P_PARKING), ('amenity', 'restaurant', P_RESTAURANT),
    ('amenity', 'pharmacy', P_PHARMACY), ('amenity', 'police', P_POLICE), ('amenity', 'place_of_worship', P_WORSHIP),
    ('amenity', 'bank', P_BANK), ('amenity', 'cafe', P_CAFE), ('tourism', 'hotel', P_HOTEL), ('tourism', 'museum', P_MUSEUM),
    ('tourism', 'attraction', P_LANDMARK), ('tourism', 'viewpoint', P_LANDMARK), ('historic', None, P_LANDMARK),
    ('station', 'subway', P_METRO), ('railway', 'station', P_METRO), ('aeroway', 'aerodrome', P_AIRPORT),
    ('shop', 'mall', P_MALL),
]
POI_LEVEL = {P_AIRPORT: 1, P_LANDMARK: 2}
PLACES = {'city': P_CITY, 'town': P_TOWN, 'village': P_VILLAGE, 'suburb': P_SUBURB, 'neighbourhood': P_SUBURB,
          'quarter': P_SUBURB, 'hamlet': P_HAMLET, 'locality': P_HAMLET}

# ---------------------------------------------------------------- Georgian text
KA_LATIN = {
    'ა': 'a', 'ბ': 'b', 'გ': 'g', 'დ': 'd', 'ე': 'e', 'ვ': 'v', 'ზ': 'z', 'თ': 't', 'ი': 'i', 'კ': 'k', 'ლ': 'l',
    'მ': 'm', 'ნ': 'n', 'ო': 'o', 'პ': 'p', 'ჟ': 'zh', 'რ': 'r', 'ს': 's', 'ტ': 't', 'უ': 'u', 'ფ': 'p', 'ქ': 'k',
    'ღ': 'gh', 'ყ': 'q', 'შ': 'sh', 'ჩ': 'ch', 'ც': 'ts', 'ძ': 'dz', 'წ': 'ts', 'ჭ': 'ch', 'ხ': 'kh', 'ჯ': 'j', 'ჰ': 'h',
}
GEORGIAN = re.compile('[Ⴀ-ჿᲐ-Ჿⴀ-⴯]')


def mkhedruli(s):
    """Mtavruli capitals -> Mkhedruli (the same letters, the form names are written in)."""
    return ''.join(chr(ord(c) - 0xBC0) if 0x1C90 <= ord(c) <= 0x1CBF else c for c in s)


def translit(s):
    """Georgian national romanisation (without the apostrophes of the ejectives)."""
    out, cap = [], True
    for c in mkhedruli(s):
        t = KA_LATIN.get(c)
        if t is None:
            out.append(c)
            cap = not c.isalnum()
        else:
            out.append(t.capitalize() if cap else t)
            cap = False
    return ''.join(out)


def normalize(s):
    """Search key: lower case, no accents, Mtavruli as Mkhedruli, punctuation as spaces (mappack.js does the same)."""
    s = unicodedata.normalize('NFKD', mkhedruli(s or '').lower())
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^0-9a-zა-ჿЀ-ӿԱ-֏]+", ' ', s)
    return ' '.join(s.split())


def names_of(tags):
    """(local, latin) display names of an OSM object."""
    name = tags.get('name', '').strip()
    ka = tags.get('name:ka', '').strip()
    en = (tags.get('name:en') or tags.get('int_name') or '').strip()
    local = ka or name
    if not en:
        base = ka or name
        en = translit(base) if GEORGIAN.search(base) else base
    if not local:
        local = en
    return local, en


def ref_of(tags):
    refs = []
    for k in ('ref', 'int_ref'):
        for r in re.split(r'[;,]', tags.get(k, '')):
            r = r.strip()
            if r and r not in refs:
                refs.append(r)
    if not refs:
        return '', ''
    local = ';'.join(refs)
    latin = ';'.join(translit(r).upper() if GEORGIAN.search(r) else r for r in refs)
    return local, latin


# ---------------------------------------------------------------- geometry
def merc(lat, lon):
    lat = max(-85.0, min(85.0, lat))
    return (R_EARTH * math.radians(lon), R_EARTH * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def unmerc(x, y):
    return (math.degrees(2 * math.atan(math.exp(y / R_EARTH)) - math.pi / 2), math.degrees(x / R_EARTH))


def ground(p, q):
    """metres on the ground between two Web Mercator points"""
    lat = unmerc(0, (p[1] + q[1]) / 2)[0]
    return math.hypot(p[0] - q[0], p[1] - q[1]) * math.cos(math.radians(lat))


def simplify(pts, tol):
    """Douglas-Peucker (iterative); keeps both ends."""
    n = len(pts)
    if n < 3 or tol <= 0:
        return list(pts)
    keep = bytearray(n)
    keep[0] = keep[-1] = 1
    stack = [(0, n - 1)]
    t2 = tol * tol
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if l2 == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best:
                best, bi = d, i
        if best > t2:
            keep[bi] = 1
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


def area2(ring):
    s = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i - 1]
        x2, y2 = ring[i]
        s += x1 * y2 - x2 * y1
    return s


def _point_in_tri(px, py, ax, ay, bx, by, cx, cy):
    d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
    d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
    d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def earclip(ring):
    """Triangles (point triples) of a simple polygon, either winding. Ear clipping over a linked
    list; only reflex corners can lie inside an ear, so only they are tested (O(n * reflex))."""
    pts = list(ring) if area2(ring) > 0 else list(ring)[::-1]
    n = len(pts)
    if n < 3:
        return []
    prv = [i - 1 for i in range(n)]
    prv[0] = n - 1
    nxt = [i + 1 for i in range(n)]
    nxt[-1] = 0

    def cross(a, b, c):
        (ax, ay), (bx, by), (cx, cy) = pts[a], pts[b], pts[c]
        return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)

    reflex = {i for i in range(n) if cross(prv[i], i, nxt[i]) <= 0}

    def ear(i):
        a, c = prv[i], nxt[i]
        if cross(a, i, c) <= 0:
            return False
        (ax, ay), (bx, by), (cx, cy) = pts[a], pts[i], pts[c]
        corners = (pts[a], pts[i], pts[c])
        for r in reflex:
            if r == a or r == i or r == c or pts[r] in corners:
                continue
            if _point_in_tri(pts[r][0], pts[r][1], ax, ay, bx, by, cx, cy):
                return False
        return True

    tris = []
    left, i, misses = n, 0, 0
    while left > 3:
        if ear(i) or misses > left:
            a, c = prv[i], nxt[i]
            if cross(a, i, c) > 0:
                tris.append((pts[a], pts[i], pts[c]))
            nxt[a], prv[c] = c, a
            reflex.discard(i)
            for j in (a, c):
                if j in reflex and cross(prv[j], j, nxt[j]) > 0:
                    reflex.discard(j)
            left -= 1
            i, misses = c, 0
        else:
            i = nxt[i]
            misses += 1
    if cross(prv[i], i, nxt[i]) > 0:
        tris.append((pts[prv[i]], pts[i], pts[nxt[i]]))
    return tris


def bridge_holes(outer, holes):
    """One ring from an outer ring and its holes (a zero-width cut to each hole), for ear clipping."""
    ring = list(outer)
    if area2(ring) < 0:
        ring.reverse()
    for h in sorted(holes, key=lambda h: -max(p[0] for p in h)):
        h = list(h)
        if area2(h) > 0:
            h.reverse()
        hi = max(range(len(h)), key=lambda i: h[i][0])
        hx, hy = h[hi]
        best, bi = None, -1
        for i, (x, y) in enumerate(ring):
            d = (x - hx) ** 2 + (y - hy) ** 2
            if x >= hx and (best is None or d < best):
                best, bi = d, i
        if bi < 0:
            bi = min(range(len(ring)), key=lambda i: (ring[i][0] - hx) ** 2 + (ring[i][1] - hy) ** 2)
        hole = h[hi:] + h[:hi] + [h[hi]]
        ring = ring[:bi + 1] + hole + ring[bi:]
    return ring


def clip_ring(ring, x0, y0, x1, y1):
    """Sutherland-Hodgman clip of a ring to a rectangle."""
    def clip(pts, inside, cross):
        out = []
        for i in range(len(pts)):
            p, q = pts[i - 1], pts[i]
            ip, iq = inside(p), inside(q)
            if iq:
                if not ip:
                    out.append(cross(p, q))
                out.append(q)
            elif ip:
                out.append(cross(p, q))
        return out

    def xcut(xv):
        return lambda p, q: (xv, p[1] + (q[1] - p[1]) * (xv - p[0]) / ((q[0] - p[0]) or 1e-12))

    def ycut(yv):
        return lambda p, q: (p[0] + (q[0] - p[0]) * (yv - p[1]) / ((q[1] - p[1]) or 1e-12), yv)

    pts = ring
    for inside, cross in ((lambda p: p[0] >= x0, xcut(x0)), (lambda p: p[0] <= x1, xcut(x1)),
                          (lambda p: p[1] >= y0, ycut(y0)), (lambda p: p[1] <= y1, ycut(y1))):
        if not pts:
            break
        pts = clip(pts, inside, cross)
    return pts


def assemble_rings(ways):
    """Closed rings from way coordinate lists that join end to end (multipolygon members)."""
    rings, open_ = [], [list(w) for w in ways if len(w) >= 2]
    while open_:
        cur = open_.pop()
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, w in enumerate(open_):
                if w[0] == cur[-1]:
                    cur += w[1:]
                elif w[-1] == cur[-1]:
                    cur += w[-2::-1]
                elif w[-1] == cur[0]:
                    cur = w[:-1] + cur
                elif w[0] == cur[0]:
                    cur = w[:0:-1] + cur
                else:
                    continue
                open_.pop(i)
                changed = True
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur[:-1])
    return rings


def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


# ---------------------------------------------------------------- dataset
class Dataset:
    """OSM data in memory: nodes {id: (lat, lon)}, node tags {id: tags}, ways [(id, refs, tags)],
    relations [(id, [(type, ref, role)], tags)]."""

    def __init__(self):
        self.nodes = {}
        self.ntags = {}
        self.ways = []
        self.rels = []
        self.source = ''
        self.attribution = '© OpenStreetMap contributors (ODbL)'


def interesting_way(t):
    if 'highway' in t and t['highway'] in ROAD and t.get('area') != 'yes':
        return True
    if area_kind(t) or line_kind(t):
        return True
    return False


def area_kind(t, buildings=False):
    n, lu, le, w = t.get('natural'), t.get('landuse'), t.get('leisure'), t.get('waterway')
    if n in ('water', 'bay', 'strait') or 'water' in t and n != 'coastline' or w in ('riverbank', 'dock') or lu in ('reservoir', 'basin'):
        return A_WATER
    if le in ('park', 'garden', 'recreation_ground', 'golf_course') or lu in ('recreation_ground', 'village_green'):
        return A_PARK
    if lu == 'forest' or n in ('wood', 'scrub'):
        return A_FOREST
    if lu in ('grass', 'meadow') or n in ('grassland', 'heath'):
        return A_GRASS
    if lu == 'residential':
        return A_RESIDENTIAL
    if lu in ('industrial', 'railway'):
        return A_INDUSTRIAL
    if lu in ('commercial', 'retail'):
        return A_COMMERCIAL
    if lu == 'cemetery' or t.get('amenity') == 'grave_yard':
        return A_CEMETERY
    if t.get('highway') == 'pedestrian' and t.get('area') == 'yes':
        return A_PEDESTRIAN
    if t.get('place') in ('island', 'islet'):
        return A_LAND
    if buildings and t.get('building') and t.get('building') != 'no':
        return A_BUILDING
    return 0


def line_kind(t):
    w = t.get('waterway')
    if w == 'river':
        return L_RIVER
    if w in ('stream', 'canal'):
        return L_STREAM
    if t.get('railway') in ('rail', 'subway', 'light_rail') and t.get('service') is None:
        return L_RAIL
    if t.get('natural') == 'coastline':
        return L_COAST
    if t.get('route') == 'ferry':
        return L_FERRY
    if t.get('boundary') == 'administrative' and t.get('admin_level') in ('2', '4'):
        return L_BORDER if t.get('admin_level') == '2' else L_REGION
    return 0


def poi_kind(t):
    if t.get('place') in PLACES:
        return PLACES[t['place']]
    for k, v, kind in POI_TAGS:
        if k in t and (v is None or t[k] == v):
            if kind == P_METRO and t.get('railway') == 'station' and t.get('station') not in ('subway', None):
                continue
            return kind
    return 0


def parse_speed(v):
    if not v:
        return 0
    m = re.match(r'\s*(\d+)\s*(mph)?', v)
    if m:
        s = int(m.group(1))
        return min(250, round(s * 1.609)) if m.group(2) else min(250, s)
    if 'urban' in v:
        return 60
    if 'rural' in v:
        return 90
    if 'motorway' in v:
        return 110
    if 'living_street' in v or 'walk' in v:
        return 20
    return 0


# ---------------------------------------------------------------- binary writer
class Blob:
    def __init__(self):
        self.b = bytearray()

    def u8(self, v): self.b += struct.pack('<B', v)
    def u16(self, v): self.b += struct.pack('<H', v)
    def i16(self, v): self.b += struct.pack('<h', v)
    def u32(self, v): self.b += struct.pack('<I', v)
    def i32(self, v): self.b += struct.pack('<i', v)
    def raw(self, b): self.b += b

    def align(self, n=4):
        while len(self.b) % n:
            self.b.append(0)


class Strings:
    def __init__(self):
        self.blob = bytearray()
        self.off = {}
        self.names = [('', '')]
        self.nidx = {('', ''): 0}

    def s(self, text):
        b = text.encode('utf-8')
        if text not in self.off:
            self.off[text] = len(self.blob)
            self.blob += b
        return self.off[text], len(b)

    def name(self, local, latin):
        local, latin = (local or '')[:200], (latin or '')[:200]
        key = (local, latin)
        if key not in self.nidx:
            self.nidx[key] = len(self.names)
            self.names.append(key)
        return self.nidx[key]

    def name_table(self):
        b = Blob()
        b.u32(len(self.names))
        for local, latin in self.names:
            lo, ll = self.s(local)
            ao, al = self.s(latin)
            b.u32(lo); b.u32(ao); b.u16(min(ll, 65535)); b.u16(min(al, 65535))
        return bytes(b.b)


# ---------------------------------------------------------------- compiler
class Compiler:
    def __init__(self, ds, region, buildings=False, log=print):
        self.ds, self.region, self.buildings, self.log = ds, region, buildings, log
        self.st = Strings()
        self.tiles = [dict() for _ in LEVELS]       # level -> {(col,row): {'roads':[], 'areas':[], 'lines':[], 'points':[]}}
        self.search = []

    # -- geometry helpers
    def coords(self, refs):
        out = []
        nodes = self.ds.nodes
        for r in refs:
            p = nodes.get(r)
            if p is not None:
                out.append(merc(p[0], p[1]))
        return out

    def tile(self, lv, col, row):
        t = self.tiles[lv].get((col, row))
        if t is None:
            t = self.tiles[lv][(col, row)] = {'roads': [], 'areas': [], 'lines': [], 'points': []}
        return t

    def q(self, lv, col, row, p):
        size = LEVELS[lv]['size']
        unit = size / UNITS
        return (int(round((p[0] - col * size) / unit)), int(round((p[1] - row * size) / unit)))

    def pieces(self, lv, pts):
        """A polyline in pieces that stay within their first point's tile and its 8 neighbours
        (so tile-local coordinates fit in 16 bits); long segments are cut first."""
        size = LEVELS[lv]['size']
        step = size * 0.9
        dense = [pts[0]]
        for p in pts[1:]:
            a = dense[-1]
            d = math.hypot(p[0] - a[0], p[1] - a[1])
            k = int(d // step)
            for j in range(1, k + 1):
                dense.append((a[0] + (p[0] - a[0]) * j / (k + 1), a[1] + (p[1] - a[1]) * j / (k + 1)))
            dense.append(p)
        tile = lambda p: (int(math.floor(p[0] / size)), int(math.floor(p[1] / size)))
        out = []
        cur = [dense[0]]
        col, row = tile(dense[0])
        for p in dense[1:]:
            c, r = tile(p)
            if abs(c - col) > 1 or abs(r - row) > 1 or len(cur) >= 4000:
                if len(cur) >= 2:
                    out.append((col, row, cur))
                cur = [cur[-1]]
                col, row = tile(cur[0])
            cur.append(p)
        if len(cur) >= 2:
            out.append((col, row, cur))
        return out

    # -- features
    def add_road(self, cls, flags, maxspeed, layer, name, ref, pts):
        top = 0 if cls <= 2 and not (flags & F_LINK) else 1 if cls <= 4 else 2
        for lv in range(top, 3):
            sp = simplify(pts, LEVELS[lv]['tol'])
            for col, row, ps in self.pieces(lv, sp):
                q = [self.q(lv, col, row, p) for p in ps]
                q = [p for i, p in enumerate(q) if i == 0 or p != q[i - 1]]
                if len(q) >= 2:
                    self.tile(lv, col, row)['roads'].append((cls, flags, maxspeed, layer & 255, name, ref, q))

    def add_line(self, kind, name, pts):
        top = 0 if kind in (L_RIVER, L_BORDER, L_COAST) else 1 if kind in (L_RAIL, L_REGION, L_FERRY) else 2
        for lv in range(top, 3):
            sp = simplify(pts, LEVELS[lv]['tol'] * 1.5)
            for col, row, ps in self.pieces(lv, sp):
                q = [self.q(lv, col, row, p) for p in ps]
                q = [p for i, p in enumerate(q) if i == 0 or p != q[i - 1]]
                if len(q) >= 2:
                    self.tile(lv, col, row)['lines'].append((kind, name, q))

    def add_area(self, kind, outer, holes):
        """outer / holes: rings of mercator points. Ear-clipped per tile, per level.
        Large areas (lakes, forests, the sea) are kept in the macro and mid levels only: the app draws
        the mid level's areas under the street level's, so they need no copy in hundreds of 2 km tiles."""
        a = abs(area2(outer)) / 2 - sum(abs(area2(h)) / 2 for h in holes)
        if a <= 0:
            return
        top = 0 if a > 4e6 or (kind == A_WATER and a > 1e6) else 1 if a > 2e4 else 2
        if kind == A_BUILDING:
            top = 2
        for lv in range(top, 3 if top == 2 else 2):
            size, tol = LEVELS[lv]['size'], LEVELS[lv]['tol'] * 2
            if a < (tol * 6) ** 2:
                continue
            o = simplify(outer + [outer[0]], tol)[:-1]
            hs = [simplify(h + [h[0]], tol)[:-1] for h in holes]
            hs = [h for h in hs if len(h) >= 3 and abs(area2(h)) > (tol * 4) ** 2]
            if len(o) < 3:
                continue
            ring = bridge_holes(o, hs) if hs else o
            xs, ys = [p[0] for p in ring], [p[1] for p in ring]
            c0, c1 = int(math.floor(min(xs) / size)), int(math.floor(max(xs) / size))
            r0, r1 = int(math.floor(min(ys) / size)), int(math.floor(max(ys) / size))
            for col in range(c0, c1 + 1):
                for row in range(r0, r1 + 1):
                    if c0 == c1 and r0 == r1:
                        part = ring
                    else:
                        part = clip_ring(ring, col * size, row * size, (col + 1) * size, (row + 1) * size)
                    if len(part) < 3:
                        continue
                    q = [self.q(lv, col, row, p) for p in part]
                    q2 = [p for i, p in enumerate(q) if p != q[i - 1]]
                    if len(q2) < 3:
                        continue
                    tris = earclip(q2)
                    if tris:
                        self.tile(lv, col, row)['areas'].append((kind, [p for t in tris for p in t]))

    def add_point(self, kind, rank, name, p):
        if kind <= P_HAMLET:
            top = 0 if kind in (P_CITY, P_TOWN) else 1 if kind in (P_VILLAGE, P_SUBURB) else 2
        else:
            top = POI_LEVEL.get(kind, 2)
        for lv in range(top, 3):
            size = LEVELS[lv]['size']
            col, row = int(math.floor(p[0] / size)), int(math.floor(p[1] / size))
            self.tile(lv, col, row)['points'].append((kind, rank, name, self.q(lv, col, row, p)))

    # -- passes
    def run(self):
        ds, st = self.ds, self.st
        t0 = time.time()
        way_coords = {}
        roads = []
        # roads (drawn) and the routing graph's input
        for wid, refs, t in ds.ways:
            hw = t.get('highway')
            if hw in ROAD and t.get('area') != 'yes':
                pts = self.coords(refs)
                if len(pts) < 2:
                    continue
                cls = ROAD[hw]
                flags = 0
                ow = t.get('oneway', '')
                rb = t.get('junction') in ('roundabout', 'circular')
                if ow in ('yes', '1', 'true', '-1') or rb or (hw in ('motorway', 'motorway_link') and ow != 'no'):
                    flags |= F_ONEWAY
                if rb:
                    flags |= F_ROUNDABOUT
                if t.get('bridge') not in (None, 'no'):
                    flags |= F_BRIDGE
                if t.get('tunnel') not in (None, 'no'):
                    flags |= F_TUNNEL
                if t.get('toll') == 'yes':
                    flags |= F_TOLL
                if hw.endswith('_link'):
                    flags |= F_LINK
                if cls == 9 or t.get('access') in ('no', 'private') or t.get('motor_vehicle') == 'no' or t.get('motorcar') == 'no':
                    flags |= F_NOCAR
                ms = parse_speed(t.get('maxspeed', ''))
                try:
                    layer = int(t.get('layer', '0'))
                except ValueError:
                    layer = 0
                local, latin = names_of(t)
                name = st.name(local, latin) if (t.get('name') or t.get('name:ka') or t.get('name:en')) else 0
                rl, ra = ref_of(t)
                ref = st.name(rl, ra) if rl else 0
                if ow == '-1':
                    refs = refs[::-1]
                    pts = pts[::-1]
                roads.append((wid, refs, pts, cls, flags, ms, layer, name, ref))
                self.add_road(cls, flags, ms, layer, name, ref, pts)
            else:
                lk = line_kind(t)
                ak = area_kind(t, self.buildings)
                if lk or ak:
                    way_coords[wid] = (refs, t)
                if lk:
                    pts = self.coords(refs)
                    if len(pts) >= 2:
                        local, latin = names_of(t)
                        nm = st.name(local, latin) if t.get('name') or t.get('name:ka') else 0
                        self.add_line(lk, nm, pts)
                if ak and refs and refs[0] == refs[-1] and len(refs) >= 4 and t.get('type') != 'multipolygon':
                    ring = self.coords(refs[:-1])
                    if len(ring) >= 3:
                        self.add_area(ak, ring, [])
        self.log('  roads: %d ways (%.1f s)' % (len(roads), time.time() - t0))
        # multipolygons and boundaries from relations
        wref = {wid: refs for wid, refs, t in ds.ways}
        nmp = 0
        for rid, members, t in ds.rels:
            ty = t.get('type')
            if ty in ('multipolygon', 'boundary') and area_kind(t, self.buildings) and ty == 'multipolygon':
                ak = area_kind(t, self.buildings)
                outer = assemble_rings([self.coords(wref[m[1]]) for m in members if m[0] == 'way' and m[1] in wref and m[2] in ('outer', '')])
                inner = assemble_rings([self.coords(wref[m[1]]) for m in members if m[0] == 'way' and m[1] in wref and m[2] == 'inner'])
                for o in outer:
                    hs = [h for h in inner if point_in_ring(h[0][0], h[0][1], o)]
                    self.add_area(ak, o, hs)
                    nmp += 1
            elif ty == 'boundary' or (ty == 'multipolygon' and t.get('boundary')):
                lk = line_kind(t)
                if lk in (L_BORDER, L_REGION):
                    for m in members:
                        if m[0] == 'way' and m[1] in wref:
                            pts = self.coords(wref[m[1]])
                            if len(pts) >= 2:
                                self.add_line(lk, 0, pts)
        self.log('  areas from relations: %d rings' % nmp)
        # points: places and POIs (nodes, and the centre of tagged closed ways)
        places = []
        for nid, t in ds.ntags.items():
            k = poi_kind(t)
            p = ds.nodes.get(nid)
            if not k or p is None:
                continue
            self.point(k, t, merc(p[0], p[1]), places)
        for wid, refs, t in ds.ways:
            if 'highway' in t:
                continue
            k = poi_kind(t)
            if k and k > P_HAMLET and len(refs) >= 3:
                pts = self.coords(refs)
                if pts:
                    c = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
                    self.point(k, t, c, places)
        self.places = places
        self.log('  points: %d places, %d search entries' % (len(places), len(self.search)))
        self.graph(roads)
        self.streets(roads)
        self.log('  compiled in %.1f s' % (time.time() - t0))

    def point(self, k, t, p, places):
        st = self.st
        local, latin = names_of(t)
        has = bool(t.get('name') or t.get('name:ka') or t.get('name:en'))
        if not has and k >= P_FUEL:
            br = t.get('brand') or t.get('operator')
            if br:
                local, latin, has = br, br, True
        name = st.name(local, latin) if has else 0
        rank = 0
        if k <= P_HAMLET:
            try:
                pop = int(re.sub(r'[^0-9]', '', t.get('population', '0')) or 0)
            except ValueError:
                pop = 0
            rank = min(255, int(math.log10(pop + 1) * 36)) if pop else {P_CITY: 150, P_TOWN: 120, P_SUBURB: 100, P_VILLAGE: 80}.get(k, 40)
            places.append((k, rank, name, p))
        if k <= P_HAMLET and not has:
            return
        self.add_point(k, rank, name, p)
        if has:
            self.search.append([name, 0, k, rank, p])

    # -- routing graph
    def graph(self, roads):
        t0 = time.time()
        use = {}
        for wid, refs, pts, cls, flags, ms, layer, name, ref in roads:
            if flags & F_NOCAR:
                continue
            for i, r in enumerate(refs):
                if r not in self.ds.nodes:
                    continue
                use[r] = use.get(r, 0) + (2 if i == 0 or i == len(refs) - 1 else 1)
        junction = {r for r, c in use.items() if c >= 2}
        nid = {}
        nxy = []

        def node(r):
            i = nid.get(r)
            if i is None:
                i = nid[r] = len(nxy)
                p = self.ds.nodes[r]
                x, y = merc(p[0], p[1])
                nxy.append((int(round(x * 10)), int(round(y * 10))))
            return i

        edges = []   # (src, dst, lenDm, name, ref, geomStart, geomCount, rev, cls, flags, speed, maxspeed)
        geom = array('i')
        for wid, refs, pts, cls, flags, ms, layer, name, ref in roads:
            if flags & F_NOCAR:
                continue
            refs = [r for r in refs if r in self.ds.nodes]
            if len(refs) < 2:
                continue
            maxs = ms or DEFAULT_MAX[cls]
            trav = TRAVEL[cls] if not ms else min(ms * (0.92 if cls <= 1 else 0.8 if cls <= 4 else 0.7), TRAVEL[cls] * 1.25)
            if flags & F_LINK:
                trav *= 0.8
            if flags & F_ROUNDABOUT:
                trav = min(trav, 25)
            start = 0
            for i in range(1, len(refs)):
                if refs[i] in junction or i == len(refs) - 1:
                    seg = refs[start:i + 1]
                    if seg[0] == seg[-1] and len(seg) <= 2:
                        start = i
                        continue
                    a, b = node(seg[0]), node(seg[-1])
                    sp = [merc(*self.ds.nodes[r]) for r in seg]
                    length = sum(ground(sp[k - 1], sp[k]) for k in range(1, len(sp)))
                    gs = len(geom) // 2
                    for r in seg[1:-1]:
                        x, y = merc(*self.ds.nodes[r])
                        geom.append(int(round(x * 10)))
                        geom.append(int(round(y * 10)))
                    gc = len(seg) - 2
                    ld = max(1, int(round(length * 10)))
                    sp_kmh = max(5, min(250, int(round(trav))))
                    # the speed limit the app shows: only a tagged one (a guessed class default is no sign)
                    edges.append((a, b, ld, name, ref, gs, gc, 0, cls, flags, sp_kmh, ms))
                    if not (flags & F_ONEWAY):
                        edges.append((b, a, ld, name, ref, gs, gc, 1, cls, flags, sp_kmh, ms))
                    start = i
        n = len(nxy)
        # the main network: nodes in small islands (a car park, a disconnected service road) are flagged
        parent = list(range(n))

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        for e in edges:
            ra, rb = find(e[0]), find(e[1])
            if ra != rb:
                parent[ra] = rb
        size = {}
        for i in range(n):
            r = find(i)
            size[r] = size.get(r, 0) + 1
        big = max(size.values()) if size else 0
        small = {r for r, s in size.items() if s < max(30, big * 0.002)}
        edges = [e[:9] + (e[9] | (F_ISOLATED if find(e[0]) in small else 0),) + e[10:] for e in edges]
        edges.sort(key=lambda e: e[0])
        first = array('I', [0] * (n + 1))
        for e in edges:
            first[e[0] + 1] += 1
        for i in range(n):
            first[i + 1] += first[i]
        self.gnodes, self.gfirst, self.gedges, self.ggeom = nxy, first, edges, geom
        self.log('  graph: %d nodes, %d edges, %d shape points, %d in islands (%.1f s)'
                 % (n, len(edges), len(geom) // 2, sum(1 for e in edges if e[9] & F_ISOLATED), time.time() - t0))

    def streets(self, roads):
        """One search entry per street: ways of the same name near each other."""
        by = {}
        for wid, refs, pts, cls, flags, ms, layer, name, ref in roads:
            if not name or cls > 8:
                continue
            by.setdefault(name, []).append(pts)
        cell = 1500.0
        for name, lines in by.items():
            groups = []
            for pts in lines:
                c = pts[len(pts) // 2]
                for g in groups:
                    if math.hypot(g['c'][0] - c[0], g['c'][1] - c[1]) < cell * (1 + len(g['l']) ** 0.5):
                        g['l'].append(pts)
                        n = len(g['l'])
                        g['c'] = (g['c'][0] + (c[0] - g['c'][0]) / n, g['c'][1] + (c[1] - g['c'][1]) / n)
                        break
                else:
                    groups.append({'c': c, 'l': [pts]})
            for g in groups:
                allp = [p for l in g['l'] for p in l]
                c = min(allp, key=lambda p: (p[0] - g['c'][0]) ** 2 + (p[1] - g['c'][1]) ** 2)
                length = sum(math.hypot(l[k][0] - l[k - 1][0], l[k][1] - l[k - 1][1]) for l in g['l'] for k in range(1, len(l)))
                self.search.append([name, 0, K_STREET, min(255, int(math.log10(length + 10) * 40)), c])
        # context: the nearest town / suburb
        pl = [p for p in self.places if p[2]]
        if pl:
            grid = {}
            for p in pl:
                grid.setdefault((int(p[3][0] // 5000), int(p[3][1] // 5000)), []).append(p)
            for e in self.search:
                if e[2] <= P_SUBURB:
                    continue          # a town or a district is its own context
                x, y = e[4]
                best, bd = None, 1e18
                for dx in (-2, -1, 0, 1, 2):
                    for dy in (-2, -1, 0, 1, 2):
                        for p in grid.get((int(x // 5000) + dx, int(y // 5000) + dy), ()):
                            w = {P_CITY: 0.35, P_TOWN: 0.5, P_SUBURB: 0.8}.get(p[0], 1.0)
                            d = ((p[3][0] - x) ** 2 + (p[3][1] - y) ** 2) * w * w
                            if d < bd and p[2] != e[0]:
                                best, bd = p, d
                if best:
                    e[1] = best[2]

    # -- output
    def write(self, path):
        st = self.st
        sections = []
        # tiles
        all_x, all_y = [], []
        for lv in range(3):
            b = Blob()
            keys = sorted(self.tiles[lv].keys(), key=lambda k: (k[1], k[0]))
            if keys:
                cols = [k[0] for k in keys]
                rows = [k[1] for k in keys]
                c0, r0 = min(cols) - 1, min(rows) - 1
                ncol = max(cols) - c0 + 2
                nrow = max(rows) - r0 + 2
            else:
                c0 = r0 = 0
                ncol = nrow = 1
            LEVELS[lv].update({'col0': c0, 'row0': r0, 'cols': ncol, 'rows': nrow})
            blobs = []
            for k in keys:
                blobs.append(((k[1] - r0) * ncol + (k[0] - c0), self.tile_blob(self.tiles[lv][k])))
            blobs.sort()
            b.u32(len(blobs))
            off = 4 + 12 * len(blobs)
            for key, tb in blobs:
                b.u32(key); b.u32(off); b.u32(len(tb))
                off += len(tb)
            for key, tb in blobs:
                b.raw(tb)
            sections.append(('TIL%d' % lv, bytes(b.b)))
        # graph
        n = len(self.gnodes)
        b = Blob()
        b.u32(n)
        b.raw(array('i', [p[0] for p in self.gnodes]).tobytes())
        b.raw(array('i', [p[1] for p in self.gnodes]).tobytes())
        b.raw(self.gfirst.tobytes())
        sections.append(('GNOD', bytes(b.b)))
        E = self.gedges
        b = Blob()
        b.u32(len(E))
        b.raw(array('I', [e[1] for e in E]).tobytes())
        b.raw(array('I', [e[2] for e in E]).tobytes())
        b.raw(array('I', [e[3] for e in E]).tobytes())
        b.raw(array('I', [e[4] for e in E]).tobytes())
        b.raw(array('I', [e[5] | (0x80000000 if e[7] else 0) for e in E]).tobytes())
        b.raw(array('I', [min(e[6], 65535) | (e[8] << 16) | (e[9] << 24) for e in E]).tobytes())
        b.raw(array('I', [e[10] | (min(255, e[11]) << 8) for e in E]).tobytes())
        sections.append(('GEDG', bytes(b.b)))
        b = Blob()
        b.u32(len(self.ggeom) // 2)
        b.raw(self.ggeom.tobytes())
        sections.append(('GGEO', bytes(b.b)))
        # snapping grid
        cells = {}
        geom = self.ggeom
        for i, e in enumerate(E):
            if e[7]:
                continue       # the reverse of an edge: the forward one is in the grid
            src = self.gnodes[e[0]]
            pts = [src] + [(geom[2 * (e[5] + k)], geom[2 * (e[5] + k) + 1]) for k in range(e[6])] + [self.gnodes[e[1]]]
            seen = set()
            for k in range(1, len(pts)):
                ax, ay = pts[k - 1][0] / 10.0, pts[k - 1][1] / 10.0
                bx, by = pts[k][0] / 10.0, pts[k][1] / 10.0
                steps = max(1, int(math.hypot(bx - ax, by - ay) / (GRID_CELL / 2)) + 1)
                for s in range(steps + 1):
                    x, y = ax + (bx - ax) * s / steps, ay + (by - ay) * s / steps
                    seen.add((int(math.floor(x / GRID_CELL)), int(math.floor(y / GRID_CELL))))
            for c in seen:
                cells.setdefault(c, []).append(i)
        if cells:
            gc0 = min(c[0] for c in cells)
            gr0 = min(c[1] for c in cells)
            gcols = max(c[0] for c in cells) - gc0 + 1
        else:
            gc0 = gr0 = 0
            gcols = 1
        keyed = sorted(((c[1] - gr0) * gcols + (c[0] - gc0), ids) for c, ids in cells.items())
        b = Blob()
        b.u32(len(keyed))
        b.raw(array('I', [k for k, _ in keyed]).tobytes())
        acc, firsts = 0, []
        for _, ids in keyed:
            firsts.append(acc)
            acc += len(ids)
        firsts.append(acc)
        b.raw(array('I', firsts).tobytes())
        b.raw(array('I', [i for _, ids in keyed for i in ids]).tobytes())
        sections.append(('GGRD', bytes(b.b)))
        grid = {'cell': GRID_CELL, 'col0': gc0, 'row0': gr0, 'cols': gcols}
        # search
        order = {P_CITY: 0, P_TOWN: 1, P_SUBURB: 2, P_AIRPORT: 3, P_VILLAGE: 4, P_LANDMARK: 5, K_STREET: 6}
        S = sorted(self.search, key=lambda e: (order.get(e[2], 7), -e[3]))
        b = Blob()
        b.u32(len(S))
        keys = []
        for e in S:
            b.u32(e[0]); b.u32(e[1]); b.u8(e[2]); b.u8(e[3]); b.u16(0)
            b.i32(int(round(e[4][0] * 10))); b.i32(int(round(e[4][1] * 10)))
            local, latin = st.names[e[0]]
            k = normalize(local)
            for extra in (normalize(latin), normalize(translit(local)) if GEORGIAN.search(local) else ''):
                if extra and extra != k:
                    k += ' ' + extra
            keys.append(k)
        sections.append(('SRCH', bytes(b.b)))
        b = Blob()
        b.u32(len(keys))
        kb = bytearray()
        offs = []
        for k in keys:
            offs.append(len(kb))
            kb += k.encode('utf-8')
        offs.append(len(kb))
        b.raw(array('I', offs).tobytes())
        b.raw(bytes(kb))
        sections.append(('SKEY', bytes(b.b)))
        tok = {}
        for i, k in enumerate(keys):
            for w in set(k.split()):
                tok.setdefault(w, []).append(i)
        toks = sorted(tok.keys(), key=lambda w: w.encode('utf-8'))
        b = Blob()
        b.u32(len(toks))
        tb = bytearray()
        post = []
        recs = []
        for w in toks:
            e = w.encode('utf-8')
            recs.append((len(tb), len(e), len(post), len(tok[w])))
            tb += e
            post += tok[w]
        base = 4 + 16 * len(toks)
        for off, ln, f, c in recs:
            b.u32(off); b.u16(ln); b.u16(0); b.u32(f); b.u32(c)
        b.raw(array('I', post).tobytes())
        tok_blob_off = len(b.b)
        b.raw(bytes(tb))
        sections.append(('STOK', bytes(b.b)))
        # names and strings (last: everything above registered its strings)
        sections.insert(0, ('NAME', st.name_table()))
        sections.insert(0, ('STRS', bytes(st.blob)))
        # bounding box
        if self.gnodes:
            xs = [p[0] / 10.0 for p in self.gnodes]
            ys = [p[1] / 10.0 for p in self.gnodes]
        else:
            xs, ys = [0.0], [0.0]
        lat0, lon0 = unmerc(min(xs), min(ys))
        lat1, lon1 = unmerc(max(xs), max(ys))
        meta = {
            'format': 'osm_nav pack', 'version': VERSION, 'region': self.region, 'source': self.ds.source,
            'attribution': self.ds.attribution, 'created': time.strftime('%Y-%m-%d'),
            'projection': 'EPSG:3857 metres; graph and search in decimetres', 'units': UNITS,
            'bbox': [round(lat0, 5), round(lon0, 5), round(lat1, 5), round(lon1, 5)],
            'mbox': [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))],
            'levels': [{k: LEVELS[i][k] for k in ('size', 'col0', 'row0', 'cols', 'rows')} for i in range(3)],
            'grid': grid, 'tokenText': tok_blob_off,
            'counts': {'names': len(st.names), 'nodes': n, 'edges': len(E), 'search': len(S),
                       'tiles': [len(self.tiles[i]) for i in range(3)]},
            'languages': ['ka', 'en'],
        }
        mj = json.dumps(meta, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        head = 16 + 12 * len(sections)
        off = head + len(mj)
        off = (off + 7) & ~7
        table = []
        for sid, data in sections:
            table.append((sid, off, len(data)))
            off = (off + len(data) + 7) & ~7
        out = bytearray()
        out += b'OSMP' + struct.pack('<HHII', VERSION, len(sections), len(mj), 0)
        for sid, o, ln in table:
            out += sid.encode('ascii') + struct.pack('<II', o, ln)
        out += mj
        for (sid, data), (_, o, ln) in zip(sections, table):
            while len(out) < o:
                out.append(0)
            out += data
        while len(out) % 8:
            out.append(0)
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        tmp = path + '.tmp'
        if len(out) > 90 * 1024 * 1024:
            import gzip
            with gzip.open(tmp, 'wb', compresslevel=6) as f:
                f.write(out)
        else:
            with open(tmp, 'wb') as f:
                f.write(out)
        os.replace(tmp, path)
        return meta, len(out), table

    def tile_blob(self, t):
        b = Blob()
        order = sorted(t['roads'], key=lambda r: (-r[0], r[1] & F_BRIDGE))
        b.u32(len(order)); b.u32(len(t['areas'])); b.u32(len(t['lines'])); b.u32(len(t['points']))
        clamp = lambda v: max(-32768, min(32767, v))
        for cls, flags, ms, layer, name, ref, q in order:
            b.u8(cls); b.u8(flags); b.u8(min(255, ms)); b.u8(layer & 255)
            b.u32(name); b.u32(ref); b.u16(len(q)); b.u16(0)
            b.raw(array('h', [clamp(v) for p in q for v in p]).tobytes())
        for kind, pts in sorted(t['areas'], key=lambda a: a[0] == A_BUILDING):
            b.u8(kind); b.u8(0); b.u16(0); b.u32(len(pts) // 3)
            b.raw(array('h', [clamp(v) for p in pts for v in p]).tobytes())
        for kind, name, q in t['lines']:
            b.u8(kind); b.u8(0); b.u16(len(q)); b.u32(name)
            b.raw(array('h', [clamp(v) for p in q for v in p]).tobytes())
        for kind, rank, name, p in sorted(t['points'], key=lambda x: (-x[1], x[0])):
            b.u8(kind); b.u8(rank); b.i16(clamp(p[0])); b.i16(clamp(p[1])); b.u16(0); b.u32(name)
        return bytes(b.b)


# ---------------------------------------------------------------- readers: OSM XML / Overpass JSON
def read_xml(path, log=print):
    import xml.etree.ElementTree as ET
    ds = Dataset()
    ds.source = os.path.basename(path)
    opener = bz2.open if path.endswith('.bz2') else gzip.open if path.endswith('.gz') else open
    with opener(path, 'rb') as f:
        cur = None
        for ev, el in ET.iterparse(f, events=('start', 'end')):
            tag = el.tag
            if ev == 'start':
                if tag in ('node', 'way', 'relation'):
                    cur = {'t': {}, 'nd': [], 'm': []}
                continue
            if tag == 'tag' and cur is not None:
                cur['t'][el.get('k')] = el.get('v')
            elif tag == 'nd' and cur is not None:
                cur['nd'].append(int(el.get('ref')))
            elif tag == 'member' and cur is not None:
                cur['m'].append((el.get('type'), int(el.get('ref')), el.get('role') or ''))
            elif tag == 'node':
                i = int(el.get('id'))
                ds.nodes[i] = (float(el.get('lat')), float(el.get('lon')))
                if cur['t']:
                    ds.ntags[i] = cur['t']
                cur = None
                el.clear()
            elif tag == 'way':
                ds.ways.append((int(el.get('id')), cur['nd'], cur['t']))
                cur = None
                el.clear()
            elif tag == 'relation':
                ds.rels.append((int(el.get('id')), cur['m'], cur['t']))
                cur = None
                el.clear()
    return ds


def read_json(path_or_data, log=print):
    if isinstance(path_or_data, (bytes, bytearray)):
        j = json.loads(path_or_data.decode('utf-8'))
        src = 'overpass'
    else:
        with open(path_or_data, encoding='utf-8') as f:
            j = json.load(f)
        src = os.path.basename(path_or_data)
    ds = Dataset()
    ds.source = src
    for e in j.get('elements', []):
        t = e.get('tags') or {}
        if e['type'] == 'node':
            ds.nodes[e['id']] = (e['lat'], e['lon'])
            if t:
                ds.ntags[e['id']] = t
        elif e['type'] == 'way':
            ds.ways.append((e['id'], e.get('nodes', []), t))
        elif e['type'] == 'relation':
            ds.rels.append((e['id'], [(m['type'], m['ref'], m.get('role', '')) for m in e.get('members', [])], t))
    return ds


def fetch_overpass(bbox, log=print):
    s, w, n, e = bbox
    q = ('[out:json][timeout:300];('
         'way["highway"](%(b)s);way["natural"~"water|wood|scrub|coastline|bay"](%(b)s);way["waterway"](%(b)s);'
         'way["landuse"~"forest|grass|meadow|residential|industrial|commercial|retail|cemetery|reservoir|basin|recreation_ground"](%(b)s);'
         'way["leisure"~"park|garden|recreation_ground"](%(b)s);way["railway"~"rail|subway"](%(b)s);'
         'relation["type"="multipolygon"]["natural"~"water|wood"](%(b)s);relation["type"="multipolygon"]["landuse"~"forest|reservoir"](%(b)s);'
         'relation["type"="multipolygon"]["leisure"="park"](%(b)s);'
         'node["place"](%(b)s);node["amenity"~"fuel|charging_station|hospital|clinic|parking|pharmacy|police"](%(b)s);'
         'node["tourism"~"attraction|museum|hotel|viewpoint"](%(b)s);node["railway"="station"](%(b)s);node["historic"](%(b)s);'
         'node["shop"="mall"](%(b)s);way["shop"="mall"](%(b)s);way["amenity"~"hospital|fuel"](%(b)s);'
         ');out body;>;out skel qt;') % {'b': '%f,%f,%f,%f' % (s, w, n, e)}
    url = 'https://overpass-api.de/api/interpreter'
    log('  fetching %s from %s ...' % (bbox, url))
    req = urllib.request.Request(url, data=('data=' + urllib.parse.quote(q)).encode('ascii'),
                                 headers={'User-Agent': 'idrive7-geo-map pack_osm.py (offline map compiler)'})
    data = urllib.request.urlopen(req, timeout=600).read()
    log('  %.1f MB' % (len(data) / 1e6))
    ds = read_json(data)
    ds.source = 'overpass %s' % (bbox,)
    return ds


GEOFABRIK = {
    'georgia': 'https://download.geofabrik.de/europe/georgia-latest.osm.pbf',
    'armenia': 'https://download.geofabrik.de/asia/armenia-latest.osm.pbf',
    'azerbaijan': 'https://download.geofabrik.de/asia/azerbaijan-latest.osm.pbf',
}


def fetch_geofabrik(region, cache, log=print):
    url = GEOFABRIK.get(region, region if region.startswith('https://') else 'https://download.geofabrik.de/%s-latest.osm.pbf' % region)
    os.makedirs(cache, exist_ok=True)
    dst = os.path.join(cache, url.rsplit('/', 1)[-1])
    if not os.path.exists(dst) or time.time() - os.path.getmtime(dst) > 7 * 86400:
        log('  downloading %s' % url)
        req = urllib.request.Request(url, headers={'User-Agent': 'idrive7-geo-map pack_osm.py'})
        with urllib.request.urlopen(req, timeout=900) as r, open(dst + '.part', 'wb') as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        os.replace(dst + '.part', dst)
    return dst


# ---------------------------------------------------------------- reader: .osm.pbf (no dependencies)
def _varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        if c < 0x80:
            return r, i
        s += 7


def _fields(b):
    """(field number, wire type, value) of a protobuf message; value = int or memoryview."""
    i, n = 0, len(b)
    while i < n:
        key, i = _varint(b, i)
        f, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(b, i)
        elif wt == 2:
            ln, i = _varint(b, i)
            v = b[i:i + ln]
            i += ln
        elif wt == 1:
            v = b[i:i + 8]
            i += 8
        elif wt == 5:
            v = b[i:i + 4]
            i += 4
        else:
            raise ValueError('protobuf wire type %d' % wt)
        yield f, wt, v


def _packed(b):
    out = []
    i, n = 0, len(b)
    ap = out.append
    while i < n:
        r = s = 0
        while True:
            c = b[i]
            i += 1
            r |= (c & 0x7F) << s
            if c < 0x80:
                break
            s += 7
        ap(r)
    return out


def _zz(v):
    return (v >> 1) ^ -(v & 1)


def _blocks(path):
    with open(path, 'rb') as f:
        while True:
            h = f.read(4)
            if len(h) < 4:
                return
            hl = struct.unpack('>I', h)[0]
            hdr = f.read(hl)
            btype, size = '', 0
            for fn, wt, v in _fields(hdr):
                if fn == 1:
                    btype = bytes(v).decode()
                elif fn == 3:
                    size = v
            blob = f.read(size)
            raw = None
            for fn, wt, v in _fields(blob):
                if fn == 1:
                    raw = bytes(v)
                elif fn == 3:
                    raw = zlib.decompress(bytes(v))
                elif fn == 4:
                    import lzma
                    raw = lzma.decompress(bytes(v))
                elif fn in (6, 7):
                    raise ValueError('this .pbf uses lz4/zstd blobs: recompress it with osmium (zlib)')
            if btype == 'OSMData' and raw is not None:
                yield memoryview(raw)


def _block(raw, want):
    """Parse one PrimitiveBlock; want = set of 'nodes', 'ways', 'rels'. Yields (kind, ...)."""
    strings, groups = [], []
    gran, lat_off, lon_off = 100, 0, 0
    for fn, wt, v in _fields(raw):
        if fn == 1:
            strings = [bytes(s).decode('utf-8', 'replace') for f2, w2, s in _fields(v) if f2 == 1]
        elif fn == 2:
            groups.append(v)
        elif fn == 17:
            gran = v
        elif fn == 19:
            lat_off = v
        elif fn == 20:
            lon_off = v
    for g in groups:
        for fn, wt, v in _fields(g):
            if fn == 2 and 'nodes' in want:
                ids = lats = lons = kv = None
                for f2, w2, v2 in _fields(v):
                    if f2 == 1:
                        ids = _packed(v2)
                    elif f2 == 8:
                        lats = _packed(v2)
                    elif f2 == 9:
                        lons = _packed(v2)
                    elif f2 == 10:
                        kv = _packed(v2)
                nid = la = lo = 0
                k = 0
                for j in range(len(ids)):
                    nid += _zz(ids[j])
                    la += _zz(lats[j])
                    lo += _zz(lons[j])
                    tags = None
                    if kv:
                        while k < len(kv) and kv[k] != 0:
                            if tags is None:
                                tags = {}
                            tags[strings[kv[k]]] = strings[kv[k + 1]]
                            k += 2
                        k += 1
                    yield ('n', nid, 1e-9 * (lat_off + gran * la), 1e-9 * (lon_off + gran * lo), tags)
            elif fn == 1 and 'nodes' in want:
                nid, la, lo, keys, vals = 0, 0, 0, [], []
                for f2, w2, v2 in _fields(v):
                    if f2 == 1:
                        nid = _zz(v2)
                    elif f2 == 2:
                        keys = _packed(v2)
                    elif f2 == 3:
                        vals = _packed(v2)
                    elif f2 == 8:
                        la = _zz(v2)
                    elif f2 == 9:
                        lo = _zz(v2)
                tags = {strings[a]: strings[b] for a, b in zip(keys, vals)} or None
                yield ('n', nid, 1e-9 * (lat_off + gran * la), 1e-9 * (lon_off + gran * lo), tags)
            elif fn == 3 and 'ways' in want:
                wid, keys, vals, refs = 0, [], [], []
                for f2, w2, v2 in _fields(v):
                    if f2 == 1:
                        wid = v2
                    elif f2 == 2:
                        keys = _packed(v2)
                    elif f2 == 3:
                        vals = _packed(v2)
                    elif f2 == 8:
                        refs = _packed(v2)
                acc, rr = 0, []
                for r in refs:
                    acc += _zz(r)
                    rr.append(acc)
                yield ('w', wid, rr, {strings[a]: strings[b] for a, b in zip(keys, vals)})
            elif fn == 4 and 'rels' in want:
                rid, keys, vals, roles, mids, types = 0, [], [], [], [], []
                for f2, w2, v2 in _fields(v):
                    if f2 == 1:
                        rid = v2
                    elif f2 == 2:
                        keys = _packed(v2)
                    elif f2 == 3:
                        vals = _packed(v2)
                    elif f2 == 8:
                        roles = _packed(v2)
                    elif f2 == 9:
                        mids = _packed(v2)
                    elif f2 == 10:
                        types = _packed(v2)
                acc, mm = 0, []
                for r, m, ty in zip(roles, mids, types):
                    acc += _zz(m)
                    mm.append((('node', 'way', 'relation')[ty], acc, strings[r]))
                yield ('r', rid, mm, {strings[a]: strings[b] for a, b in zip(keys, vals)})


def read_pbf(path, buildings=False, log=print):
    """Three passes: relations (which ways their areas need), ways (which nodes), nodes."""
    ds = Dataset()
    ds.source = os.path.basename(path)
    t0 = time.time()
    member_ways = set()
    for raw in _blocks(path):
        for r in _block(raw, {'rels'}):
            _, rid, mm, t = r
            if t.get('type') == 'multipolygon' and area_kind(t, buildings) or t.get('boundary') == 'administrative' and t.get('admin_level') in ('2', '4'):
                ds.rels.append((rid, mm, t))
                member_ways.update(m[1] for m in mm if m[0] == 'way')
    log('  pass 1: %d relations (%.0f s)' % (len(ds.rels), time.time() - t0))
    need = set()
    for raw in _blocks(path):
        for r in _block(raw, {'ways'}):
            _, wid, refs, t = r
            keep = wid in member_ways or interesting_way(t) or (buildings and t.get('building')) or (poi_kind(t) > P_HAMLET)
            if keep:
                ds.ways.append((wid, refs, t))
                need.update(refs)
    log('  pass 2: %d ways, %d nodes needed (%.0f s)' % (len(ds.ways), len(need), time.time() - t0))
    for raw in _blocks(path):
        for r in _block(raw, {'nodes'}):
            _, nid, la, lo, tags = r
            if nid in need:
                ds.nodes[nid] = (la, lo)
            if tags and poi_kind(tags):
                ds.nodes[nid] = (la, lo)
                ds.ntags[nid] = tags
    log('  pass 3: %d nodes (%.0f s)' % (len(ds.nodes), time.time() - t0))
    return ds


# ---------------------------------------------------------------- the built-in Georgia map
def builtin_georgia(log=print):
    from georgia_builtin import build
    return build(Dataset, log)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input', nargs='?', help='.osm.pbf, .osm / .osm.bz2 / .osm.gz (XML) or .osm.json / .json (Overpass)')
    ap.add_argument('-o', '--output', required=True)
    ap.add_argument('--builtin-georgia', action='store_true', help='make the built-in Georgia / Tbilisi map (no download)')
    ap.add_argument('--overpass', metavar='S,W,N,E', help='fetch this box from the Overpass API')
    ap.add_argument('--fetch', metavar='REGION', help='download a Geofabrik extract (georgia, armenia, ... or a URL) and compile it')
    ap.add_argument('--region', default=None, help='region name shown in the app')
    ap.add_argument('--buildings', action='store_true', help='include building footprints (much larger)')
    ap.add_argument('--cache', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '.osm-cache'))
    a = ap.parse_args()
    t0 = time.time()
    if a.builtin_georgia:
        ds = builtin_georgia()
        region = a.region or 'Georgia'
    elif a.overpass:
        ds = fetch_overpass([float(v) for v in a.overpass.split(',')])
        region = a.region or 'Custom area'
    elif a.fetch:
        path = fetch_geofabrik(a.fetch, a.cache)
        ds = read_pbf(path, a.buildings)
        region = a.region or a.fetch.rsplit('/', 1)[-1].replace('-latest.osm.pbf', '').title()
    elif a.input:
        p = a.input
        if p.endswith('.pbf'):
            ds = read_pbf(p, a.buildings)
        elif p.endswith('.json'):
            ds = read_json(p)
        else:
            ds = read_xml(p)
        region = a.region or re.sub(r'(-latest)?\.osm.*$|\.json$', '', os.path.basename(p)).title()
    else:
        ap.error('give an input file, --builtin-georgia, --overpass or --fetch')
    print('%s: %d nodes, %d ways, %d relations' % (ds.source, len(ds.nodes), len(ds.ways), len(ds.rels)))
    c = Compiler(ds, region, a.buildings)
    c.run()
    meta, size, table = c.write(a.output)
    print('%s: %s, %.2f MB in %.1f s' % (a.output, region, size / 1e6, time.time() - t0))
    for sid, off, ln in table:
        print('  %s %9d bytes' % (sid, ln))
    print('  %(nodes)d graph nodes, %(edges)d edges, %(search)d search entries, tiles %(tiles)s' % meta['counts'])


if __name__ == '__main__':
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
