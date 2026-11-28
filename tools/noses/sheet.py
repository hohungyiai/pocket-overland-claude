# The nose bench's picture sheets: one per case, its views in a grid.
#   python3 tools/noses/sheet.py SHOTS_DIR OUT_DIR [--before BEFORE_DIR] [ids ...]
# With --before, each view is a pair, before (left) and after (right).
# Views come from tools/noses/spots.cjs, rendered by
# /mnt/project-files/tools/reviewer/shoot.cjs --course noses.
import json, os, sys
from PIL import Image, ImageDraw
a = sys.argv[1:]
before = None
if '--before' in a:
    k = a.index('--before'); before = a[k + 1]; del a[k:k + 2]
shots, out, ids = a[0], a[1], a[2:]
here = os.path.dirname(os.path.abspath(__file__))
cases = json.load(open(os.path.join(here, 'cases.json')))
os.makedirs(out, exist_ok=True)
VIEWS = ['top', 'car', 'ne', 'se', 'sw', 'nw']
TW = 480
def tile(path, label):
    im = Image.open(path).convert('RGB'); im = im.resize((TW, round(im.height * TW / im.width)))
    d = ImageDraw.Draw(im); d.rectangle([0, 0, 8 + 7 * len(label), 20], fill='black'); d.text((5, 4), label, fill='white')
    return im
for c in cases:
    if ids and c['id'] not in ids: continue
    cells = []
    for v in VIEWS:
        f = f"{shots}/{c['id']}-{v}.png"
        if not os.path.exists(f): continue
        if before:
            b = tile(f"{before}/{c['id']}-{v}.png", f"{v} BEFORE"); n = tile(f, f"{v} AFTER")
            p = Image.new('RGB', (2 * TW + 6, b.height), 'white'); p.paste(b, (0, 0)); p.paste(n, (TW + 6, 0)); cells.append(p)
        else:
            cells.append(tile(f, v))
    if not cells: continue
    cols = 1 if before else 3
    cw, ch = cells[0].width, max(x.height for x in cells)
    rows = (len(cells) + cols - 1) // cols
    head = 44
    S = Image.new('RGB', (cols * (cw + 6), head + rows * (ch + 6)), 'white')
    d = ImageDraw.Draw(S)
    d.text((6, 4), f"{c['id']} ({c['status']}) at {c['x']},{c['z']}: {c['kind']}", fill='black')
    d.text((6, 22), (c.get('fault') or 'looks right: must stay so') + '   rules ' + ' '.join(c.get('rules', [])), fill='black')
    for i, x in enumerate(cells): S.paste(x, ((i % cols) * (cw + 6), head + (i // cols) * (ch + 6)))
    S.save(f"{out}/{c['id']}.jpg", quality=85); print(f"{out}/{c['id']}.jpg")
