import test from "node:test";
import assert from "node:assert/strict";
import { captureSymbol, findSymbols, sanitizeTemplate } from "../js/symbols.js";
import { detect, newRule, ruleKind } from "../js/core.js";

// A made-up "door": a frame, two panels and a swing, as separate paths.
const door = () => [
  { pts: [[-24, -4], [24, -4], [24, 4], [-24, 4]], closed: true },
  { pts: [[-22, -1.2], [2, -1.2]], closed: false },
  { pts: [[-2, 1.2], [22, 1.2]], closed: false },
  { pts: [[-24, 4], [-24, 40]], closed: false },
  { pts: Array.from({ length: 9 }, (_, i) => { const a = (i / 8) * (Math.PI / 2); return [-24 + 36 * Math.sin(a), 4 + 36 * Math.cos(a) - 0]; }), closed: false },
];
const window_ = () => [
  { pts: [[-24, -4], [24, -4], [24, 4], [-24, 4]], closed: true },
  { pts: [[-24, 0], [24, 0]], closed: false },
];
function place(paths, x, y, deg = 0, mirror = false) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return paths.map((p) => ({ closed: p.closed, pts: p.pts.map(([px, py]) => { const mx = mirror ? -px : px; return [x + c * mx - s * py, y + s * mx + c * py]; }) }));
}
// Where the middle of a box drawn around the door at (0,0) ends up on a copy placed at x, y.
const centreOf = (x, y, deg = 0, mirror = false) => place([{ pts: [[0, 25], [0, 25]], closed: false }], x, y, deg, mirror)[0].pts[0];
const sheet = (...parts) => parts.flat();
const wall = (x1, y1, x2, y2) => ({ pts: [[x1, y1], [x2, y2]], closed: false });

const PLAN = sheet(
  place(door(), 200, 150), place(door(), 600, 150), place(door(), 900, 450, 90), place(door(), 300, 600, 180), place(door(), 700, 620, 0, true),
  place(window_(), 1000, 150), place(window_(), 150, 420, 90),
  [wall(60, 150, 176, 150), wall(224, 150, 576, 150), wall(60, 700, 1140, 700)],
);
const box = (x, y, w = 140, h = 130) => [x - 70, y - 40, x - 70 + w, y - 40 + h];

test("a boxed symbol is cut out with its lines relative to the box centre", () => {
  const { template, error } = captureSymbol(PLAN, box(200, 150));
  assert.equal(error, undefined);
  assert.equal(template.paths.length, 5); // the wall lines cross the box edge, so they are left out
  assert.equal(template.w, 140);
  assert.ok(Math.abs(template.pin[0]) < 70 && Math.abs(template.pin[1]) < 65);
});

