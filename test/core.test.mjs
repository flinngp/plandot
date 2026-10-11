import test from "node:test";
import assert from "node:assert/strict";
import { extractTokens, compileMatcher, detect, renderTemplate, dedupeTokens, chunk, IMPORT_LIMIT, pinMode, newRule } from "../js/core.js";

const W = 600, H = 400;
// Fake pdf.js items on an upright page; user space origin bottom-left, viewport top-left.
const project = (x, y) => [x, H - y];
const item = (str, x, yBaselineUser, width = str.length * 6, height = 10) => ({
  str, width, height, transform: [10, 0, 0, 10, x, yBaselineUser],
});

test("splits items into words and puts the centre mid-word, slightly above the baseline", () => {
  const t = extractTokens([item("A1", 100, 300, 12)], project);
  assert.equal(t.length, 1);
  assert.equal(t[0].text, "A1");
  assert.ok(Math.abs(t[0].x - 106) < 0.01);
  assert.ok(Math.abs(t[0].y - (H - 303.5)) < 0.01);
});

test("splits a multi-word item and positions each word", () => {
  const t = extractTokens([item("A1 1-102", 0, 100, 48)], project);
  assert.deepEqual(t.map((x) => x.text), ["A1", "1-102"]);
  assert.ok(t[0].x < t[1].x);
});

test("ignores whitespace-only items and items without a transform", () => {
  assert.equal(extractTokens([{ str: "  ", width: 3, height: 10, transform: [10, 0, 0, 10, 0, 0] }, { str: "x" }], project).length, 0);
});

test("rotated text is centred along its own direction", () => {
  // text running upward (90 degrees): a=0,b=10,c=-10,d=0
  const t = extractTokens([{ str: "A1", width: 12, height: 10, transform: [0, 10, -10, 0, 50, 50] }], project);
  assert.ok(Math.abs(t[0].ux - (50 - 3.5)) < 0.01); // perp offset sideways
  assert.ok(Math.abs(t[0].uy - 56) < 0.01); // half the width along the direction
});

test("overprinted duplicates collapse, distinct neighbours do not", () => {
  const t = dedupeTokens([
    { text: "A1", x: 10, y: 10 }, { text: "A1", x: 10.5, y: 10.4 }, { text: "A1", x: 30, y: 10 }, { text: "A2", x: 10, y: 10 },
  ]);
  assert.equal(t.length, 3);
});

test("exact tags are whole-word and regex characters are escaped", () => {
  const m = compileMatcher({ tags: "A1, A2; DB.04" });
  assert.ok(m.test("A1") && m.test("A2") && m.test("DB.04"));
  assert.ok(!m.test("A10") && !m.test("A1.01") && !m.test("DBx04") && !m.test("A3"));
});

test("pattern mode is anchored, and a bad pattern reports an error instead of throwing", () => {
  const m = compileMatcher({ tags: "A[1-3]", usePattern: true });
  assert.ok(m.test("A2") && !m.test("A22") && !m.test("XA2"));
  const bad = compileMatcher({ tags: "A(", usePattern: true });
  assert.match(bad.error, /valid pattern/);
  assert.equal(compileMatcher({ tags: "  " }).empty, true);
});

test("renderTemplate fills known fields, blanks unknown ones and tidies spaces", () => {
  assert.equal(renderTemplate("Install {tag} {room_label} {nope}", { tag: "A1", room_label: "" }), "Install A1");
  assert.equal(renderTemplate("", {}), "");
});

const rules = [
  { id: "s", name: "Sockets", tags: "A1, A2", title: "Install socket {tag} {room_label}", columns: {} },
  { id: "t", name: "TV", tags: "B1", title: "TV {tag}", columns: {} },
];
const tokens = [
  { text: "A1", x: 100, y: 100, ux: 100, uy: 300 },
  { text: "1-105", x: 112, y: 118, ux: 112, uy: 282 },
  { text: "A2", x: 300, y: 50, ux: 300, uy: 350 },
  { text: "A3", x: 400, y: 60, ux: 400, uy: 340 },
  { text: "B1", x: 560, y: 300, ux: 560, uy: 100 },
];

test("detect: ordering, percentages, titles and rule names", () => {
  const { pins } = detect({ tokens, width: W, height: H, rules, settings: { roomPattern: "\\d-\\d{3}", roomDistance: 10 } });
  assert.deepEqual(pins.map((p) => p.tag), ["A2", "A1", "B1"]); // rule order, then top to bottom
  assert.deepEqual(pins.map((p) => p.n), [1, 2, 3]);
  const a1 = pins[1];
  assert.equal(a1.room, "1-105");
  assert.equal(a1.title, "Install socket A1 (Room 1-105)");
  assert.ok(Math.abs(a1.px - (100 / W) * 100) < 1e-9 && Math.abs(a1.py - 25) < 1e-9);
  assert.equal(pins[0].title, "Install socket A2"); // no room nearby: no stray brackets
});

test("detect: search area keeps only tokens inside it", () => {
  const { pins } = detect({ tokens, width: W, height: H, rules, settings: { area: [0, 0, 0.8, 1] } });
  assert.deepEqual(pins.map((p) => p.tag), ["A2", "A1"]); // B1 at x=560 is outside 80% of 600
});

