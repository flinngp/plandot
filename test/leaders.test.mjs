import test from "node:test";
import assert from "node:assert/strict";
import { buildGeometry, findAnchor, findAnchors, polygonArea, shapesFromOperatorList, DOT } from "../js/leaders.js";

// ---- builders for synthetic drawings (viewport points, y down) ----------------------------

const BLACK = 0;
const diamond = (cx, cy, half = 12.4) => ({
  pts: [[cx - half, cy], [cx, cy - half], [cx + half, cy], [cx, cy + half], [cx - half, cy]],
  closed: true,
  color: BLACK,
});
const circle = (cx, cy, r = 12) => ({
  pts: Array.from({ length: 32 }, (_, i) => [cx + r * Math.cos((i / 32) * 2 * Math.PI), cy + r * Math.sin((i / 32) * 2 * Math.PI)]),
  closed: true,
  color: BLACK,
});
const line = (...pts) => ({ pts, closed: false, color: BLACK });
/** A dot drawn the way the sample drawing does it: a fan of tiny triangles around a centre. */
const fan = (cx, cy, r = 2.25, n = 22) =>
  Array.from({ length: n }, (_, k) => {
    const a = (k / n) * 2 * Math.PI, b = ((k + 1) / n) * 2 * Math.PI;
    const pts = [[cx, cy], [cx + r * Math.cos(a), cy + r * Math.sin(a)], [cx + r * Math.cos(b), cy + r * Math.sin(b)]];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return { bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], area: polygonArea(pts) };
  });
const near = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

// Callout at (100,100); leader goes left from the diamond's tip (87.6,100) to x=78.6, then down to the dot.
const calloutWithDot = () => ({
  strokes: [diamond(100, 100), line([78.6, 128.8], [78.6, 100], [87.6, 100])],
  fills: fan(78.6, 131.05),
});

test("pins the dot at the end of an elbow leader, whichever way the line was drawn", () => {
  for (const reversed of [false, true]) {
    const shapes = calloutWithDot();
    if (reversed) shapes.strokes[1].pts.reverse();
    const a = findAnchor(buildGeometry(shapes), { x: 100, y: 100 });
    assert.equal(a.kind, "dot");
    near(a.x, 78.6);
    near(a.y, 131.05);
  }
});

test("a tag with two leaders gives two places, one per dot, in a steady order", () => {
  // Second leader leaves the diamond's right tip (112.4,100) and runs to a dot at (150,100).
  const shapes = calloutWithDot();
  shapes.strokes.push(line([112.4, 100], [147.75, 100]));
  shapes.fills.push(...fan(150, 100));
  const found = findAnchors(buildGeometry(shapes), { x: 100, y: 100 });
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((a) => a.kind), ["dot", "dot"]);
  near(found[0].y, 100); // sorted top to bottom, so the dot at y=100 comes first
  near(found[0].x, 150);
  near(found[1].x, 78.6);
  near(found[1].y, 131.05);
});

test("two leaders that end on the same dot count once", () => {
  const shapes = calloutWithDot();
  shapes.strokes.push(line([87.6, 100], [78.6, 100], [78.6, 128.8])); // drawn a second time
  assert.equal(findAnchors(buildGeometry(shapes), { x: 100, y: 100 }).length, 1);
});

test("leaders that end without a dot never multiply the pins", () => {
  const shapes = { strokes: [diamond(100, 100), line([87.6, 100], [60, 100]), line([112.4, 100], [140, 100])], fills: [] };
  const found = findAnchors(buildGeometry(shapes), { x: 100, y: 100 });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "leader");
});

test("a leader drawn as several joined pieces still reaches its dot", () => {
  const shapes = {
    strokes: [diamond(100, 100), line([87.6, 100], [78.6, 100]), line([78.6, 100], [78.6, 128.8])],
    fills: fan(78.6, 131.05),
  };
  const a = findAnchor(buildGeometry(shapes), { x: 100, y: 100 });
  assert.equal(a.kind, "dot");
  near(a.y, 131.05);
});

test("a leader with no dot gives the end of the leader", () => {
  const shapes = { strokes: [diamond(100, 100), line([87.6, 100], [60, 100])], fills: [] };
  const a = findAnchor(buildGeometry(shapes), { x: 100, y: 100 });
  assert.equal(a.kind, "leader");
  near(a.x, 60);
  near(a.y, 100);
});

test("a callout with no leader has no anchor, so the caller falls back to the text", () => {
  const geo = buildGeometry({ strokes: [diamond(100, 100)], fills: fan(50, 50) });
  assert.equal(findAnchor(geo, { x: 100, y: 100 }), null);
});

test("a tag that is not inside any outline has no anchor", () => {
  const geo = buildGeometry(calloutWithDot());
  assert.equal(findAnchor(geo, { x: 300, y: 300 }), null);
});

test("each callout gets its own dot, not the nearest one", () => {
  // Callout B's dot sits much closer to callout A than A's own dot does.
  const a = calloutWithDot();
  const bStrokes = [diamond(100, 200), line([87.6, 200], [60, 200], [60, 105])];
  const geo = buildGeometry({ strokes: [...a.strokes, ...bStrokes], fills: [...a.fills, ...fan(60, 103)] });
  const forA = findAnchor(geo, { x: 100, y: 100 });
  const forB = findAnchor(geo, { x: 100, y: 200 });
  near(forA.x, 78.6);
  near(forA.y, 131.05);
  near(forB.x, 60);
  near(forB.y, 103);
});

