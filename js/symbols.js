// Find every copy of a symbol the user boxed on the drawing.
//
// A symbol is the set of drawn lines and curves that sit completely inside the box. To find the
// same symbol elsewhere we look for places where the page has the same lines, at the same size,
// turned any way round (and optionally mirrored). Pure functions, no DOM or PDF library, so it can
// be tested in Node.
//
// A "path" is {pts: [[x, y], ...], closed}. Coordinates are viewport points (top-left origin).
// A "template" is {w, h, paths, pin}: the box size, the lines relative to the box centre, and the
// pin spot relative to the box centre.

export const MAX_TEMPLATE_PATHS = 300;
export const MAX_TEMPLATE_SEGMENTS = 3000;
const CELL = 8; // grid cell for line lookups; must be larger than the tolerance
const MAX_TOL = 5;
const MAX_PAGE_TOL = 7.5; // must stay under the grid cell size

/** Strictness 1..5 -> the share of the symbol that has to match. */
export const STRICTNESS = { 1: 0.6, 2: 0.7, 3: 0.8, 4: 0.9, 5: 0.96 };
export const thresholdFor = (level) => STRICTNESS[level] ?? STRICTNESS[3];

const r2 = (v) => Math.round(v * 100) / 100;

/** A path as a clean list of points (closing duplicate removed). */
function cleanPts(p) {
  const pts = p.pts;
  if (pts.length > 2) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05) return pts.slice(0, -1);
  }
  return pts;
}

function pathLength(pts, closed) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (closed && pts.length > 2) len += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
  return len;
}

const toleranceFor = (diag) => Math.min(MAX_TOL, Math.max(0.3, diag * 0.01));

/**
 * Cut a template out of the page: every path that lies completely inside `box` [x0, y0, x1, y1].
 * Returns {template} or {error}.
 */
export function captureSymbol(paths, box) {
  const [x0, y0, x1, y1] = box;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    if (p.pts.length < 2) continue;
    let inside = true;
    for (const [x, y] of p.pts) if (x < x0 || x > x1 || y < y0 || y > y1) { inside = false; break; }
    if (!inside) continue;
    const pts = p.pts.map(([x, y]) => [r2(x - cx), r2(y - cy)]);
    if (pts.every((q) => q[0] === pts[0][0] && q[1] === pts[0][1])) continue; // a dot with no size
    const key = pts.map((q) => q.join(",")).join(";");
    if (seen.has(key)) continue; // drawn twice on top of each other
    seen.add(key);
    out.push({ pts, closed: !!p.closed });
  }
  if (!out.length) return { error: "There are no lines completely inside that box. Draw it a little larger so it fully contains the symbol." };
  if (out.length > MAX_TEMPLATE_PATHS) return { error: "That box holds too much detail to match. Draw it around just the symbol." };
  const segs = out.reduce((n, p) => n + p.pts.length, 0);
  if (segs > MAX_TEMPLATE_SEGMENTS) return { error: "That box holds too much detail to match. Draw it around just the symbol." };
  // The default pin spot is the middle of the lines themselves, not of the box.
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of out) for (const [x, y] of p.pts) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return { template: { w: r2(x1 - x0), h: r2(y1 - y0), paths: out, pin: [r2((a + c) / 2), r2((b + d) / 2)] } };
}

/** Check something read from a rules file, and tidy it. Returns a template or null. */
export function sanitizeTemplate(t) {
  if (!t || typeof t !== "object" || !Array.isArray(t.paths)) return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e5 ? v : null);
  const paths = [];
  let total = 0;
  for (const p of t.paths.slice(0, MAX_TEMPLATE_PATHS)) {
    if (!p || !Array.isArray(p.pts) || p.pts.length < 2 || p.pts.length > 200) continue;
    const pts = p.pts.map((q) => (Array.isArray(q) ? [num(q[0]), num(q[1])] : [null, null]));
    if (pts.some((q) => q[0] == null || q[1] == null)) continue;
    total += pts.length;
    if (total > MAX_TEMPLATE_SEGMENTS) break;
    paths.push({ pts, closed: !!p.closed });
  }
  const w = num(t.w), h = num(t.h);
  const pin = Array.isArray(t.pin) && num(t.pin[0]) != null && num(t.pin[1]) != null ? [t.pin[0], t.pin[1]] : [0, 0];
  if (!paths.length || !w || !h || w <= 0 || h <= 0) return null;
  return { w, h, paths, pin };
}

