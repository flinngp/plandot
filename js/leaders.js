// Finds the dot at the end of a callout's leader line.
//
// A callout on a drawing is usually a tag (A1, B2 ...) inside a diamond, hexagon or
// circle, with a leader line running from the outline to a dot on the thing it tags.
// The tag text sits on the callout, but the task belongs on the dot.
//
// Everything here is pure geometry (no DOM, no pdf.js) so it can be unit-tested in Node.
// All coordinates are viewport points: origin top-left, y increasing downward.
//
//   shapes = {
//     strokes: [{ pts: [[x, y], ...], closed: boolean, color: number }],
//     fills:   [{ bbox: [x0, y0, x1, y1], area: number }],     // small dark filled shapes
//   }

export const DOT = {
  min: 1.2, // smallest dot, in points
  max: 10, // largest dot
  slack: 3, // how far a leader's end may be from a dot's edge and still count as touching
  aspect: 1.45, // widest allowed width:height
  fillMin: 0.6, // a round blob fills ~0.78 of its bounding box; a lone triangle only 0.5
  fillMax: 0.95, // ...and a square fills 1.0
};
const OUTLINE = { min: 6, max: 90 }; // callout outline size range (points)
const ATTACH = 1.6; // a leader must start this close to the outline
const CHAIN = 0.9; // two line pieces this close at their ends are one leader
const MAX_HOPS = 8;
const MAX_LENGTH = 1500;
const CELL = 12;

// ------------------------------------------------------------------ small helpers