test("an arrowhead (one filled triangle) or a square block is not a dot", () => {
  const triangle = [[60, 100], [66, 97], [66, 103]];
  const tri = { bbox: [60, 97, 66, 103], area: polygonArea(triangle) };
  const square = { bbox: [58, 98, 62, 102], area: 16 };
  for (const fill of [tri, square]) {
    const geo = buildGeometry({ strokes: [diamond(100, 100), line([87.6, 100], [61, 100])], fills: [fill] });
    const a = findAnchor(geo, { x: 100, y: 100 });
    assert.equal(a.kind, "leader", "falls back to the leader end rather than inventing a dot");
  }
});

test("a dot that is far from the end of the leader is ignored", () => {
  const geo = buildGeometry({ strokes: [diamond(100, 100), line([87.6, 100], [60, 100])], fills: fan(60, 112) });
  assert.equal(findAnchor(geo, { x: 100, y: 100 }).kind, "leader");
});

test("round callouts work too, and the smallest outline around the tag is the callout", () => {
  const big = { pts: [[40, 60], [160, 60], [160, 140], [40, 140], [40, 60]], closed: true, color: BLACK };
  const geo = buildGeometry({
    strokes: [big, circle(100, 100), line([88, 100], [70, 100], [70, 120])],
    fills: fan(70, 122.25),
  });
  const a = findAnchor(geo, { x: 100, y: 100 });
  assert.equal(a.kind, "dot");
  near(a.x, 70);
  near(a.y, 122.25);
});

test("a leader line in another colour that merely ends nearby is not followed", () => {
  const stray = { pts: [[78.6, 128.8], [20, 128.8]], closed: false, color: 0xff0000 };
  const shapes = { strokes: [diamond(100, 100), line([87.6, 100], [78.6, 100], [78.6, 120]), stray], fills: [] };
  const a = findAnchor(buildGeometry(shapes), { x: 100, y: 100 });
  assert.equal(a.kind, "leader");
  near(a.y, 120);
});

test("dot size limits are sane", () => {
  assert.ok(DOT.min < DOT.max && DOT.fillMin < DOT.fillMax);
});

// ---- pdf.js operator list -> shapes ---------------------------------------------------------

const OPS = { save: 10, restore: 11, transform: 12, constructPath: 91, stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27, setFillRGBColor: 59, setStrokeRGBColor: 58, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75 };
const path = (...cmds) => new Float32Array(cmds.flat());
const MOVE = 0, LINE = 1, CURVE = 2, CLOSE = 4;
const VIEW = [1, 0, 0, -1, 0, 100]; // like pdf.js: flips y on a 100pt-high page

test("operator list: nested transforms are applied inside-out and the viewport flips y", () => {
  const ops = {
    fnArray: [OPS.save, OPS.transform, OPS.save, OPS.transform, OPS.constructPath, OPS.restore, OPS.constructPath, OPS.restore],
    argsArray: [
      null,
      [1, 0, 0, 1, 10, 0], // translate x by 10 (outer)
      null,
      [2, 0, 0, 2, 0, 0], // scale by 2 (inner)
      [OPS.stroke, [path([MOVE, 5, 5], [LINE, 7, 5])], null], // inside both: (5,5) -> (10,10) -> (20,10)
      null,
      [OPS.stroke, [path([MOVE, 5, 5], [LINE, 7, 5])], null], // outer only: (5,5) -> (15,5)
      null,
    ],
  };
  const { strokes } = shapesFromOperatorList(ops, OPS, VIEW);
  assert.deepEqual(strokes[0].pts, [[20, 90], [24, 90]]);
  assert.deepEqual(strokes[1].pts, [[15, 95], [17, 95]]);
});

test("operator list: closePath makes a closed outline, colours follow save/restore", () => {
  const ops = {
    fnArray: [OPS.save, OPS.setStrokeRGBColor, OPS.constructPath, OPS.restore, OPS.constructPath],
    argsArray: [
      null,
      [255, 0, 0],
      [OPS.stroke, [path([MOVE, 0, 0], [LINE, 10, 0], [LINE, 10, 10], [CLOSE])], null],
      null,
      [OPS.stroke, [path([MOVE, 0, 0], [LINE, 10, 0])], null],
    ],
  };
  const { strokes } = shapesFromOperatorList(ops, OPS, VIEW);
  assert.equal(strokes[0].closed, true);
  assert.equal(strokes[0].color, 0xff0000);
  assert.equal(strokes[1].closed, false);
  assert.equal(strokes[1].color, 0, "colour goes back to black after restore");
});

test("operator list: only small dark fills are kept, and a filled circle made of curves is flattened", () => {
  const k = 0.5523 * 2;
  const circle2 = path([MOVE, 12, 5], [CURVE, 12, 5 + k, 10 + k, 7, 10, 7], [CURVE, 10 - k, 7, 8, 5 + k, 8, 5], [CURVE, 8, 5 - k, 10 - k, 3, 10, 3], [CURVE, 10 + k, 3, 12, 5 - k, 12, 5], [CLOSE]);
  const ops = {
    fnArray: [OPS.constructPath, OPS.setFillRGBColor, OPS.constructPath, OPS.constructPath],
    argsArray: [
      [OPS.fill, [circle2], null], // black by default
      [200, 200, 200],
      [OPS.fill, [circle2], null], // light grey: not a dot
      [OPS.fill, [path([MOVE, 0, 0], [LINE, 80, 0], [LINE, 80, 80], [CLOSE])], null], // far too big
    ],
  };
  const { fills } = shapesFromOperatorList(ops, OPS, VIEW);
  assert.equal(fills.length, 1);
  const geo = buildGeometry({ strokes: [], fills });
  assert.equal(geo.dots.length, 1);
  near(geo.dots[0].x, 10, 0.1);
  near(geo.dots[0].y, 95, 0.1);
});