// ------------------------------------------------------------------ line lookup

class SegGrid {
  constructor() { this.segs = []; this.cells = new Map(); }
  add(x1, y1, x2, y2) {
    const id = this.segs.length;
    this.segs.push([x1, y1, x2, y2]);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(len / (CELL / 2)));
    let last = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const gx = Math.floor((x1 + (x2 - x1) * t) / CELL), gy = Math.floor((y1 + (y2 - y1) * t) / CELL);
      const key = gx * 100003 + gy;
      if (key === last) continue;
      last = key;
      const list = this.cells.get(key);
      if (list) { if (list[list.length - 1] !== id) list.push(id); } else this.cells.set(key, [id]);
    }
  }
  /** Is any line within `tol` of the point? */
  near(x, y, tol) {
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = this.cells.get((gx + i) * 100003 + gy + j);
        if (!list) continue;
        for (const id of list) {
          const [ax, ay, bx, by] = this.segs[id];
          const dx = bx - ax, dy = by - ay;
          const l2 = dx * dx + dy * dy;
          let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          if (Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= tol) return true;
        }
      }
    }
    return false;
  }
}

function segmentsOf(path) {
  const pts = path.pts, out = [];
  for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]]);
  if (path.closed && pts.length > 2) out.push([pts[pts.length - 1], pts[0]]);
  return out;
}

/** Evenly spaced points along a path, ends included. */
function samplePath(path, step, into) {
  for (const [a, b] of segmentsOf(path)) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = 0; i <= n; i++) into.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, len / n]);
  }
}

// ------------------------------------------------------------------ the page index

const PAGE_INDEX = new WeakMap();

/** Everything about the page's paths that does not depend on the symbol. Built once per page. */
function indexPage(paths) {
  let idx = PAGE_INDEX.get(paths);
  if (idx) return idx;
  const grid = new SegGrid();
  const byCount = new Map(); // point count -> [{i, len, closed}] sorted by length
  const starts = new Map(); // coarse cell of the first point -> path indices
  const START_CELL = 40;
  paths.forEach((p, i) => {
    if (p.pts.length < 2) return;
    for (const [a, b] of segmentsOf(p)) grid.add(a[0], a[1], b[0], b[1]);
    const pts = cleanPts(p);
    const closed = !!p.closed && pts.length > 2;
    const key = `${pts.length}${closed ? "c" : "o"}`;
    if (!byCount.has(key)) byCount.set(key, []);
    byCount.get(key).push({ i, len: pathLength(pts, closed) });
    const sk = Math.floor(p.pts[0][0] / START_CELL) * 100003 + Math.floor(p.pts[0][1] / START_CELL);
    if (!starts.has(sk)) starts.set(sk, []);
    starts.get(sk).push(i);
  });
  for (const list of byCount.values()) list.sort((a, b) => a.len - b.len);
  idx = { grid, byCount, starts, START_CELL };
  PAGE_INDEX.set(paths, idx);
  return idx;
}

function candidatesFor(idx, n, closed, minLen, maxLen, lenTol) {
  const list = idx.byCount.get(`${n}${closed ? "c" : "o"}`);
  if (!list) return [];
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].len < minLen - lenTol) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let k = lo; k < list.length && list[k].len <= maxLen + lenTol; k++) out.push(list[k].i);
  return out;
}

// ------------------------------------------------------------------ matching

/** Rigid transform taking template points P (optionally mirrored) onto page points Q. */
function fit(P, Q, mirror, withScale) {
  const n = P.length;
  let pcx = 0, pcy = 0, qcx = 0, qcy = 0;
  for (let i = 0; i < n; i++) { pcx += mirror * P[i][0]; pcy += P[i][1]; qcx += Q[i][0]; qcy += Q[i][1]; }
  pcx /= n; pcy /= n; qcx /= n; qcy /= n;
  let dot = 0, cross = 0, pp = 0;
  for (let i = 0; i < n; i++) {
    const px = mirror * P[i][0] - pcx, py = P[i][1] - pcy, qx = Q[i][0] - qcx, qy = Q[i][1] - qcy;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
    pp += px * px + py * py;
  }
  const th = Math.atan2(cross, dot);
  const c = Math.cos(th), s = Math.sin(th);
  const k = withScale && pp > 0 ? Math.hypot(dot, cross) / pp : 1; // how much bigger the page copy is
  return { c, s, k, m: mirror, th, tx: qcx - k * (c * pcx - s * pcy), ty: qcy - k * (s * pcx + c * pcy) };
}
const apply = (T, x, y) => { const px = T.m * x; return [T.k * (T.c * px - T.s * y) + T.tx, T.k * (T.s * px + T.c * y) + T.ty]; };
const unapply = (T, x, y) => { const dx = (x - T.tx) / T.k, dy = (y - T.ty) / T.k; return [T.m * (T.c * dx + T.s * dy), -T.s * dx + T.c * dy]; };