test("detect: room search respects the distance limit", () => {
  const { pins } = detect({ tokens, width: W, height: H, rules, settings: { roomPattern: "\\d-\\d{3}", roomDistance: 1 } });
  assert.ok(pins.every((p) => p.room === "")); // 1% of 600 = 6pt, room label is ~16pt away
});

test("detect: a broken rule reports an error and does not stop the others", () => {
  const { pins, errors } = detect({ tokens, width: W, height: H, rules: [{ id: "x", name: "Bad", tags: "(", usePattern: true, title: "x" }, rules[1]], settings: {} });
  assert.ok(errors.x);
  assert.deepEqual(pins.map((p) => p.tag), ["B1"]);
});

test("detect: a bad room pattern is reported and room matching is skipped", () => {
  const { pins, errors } = detect({ tokens, width: W, height: H, rules, settings: { roomPattern: "(" } });
  assert.ok(errors.room);
  assert.equal(pins.length, 3);
});

test("chunk: Fieldwire's 500-task limit splits big exports and keeps order", () => {
  assert.equal(IMPORT_LIMIT, 500);
  const rows = Array.from({ length: 1203 }, (_, i) => i);
  const parts = chunk(rows);
  assert.deepEqual(parts.map((p) => p.length), [500, 500, 203]);
  assert.deepEqual(parts.flat(), rows);
  assert.deepEqual(chunk(rows.slice(0, 500)).length, 1);
  assert.deepEqual(chunk([]), []);
});

// ---- pinning on the dot at the end of the leader ----------------------------------------------------
const dotAt = (x, y, extra = {}) => ({ kind: "dot", x, y, ux: x, uy: H - y, ...extra });

test("pinMode: dot unless a rule says text, and new rules default to dot", () => {
  assert.equal(pinMode({}), "dot");
  assert.equal(pinMode({ pinAt: "dot" }), "dot");
  assert.equal(pinMode({ pinAt: "text" }), "text");
  assert.equal(newRule().pinAt, "dot");
});

test("detect: pins move to the dot, keep a link to the callout, and fall back to the text when there is no leader", () => {
  const anchors = { "100,100": [dotAt(70, 130)], "300,50": [] }; // A3 and B1 are not listed: no leader
  const { pins } = detect({ tokens, width: W, height: H, rules, settings: {}, anchorFor: (t) => anchors[`${t.x},${t.y}`] ?? [] });
  const a1 = pins.find((p) => p.tag === "A1");
  assert.deepEqual([a1.x, a1.y, a1.ux, a1.uy], [70, 130, 70, H - 130]);
  assert.deepEqual([a1.tx, a1.ty, a1.anchor], [100, 100, "dot"]);
  assert.equal(a1.px, (70 / W) * 100);
  assert.equal(a1.py, (130 / H) * 100);
  const a2 = pins.find((p) => p.tag === "A2");
  assert.deepEqual([a2.x, a2.y, a2.anchor], [300, 50, "text"], "no leader found: stays on the callout text");
});

test("detect: a callout with two dots gives two pins with their own keys, numbers and positions", () => {
  const two = { "100,100": [dotAt(80, 100), dotAt(150, 100)] };
  const { pins } = detect({ tokens, width: W, height: H, rules, settings: {}, anchorFor: (t) => two[`${t.x},${t.y}`] ?? [] });
  const a1 = pins.filter((p) => p.tag === "A1");
  assert.equal(a1.length, 2);
  assert.deepEqual(a1.map((p) => [p.anchorIndex, p.anchorCount]), [[1, 2], [2, 2]]);
  assert.equal(new Set(pins.map((p) => p.key)).size, pins.length, "keys stay unique");
  assert.deepEqual(pins.map((p) => p.n), pins.map((_, i) => i + 1));
  assert.deepEqual(a1.map((p) => p.vars.n), [2, 3], "{n} counts pins within the rule: A2 is higher on the sheet, so it is the first");
});

test("detect: a rule set to text ignores the dots, and a pin's key does not depend on where it is pinned", () => {
  const anchors = { "100,100": [dotAt(70, 130)] };
  const anchorFor = (t) => anchors[`${t.x},${t.y}`] ?? [];
  const textRules = rules.map((r) => ({ ...r, pinAt: "text" }));
  const onText = detect({ tokens, width: W, height: H, rules: textRules, settings: {}, anchorFor }).pins.find((p) => p.tag === "A1");
  const onDot = detect({ tokens, width: W, height: H, rules, settings: {}, anchorFor }).pins.find((p) => p.tag === "A1");
  assert.deepEqual([onText.x, onText.y, onText.anchor], [100, 100, "text"]);
  assert.equal(onText.key, onDot.key);
});

test("detect: the room comes from the dot, not the callout text", () => {
  const withRooms = [...tokens, { text: "2-201", x: 70, y: 135, ux: 70, uy: H - 135 }];
  const anchors = { "100,100": [dotAt(70, 130)] };
  const run = (anchorFor) => detect({ tokens: withRooms, width: W, height: H, rules, settings: { roomPattern: "\\d-\\d{3}", roomDistance: 10 }, anchorFor }).pins.find((p) => p.tag === "A1");
  assert.equal(run(null).room, "1-105", "on the text the closest room label is the one beside the callout");
  assert.equal(run((t) => anchors[`${t.x},${t.y}`] ?? []).room, "2-201", "on the dot it is the one beside the dot");
});
