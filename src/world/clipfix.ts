import { Clipper, Clipper64, ClipperOffset, EndType, InternalClipper, Path64, Point64 } from 'clipper2-js';

// clipper2-js 1.2.4 is a port of Clipper2's C#, where a point is a value.
// Here it is an object, and getIntersectPoint hands back one of the edge's
// own end points when the crossing falls at or past it; the clipper then
// moves that point in place to keep it within the scan band, and the
// vertex itself moves: the outline it came from, and any shape cut from
// it, bend round a corner that is no longer where it was (a needle of
// paving laid past the kerb at (1165, 1576)). Each answer a copy.
const IC = InternalClipper as unknown as { getIntersectPoint: (a: Point64, b: Point64, c: Point64, d: Point64) => { ip: Point64; success: boolean } };
const orig = IC.getIntersectPoint;
if (!(orig as { copied?: boolean }).copied) {
  const fixed = (a: Point64, b: Point64, c: Point64, d: Point64) => {
    const r = orig.call(InternalClipper, a, b, c, d);
    if (r.ip === a || r.ip === b) r.ip = new Point64(r.ip.x, r.ip.y);
    return r;
  };
  (fixed as { copied?: boolean }).copied = true;
  IC.getIntersectPoint = fixed;
}

// Its scan line list kept sorted by sorting the whole list again at every
// insert, after a linear search for the value: a tenth of the map's start
// went there, in the clipper's every cut. The same list, the same order
// (rising, no value twice), by a binary search.
const SL = (new Clipper64() as unknown as { _scanlineList: { items: number[] } })._scanlineList;
const SLP = Object.getPrototypeOf(SL) as { add: (y: number) => void; fast?: boolean };
if (!SLP.fast) {
  SLP.fast = true;
  SLP.add = function (this: { items: number[] }, y: number) {
    const a = this.items;
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (a[m] < y) lo = m + 1;
      else hi = m;
    }
    if (a[lo] !== y) a.splice(lo, 0, y);
  };
}

// Its offsetting (the only use: the island lawn's reach, its paths' strips
// and its opening) had two faults more.
// Where it skips a point the same as the one before it asks whether it is
// the same object, not the same place: two points at one place, each its
// own object, were both kept, and the side between them had no length and
// no direction (the clipper's cuts hand back such points every few metres
// round the lawn's reach).
// And each corner is to be turned between the side before it and the side
// after: the C# hands on which side was last by reference, here a copy was
// handed and never changed, so every corner of a ring was turned against
// its last side, of an open line against its first. Rounded, a path's
// strip came back notched on the inside of every bend (lawn over half the
// path, 1153,1600); narrowed by 5 mm, a lawn ring of 1,724 square metres
// came back 1,818, with a spike 290 m long (lawn laid where no kerb was in
// one tile and not the next, 1849.7,2200).
const same = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x === b.x && a.y === b.y;
const CS = Clipper as unknown as { stripDuplicates: (path: Path64, closed: boolean) => Path64; byPlace?: boolean };
if (!CS.byPlace) {
  CS.byPlace = true;
  CS.stripDuplicates = (path, closed) => {
    const out = new Path64();
    if (!path.length) return out;
    let last = path[0];
    out.push(last);
    for (let i = 1; i < path.length; i++) if (!same(path[i], last)) { last = path[i]; out.push(last); }
    if (closed) while (out.length > 1 && same(out[out.length - 1], out[0])) out.pop();
    return out;
  };
}
type Grp = { outPath: Point64[]; outPaths: Point64[][] };
type Off = {
  _groupDelta: number; _endType: EndType; _normals: { x: number; y: number }[];
  offsetPoint: (g: Grp, p: Path64, j: number, k: number) => void;
  doBevel: (g: Grp, p: Path64, j: number, k: number) => void;
  doSquare: (g: Grp, p: Path64, j: number, k: number) => void;
  doRound: (g: Grp, p: Path64, j: number, k: number, a: number) => void;
  DeltaCallback?: unknown;
  offsetPolygon: (g: Grp, p: Path64) => void; offsetOpenPath: (g: Grp, p: Path64) => void; turned?: boolean;
};
const OP = ClipperOffset.prototype as unknown as Off;
if (!OP.turned) {
  OP.turned = true;
  const TOL = 1e-12;
  OP.offsetPolygon = function (this: Off, group, path) {
    const area = Clipper.area(path);
    if ((area < 0) !== (this._groupDelta < 0)) {
      const rect = Clipper.getBounds(path);
      const d = Math.abs(this._groupDelta) * 2;
      if (d > rect.width || d > rect.height) return;
    }
    group.outPath = [];
    const cnt = path.length;
    for (let i = 0, k = cnt - 1; i < cnt; k = i, i++) this.offsetPoint(group, path, i, k);
    group.outPaths.push(group.outPath);
  };
  const cap = (o: Off, group: Grp, path: Path64, i: number) => {
    if (Math.abs(o._groupDelta) < TOL) group.outPath.push(path[i] as Point64);
    else if (o._endType === EndType.Butt) o.doBevel(group, path, i, i);
    else if (o._endType === EndType.Round) o.doRound(group, path, i, i, Math.PI);
    else o.doSquare(group, path, i, i);
  };
  OP.offsetOpenPath = function (this: Off, group, path) {
    if (this.DeltaCallback !== undefined) throw new Error('clipfix: DeltaCallback not supported');
    group.outPath = [];
    const highI = path.length - 1;
    cap(this, group, path, 0);
    for (let i = 1, k = 0; i < highI; k = i, i++) this.offsetPoint(group, path, i, k);
    for (let i = highI; i > 0; i--) this._normals[i] = { x: -this._normals[i - 1].x, y: -this._normals[i - 1].y };
    this._normals[0] = this._normals[highI];
    cap(this, group, path, highI);
    for (let i = highI, k = 0; i > 0; k = i, i--) this.offsetPoint(group, path, i, k);
    group.outPaths.push(group.outPath);
  };
}
