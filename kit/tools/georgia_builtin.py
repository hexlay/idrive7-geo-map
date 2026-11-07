"""georgia_builtin.py - the built-in Georgia map for pack_osm.py --builtin-georgia (no download).

Builds an OSM-like dataset (nodes, ways with OSM tags) that pack_osm.py compiles like a real extract:

  - Georgia's highways (S1 ... S12 with their E-numbers) between its cities and towns, with mountain
    roads winding more than the plains, and their speed limits
  - the Black Sea, the country border, lakes and reservoirs, the Mtkvari, Rioni, Aragvi, Alazani,
    Enguri and Tergi rivers
  - Tbilisi: Rustaveli Avenue, Freedom Square and Heroes' Square (roundabouts), Kostava, Chavchavadze,
    Kazbegi, Vazha-Pshavela, Pekini, Aghmashenebeli, Tsereteli, Ketevan Tsamebuli, the Mtkvari
    embankments and bridges, parks and lakes, landmarks, metro stations, hospitals, fuel stations
    and parking at their approximate real places; residential streets generated for each district
    (Georgian and English names), some of them one-way
  - street grids for Batumi, Kutaisi, Rustavi, Gori, Zugdidi, Telavi and Poti

Positions are approximate (from public geography, not surveyed), so this is a demo / starter map: for
the real map compile a Geofabrik extract (pack_osm.py georgia-latest.osm.pbf or --fetch georgia).
Everything is deterministic: the same pack comes out every time.
"""
import math
import random

R_EARTH = 6378137.0


