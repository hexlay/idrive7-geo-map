#!/usr/bin/env python3
"""Bake the Georgian glyph atlases: label-ka.json and bold-ka.json in kit/runtime/fonts/.

python3 kit/tools/bake_georgian.py [path/to/NotoSansGeorgian[wdth,wght].ttf]

Each is a copy of its base family (label, bold: every size, the very same Latin glyph bitmaps
and metrics) plus the Georgian script from Noto Sans Georgian (OFL-1.1), drawn at the same
weight and width and scaled so its letters stand as tall as the base font's x-height.
fonts.js draws a text that has Georgian in it from these (bold from bold-ka, the rest from
label-ka), so a title mixing Georgian and Latin looks like every other text.

Without a path, downloads the font from Google Fonts and checks its SHA-256. Pillow is
needed only here: the generated atlases are committed, and app builds need neither.
"""
import base64
import hashlib
import json
from pathlib import Path
import sys
import urllib.request
import zlib

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
FONTS = ROOT / 'kit/runtime/fonts'
URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosansgeorgian/NotoSansGeorgian%5Bwdth%2Cwght%5D.ttf'
SHA256 = 'dc591156f36842d38996c4a7a17fee9bb58e45da3e2cac7a31b7d33de700adb9'

# modern Georgian: Mkhedruli (U+10D0-10FF) and its Mtavruli capitals (U+1C90-1CBF). The church
# scripts (Asomtavruli U+10A0-10CF, Nuskhuri U+2D00-2D2F) are left out: no song title has them,
# and every glyph is in every app. Code points the font does not have are left out too.
RANGES = [(0x10D0, 0x10FF), (0x1C90, 0x1CBF)]
# base family -> Noto's (weight, width) and the sizes baked: the base is Ubuntu at width 85,
# weight 400 / 700. Bold's 64 px is left out (the apps' bold text is up to 44 px; fonts.js scales).
BASES = {'label': (400, 85, None), 'bold': (700, 85, (24, 32, 44))}
REF = 'ა'          # "a": an x-height letter, sized to the base font's "x"


def noto(path, size, weight, width):
    f = ImageFont.truetype(str(path), size)
    axes = [a['name'] for a in f.get_variation_axes()]
    f.set_variation_by_axes([weight if n == b'Weight' else width for n in axes])
    return f


def render(font, ch):
    """(bitmap, bbox from the baseline, advance) of one character, bitmap None for a space."""
    bbox = font.getbbox(ch, anchor='ls')
    w, h = max(0, bbox[2] - bbox[0]), max(0, bbox[3] - bbox[1])
    im = None
    if w and h:
        im = Image.new('L', (w, h), 0)
        ImageDraw.Draw(im).text((-bbox[0], -bbox[1]), ch, font=font, fill=255, anchor='ls')
    return im, bbox, font.getlength(ch)


def covered(font):
    """The Georgian code points the font draws (not as its "missing glyph" box)."""
    notdef = render(font, '')[0]
    nd = notdef.tobytes() if notdef else None
    out = []
    for lo, hi in RANGES:
        for c in range(lo, hi + 1):
            im = render(font, chr(c))[0]
            if im is not None and im.tobytes() != nd:
                out.append(chr(c))
    return out


def bake_size(base, path, weight, width):
    """One size of the base family with the Georgian glyphs added."""
    size = base['size']
    atlas = Image.frombytes('L', (base['atlasW'], base['atlasH']), zlib.decompress(base64.b64decode(base['alpha'])))
    items = []                                     # (code, bitmap, ox, oy, adv)
    for code, g in base['glyphs'].items():
        x, y, w, h, ox, oy, adv = g
        items.append((int(code), atlas.crop((x, y, x + w, y + h)) if w and h else None, ox, oy, adv))
    # the Georgian letters as tall as the base's x-height
    xg = base['glyphs'].get(str(ord('x')))
    probe = noto(path, size, weight, width)
    ref_h = render(probe, REF)[0].height
    px = max(6, round(size * (xg[3] / ref_h))) if xg and ref_h else size
    font = noto(path, px, weight, width)
    for ch in covered(font):
        im, bbox, adv = render(font, ch)
        items.append((ord(ch), im, bbox[0], bbox[1], round(adv, 2)))
    # shelf-pack, as bake_fonts.py
    W = base['atlasW']
    x = y = rowh = 0
    place = {}
    for code, im, ox, oy, adv in items:
        if im is None:
            place[code] = (0, 0, 0, 0)
            continue
        if x + im.width > W:
            x, y, rowh = 0, y + rowh + 1, 0
        place[code] = (x, y, im.width, im.height)
        x += im.width + 1
        rowh = max(rowh, im.height)
    H = y + rowh + 1
    out = Image.new('L', (W, H), 0)
    glyphs = {}
    for code, im, ox, oy, adv in items:
        gx, gy, gw, gh = place[code]
        if im is not None:
            out.paste(im, (gx, gy))
        glyphs[code] = [gx, gy, gw, gh, ox, oy, adv]
    return {'size': size, 'ascent': base['ascent'], 'descent': base['descent'], 'atlasW': W, 'atlasH': H,
            'alpha': base64.b64encode(zlib.compress(out.tobytes(), 9)).decode(), 'glyphs': glyphs}


def main():
    path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else HERE / '.font-cache/NotoSansGeorgian.ttf'
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(URL, timeout=120) as response:
            path.write_bytes(response.read())
    if hashlib.sha256(path.read_bytes()).hexdigest() != SHA256:
        raise SystemExit('Noto Sans Georgian SHA-256 mismatch; refusing to bake a different font')
    for name, (weight, width, only) in BASES.items():
        base = json.loads((FONTS / (name + '.json')).read_text(encoding='utf-8'))
        sizes = [bake_size(s, path, weight, width) for s in base['sizes'] if not only or s['size'] in only]
        # the daemon shares atlases between apps by family + size + cacheKey: a new bake, a new key
        key = hashlib.sha256(json.dumps(sizes, separators=(',', ':')).encode()).hexdigest()[:16]
        data = {'family': name + '-ka', 'source': base.get('source', '') + ' + Noto Sans Georgian (OFL-1.1)',
                'cacheKey': key, 'sizes': sizes}
        out = FONTS / (name + '-ka.json')
        out.write_text(json.dumps(data, separators=(',', ':')) + '\n', encoding='utf-8')
        print(name + '-ka:', [(s['size'], s['atlasH']) for s in sizes], len(sizes[0]['glyphs']), 'glyphs,',
              out.stat().st_size // 1024, 'KiB')


if __name__ == '__main__':
    main()
