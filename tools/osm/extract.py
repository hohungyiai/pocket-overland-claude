#!/usr/bin/env python3
"""Stand-in for an Overpass download: answers one of the .overpassql query
files from an OpenStreetMap extract (.osm.pbf), in the same JSON shape
("out body geom"), for when the Overpass servers refuse the query.

    extract.py <extract.osm.pbf> <query.overpassql> <out.json>

Only the kind of query tools/osm uses is understood: one [bbox:S,W,N,E], and
statements such as way["highway"]; nwr["railway"="station"];
way["railway"~"^(rail|subway)$"]; relation["type"="multipolygon"]["landuse"];
Map data (c) OpenStreetMap contributors, ODbL 1.0.
"""
import json
import re
import sys

import osmium

pbf, query, out = sys.argv[1:4]
text = "\n".join(line for line in open(query).read().splitlines() if not line.lstrip().startswith("//"))
S, W, N, E = map(float, re.search(r"\[bbox:([\d.]+),([\d.]+),([\d.]+),([\d.]+)\]", text).groups())

# Each statement: the element types it asks for, and its tag tests.
RULES = []
for kind, tests in re.findall(r"\b(node|way|relation|nwr)((?:\[[^\]]+\])+);", text):
    conds = []
    for key, op, val in re.findall(r'\["([^"]+)"(?:(=|~)"([^"]*)")?\]', tests):
        conds.append((key, op, re.compile(val) if op == "~" else val))
    RULES.append(({"nwr": "nwr", "node": "n", "way": "w", "relation": "r"}[kind], conds))


def wanted(kind, tags):
    for types, conds in RULES:
        if kind not in types:
            continue
        if all(k in tags and (not op or (tags[k] == v if op == "=" else v.search(tags[k]))) for k, op, v in conds):
            return True
    return False


def inside(lat, lon):
    return S <= lat <= N and W <= lon <= E


def crosses(a, b):
    """Does the segment a-b pass through the box? (Liang-Barsky.)"""
    t0, t1 = 0.0, 1.0
    d = (b[0] - a[0], b[1] - a[1])
    for p, q in ((-d[0], a[0] - S), (d[0], N - a[0]), (-d[1], a[1] - W), (d[1], E - a[1])):
        if p == 0:
            if q < 0:
                return False
            continue
        t = q / p
        if p < 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
        if t0 > t1:
            return False
    return True


def touches(geom):
    pts = [(g["lat"], g["lon"]) for g in geom if g]
    return any(inside(*p) for p in pts) or any(crosses(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


class Relations(osmium.SimpleHandler):
    """First pass: the relations asked for, and the ways they are made of."""

    def __init__(self):
        super().__init__()
        self.found = []
        self.ways = set()

    def relation(self, r):
        tags = {t.k: t.v for t in r.tags}
        if not wanted("r", tags):
            return
        members = [{"type": {"n": "node", "w": "way", "r": "relation"}[m.type], "ref": m.ref, "role": m.role} for m in r.members]
        self.found.append({"type": "relation", "id": r.id, "members": members, "tags": tags})
        self.ways.update(m["ref"] for m in members if m["type"] == "way")


class Rest(osmium.SimpleHandler):
    """Second pass: tagged nodes, ways (with their geometry), member ways."""

    def __init__(self, member_ways):
        super().__init__()
        self.member_ways = member_ways
        self.geom = {}
        self.elements = []

    def node(self, n):
        if not n.tags or not n.location.valid() or not inside(n.location.lat, n.location.lon):
            return
        tags = {t.k: t.v for t in n.tags}
        if wanted("n", tags):
            self.elements.append({"type": "node", "id": n.id, "lat": n.location.lat, "lon": n.location.lon, "tags": tags})

    def way(self, w):
        tags = {t.k: t.v for t in w.tags}
        ask = wanted("w", tags)
        if not ask and w.id not in self.member_ways:
            return
        geom = [{"lat": nd.location.lat, "lon": nd.location.lon} if nd.location.valid() else None for nd in w.nodes]
        if w.id in self.member_ways:
            self.geom[w.id] = [g for g in geom if g]
        if ask and touches(geom):
            self.elements.append({"type": "way", "id": w.id, "nodes": [nd.ref for nd in w.nodes], "geometry": geom, "tags": tags})


rels = Relations()
rels.apply_file(pbf)
rest = Rest(rels.ways)
rest.apply_file(pbf, locations=True)
elements = rest.elements
for r in rels.found:
    hit = False
    for m in r["members"]:
        if m["type"] == "way" and m["ref"] in rest.geom:
            m["geometry"] = rest.geom[m["ref"]]
            hit = hit or touches(m["geometry"])
    if hit:
        elements.append(r)
json.dump({"version": 0.6, "generator": "tools/osm/extract.py", "elements": elements}, open(out, "w"), separators=(",", ":"))
print(len(elements), "elements")