def merc(lat, lon):
    return (R_EARTH * math.radians(lon), R_EARTH * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def unmerc(x, y):
    return (math.degrees(2 * math.atan(math.exp(y / R_EARTH)) - math.pi / 2), math.degrees(x / R_EARTH))


def offset(pts, metres):
    """A polyline (lat, lon) moved sideways by metres on the ground (+ = left of its direction)."""
    m = [merc(*p) for p in pts]
    out = []
    for i in range(len(m)):
        a = m[max(0, i - 1)]
        b = m[min(len(m) - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(dx, dy) or 1
        k = metres / math.cos(math.radians(pts[i][0]))
        out.append(unmerc(m[i][0] - dy / ln * k, m[i][1] + dx / ln * k))
    return out


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def dist_m(a, b):
    pa, pb = merc(*a), merc(*b)
    return math.hypot(pa[0] - pb[0], pa[1] - pb[1]) * math.cos(math.radians((a[0] + b[0]) / 2))


def wind(pts, step_m, amp_m, rng):
    """Densify a route every step_m and let it wind by up to amp_m (smooth, deterministic)."""
    out = [pts[0]]
    phase = rng.random() * 6.28
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        d = dist_m(a, b)
        n = max(1, int(d / step_m))
        ma, mb = merc(*a), merc(*b)
        dx, dy = mb[0] - ma[0], mb[1] - ma[1]
        ln = math.hypot(dx, dy) or 1
        for k in range(1, n + 1):
            t = k / n
            x, y = ma[0] + dx * t, ma[1] + dy * t
            if k < n:
                w = amp_m * math.sin(t * math.pi) * (0.6 * math.sin(phase + k * 0.9) + 0.4 * math.sin(phase * 1.7 + k * 2.3))
                w /= math.cos(math.radians(a[0]))
                x += -dy / ln * w
                y += dx / ln * w
            out.append(unmerc(x, y))
        phase += 1.3
    return out


def oval(c, rx_m, ry_m, rot_deg, n, rng, rough=0.08):
    cx, cy = merc(*c)
    k = 1 / math.cos(math.radians(c[0]))
    ro = math.radians(rot_deg)
    out = []
    for i in range(n):
        a = 2 * math.pi * i / n
        r = 1 + rough * (rng.random() - 0.5) * 2
        x, y = math.cos(a) * rx_m * r, math.sin(a) * ry_m * r
        x, y = x * math.cos(ro) - y * math.sin(ro), x * math.sin(ro) + y * math.cos(ro)
        out.append(unmerc(cx + x * k, cy + y * k))
    return out


def rect(c, w_m, h_m, rot_deg=0):
    cx, cy = merc(*c)
    k = 1 / math.cos(math.radians(c[0]))
    ro = math.radians(rot_deg)
    out = []
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        x, y = sx * w_m / 2, sy * h_m / 2
        x, y = x * math.cos(ro) - y * math.sin(ro), x * math.sin(ro) + y * math.cos(ro)
        out.append(unmerc(cx + x * k, cy + y * k))
    return out


# ---------------------------------------------------------------- places
CITIES = [  # en, ka, lat, lon, place, population
    ('Tbilisi', 'თბილისი', 41.7151, 44.8271, 'city', 1202731),
    ('Batumi', 'ბათუმი', 41.6168, 41.6367, 'city', 169095),
    ('Kutaisi', 'ქუთაისი', 42.2679, 42.6946, 'city', 130361),
    ('Rustavi', 'რუსთავი', 41.5495, 44.9931, 'city', 125103),
    ('Zugdidi', 'ზუგდიდი', 42.5088, 41.8709, 'town', 42998),
    ('Gori', 'გორი', 41.9816, 44.1124, 'town', 48143),
    ('Poti', 'ფოთი', 42.1462, 41.6719, 'town', 41465),
    ('Samtredia', 'სამტრედია', 42.1537, 42.3350, 'town', 25318),
    ('Khashuri', 'ხაშური', 41.9945, 43.5992, 'town', 26135),
    ('Senaki', 'სენაკი', 42.2710, 42.0675, 'town', 21596),
    ('Zestaponi', 'ზესტაფონი', 42.1100, 43.0510, 'town', 20814),
    ('Marneuli', 'მარნეული', 41.4760, 44.8080, 'town', 20211),
    ('Telavi', 'თელავი', 41.9198, 45.4731, 'town', 19629),
    ('Akhaltsikhe', 'ახალციხე', 41.6390, 42.9820, 'town', 17903),
    ('Kobuleti', 'ქობულეთი', 41.8214, 41.7792, 'town', 16546),
    ('Ozurgeti', 'ოზურგეთი', 41.9244, 42.0050, 'town', 14785),
    ('Kaspi', 'კასპი', 41.9250, 44.4250, 'town', 13423),
    ('Chiatura', 'ჭიათურა', 42.2900, 43.2840, 'town', 12803),
    ('Gardabani', 'გარდაბანი', 41.4600, 45.0900, 'town', 11550),
    ('Tskaltubo', 'წყალტუბო', 42.3290, 42.6000, 'town', 11281),
    ('Sagarejo', 'საგარეჯო', 41.7340, 45.3300, 'town', 10871),
    ('Borjomi', 'ბორჯომი', 41.8390, 43.3790, 'town', 10546),
    ('Akhalkalaki', 'ახალქალაქი', 41.4050, 43.4860, 'town', 8295),
    ('Gurjaani', 'გურჯაანი', 41.7440, 45.8000, 'town', 8024),
    ('Mtskheta', 'მცხეთა', 41.8460, 44.7210, 'town', 7940),
    ('Lanchkhuti', 'ლანჩხუთი', 42.0900, 42.0300, 'town', 6395),
    ('Dusheti', 'დუშეთი', 42.0850, 44.6950, 'town', 6167),
    ('Lagodekhi', 'ლაგოდეხი', 41.8270, 46.2770, 'town', 5918),
    ('Mestia', 'მესტია', 43.0450, 42.7300, 'town', 1973),
    ('Ambrolauri', 'ამბროლაური', 42.5200, 43.1500, 'town', 2047),
    ('Sighnaghi', 'სიღნაღი', 41.6200, 45.9220, 'town', 1485),
    ('Stepantsminda', 'სტეფანწმინდა', 42.6570, 44.6430, 'village', 1326),
    ('Gudauri', 'გუდაური', 42.4780, 44.4780, 'village', 200),
    ('Bakuriani', 'ბაკურიანი', 41.7500, 43.5300, 'village', 2000),
    ('Ananuri', 'ანანური', 42.1640, 44.7030, 'village', 300),
    ('Pasanauri', 'ფასანაური', 42.3500, 44.6880, 'village', 900),
    ('Zhinvali', 'ჟინვალი', 42.1300, 44.7700, 'village', 1500),
    ('Sadakhlo', 'სადახლო', 41.2440, 44.8130, 'village', 8000),
]
C = {c[0]: (c[2], c[3]) for c in CITIES}

TBILISI_SUBURBS = [
    ('Vake', 'ვაკე', 41.7080, 44.7650), ('Saburtalo', 'საბურთალო', 41.7250, 44.7500), ('Mtatsminda', 'მთაწმინდა', 41.6965, 44.7905),
    ('Sololaki', 'სოლოლაკი', 41.6905, 44.7990), ('Old Tbilisi', 'ძველი თბილისი', 41.6890, 44.8075), ('Avlabari', 'ავლაბარი', 41.6935, 44.8175),
    ('Chugureti', 'ჩუღურეთი', 41.7110, 44.8090), ('Didube', 'დიდუბე', 41.7420, 44.7965), ('Nadzaladevi', 'ნაძალადევი', 41.7350, 44.8120),
    ('Isani', 'ისანი', 41.6870, 44.8360), ('Samgori', 'სამგორი', 41.6700, 44.8650), ('Varketili', 'ვარკეთილი', 41.6610, 44.8850),
    ('Gldani', 'გლდანი', 41.7900, 44.8200), ('Dighomi', 'დიღომი', 41.7500, 44.7520), ('Vera', 'ვერა', 41.7010, 44.7885),
    ('Ortachala', 'ორთაჭალა', 41.6770, 44.8110), ('Krtsanisi', 'კრწანისი', 41.6520, 44.8250),
]

# ---------------------------------------------------------------- Tbilisi geometry
FREEDOM = (41.6934, 44.8015)
ROSE = (41.7019, 44.7938)
RMETRO = (41.7045, 44.7905)
HEROES = (41.7135, 44.7860)
# the Mtkvari through Tbilisi, upstream (north) first
MTKVARI_TB = [(41.7790, 44.7700), (41.7680, 44.7745), (41.7570, 44.7790), (41.7470, 44.7815), (41.7380, 44.7838),
              (41.7300, 44.7870), (41.7225, 44.7905), (41.7160, 44.7932), (41.7095, 44.7965), (41.7040, 44.8005),
              (41.6995, 44.8045), (41.6965, 44.8070), (41.6942, 44.8085), (41.6920, 44.8098), (41.6898, 44.8112),
              (41.6870, 44.8135), (41.6830, 44.8170), (41.6785, 44.8210), (41.6730, 44.8262), (41.6660, 44.8330),
              (41.6580, 44.8420), (41.6480, 44.8540)]

STREET_NAMES = [  # genitive stem (Georgian), English
    ('ილია ჭავჭავაძის', 'Ilia Chavchavadze'), ('აკაკი წერეთლის', 'Akaki Tsereteli'), ('ვასილ ბარნოვის', 'Vasil Barnovi'),
    ('ზაქარია ფალიაშვილის', 'Zakaria Paliashvili'), ('ირაკლი აბაშიძის', 'Irakli Abashidze'), ('მიხეილ ყიფშიძის', 'Mikheil Kipshidze'),
    ('ფანასკერტელის', 'Panaskerteli'), ('ივანე ჯავახიშვილის', 'Ivane Javakhishvili'), ('მიხეილ ლერმონტოვის', 'Mikheil Lermontov'),
    ('გიორგი ერისთავის', 'Giorgi Eristavi'), ('კოტე მარჯანიშვილის', 'Kote Marjanishvili'), ('გიორგი მაზნიაშვილის', 'Giorgi Mazniashvili'),
    ('გრიგოლ ორბელიანის', 'Grigol Orbeliani'), ('ბარბარე ჯორჯაძის', 'Barbare Jorjadze'), ('ბახტრიონის', 'Bakhtrioni'),
    ('სოლომონ ციციშვილის', 'Solomon Tsitsishvili'), ('ალექსი ყაზბეგის', 'Aleksi Kazbegi'), ('ნიკო ნიკოლაძის', 'Niko Nikoladze'),
    ('დავით გამრეკელის', 'Davit Gamrekeli'), ('ლადო ასათიანის', 'Lado Asatiani'), ('გიორგი ჭანტურიას', 'Giorgi Chanturia'),
    ('ივანე მაჩაბლის', 'Ivane Machabeli'), ('პავლე ინგოროყვას', 'Pavle Ingorokva'), ('სულხან-საბა ორბელიანის', 'Sulkhan-Saba Orbeliani'),
    ('ლეო ტოლსტოის', 'Leo Tolstoy'), ('ეგნატე ნინოშვილის', 'Egnate Ninoshvili'), ('სიმონ ჩიქოვანის', 'Simon Chikovani'),
    ('ირაკლი მოსაშვილის', 'Irakli Mosashvili'), ('ვახტანგ გაბაშვილის', 'Vakhtang Gabashvili'), ('ვაშლოვანის', 'Vashlovani'),
    ('ლეო ქიაჩელის', 'Leo Kiacheli'), ('სანდრო ეულის', 'Sandro Euli'), ('ილიკო ბოჭორიშვილის', 'Iliko Bochorishvili'),
    ('ელენე ახვლედიანის', 'Elene Akhvlediani'), ('ციხისძირის', 'Tsikhisdziri'), ('პეტრე ბაგრატიონის', 'Petre Bagrationi'),
    ('მარშალ გელოვანის', 'Marshal Gelovani'), ('დიდგორის', 'Didgori'), ('სიმონ ჯანაშიას', 'Simon Janashia'),
    ('უნივერსიტეტის', 'University'), ('გიორგი ჯიქიას', 'Giorgi Jikia'), ('ვახტანგ ბახტაძის', 'Vakhtang Bakhtadze'),
    ('მეტეხის', 'Metekhi'), ('ერეკლე მეორის', 'Erekle II'), ('ლადო გუდიაშვილის', 'Lado Gudiashvili'),
    ('ქობულეთის', 'Kobuleti'), ('კორნელი კეკელიძის', 'Korneli Kekelidze'), ('ნიკო ფიროსმანის', 'Niko Pirosmani'),
    ('დავით სარაჯიშვილის', 'Davit Sarajishvili'), ('გიორგი ჩუბინაშვილის', 'Giorgi Chubinashvili'), ('ვახტანგ ჯაბაურის', 'Vakhtang Jabauri'),
    ('ნიკო ხიზანიშვილის', 'Niko Khizanishvili'), ('ნიკო კალანდაძის', 'Niko Kalandadze'), ('თამარაშვილის', 'Tamarashvili'),
    ('ნიკო დადიანის', 'Niko Dadiani'), ('მიხეილ ჯაფარიძის', 'Mikheil Japaridze'), ('თამარ მეფის', 'Queen Tamar'),
    ('ფარნავაზ მეფის', 'King Parnavaz'), ('მირიან მეფის', 'King Mirian'), ('ვახტანგ კოტეტიშვილის', 'Vakhtang Kotetishvili'),
    ('გალაკტიონ ტაბიძის', 'Galaktion Tabidze'), ('ტიციან ტაბიძის', 'Titsian Tabidze'), ('იაკობ გოგებაშვილის', 'Iakob Gogebashvili'),
    ('ნოდარ დუმბაძის', 'Nodar Dumbadze'), ('ექვთიმე თაყაიშვილის', 'Ekvtime Takaishvili'), ('ალექსანდრე ორბელიანის', 'Aleksandre Orbeliani'),
    ('დიმიტრი უზნაძის', 'Dimitri Uznadze'), ('ზურაბ ანჯაფარიძის', 'Zurab Anjaparidze'), ('არჩილ ქურდიანის', 'Archil Kurdiani'),
    ('ვასო გოძიაშვილის', 'Vaso Godziashvili'), ('მერაბ ალექსიძის', 'Merab Aleksidze'), ('ბესარიონ ჟღენტის', 'Besarion Zhgenti'),
    ('ალექსანდრე კაზბეგის', 'Aleksandre Kazbegi'), ('რეზო თაბუკაშვილის', 'Rezo Tabukashvili'), ('დავით კლდიაშვილის', 'Davit Kldiashvili'),
    ('ნიკოლოზ მუსხელიშვილის', 'Nikoloz Muskhelishvili'), ('ჯონდი ბაგრატიონის', 'Jondi Bagrationi'), ('ბელიაშვილის', 'Beliashvili'),
    ('ანა პოლიტკოვსკაიას', 'Anna Politkovskaya'), ('ვაჟა ფშაველას', 'Vazha Pshavela'), ('ლადო კავსაძის', 'Lado Kavsadze'),
    ('მაკაშვილის', 'Makashvili'), ('ნიკო ბერძენიშვილის', 'Niko Berdzenishvili'), ('გრიგოლ რობაქიძის', 'Grigol Robakidze'),
]
KINDS = [('ქუჩა', 'St'), ('ქუჩა', 'St'), ('ქუჩა', 'St'), ('შესახვევი', 'Lane'), ('ქუჩა', 'St'), ('ჩიხი', 'Blind Alley')]


class Gen:
    def __init__(self, Dataset):
        self.ds = Dataset()
        self.ways = []          # [coords [(lat, lon)], tags]
        self.pois = []          # (lat, lon, tags)
        self.rng = random.Random(1991)
        self.names_used = 0
        self.forbid = []        # rings (lat, lon) the generated streets keep out of (parks, lakes)
        self.rivers = []        # polylines generated streets keep away from

    # -- primitives
    def way(self, pts, tags):
        self.ways.append([list(pts), dict(tags)])
        return self.ways[-1]

    def road(self, pts, hw, ka=None, en=None, maxspeed=None, ref=None, int_ref=None, **extra):
        t = {'highway': hw}
        if ka:
            t['name'] = ka
            t['name:ka'] = ka
        if en:
            t['name:en'] = en
        if maxspeed:
            t['maxspeed'] = str(maxspeed)
        if ref:
            t['ref'] = ref
        if int_ref:
            t['int_ref'] = int_ref
        t.update({k.replace('_', ':') if k.startswith('name_') else k: v for k, v in extra.items()})
        return self.way(pts, t)

    def area(self, ring, ka=None, en=None, **tags):
        t = dict(tags)
        if ka:
            t['name'] = ka
            t['name:ka'] = ka
        if en:
            t['name:en'] = en
        return self.way(list(ring) + [ring[0]], t)

    def poi(self, lat, lon, ka, en, **tags):
        t = dict(tags)
        if ka:
            t['name'] = ka
            t['name:ka'] = ka
        if en:
            t['name:en'] = en
        self.pois.append((lat, lon, t))

    def street_name(self, kind_i=None):
        stem, en = STREET_NAMES[self.names_used % len(STREET_NAMES)]
        self.names_used += 1
        k = KINDS[(self.names_used if kind_i is None else kind_i) % len(KINDS)]
        return stem + ' ' + k[0], en + ' ' + k[1]

    # -- the country
    def country(self):
        rng = self.rng
        # the Black Sea off the coast (south to north), closed out to the west
        coast = [(41.5225, 41.5480), (41.5650, 41.5700), (41.6060, 41.6000), (41.6500, 41.6300), (41.6800, 41.6950),
                 (41.6980, 41.7150), (41.7660, 41.7470), (41.8200, 41.7680), (41.9300, 41.7700), (41.9950, 41.7550),
                 (42.0450, 41.7130), (42.1000, 41.6650), (42.1500, 41.6500), (42.2500, 41.6100), (42.3900, 41.5600),
                 (42.5000, 41.5300), (42.7100, 41.4600), (42.8600, 41.2500), (43.0000, 41.0100), (43.0900, 40.8100),
                 (43.1000, 40.6200), (43.1600, 40.3400), (43.2800, 40.2700), (43.3850, 40.0050)]
        sea = coast + [(43.45, 39.85), (41.40, 39.85), (41.42, 41.40)]
        self.area(sea, 'შავი ზღვა', 'Black Sea', natural='water', water='sea')
        self.forbid.append(sea)
        self.poi(42.35, 40.60, 'შავი ზღვა', 'Black Sea', place='sea')
        border = [(41.5216, 41.5475), (41.4700, 41.7600), (41.5200, 42.0000), (41.4800, 42.4500), (41.5800, 42.6000), (41.5700, 42.8500),
                  (41.4700, 43.0500), (41.3200, 43.2000), (41.1800, 43.4700), (41.1300, 43.7500), (41.1000, 44.1000), (41.1800, 44.3500),
                  (41.2000, 44.8000), (41.1200, 45.0000), (41.3100, 45.0800), (41.2000, 45.3500), (41.1700, 45.7000), (41.4000, 46.1000),
                  (41.5500, 46.4000), (41.8000, 46.5500), (42.0500, 46.4000), (42.3000, 45.8500), (42.5500, 45.6500), (42.6000, 45.1500),
                  (42.7200, 44.8500), (42.7600, 44.6200), (42.6000, 44.2000), (42.8500, 43.6000), (43.0000, 43.0500), (43.1500, 42.6000),
                  (43.2000, 42.1000), (43.3000, 41.6000), (43.4000, 40.8000), (43.3850, 40.0050)]
        border = border + coast[::-1][1:]
        self.way(border + [border[0]], {'boundary': 'administrative', 'admin_level': '2', 'name': 'საქართველო', 'name:en': 'Georgia'})
        for (ka, en, c, rx, ry, rot) in [
                ('ფარავნის ტბა', 'Paravani Lake', (41.4500, 43.8000), 3600, 2600, 20),
                ('თბილისის ზღვა', 'Tbilisi Sea', (41.7660, 44.8250), 2300, 800, -55),
                ('ჟინვალის წყალსაცავი', 'Zhinvali Reservoir', (42.1500, 44.7650), 1100, 4500, 10),
                ('შაორის წყალსაცავი', 'Shaori Reservoir', (42.3200, 43.0800), 1600, 700, 30),
                ('სიონის წყალსაცავი', 'Sioni Reservoir', (41.9800, 44.9700), 900, 4000, -20),
                ('ჯანდარის ტბა', 'Jandari Lake', (41.4300, 45.1800), 2400, 1400, 0),
                ('ტაბაწყურის ტბა', 'Tabatskuri Lake', (41.6600, 43.6000), 2400, 1400, 15),
                ('ლისის ტბა', 'Lisi Lake', (41.7435, 44.7380), 330, 220, 10),
                ('კუს ტბა', 'Turtle Lake', (41.6930, 44.7590), 160, 80, 30)]:
            ring = oval(c, rx, ry, rot, 28, rng)
            self.area(ring, ka, en, natural='water')
            self.forbid.append(ring)
        rivers = [
            ('მტკვარი', 'Mtkvari', [(41.3700, 43.0800), (41.5700, 43.2500), (41.7400, 43.1700), (41.8400, 43.3900), (41.9700, 43.6000),
                                    (41.9900, 43.9000), (41.9750, 44.1100), (41.9200, 44.4200), (41.8700, 44.6200), (41.8440, 44.7150),
                                    (41.8000, 44.7480)] + MTKVARI_TB + [(41.6200, 44.9000), (41.5500, 45.0050), (41.4500, 45.1500), (41.3200, 45.3000)]),
            ('რიონი', 'Rioni', [(42.5800, 43.4000), (42.5200, 43.1500), (42.3600, 42.8500), (42.2750, 42.7050), (42.2200, 42.5500),
                                (42.1700, 42.3500), (42.1800, 42.0000), (42.1600, 41.6600)]),
            ('არაგვი', 'Aragvi', [(42.5000, 44.5500), (42.3500, 44.6950), (42.2200, 44.7300), (42.1100, 44.7600), (41.9500, 44.7400), (41.8440, 44.7180)]),
            ('ალაზანი', 'Alazani', [(42.2500, 45.3000), (41.9500, 45.5500), (41.7000, 46.0000), (41.4500, 46.4000)]),
            ('ენგური', 'Enguri', [(43.0600, 42.7500), (42.9000, 42.4000), (42.7500, 42.1000), (42.5500, 41.8200), (42.4000, 41.5800)]),
            ('თერგი', 'Tergi', [(42.5800, 44.5800), (42.6500, 44.6450), (42.7420, 44.6350), (42.8000, 44.6500)]),
        ]
        for ka, en, pts in rivers:
            p = wind(pts, 1500, 250, rng) if en != 'Mtkvari' else pts[:11] + MTKVARI_TB + pts[11 + len(MTKVARI_TB):]
            self.way(p, {'waterway': 'river', 'name': ka, 'name:ka': ka, 'name:en': en})
            self.rivers.append(p)
        for en, ka, lat, lon, place, pop in CITIES:
            self.poi(lat, lon, ka, en, place=place, population=str(pop))
        for en, ka, lat, lon in TBILISI_SUBURBS:
            self.poi(lat, lon, ka, en, place='suburb')

    def highways(self):
        rng = self.rng
        H = []

        def hw(cls, pts, ref, iref, ka, en, ms, mountain=False, step=1200):
            amp = 380 if mountain else 120
            p = wind(pts, step, amp, rng)
            # one line for both directions (OSM draws a motorway's carriageways apart; one is enough here)
            self.road(p, cls, ka, en, ms, ref, iref, **({'oneway': 'no'} if cls == 'motorway' else {}))
            H.append(p)
            return p

        TN = (41.7560, 44.7860)
        hw('motorway', [TN, (41.7800, 44.7780), (41.8100, 44.7600), (41.8320, 44.7420), (41.8500, 44.7050), (41.8650, 44.6400),
                        (41.8900, 44.5300), (41.9250, 44.4250), (41.9600, 44.2600), (41.9900, 44.1200), (42.0000, 43.8500), C['Khashuri']],
           'ს1', 'E60', 'აღმოსავლეთ-დასავლეთის მაგისტრალი', 'East-West Highway', 110, step=2000)
        hw('trunk', [C['Khashuri'], (42.0400, 43.4800), (42.0700, 43.4000), (42.0900, 43.2500), C['Zestaponi']],
           'ს1', 'E60', 'რიკოთის უღელტეხილი', 'Rikoti Pass', 70, mountain=True)
        hw('trunk', [C['Zestaponi'], (42.1600, 42.9000), (42.2000, 42.8000), (42.1900, 42.5500), C['Samtredia']],
           'ს1', 'E60', 'აღმოსავლეთ-დასავლეთის მაგისტრალი', 'East-West Highway', 90)
        hw('trunk', [C['Samtredia'], (42.2200, 42.2000), C['Senaki'], (42.4000, 41.9600), C['Zugdidi'], (42.5500, 41.8000)],
           'ს1', 'E60', 'აღმოსავლეთ-დასავლეთის მაგისტრალი', 'East-West Highway', 90)
        hw('trunk', [C['Senaki'], (42.2000, 41.8500), C['Poti'], (42.0400, 41.7350), (41.9300, 41.7850), C['Kobuleti'],
                     (41.7600, 41.7600), (41.6900, 41.7100), C['Batumi'], (41.5700, 41.5800), (41.5230, 41.5520)],
           'ს2', 'E70', 'შავი ზღვის სანაპირო გზა', 'Black Sea Coastal Road', 80)
        hw('trunk', [C['Samtredia'], C['Lanchkhuti'], (42.0400, 41.7500)], 'ს12', 'E70', 'სამტრედია – გრიგოლეთი', 'Samtredia–Grigoleti', 90)
        hw('primary', [(41.8320, 44.7420), (41.9500, 44.7700), C['Zhinvali'], (42.1450, 44.7400), C['Ananuri'], C['Pasanauri'],
                       (42.4300, 44.6000), C['Gudauri'], (42.5200, 44.4700), (42.5600, 44.5200), C['Stepantsminda'], (42.7420, 44.6300)],
           'ს3', 'E117', 'საქართველოს სამხედრო გზა', 'Georgian Military Road', 60, mountain=True)
        return H

    # -- Tbilisi
    def tbilisi(self):
        rng = self.rng
        M = MTKVARI_TB
        Lb = offset(M, 95)      # left (east) bank
        Rb = offset(M, -95)     # right (west) bank
        water = offset(M, 48) + offset(M, -48)[::-1]
        self.area(water, 'მტკვარი', 'Mtkvari', natural='water', water='river')
        self.forbid.append(water)
        R = self.road
        # squares as roundabouts: their ring, and the roads reach it at its nearest point
        self.rings = []

        def roundabout(c, r_m, ka, en):
            ring = oval(c, r_m, r_m, 0, 20, rng, 0)
            self.way(ring + [ring[0]], {'highway': 'primary', 'junction': 'roundabout', 'name': ka, 'name:ka': ka, 'name:en': en, 'maxspeed': '40'})
            self.rings.append((c, ring))
        roundabout(FREEDOM, 55, 'თავისუფლების მოედანი', 'Freedom Square')
        roundabout(HEROES, 85, 'გმირთა მოედანი', "Heroes' Square")
        R([FREEDOM, (41.6955, 44.7996), (41.6978, 44.7975), (41.6999, 44.7958), ROSE], 'primary', 'შოთა რუსთაველის გამზირი', 'Shota Rustaveli Ave', 50)
        R([ROSE, RMETRO, (41.7085, 44.7880), HEROES], 'primary', 'მერაბ კოსტავას ქუჩა', 'Merab Kostava St', 60)
        R([RMETRO, (41.7060, 44.7840), (41.7075, 44.7770), (41.7085, 44.7690), (41.7092, 44.7610), (41.7095, 44.7540)], 'primary',
          'ილია ჭავჭავაძის გამზირი', 'Ilia Chavchavadze Ave', 60)
        R([HEROES, (41.7185, 44.7790), (41.7235, 44.7720), (41.7290, 44.7650), (41.7335, 44.7590), (41.7380, 44.7530)], 'primary',
          'ალექსანდრე ყაზბეგის გამზირი', 'Aleksandre Kazbegi Ave', 60)
        R([(41.7085, 44.7690), (41.7150, 44.7640), (41.7210, 44.7570), (41.7265, 44.7490), (41.7320, 44.7400), (41.7365, 44.7320), (41.7420, 44.7230)],
          'primary', 'ვაჟა-ფშაველას გამზირი', 'Vazha-Pshavela Ave', 60)
        R([(41.7210, 44.7570), (41.7225, 44.7650), (41.7235, 44.7720), (41.7243, 44.7800), Rb[6]], 'secondary', 'პეკინის გამზირი', 'Pekini Ave', 60)
        R([(41.7265, 44.7490), (41.7240, 44.7400), (41.7215, 44.7310), (41.7190, 44.7230)], 'secondary', 'შალვა ნუცუბიძის ქუჩა', 'Shalva Nutsubidze St', 50)
        R([HEROES, (41.7150, 44.7900), Rb[7]], 'primary', 'გმირთა მოედნის ესტაკადა', "Heroes' Square Flyover", 60, bridge='yes', layer='1')
        R([FREEDOM, (41.6940, 44.8040), Rb[12]], 'secondary', 'ნიკოლოზ ბარათაშვილის ქუჩა', 'Nikoloz Baratashvili St', 50)
        R([FREEDOM, (41.6915, 44.8040), (41.6900, 44.8070), Rb[14]], 'tertiary', 'კოტე აფხაზის ქუჩა', 'Kote Afkhazi St', 40)
        R([FREEDOM, (41.6955, 44.8030), (41.6975, 44.8040), Rb[10]], 'tertiary', 'ალექსანდრე პუშკინის ქუჩა', 'Aleksandre Pushkin St', 40)
        R(Rb[3:13], 'primary', 'ზვიად გამსახურდიას სანაპირო', 'Zviad Gamsakhurdia Embankment', 70)
        R(Rb[12:20], 'secondary', 'ვახტანგ გორგასლის ქუჩა', 'Vakhtang Gorgasali St', 60)
        R(Lb[2:11], 'secondary', 'მარცხენა სანაპირო', 'Left Embankment', 70)
        R([Lb[10], (41.6985, 44.8100), (41.7035, 44.8068), (41.7090, 44.8040), (41.7150, 44.8012), (41.7215, 44.7985)], 'secondary',
          'დავით აღმაშენებლის გამზირი', 'Davit Aghmashenebeli Ave', 50)
        TN = (41.7560, 44.7860)
        R([(41.7215, 44.7985), (41.7290, 44.7955), (41.7370, 44.7925), (41.7450, 44.7895), TN], 'primary', 'გიორგი წერეთლის გამზირი', 'Giorgi Tsereteli Ave', 60)
        KT = (41.6830, 44.8380)
        R([Lb[14], (41.6935, 44.8150), (41.6905, 44.8225), (41.6870, 44.8300), KT], 'primary', 'ქეთევან წამებულის გამზირი', 'Ketevan Tsamebuli Ave', 60)
        R(wind([KT, (41.6880, 44.8700), (41.7000, 44.9200), (41.7200, 45.0800), C['Sagarejo'], (41.7500, 45.6000), C['Gurjaani'],
                (41.8000, 46.0000), C['Lagodekhi'], (41.8400, 46.3000)], 1500, 150, rng), 'primary', 'კახეთის გზატკეცილი', 'Kakheti Highway', 80, 'ს5', 'E117')
        AP = (41.6692, 44.9547)
        R([KT, (41.6760, 44.8700), (41.6720, 44.9100), AP], 'trunk', 'აეროპორტის გზატკეცილი', 'Airport Highway', 80)
        # bridges: right bank <-> left bank, then on into the streets of each side
        bridges = [(4, 'დიდუბის ხიდი', 'Didube Bridge', (41.7385, 44.7700), (41.7370, 44.7925)),
                   (6, 'ბაგრატიონის ხიდი', 'Bagrationi Bridge', None, (41.7230, 44.7985)),
                   (8, 'საარბრიუკენის ხიდი', 'Saarbrücken Bridge', (41.7110, 44.7880), (41.7090, 44.8040)),
                   (9, 'გალაკტიონ ტაბიძის ხიდი', 'Galaktion Tabidze Bridge', (41.7030, 44.7975), (41.7035, 44.8068)),
                   (10, 'მშრალი ხიდი', 'Dry Bridge', None, (41.6985, 44.8100)),
                   (12, 'ბარათაშვილის ხიდი', 'Baratashvili Bridge', None, (41.6935, 44.8150)),
                   (14, 'მეტეხის ხიდი', 'Metekhi Bridge', None, None),
                   (18, 'ორთაჭალის ხიდი', 'Ortachala Bridge', None, None)]
        for i, ka, en, west, east in bridges:
            R([Rb[i], Lb[i]], 'secondary', ka, en, 50, bridge='yes', layer='1')
            if west:
                R([west, Rb[i]], 'tertiary', None, None, 50)
            if east:
                R([Lb[i], east], 'tertiary', None, None, 50)
        R([Rb[13], Lb[13]], 'pedestrian', 'მშვიდობის ხიდი', 'Bridge of Peace', bridge='yes', layer='1')
        # out of town: Rustavi (S4) over the Ortachala bridge, Marneuli (S7) on the right bank
        R(wind([Lb[18], (41.6400, 44.8800), (41.6000, 44.9400), C['Rustavi'], (41.4500, 45.0300), (41.3220, 45.0750)], 1200, 120, rng),
          'trunk', 'რუსთავის გზატკეცილი', 'Rustavi Highway', 90, 'ს4', 'E60')
        R(wind([Rb[19], (41.6400, 44.8250), (41.5800, 44.8300), (41.5200, 44.8350), C['Marneuli'], (41.3500, 44.8100), C['Sadakhlo'], (41.2150, 44.8200)], 1200, 140, rng),
          'primary', 'მარნეულის გზატკეცილი', 'Marneuli Highway', 80, 'ს7', 'E117')
        self.tb = {'Lb': Lb, 'Rb': Rb}
        # parks
        for ka, en, c, w, h, rot, kind in [
                ('ვაკის პარკი', 'Vake Park', (41.7080, 44.7480), 620, 480, 10, 'park'),
                ('მთაწმინდის პარკი', 'Mtatsminda Park', (41.6935, 44.7855), 900, 520, 30, 'forest'),
                ('თბილისის ბოტანიკური ბაღი', 'Tbilisi Botanical Garden', (41.6860, 44.8020), 950, 480, -20, 'park'),
                ('რიყის პარკი', 'Rike Park', (41.6930, 44.8128), 260, 150, 30, 'park'),
                ('მზიური', 'Mziuri Park', (41.7155, 44.7660), 420, 220, 40, 'park'),
                ('დედაენის ბაღი', 'Dedaena Park', (41.7062, 44.8035), 240, 140, 30, 'park'),
                ('თბილისის ტყე-პარკი', 'Tbilisi Forest Park', (41.6920, 44.7560), 1500, 900, 0, 'forest'),
                ('კრწანისის ტყე-პარკი', 'Krtsanisi Forest Park', (41.6450, 44.8100), 2200, 1500, 20, 'forest'),
                ('თბილისის ეროვნული პარკი', 'Tbilisi National Park', (41.8700, 44.8600), 12000, 8000, 10, 'forest'),
                ('ლისის ტბის პარკი', 'Lisi Lake Park', (41.7435, 44.7380), 650, 480, 10, 'park'),
                ('ნარიყალა', 'Narikala', (41.6878, 44.8085), 260, 120, 20, 'park')]:
            ring = rect(c, w, h, rot) if kind == 'park' else oval(c, w / 2, h / 2, rot, 24, rng, 0.12)
            if kind == 'park':
                self.area(ring, ka, en, leisure='park')
            else:
                self.area(ring, ka, en, landuse='forest')
            if en != 'Tbilisi National Park':
                self.forbid.append(ring)

    def grid(self, corners, spacing, seed, oneway=False, cls='residential', ms=40, near_river=110):
        """Streets of a district: a grid between four corners (SW, SE, NE, NW), a little uneven, kept out
        of parks, lakes and rivers, named one after another."""
        rng = random.Random(seed)
        sw, se, ne, nw = corners

        def at(u, v):
            a, b = lerp(sw, se, u), lerp(nw, ne, u)
            return lerp(a, b, v)
        w_m = dist_m(sw, se)
        h_m = dist_m(sw, nw)
        nu, nv = max(2, int(w_m / spacing)), max(2, int(h_m / spacing))
        self.area([sw, se, ne, nw], None, None, landuse='residential')
        lines = []
        for j in range(nv + 1):                         # east-west streets
            v = j / nv + (rng.random() - 0.5) * 0.25 / nv if 0 < j < nv else j / nv
            lines.append([at(i / (nu * 2), v) for i in range(nu * 2 + 1)])
        for i in range(nu + 1):                         # north-south streets
            u = i / nu + (rng.random() - 0.5) * 0.25 / nu if 0 < i < nu else i / nu
            lines.append([at(u, k / (nv * 2)) for k in range(nv * 2 + 1)])
        made = 0
        for n, line in enumerate(lines):
            # an uneven street: each inner point off by a few metres
            pts = [line[0]]
            for p in line[1:-1]:
                mp = merc(*p)
                k = 1 / math.cos(math.radians(p[0]))
                pts.append(unmerc(mp[0] + (rng.random() - 0.5) * 14 * k, mp[1] + (rng.random() - 0.5) * 14 * k))
            pts.append(line[-1])
            # cut where it would run through a park, a lake or a river
            runs, cur = [], []
            for p in pts:
                bad = any(_inside(p, r) for r in self.forbid) or any(_near(p, rv, near_river) for rv in self.rivers)
                if bad:
                    if len(cur) >= 2:
                        runs.append(cur)
                    cur = []
                else:
                    cur.append(p)
            if len(cur) >= 2:
                runs.append(cur)
            if rng.random() < 0.12 and runs and len(runs[0]) > 4:   # a street that stops short
                runs[0] = runs[0][:len(runs[0]) // 2 + 1]
            ka, en = self.street_name()
            hw = 'tertiary' if n % 4 == 0 and cls == 'residential' else cls
            for r in runs:
                t = {}
                if oneway and hw == 'residential':
                    t['oneway'] = 'yes'
                    if n % 2:
                        r = r[::-1]
                self.road(r, hw, ka, en, 50 if hw == 'tertiary' else ms, **t)
                made += 1
        return made

    def districts(self):
        G = self.grid
        n = 0
        n += G([(41.6995, 44.7440), (41.7030, 44.7835), (41.7135, 44.7790), (41.7110, 44.7440)], 170, 1)          # Vake
        n += G([(41.7160, 44.7340), (41.7180, 44.7760), (41.7330, 44.7660), (41.7310, 44.7290)], 190, 2)          # Saburtalo
        n += G([(41.6975, 44.7880), (41.6995, 44.7960), (41.7030, 44.7920), (41.7015, 44.7865)], 110, 3)          # Vera
        n += G([(41.6880, 44.7950), (41.6880, 44.8040), (41.6926, 44.8032), (41.6930, 44.7948)], 105, 4, oneway=True, ms=30)   # Sololaki
        n += G([(41.6990, 44.8080), (41.6985, 44.8250), (41.7205, 44.8150), (41.7205, 44.8005)], 160, 5)          # Chugureti
        n += G([(41.7240, 44.7995), (41.7240, 44.8200), (41.7550, 44.8050), (41.7550, 44.7905)], 180, 6)          # Didube / Nadzaladevi
        n += G([(41.6800, 44.8225), (41.6790, 44.8500), (41.6960, 44.8420), (41.6962, 44.8165)], 150, 7)          # Avlabari / Isani
        n += G([(41.6560, 44.8550), (41.6560, 44.8950), (41.6780, 44.8950), (41.6780, 44.8550)], 200, 8)          # Samgori / Varketili
        n += G([(41.7750, 44.8050), (41.7750, 44.8400), (41.8050, 44.8350), (41.8050, 44.8050)], 210, 9)          # Gldani
        n += G([(41.7350, 44.7380), (41.7380, 44.7700), (41.7650, 44.7650), (41.7620, 44.7350)], 200, 10)         # Dighomi
        n += G([(41.6700, 44.8050), (41.6720, 44.8180), (41.6850, 44.8100), (41.6840, 44.8000)], 140, 11)         # Ortachala
        # other cities: a centre around the main road
        for name, w, h, sp, seed in [('Batumi', 3200, 2400, 190, 21), ('Kutaisi', 2800, 2600, 200, 22), ('Rustavi', 3000, 2200, 210, 23),
                                     ('Gori', 2200, 1600, 190, 24), ('Zugdidi', 2200, 2000, 200, 25), ('Telavi', 1800, 1400, 180, 26),
                                     ('Poti', 2000, 1600, 200, 27)]:
            c = C[name]
            if name == 'Batumi':
                c = (41.6300, 41.6450)
            if name == 'Poti':
                c = (42.1462, 41.6850)
            r = rect(c, w, h, 0)
            n += G([r[0], r[1], r[2], r[3]], sp, seed, near_river=70)
        return n

    def connectors(self):
        """Short roads that tie the town grids and the airport to the highways."""
        R = self.road
        R([C['Kutaisi'], (42.2400, 42.7300), (42.2000, 42.8000)], 'secondary', 'ქუთაისი – ზესტაფონი', 'Kutaisi–Zestaponi Road', 70)
        R(wind([C['Kutaisi'], C['Tskaltubo']], 1000, 80, self.rng), 'secondary', 'წყალტუბოს გზა', 'Tskaltubo Road', 60)
        R(wind([C['Kutaisi'], (42.3600, 42.8500), C['Ambrolauri']], 1000, 300, self.rng), 'secondary', 'ქუთაისი – ამბროლაური', 'Kutaisi–Ambrolauri Road', 60)
        R([(42.1900, 42.5500), (42.1764, 42.4826)], 'secondary', 'აეროპორტის გზა', 'Airport Road', 60)
        R(wind([C['Zugdidi'], (42.7200, 42.0500), (42.8800, 42.4000), C['Mestia']], 1000, 400, self.rng), 'secondary', 'ზუგდიდი – მესტია', 'Zugdidi–Mestia Road', 60)
        R(wind([C['Khashuri'], (41.9200, 43.4500), C['Borjomi'], (41.7500, 43.2000), C['Akhaltsikhe'], (41.6200, 42.8600)], 1000, 300, self.rng),
          'primary', 'ბორჯომის გზა', 'Borjomi Road', 70, 'ს8', 'E691')
        R(wind([C['Borjomi'], (41.8000, 43.4600), C['Bakuriani']], 1000, 250, self.rng), 'secondary', 'ბაკურიანის გზა', 'Bakuriani Road', 60)
        R(wind([C['Akhaltsikhe'], (41.5200, 43.2000), C['Akhalkalaki']], 1000, 300, self.rng), 'secondary', 'ახალციხე – ახალქალაქი', 'Akhaltsikhe–Akhalkalaki Road', 60)
        R(wind([(41.7000, 44.9200), (41.8500, 45.2200), C['Telavi']], 1000, 350, self.rng), 'secondary', 'გომბორის გზა', 'Gombori Road', 60)
        R(wind([C['Telavi'], (41.8300, 45.6500), C['Gurjaani']], 1000, 200, self.rng), 'secondary', 'თელავი – გურჯაანი', 'Telavi–Gurjaani Road', 70)
        R(wind([(41.7500, 45.8800), C['Sighnaghi']], 800, 200, self.rng), 'secondary', 'სიღნაღის გზა', 'Sighnaghi Road', 60)
        R([C['Ozurgeti'], (41.9900, 41.9000), (42.0400, 41.7500)], 'secondary', 'ოზურგეთის გზა', 'Ozurgeti Road', 70)
        R(wind([C['Zestaponi'], C['Chiatura']], 900, 250, self.rng), 'secondary', 'ჭიათურის გზა', 'Chiatura Road', 60)
        R([C['Mtskheta'], (41.8500, 44.7050)], 'tertiary', None, None, 50)
        R([C['Kaspi'], (41.9250, 44.4250)], 'tertiary', None, None, 50)
        R([C['Gardabani'], (41.5000, 45.0200)], 'secondary', 'გარდაბნის გზა', 'Gardabani Road', 70)
        R([C['Dusheti'], (42.0300, 44.7600)], 'secondary', 'დუშეთის გზა', 'Dusheti Road', 60)

    def add_pois(self):
        P = self.poi
        # Tbilisi landmarks
        for lat, lon, ka, en, k, v in [
                (41.6878, 44.8085, 'ნარიყალა', 'Narikala Fortress', 'historic', 'castle'),
                (41.6975, 44.8170, 'სამების საკათედრო ტაძარი', 'Holy Trinity Cathedral', 'amenity', 'place_of_worship'),
                (41.6929, 44.8100, 'მშვიდობის ხიდი', 'Bridge of Peace', 'tourism', 'attraction'),
                (41.6966, 44.7986, 'საქართველოს პარლამენტი', 'Parliament of Georgia', 'tourism', 'attraction'),
                (41.6998, 44.7963, 'თბილისის ოპერისა და ბალეტის თეატრი', 'Tbilisi Opera and Ballet Theatre', 'tourism', 'attraction'),
                (41.6939, 44.8010, 'თავისუფლების მონუმენტი', 'Freedom Monument', 'historic', 'monument'),
                (41.6955, 44.8000, 'საქართველოს ეროვნული მუზეუმი', 'Georgian National Museum', 'tourism', 'museum'),
                (41.6886, 44.8020, 'ქართლის დედა', 'Mother of Georgia', 'historic', 'monument'),
                (41.6906, 44.8121, 'მეტეხის ტაძარი', 'Metekhi Church', 'amenity', 'place_of_worship'),
                (41.6915, 44.8073, 'სიონის ტაძარი', 'Sioni Cathedral', 'amenity', 'place_of_worship'),
                (41.6880, 44.8105, 'აბანოთუბანი', 'Abanotubani Sulphur Baths', 'tourism', 'attraction'),
                (41.6993, 44.8062, 'მშრალი ხიდის ბაზრობა', 'Dry Bridge Market', 'tourism', 'attraction'),
                (41.7720, 44.8180, 'საქართველოს მატიანე', 'Chronicle of Georgia', 'historic', 'monument'),
                (41.6945, 44.7845, 'თბილისის ტელეანძა', 'Tbilisi TV Tower', 'tourism', 'attraction'),
                (41.7245, 44.7960, 'დინამო არენა', 'Dinamo Arena', 'tourism', 'attraction'),
                (41.7095, 44.7830, 'თბილისის ზოოპარკი', 'Tbilisi Zoo', 'tourism', 'attraction'),
                (41.8384, 44.7337, 'ჯვრის მონასტერი', 'Jvari Monastery', 'amenity', 'place_of_worship'),
                (41.8421, 44.7208, 'სვეტიცხოვლის საკათედრო ტაძარი', 'Svetitskhoveli Cathedral', 'amenity', 'place_of_worship'),
                (42.6625, 44.6200, 'გერგეტის სამება', 'Gergeti Trinity Church', 'amenity', 'place_of_worship'),
                (42.1636, 44.7031, 'ანანურის ციხე', 'Ananuri Fortress', 'historic', 'castle'),
                (41.9672, 44.2072, 'უფლისციხე', 'Uplistsikhe Cave Town', 'historic', 'archaeological_site'),
                (41.3814, 43.2847, 'ვარძია', 'Vardzia Cave Monastery', 'historic', 'monastery'),
                (42.2947, 42.7681, 'გელათის მონასტერი', 'Gelati Monastery', 'amenity', 'place_of_worship'),
                (42.2774, 42.7044, 'ბაგრატის ტაძარი', 'Bagrati Cathedral', 'amenity', 'place_of_worship'),
                (42.3765, 42.6006, 'პრომეთეს მღვიმე', 'Prometheus Cave', 'tourism', 'attraction'),
                (42.4572, 42.3772, 'მარტვილის კანიონი', 'Martvili Canyon', 'tourism', 'attraction'),
                (41.6510, 41.6390, 'ბათუმის ბულვარი', 'Batumi Boulevard', 'tourism', 'attraction'),
                (41.6555, 41.6420, 'ალი და ნინო', 'Ali and Nino Statue', 'tourism', 'attraction'),
                (41.6205, 45.9230, 'სიღნაღის გალავანი', 'Sighnaghi Town Walls', 'historic', 'city_gate'),
                (42.0325, 45.3772, 'ალავერდის მონასტერი', 'Alaverdi Monastery', 'amenity', 'place_of_worship'),
                (41.8385, 43.3800, 'ბორჯომის ცენტრალური პარკი', 'Borjomi Central Park', 'tourism', 'attraction'),
                (42.4950, 44.4560, 'მეგობრობის მონუმენტი', 'Friendship Monument (Gudauri)', 'tourism', 'viewpoint')]:
            P(lat, lon, ka, en, **{k: v})
        for lat, lon, ka, en in [(41.6692, 44.9547, 'თბილისის საერთაშორისო აეროპორტი', 'Tbilisi International Airport'),
                                 (42.1764, 42.4826, 'ქუთაისის საერთაშორისო აეროპორტი', 'Kutaisi International Airport'),
                                 (41.5994, 41.6030, 'ბათუმის საერთაშორისო აეროპორტი', 'Batumi International Airport')]:
            P(lat, lon, ka, en, aeroway='aerodrome')
        for lat, lon, ka, en in [(41.7795, 44.7575, 'თბილისი მოლი', 'Tbilisi Mall'), (41.6745, 44.9030, 'ისთ ფოინთი', 'East Point'),
                                 (41.6942, 44.8003, 'გალერეა თბილისი', 'Galleria Tbilisi'), (41.7336, 44.7598, 'სითი მოლი საბურთალო', 'City Mall Saburtalo')]:
            P(lat, lon, ka, en, shop='mall')
        for lat, lon, ka, en in [(41.7232, 44.7540, 'ნიუ ჰოსპიტალსი', 'New Hospitals'), (41.7350, 44.7335, 'თოდუას კლინიკა', 'Todua Clinic'),
                                 (41.7012, 44.7812, 'ავერსი კლინიკა', 'Aversi Clinic'), (41.7225, 44.7590, 'პირველი საუნივერსიტეტო კლინიკა', 'First University Clinic'),
                                 (41.6900, 44.8320, 'ინგოროყვას კლინიკა', 'Ingorokva Clinic'), (41.6430, 41.6400, 'ბათუმის რესპუბლიკური საავადმყოფო', 'Batumi Republican Hospital'),
                                 (42.2650, 42.7000, 'ქუთაისის რეფერალური ჰოსპიტალი', 'Kutaisi Referral Hospital')]:
            P(lat, lon, ka, en, amenity='hospital')
        metro = [(41.6934, 44.8015, 'თავისუფლების მოედანი', 'Liberty Square'), (41.7038, 44.7912, 'რუსთაველი', 'Rustaveli'),
                 (41.7085, 44.8030, 'მარჯანიშვილი', 'Marjanishvili'), (41.7215, 44.7980, 'სადგურის მოედანი', 'Station Square'),
                 (41.7290, 44.7950, 'წერეთელი', 'Tsereteli'), (41.7330, 44.7935, 'ელექტროდეპო', 'Electrodepo'), (41.7365, 44.7925, 'დიდუბე', 'Didube'),
                 (41.7470, 44.7880, 'ღრმაღელე', 'Ghrmaghele'), (41.7600, 44.7950, 'გურამიშვილი', 'Guramishvili'), (41.7700, 44.8050, 'სარაჯიშვილი', 'Sarajishvili'),
                 (41.7770, 44.8150, 'ახმეტელის თეატრი', 'Akhmeteli Theatre'), (41.6947, 44.8126, 'ავლაბარი', 'Avlabari'),
                 (41.6905, 44.8240, '300 არაგველი', '300 Aragveli'), (41.6855, 44.8310, 'ისანი', 'Isani'), (41.6720, 44.8455, 'სამგორი', 'Samgori'),
                 (41.6620, 44.8695, 'ვარკეთილი', 'Varketili'), (41.7265, 44.7490, 'დელისი', 'Delisi'), (41.7215, 44.7575, 'სამედიცინო უნივერსიტეტი', 'Medical University'),
                 (41.7235, 44.7720, 'ტექნიკური უნივერსიტეტი', 'Technical University'), (41.7320, 44.7400, 'ვაჟა-ფშაველა', 'Vazha-Pshavela'),
                 (41.7365, 44.7320, 'სახელმწიფო უნივერსიტეტი', 'State University')]
        for lat, lon, ka, en in metro:
            P(lat, lon, ka, en, railway='station', station='subway')
        P(41.7218, 44.7990, 'თბილისის ცენტრალური სადგური', 'Tbilisi Central Station', railway='station', station='train')
        # fuel, charging and parking: along the main roads, real Georgian brands
        brands = ['Gulf', 'SOCAR', 'Rompetrol', 'Wissol', 'Lukoil', 'Connect', 'Portal']
        fuel_at = [(41.7105, 44.7720), (41.7190, 44.7615), (41.7300, 44.7440), (41.7270, 44.7640), (41.7180, 44.7950), (41.7400, 44.7915),
                   (41.6890, 44.8270), (41.6800, 44.8600), (41.6745, 44.8180), (41.7065, 44.8050), (41.7630, 44.7830), (41.7850, 44.7720)]
        hw_fuel = [(41.8650, 44.6400), (41.9400, 44.3500), (41.9950, 43.8000), (42.0900, 43.2500), (42.2000, 42.7000), (42.2200, 42.2000),
                   (42.4000, 41.9600), (41.8200, 41.7750), (41.6900, 41.7100), (41.6000, 44.9400), (41.5300, 44.8350), (41.7200, 45.0800),
                   (41.7400, 45.5000), (42.1450, 44.7400), (42.4780, 44.4790), (41.9000, 43.4500), (42.1500, 41.6800)]
        for i, (lat, lon) in enumerate(fuel_at + hw_fuel):
            b = brands[i % len(brands)]
            P(lat, lon, None, None, amenity='fuel', brand=b, name=b)
        for lat, lon, op in [(41.6950, 44.8000, 'e-Space'), (41.7090, 44.7650, 'e-Space'), (41.7235, 44.7560, 'Tesla Destination'),
                             (41.7795, 44.7590, 'e-Space'), (41.6340, 41.6420, 'e-Space'), (42.2680, 42.6980, 'e-Space'), (41.9900, 44.1100, 'Wissol EV')]:
            P(lat, lon, 'ელექტრო დამტენი', 'EV Charging', amenity='charging_station', operator=op)
        for lat, lon, ka, en in [(41.6940, 44.8030, 'პარკინგი თავისუფლების მოედანთან', 'Freedom Square Parking'),
                                 (41.7025, 44.7945, 'ვარდების რევოლუციის მოედნის პარკინგი', 'Rose Revolution Square Parking'),
                                 (41.7120, 44.7840, 'გმირთა მოედნის პარკინგი', "Heroes' Square Parking"),
                                 (41.6990, 44.8070, 'მშრალი ხიდის პარკინგი', 'Dry Bridge Parking'),
                                 (41.7090, 44.7560, 'ვაკის პარკის პარკინგი', 'Vake Park Parking'),
                                 (41.6705, 44.9520, 'აეროპორტის პარკინგი', 'Airport Parking'),
                                 (41.6450, 41.6380, 'ბულვარის პარკინგი', 'Boulevard Parking')]:
            P(lat, lon, ka, en, amenity='parking')
        for lat, lon, ka, en in [(41.6942, 44.8048, 'სასტუმრო თბილისი მარიოტი', 'Tbilisi Marriott Hotel'),
                                 (41.7015, 44.7950, 'რედისონ ბლუ ივერია', 'Radisson Blu Iveria'),
                                 (41.6920, 44.8090, 'სასტუმრო რუმსი', 'Rooms Hotel'), (41.6520, 41.6400, 'ჰილტონ ბათუმი', 'Hilton Batumi')]:
            P(lat, lon, ka, en, tourism='hotel')

    # -- finish: roundabout entries, crossings as junctions, node ids
    def finish(self):
        ds = self.ds
        roads = [w for w in self.ways if 'highway' in w[1]]
        # roads that end at a square's centre: on to the ring's nearest point instead
        for c, ring in getattr(self, 'rings', []):
            for w in roads:
                pts = w[0]
                if w[1].get('junction') == 'roundabout':
                    continue
                for end in (0, -1):
                    if pts[end] == c:
                        nb = pts[1] if end == 0 else pts[-2]
                        best = min(ring, key=lambda q: dist_m(q, nb))
                        pts[end] = best
        node_roads(roads)
        key = {}
        nid = [0]

        def node(p):
            k = (round(p[0], 7), round(p[1], 7))
            i = key.get(k)
            if i is None:
                nid[0] += 1
                i = key[k] = nid[0]
                ds.nodes[i] = k
            return i
        for n, (pts, tags) in enumerate(self.ways):
            refs = [node(p) for p in pts]
            refs = [r for i, r in enumerate(refs) if i == 0 or r != refs[i - 1]]
            if len(refs) >= 2:
                ds.ways.append((n + 1, refs, tags))
        for lat, lon, tags in self.pois:
            nid[0] += 1
            ds.nodes[nid[0]] = (lat, lon)
            ds.ntags[nid[0]] = tags
        ds.source = 'builtin Georgia'
        ds.attribution = 'Built-in demo map (approximate public geography, generated streets); compile a Geofabrik extract for the real one'
        return ds


def _inside(p, ring):
    y, x = p
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        yi, xi = ring[i]
        yj, xj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def _near(p, line, m):
    """within m metres of a polyline (cheap: a bounding test first)"""
    lat, lon = p
    dlat = m / 111000.0
    dlon = m / (111000.0 * math.cos(math.radians(lat)))
    for i in range(1, len(line)):
        a, b = line[i - 1], line[i]
        if lat < min(a[0], b[0]) - dlat or lat > max(a[0], b[0]) + dlat or lon < min(a[1], b[1]) - dlon or lon > max(a[1], b[1]) + dlon:
            continue
        ax, ay = merc(*a)
        bx, by = merc(*b)
        px, py = merc(*p)
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy or 1
        t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
        if math.hypot(px - ax - t * dx, py - ay - t * dy) * math.cos(math.radians(lat)) < m:
            return True
    return False


def node_roads(roads, cell=300.0, snap=4.0):
    """Make crossings junctions: where two roads cross (neither a bridge or tunnel there), both get the
    crossing point; a road that ends within snap metres of another is joined to it there."""
    M = [[merc(*p) for p in w[0]] for w in roads]
    raised = [w[1].get('bridge') == 'yes' or w[1].get('tunnel') == 'yes' for w in roads]
    grid = {}
    for wi, pts in enumerate(M):
        for k in range(len(pts) - 1):
            (ax, ay), (bx, by) = pts[k], pts[k + 1]
            for cx in range(int(math.floor(min(ax, bx) / cell)), int(math.floor(max(ax, bx) / cell)) + 1):
                for cy in range(int(math.floor(min(ay, by) / cell)), int(math.floor(max(ay, by) / cell)) + 1):
                    grid.setdefault((cx, cy), []).append((wi, k))
    splits = {}
    seen = set()

    def add(wi, k, t, ll):
        splits.setdefault((wi, k), []).append((t, ll))
    for segs in grid.values():
        for i in range(len(segs)):
            wa, ka = segs[i]
            (ax, ay), (bx, by) = M[wa][ka], M[wa][ka + 1]
            for j in range(i + 1, len(segs)):
                wb, kb = segs[j]
                if wa == wb and abs(ka - kb) <= 1:
                    continue
                pair = (segs[i], segs[j]) if segs[i] < segs[j] else (segs[j], segs[i])
                if pair in seen:
                    continue
                seen.add(pair)
                (cx, cy), (dx, dy) = M[wb][kb], M[wb][kb + 1]
                rx, ry, sx, sy = bx - ax, by - ay, dx - cx, dy - cy
                den = rx * sy - ry * sx
                if abs(den) < 1e-9:
                    continue
                t = ((cx - ax) * sy - (cy - ay) * sx) / den
                u = ((cx - ax) * ry - (cy - ay) * rx) / den
                eps = 1e-6
                if eps < t < 1 - eps and eps < u < 1 - eps and not raised[wa] and not raised[wb]:
                    x, y = ax + rx * t, ay + ry * t
                    ll = unmerc(x, y)
                    add(wa, ka, t, ll)
                    add(wb, kb, u, ll)
    # T-junctions: a road's end near another road's side
    for wi, pts in enumerate(M):
        for end in (0, len(pts) - 1):
            ex, ey = pts[end]
            c = (int(math.floor(ex / cell)), int(math.floor(ey / cell)))
            best = None
            for (wb, kb) in grid.get(c, ()):
                if wb == wi:
                    continue
                (ax, ay), (bx, by) = M[wb][kb], M[wb][kb + 1]
                dx, dy = bx - ax, by - ay
                l2 = dx * dx + dy * dy
                if l2 == 0:
                    continue
                t = ((ex - ax) * dx + (ey - ay) * dy) / l2
                if t <= 0.01 or t >= 0.99:
                    continue
                d = math.hypot(ex - ax - t * dx, ey - ay - t * dy)
                if d < snap * 1.35 and (best is None or d < best[0]):
                    best = (d, wb, kb, t)
            if best:
                _, wb, kb, t = best
                (ax, ay), (bx, by) = M[wb][kb], M[wb][kb + 1]
                ll = unmerc(ax + (bx - ax) * t, ay + (by - ay) * t)
                add(wb, kb, t, ll)
                roads[wi][0][end if end == 0 else -1] = ll
    # rebuild each road with its crossing points in order
    by_way = {}
    for (wi, k), lst in splits.items():
        by_way.setdefault(wi, {})[k] = sorted(lst)
    for wi, ks in by_way.items():
        pts = roads[wi][0]
        out = []
        for k in range(len(pts)):
            out.append(pts[k])
            for t, ll in ks.get(k, ()):
                out.append(ll)
        roads[wi][0] = out


def build(Dataset, log=print):
    g = Gen(Dataset)
    g.country()
    g.highways()
    g.tbilisi()
    n = g.districts()
    g.connectors()
    g.add_pois()
    log('  builtin Georgia: %d ways (%d generated streets), %d POIs' % (len(g.ways), n, len(g.pois)))
    return g.finish()
