import { Clipper64, InternalClipper, Point64 } from 'clipper2-js';

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