/** The range of sizes searched when "other sizes" is on: half to double the boxed copy. */
export const SIZE_RANGE = [0.5, 2];

function* orderings(n, closed) {
  if (closed) {
    for (let shift = 0; shift < n; shift++) {
      yield Array.from({ length: n }, (_, i) => (i + shift) % n);
      yield Array.from({ length: n }, (_, i) => (shift - i + n) % n);
    }
  } else {
    yield Array.from({ length: n }, (_, i) => i);
    yield Array.from({ length: n }, (_, i) => n - 1 - i);
  }
}

/**
 * Find copies of `template` among `paths`.
 * @param opts.level   strictness 1..5 (default 3)
 * @param opts.rotate  also find turned and mirrored copies (default true)
 * @param opts.sizes   also find copies drawn bigger or smaller, half to double (default false)
 * @returns {{hits: {x, y, cx, cy, angle, mirrored, scale, score}[], note?: string}}
 */
export function findSymbols(paths, template, opts = {}) {
  const run = searchSymbols(paths, template, opts);
  for (;;) { const step = run.next(); if (step.done) return step.value; }
}

/**
 * The same search, but on a page that stays responsive: it hands control back every so often so a progress
 * bar can move. onProgress gets a number from 0 to 1. opts.shouldStop() can cancel it (the result is then
 * {hits: [], stopped: true}).
 */
export async function findSymbolsAsync(paths, template, opts = {}, onProgress) {
  const run = searchSymbols(paths, template, opts);
  for (;;) {
    const step = run.next();
    if (step.done) return step.value;
    onProgress?.(step.value);
    await new Promise((r) => setTimeout(r, 0));
    if (opts.shouldStop?.()) return { hits: [], stopped: true };
  }
}