test("every copy is found: upright, turned, upside down and mirrored; windows are not", () => {
  const { template } = captureSymbol(PLAN, box(200, 150));
  const { hits } = findSymbols(PLAN, template);
  assert.equal(hits.length, 5);
  const centres = hits.map((h) => [Math.round(h.cx), Math.round(h.cy)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const wanted = [centreOf(200, 150), centreOf(300, 600, 180), centreOf(600, 150), centreOf(700, 620, 0, true), centreOf(900, 450, 90)].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  centres.forEach((c, i) => { assert.ok(Math.hypot(c[0] - wanted[i][0], c[1] - wanted[i][1]) < 1, `${c} vs ${wanted[i]}`); });
  assert.equal(hits.filter((h) => h.mirrored).length >= 1, true);
  assert.ok(hits.every((h) => h.score > 0.95));
});

test("the pin lands on the same spot of every copy, however it is turned", () => {
  const { template } = captureSymbol(PLAN, box(200, 150));
  template.pin = [10, 20]; // a chosen spot
  const { hits } = findSymbols(PLAN, template);
  // For the upright copy at (200,150) the spot is at +10,+20 from the box centre.
  const upright = hits.find((h) => Math.abs(h.cx - 200) < 1 && Math.abs(h.cy - 175) < 1);
  assert.ok(Math.hypot(upright.x - (upright.cx + 10), upright.y - (upright.cy + 20)) < 0.01);
  // For the copy turned 90 degrees clockwise, (10, 20) becomes (-20, 10).
  const turned = hits.find((h) => Math.abs(h.cx - 875) < 1);
  assert.ok(Math.hypot(turned.x - (turned.cx - 20), turned.y - (turned.cy + 10)) < 0.01, `${turned.x - turned.cx}, ${turned.y - turned.cy}`);
});

test("turning rotation off finds only copies the same way up", () => {
  const { template } = captureSymbol(PLAN, box(200, 150));
  const { hits } = findSymbols(PLAN, template, { rotate: false });
  assert.deepEqual(hits.map((h) => Math.round(h.cx)).sort((a, b) => a - b), [200, 600]);
});

test("boxing a window finds the windows and not the doors", () => {
  const { template } = captureSymbol(PLAN, [1000 - 40, 150 - 20, 1000 + 40, 150 + 20]);
  const { hits } = findSymbols(PLAN, template);
  assert.equal(hits.length, 2);
});

test("a copy with an extra line inside the box is rejected when strict, accepted when loose", () => {
  const extra = sheet(PLAN, [{ pts: [[100, 100], [100 + 20, 100 + 15]], closed: false }, ...place([{ pts: [[-10, 10], [10, 25]], closed: false }], 600, 150)]);
  const { template } = captureSymbol(PLAN, box(200, 150));
  const strict = findSymbols(extra, template, { level: 5 }).hits.map((h) => Math.round(h.cx));
  assert.ok(!strict.includes(600), "exact should reject the copy with an extra stroke");
  const loose = findSymbols(extra, template, { level: 1 }).hits.map((h) => Math.round(h.cx));
  assert.ok(loose.includes(600));
});

test("a copy missing part of the symbol is only found when loose", () => {
  const short = PLAN.filter((p) => !(p.pts.length === 2 && Math.abs(p.pts[0][0] - 576) < 1)); // keep walls
  const damaged = sheet(short.filter((_, i) => i !== 9)); // drop one stroke of the second door
  const { template } = captureSymbol(PLAN, box(200, 150));
  const exact = findSymbols(damaged, template, { level: 5 }).hits.length;
  const loose = findSymbols(damaged, template, { level: 1 }).hits.length;
  assert.ok(loose >= exact);
});

test("clear errors for an empty box and for a box with too much in it", () => {
  assert.match(captureSymbol(PLAN, [0, 0, 10, 10]).error, /no lines/i);
  const many = Array.from({ length: 400 }, (_, i) => ({ pts: [[i % 50, Math.floor(i / 50)], [i % 50 + 0.5, Math.floor(i / 50) + 0.5]], closed: false }));
  assert.match(captureSymbol(many, [-1, -1, 60, 20]).error, /too much/i);
});

test("a big busy sheet is searched quickly", () => {
  const lines = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const spots = [[500, 500], [1500, 900], [2000, 300]];
  for (let i = 0; i < 60000; i++) {
    const x = rnd() * 2400, y = rnd() * 1500, a = rnd() * 6.28, l = 1 + rnd() * 30;
    if (spots.some(([sx, sy]) => Math.hypot(x - sx, y - sy) < 90)) continue; // keep the doors' surroundings clear, as walls would
    lines.push({ pts: [[x, y], [x + Math.cos(a) * l, y + Math.sin(a) * l]], closed: false });
  }
  const big = sheet(lines, place(door(), 500, 500), place(door(), 1500, 900, 270), place(door(), 2000, 300, 45, true));
  const { template } = captureSymbol(big, [470, 490, 530, 545]);
  const t0 = Date.now();
  const { hits } = findSymbols(big, template);
  const ms = Date.now() - t0;
  assert.equal(hits.length, 3);
  assert.ok(ms < 5000, `took ${ms} ms`);
});

test("rules files: damaged symbols are dropped, good ones are kept", () => {
  const { template } = captureSymbol(PLAN, box(200, 150));
  assert.ok(sanitizeTemplate(JSON.parse(JSON.stringify(template))));
  for (const bad of [null, 5, {}, { paths: "x" }, { w: 1, h: 1, paths: [{ pts: [[0, "a"], [1, 1]] }] }, { w: -1, h: 1, paths: [{ pts: [[0, 0], [1, 1]] }] }, { w: 1, h: 1, paths: [{ pts: [[0, 0], [1e9, 1]] }] }]) assert.equal(sanitizeTemplate(bad), null);
  const huge = { w: 10, h: 10, paths: Array.from({ length: 5000 }, () => ({ pts: [[0, 0], [1, 1]] })) };
  assert.ok(sanitizeTemplate(huge).paths.length <= 300);
});

test("symbol rules turn into pins, filtered by the search area, titled with the rule name", () => {
  const rule = { ...newRule(1), name: "Patio door", kind: "symbol", title: "Check {tag} {n}" };
  assert.equal(ruleKind(rule), "symbol");
  assert.equal(ruleKind(newRule(2)), "text");
  const symbolHits = { [rule.id]: [{ x: 100, y: 100, ux: 100, uy: 700, cx: 100, cy: 100 }, { x: 900, y: 500, ux: 900, uy: 300, cx: 900, cy: 500 }] };
  const all = detect({ tokens: [], width: 1000, height: 800, rules: [rule], symbolHits });
  assert.equal(all.pins.length, 2);
  assert.equal(all.pins[0].title, "Check Patio door 1");
  assert.equal(all.pins[0].anchor, "symbol");
  assert.equal(all.pins[1].px, 90);
  const area = detect({ tokens: [], width: 1000, height: 800, rules: [rule], symbolHits, settings: { area: [0, 0, 0.5, 0.5] } });
  assert.equal(area.pins.length, 1);
  // A symbol rule with no symbol yet gives no pins and no errors.
  assert.deepEqual(detect({ tokens: [], width: 10, height: 10, rules: [rule] }).pins, []);
});