class Grid {
  constructor(cell = CELL) {
    this.cell = cell;
    this.map = new Map();
  }
  add(x, y, item) {
    const key = `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
    const list = this.map.get(key);
    if (list) list.push(item);
    else this.map.set(key, [item]);
  }
  /** Items stored in every cell that touches the square of half-size r around (x, y). */
  near(x, y, r) {
    const out = [];
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((y - r) / c); j <= Math.floor((y + r) / c); j++) {
        const list = this.map.get(`${i},${j}`);
        if (list) out.push(...list);
      }
    }
    return out;
  }
}

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distToPolygon(px, py, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    best = Math.min(best, distToSegment(px, py, ax, ay, bx, by));
  }
  return best;
}

function insidePolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ------------------------------------------------------------------ dots

/**
 * A dot is often drawn as a ring of tiny filled triangles (or one small filled circle).
 * Group touching small fills, then keep the groups that are round and dot-sized.
 */
function clusterDots(fills) {
  const parent = fills.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const grid = new Grid(6);
  const EPS = 0.4;
  fills.forEach((f, i) => {
    const [x0, y0, x1, y1] = f.bbox;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    for (const j of grid.near(cx, cy, DOT.max)) {
      const g = fills[j].bbox;
      if (x0 - EPS <= g[2] && g[0] - EPS <= x1 && y0 - EPS <= g[3] && g[1] - EPS <= y1) parent[find(i)] = find(j);
    }
    grid.add(cx, cy, i);
  });

  const groups = new Map();
  fills.forEach((f, i) => {
    const root = find(i);
    const g = groups.get(root);
    if (!g) groups.set(root, { bbox: [...f.bbox], area: f.area });
    else {
      g.bbox = [Math.min(g.bbox[0], f.bbox[0]), Math.min(g.bbox[1], f.bbox[1]), Math.max(g.bbox[2], f.bbox[2]), Math.max(g.bbox[3], f.bbox[3])];
      g.area += f.area;
    }
  });

  const dots = [];
  for (const g of groups.values()) {
    const w = g.bbox[2] - g.bbox[0], h = g.bbox[3] - g.bbox[1];
    if (Math.min(w, h) < DOT.min || Math.max(w, h) > DOT.max) continue;
    if (Math.max(w, h) / Math.min(w, h) > DOT.aspect) continue;
    const fill = g.area / (w * h);
    if (fill < DOT.fillMin || fill > DOT.fillMax) continue;
    dots.push({ x: (g.bbox[0] + g.bbox[2]) / 2, y: (g.bbox[1] + g.bbox[3]) / 2, r: (w + h) / 4 });
  }
  return dots;
}

// ------------------------------------------------------------------ geometry index

export function buildGeometry({ strokes = [], fills = [] }) {
  const dots = clusterDots(fills);
  const dotGrid = new Grid();
  dots.forEach((d, i) => dotGrid.add(d.x, d.y, i));

  const open = [];
  const outlines = [];
  const ends = new Grid();
  for (const s of strokes) {
    const bbox = bboxOf(s.pts);
    const w = bbox[2] - bbox[0], h = bbox[3] - bbox[1];
    if (s.closed) {
      if (s.pts.length >= 3 && Math.min(w, h) >= OUTLINE.min && Math.max(w, h) <= OUTLINE.max) {
        outlines.push({ pts: s.pts, color: s.color, bbox, area: polygonArea(s.pts) });
      }
    } else if (s.pts.length >= 2 && w + h > 0.5) {
      const i = open.push({ pts: s.pts, color: s.color }) - 1;
      const first = s.pts[0], last = s.pts[s.pts.length - 1];
      ends.add(first[0], first[1], { i, end: 0 });
      ends.add(last[0], last[1], { i, end: 1 });
    }
  }
  outlines.sort((a, b) => a.area - b.area); // smallest enclosing outline first
  return { dots, dotGrid, open, ends, outlines };
}

const endPoint = (geo, e) => {
  const pts = geo.open[e.i].pts;
  return e.end === 0 ? pts[0] : pts[pts.length - 1];
};
const farPoint = (geo, e) => {
  const pts = geo.open[e.i].pts;
  return e.end === 0 ? pts[pts.length - 1] : pts[0];
};

function dotAt(geo, p) {
  let best = null, bestD = Infinity;
  for (const i of geo.dotGrid.near(p[0], p[1], DOT.max + DOT.slack)) {
    const d = geo.dots[i];
    const dist = Math.hypot(d.x - p[0], d.y - p[1]);
    if (dist <= d.r + DOT.slack && dist < bestD) {
      best = d;
      bestD = dist;
    }
  }
  return best;
}

/** Follow a leader from the callout outline to its far end, and see what is there. */
function trace(geo, start) {
  const visited = new Set([start.i]);
  let piece = geo.open[start.i];
  let far = farPoint(geo, start);
  let length = pathLength(piece.pts);
  for (let hop = 0; ; hop++) {
    const dot = dotAt(geo, far);
    if (dot) return { kind: "dot", x: dot.x, y: dot.y, r: dot.r, end: { x: far[0], y: far[1] }, length };
    if (hop >= MAX_HOPS || length > MAX_LENGTH) break;
    let next = null;
    for (const e of geo.ends.near(far[0], far[1], CHAIN)) {
      if (visited.has(e.i) || geo.open[e.i].color !== piece.color) continue;
      const p = endPoint(geo, e);
      if (Math.hypot(p[0] - far[0], p[1] - far[1]) <= CHAIN) {
        next = e;
        break;
      }
    }
    if (!next) break;
    visited.add(next.i);
    piece = geo.open[next.i];
    far = farPoint(geo, next);
    length += pathLength(piece.pts);
  }
  return length >= 3 ? { kind: "leader", x: far[0], y: far[1], length } : null;
}

function leaderFrom(geo, outline) {
  const [x0, y0, x1, y1] = outline.bbox;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const reach = Math.hypot(x1 - x0, y1 - y0) / 2 + ATTACH + 1;
  const starts = geo.ends.near(cx, cy, reach).filter((e) => {
    const p = endPoint(geo, e);
    return distToPolygon(p[0], p[1], outline.pts) <= ATTACH;
  });
  // A leader is drawn like the outline it hangs from, so try same-coloured lines first.
  starts.sort((a, b) => (geo.open[b.i].color === outline.color) - (geo.open[a.i].color === outline.color));
  const dots = [];
  let leaderOnly = null;
  for (const e of starts) {
    const found = trace(geo, e);
    if (!found) continue;
    if (found.kind === "dot") {
      if (!dots.some((d) => Math.hypot(d.x - found.x, d.y - found.y) < 1)) dots.push(found);
    } else leaderOnly ??= found;
  }
  // A tag with two leaders marks two places, so every dot counts. Lines that end without a dot are
  // less certain (they might not be leaders at all), so only the first of those is used.
  if (dots.length) return dots.sort((a, b) => a.y - b.y || a.x - b.x);
  return leaderOnly ? [leaderOnly] : [];
}

/**
 * Where should the task(s) go for this tag? One place per leader that ends in a dot.
 * @param token {x, y} centre of the tag text
 * @returns [{kind: "dot"|"leader", x, y, ...}], empty when the tag has no outline with a leader
 */
export function findAnchors(geo, token) {
  for (const outline of geo.outlines) {
    const [x0, y0, x1, y1] = outline.bbox;
    if (token.x < x0 || token.x > x1 || token.y < y0 || token.y > y1) continue;
    if (!insidePolygon(token.x, token.y, outline.pts)) continue;
    const found = leaderFrom(geo, outline);
    if (found.length) return found;
  }
  return [];
}

/** The first place for this tag, or null. */
export const findAnchor = (geo, token) => findAnchors(geo, token)[0] ?? null;

// ------------------------------------------------------------------ pdf.js operator list -> shapes

const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const pack = (c) => ((c[0] & 255) << 16) | ((c[1] & 255) << 8) | (c[2] & 255);
const luminance = (packed) => 0.299 * ((packed >> 16) & 255) + 0.587 * ((packed >> 8) & 255) + 0.114 * (packed & 255);
const DARK = 110;
const CURVE_STEPS = 8;

function cubic(p0, p1, p2, p3, out) {
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS, u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
}

/** Turn pdf.js path data (moveTo 0, lineTo 1, curveTo 2, quadTo 3, closePath 4) into point lists. */
function subpaths(data, view) {
  const out = [];
  let cur = null;
  const at = (k) => apply(view, data[k], data[k + 1]);
  for (let k = 0; k < data.length; ) {
    switch (data[k]) {
      case 0:
        cur = { pts: [at(k + 1)], closed: false };
        out.push(cur);
        k += 3;
        break;
      case 1:
        if (!cur) { cur = { pts: [], closed: false }; out.push(cur); }
        cur.pts.push(at(k + 1));
        k += 3;
        break;
      case 2:
        if (cur?.pts.length) cubic(cur.pts[cur.pts.length - 1], at(k + 1), at(k + 3), at(k + 5), cur.pts);
        k += 7;
        break;
      case 3:
        if (cur?.pts.length) {
          const p0 = cur.pts[cur.pts.length - 1], c = at(k + 1), p3 = at(k + 3);
          cubic(p0, [p0[0] + (2 / 3) * (c[0] - p0[0]), p0[1] + (2 / 3) * (c[1] - p0[1])], [p3[0] + (2 / 3) * (c[0] - p3[0]), p3[1] + (2 / 3) * (c[1] - p3[1])], p3, cur.pts);
        }
        k += 5;
        break;
      case 4:
        if (cur) cur.closed = true;
        k += 1;
        break;
      default:
        return out; // unknown command: stop rather than guess
    }
  }
  return out;
}

/**
 * Walk a pdf.js operator list and collect the shapes this module cares about: stroked
 * outlines and leader lines, and small dark filled shapes (dot candidates).
 * @param opList  {fnArray, argsArray} from page.getOperatorList()
 * @param OPS     pdf.js OPS table
 * @param view    viewport transform [a, b, c, d, e, f] (user space -> top-left origin)
 */
export function shapesFromOperatorList({ fnArray, argsArray }, OPS, view) {
  const fillOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const closingOps = new Set([OPS.closeStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);

  let state = { ctm: [1, 0, 0, 1, 0, 0], fill: 0, stroke: 0 };
  const stack = [];
  const strokes = [];
  const fills = [];
  const paths = []; // every painted line or shape, for matching symbols

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(state);
        break;
      case OPS.restore:
        if (stack.length) state = stack.pop();
        break;
      case OPS.transform:
        state = { ...state, ctm: mul(args, state.ctm) };
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(state);
        if (args?.[0]) state = { ...state, ctm: mul(args[0], state.ctm) };
        break;
      case OPS.paintFormXObjectEnd:
        if (stack.length) state = stack.pop();
        break;
      case OPS.setFillRGBColor:
        state = { ...state, fill: pack(args) };
        break;
      case OPS.setStrokeRGBColor:
        state = { ...state, stroke: pack(args) };
        break;
      case OPS.constructPath: {
        const paint = args[0];
        const wantFill = fillOps.has(paint), wantStroke = strokeOps.has(paint);
        if (!wantFill && !wantStroke) break;
        const data = Array.isArray(args[1]) ? args[1][0] : args[1];
        if (!data || !data.length) break;
        const m = mul(state.ctm, view);
        for (const sp of subpaths(data, m)) {
          if (sp.pts.length < 2) continue;
          const bbox = bboxOf(sp.pts);
          const w = bbox[2] - bbox[0], h = bbox[3] - bbox[1];
          if (sp.pts.length <= 200 && Math.max(w, h) <= 3000) {
            paths.push({ pts: sp.pts, closed: !!(sp.closed || closingOps.has(paint) || (wantFill && !wantStroke)) });
          }
          if (wantFill && w <= DOT.max + 2 && h <= DOT.max + 2 && luminance(state.fill) < DARK) {
            fills.push({ bbox, area: polygonArea(sp.pts) });
          }
          if (wantStroke && sp.pts.length <= 80 && Math.max(w, h) <= 1500) {
            const first = sp.pts[0], last = sp.pts[sp.pts.length - 1];
            const closed = sp.closed || closingOps.has(paint) || (sp.pts.length > 2 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.05);
            strokes.push({ pts: sp.pts, closed, color: state.stroke });
          }
        }
        break;
      }
      default:
    }
  }
  return { strokes, fills, paths };
}