function* searchSymbols(paths, template, opts = {}) {
  const threshold = thresholdFor(opts.level ?? 3);
  const rotate = opts.rotate !== false;
  const [kLo, kHi] = opts.sizes ? SIZE_RANGE : [1, 1];
  const tpl = template.paths.map((p) => ({ pts: p.pts, closed: !!p.closed }));
  if (!tpl.length) return { hits: [] };

  // size and tolerance
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of tpl) for (const [x, y] of p.pts) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  const diag = Math.hypot(c - a, d - b) || 1;
  const tol = toleranceFor(diag);

  const idx = indexPage(paths);

  // Template samples (what must be found on the page) and a lookup of its lines (what the page may contain).
  const step = Math.max(0.6, diag / 60);
  let samples = [];
  for (const p of tpl) samplePath(p, step, samples);
  if (samples.length > 500) { const k = Math.ceil(samples.length / 500); samples = samples.filter((_, i) => i % k === 0); }
  const tgrid = new SegGrid();
  for (const p of tpl) for (const [s, e] of segmentsOf(p)) tgrid.add(s[0], s[1], e[0], e[1]);

  // The anchor: the template path with the fewest lookalikes on the page.
  let anchor = null;
  for (const p of tpl) {
    const pts = cleanPts(p);
    const closed = p.closed && pts.length > 2;
    const len = pathLength(pts, closed);
    if (len < tol * 2) continue;
    const lenTol = tol * 1.5 * Math.max(1, pts.length - 1);
    const cands = candidatesFor(idx, pts.length, closed, len * kLo, len * kHi, lenTol * kHi);
    const score = cands.length * 1000 - pts.length * 10 - Math.min(len, 99);
    if (!anchor || score < anchor.score) anchor = { pts, closed, cands, score };
  }
  if (!anchor) return { hits: [], note: "The symbol is too small to match." };

  const halfW = template.w / 2 + tol, halfH = template.h / 2 + tol;
  const allowedMiss = Math.floor(samples.length * (1 - threshold));
  const hits = [];
  const mirrors = rotate ? [1, -1] : [1];
  let tried = 0;
  const BUDGET = 400000;

  let lastYield = Date.now(), done = 0;
  outer:
  for (const qi of anchor.cands) {
    if (Date.now() - lastYield > (opts.yieldMs ?? 60)) { lastYield = Date.now(); yield done / anchor.cands.length; }
    done++;
    const qpts = cleanPts(paths[qi]);
    for (const order of orderings(qpts.length, anchor.closed)) {
      const Q = order.map((k) => qpts[k]);
      for (const m of mirrors) {
        const T = fit(anchor.pts, Q, m, kHi !== kLo);
        if (!rotate && (Math.abs(T.th) > 0.05)) continue;
        if (T.k < kLo * 0.97 || T.k > kHi * 1.03) continue;
        if (++tried > BUDGET) break outer;
        const ptol = Math.min(tol * T.k, MAX_PAGE_TOL); // the tolerance on the page grows with the copy
        // the anchor itself must sit on its page twin
        let ok = true;
        for (let k = 0; k < anchor.pts.length && ok; k++) {
          const [x, y] = apply(T, anchor.pts[k][0], anchor.pts[k][1]);
          if (Math.hypot(x - Q[k][0], y - Q[k][1]) > ptol * 1.5) ok = false;
        }
        if (!ok) continue;

        // coverage: how much of the template is drawn on the page here?
        let miss = 0, found = 0;
        for (const [sx, sy] of samples) {
          const [x, y] = apply(T, sx, sy);
          if (idx.grid.near(x, y, ptol)) found++; else if (++miss > allowedMiss) break;
        }
        if (miss > allowedMiss) continue;
        const coverage = found / samples.length;

        // precision: is everything else that sits inside the box part of the symbol?
        const [ccx, ccy] = [T.tx, T.ty];
        const reach = Math.hypot(halfW, halfH) * T.k;
        const x0 = Math.floor((ccx - reach) / idx.START_CELL), x1 = Math.floor((ccx + reach) / idx.START_CELL);
        const y0 = Math.floor((ccy - reach) / idx.START_CELL), y1 = Math.floor((ccy + reach) / idx.START_CELL);
        let total = 0, explained = 0;
        for (let gx = x0; gx <= x1; gx++) {
          for (let gy = y0; gy <= y1; gy++) {
            for (const pi of idx.starts.get(gx * 100003 + gy) || []) {
              const path = paths[pi];
              let inside = true;
              for (const [x, y] of path.pts) {
                const [u, v] = unapply(T, x, y);
                if (Math.abs(u) > halfW || Math.abs(v) > halfH) { inside = false; break; }
              }
              if (!inside) continue;
              const pts = [];
              samplePath(path, step * T.k, pts);
              for (const [x, y, w] of pts) {
                const [u, v] = unapply(T, x, y);
                total += w;
                if (tgrid.near(u, v, tol)) explained += w;
              }
            }
          }
        }
        const precision = total > 0 ? explained / total : 1;
        const score = Math.min(coverage, precision);
        if (score < threshold) continue;
        const [px, py] = apply(T, template.pin[0], template.pin[1]);
        hits.push({ x: px, y: py, cx: ccx, cy: ccy, angle: T.th, mirrored: T.m < 0, scale: T.k, score });
      }
    }
  }

  // Several starting points can describe the same copy: keep the best one in each place.
  hits.sort((p, q) => Math.round(q.score * 1000) - Math.round(p.score * 1000) || (p.mirrored - q.mirrored) || Math.abs(p.angle) - Math.abs(q.angle));
  const kept = [];
  for (const h of hits) {
    const radius = Math.max(tol * 2, diag * 0.3) * Math.max(1, h.scale);
    if (!kept.some((k) => Math.hypot(k.cx - h.cx, k.cy - h.cy) < Math.max(radius, Math.max(tol * 2, diag * 0.3) * Math.max(1, k.scale)))) kept.push(h);
  }
  kept.sort((p, q) => p.y - q.y || p.x - q.x);
  return { hits: kept, note: tried > BUDGET ? "The drawing is very busy, so only part of it was searched." : undefined };
}
