// Pin by symbol, driven in a real browser with the made-up patio door sample.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { launch } from "./helpers/browser.mjs";

const root = new URL("..", import.meta.url).pathname;
const PDF = `${root}samples/sample-symbols.pdf`;
let env;
before(async () => { env = await launch(); });
after(async () => env.close());

async function open() {
  const page = await env.browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${env.server.url}/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.setInputFiles("#file-pdf", PDF);
  await page.waitForFunction(() => window.planTasks.state.pdf?.tokens);
  return page;
}
// Drag a box on the sheet; coordinates are PDF points on the 1200 x 800 sample.
async function drawBox(page, x0, y0, x1, y1) {
  const r = await page.$eval("#stage", (e) => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; });
  const f = (x, y) => [r[0] + (x / 1200) * r[2], r[1] + (y / 800) * r[3]];
  const [ax, ay] = f(x0, y0), [bx, by] = f(x1, y1);
  await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(bx, by, { steps: 4 }); await page.mouse.up();
}
const settle = (page) => page.waitForFunction(() => !window.planTasks.state.busy && !/^(Looking|Reading)/.test(document.querySelector("#status").textContent));
async function boxFirstDoor(page) {
  await page.selectOption(".rule select[id$=-kind]", "symbol");
  await page.click(".rule button:has-text('Draw a box around the symbol')");
  await drawBox(page, 130, 135, 232, 200);
  await page.waitForFunction(() => window.planTasks.state.rules[0].symbol);
  await page.waitForFunction(() => window.planTasks.state.pins.length > 0);
  await settle(page);
}
const pins = (page) => page.evaluate(() => window.planTasks.state.pins.map((p) => ({ x: p.x, y: p.y, anchor: p.anchor, title: p.title, px: p.px, py: p.py })));

test("boxing one patio door pins every patio door, turned or mirrored, and no windows", async () => {
  const page = await open();
  await boxFirstDoor(page);
  const found = await pins(page);
  assert.equal(found.length, 5);
  assert.ok(found.every((p) => p.anchor === "symbol"));
  // none of the pins sits on a window
  for (const [wx, wy] of [[1000, 150], [60, 560], [500, 700]]) assert.ok(found.every((p) => Math.hypot(p.x - wx, p.y - wy) > 40));
  // the doors are at these spots (give or take the swing)
  for (const [dx, dy] of [[200, 150], [600, 150], [1140, 560], [300, 700], [700, 700]]) assert.ok(found.some((p) => Math.hypot(p.x - dx, p.y - dy) < 40), `door ${dx},${dy}`);
  assert.match(await page.textContent(".rule-status"), /5 found/);
  assert.equal(await page.$eval("#tb-pins", (e) => e.textContent), "5 / 5");
  await page.close();
});

test("the rule name becomes the task title, and the pin table shows Symbol", async () => {
  const page = await open();
  await boxFirstDoor(page);
  await page.fill(".rule-head input", "Patio door");
  await page.fill('.rule input[id$="-title"]', "Inspect {tag} {n}");
  await page.waitForFunction(() => window.planTasks.state.pins[0]?.title === "Inspect Patio door 1");
  assert.equal(await page.$eval("#pin-rows tr:first-child td:nth-child(6)", (e) => e.textContent), "Symbol");
  await page.close();
});

test("clicking the picture moves the pin to the same spot on every copy", async () => {
  const page = await open();
  await boxFirstDoor(page);
  const before = await pins(page);
  const box = await (await page.$(".sym-preview")).boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.2); // near the top of the picture
  await page.waitForFunction((old) => window.planTasks.state.pins.length === 5 && Math.abs(window.planTasks.state.pins[0].y - old) > 3, before[0].y);
  const after = await pins(page);
  assert.equal(after.length, 5);
  await page.close();
});

test("the match slider and the turned-copies switch change what is found", async () => {
  const page = await open();
  await boxFirstDoor(page);
  await page.uncheck('.rule label.check:has-text("turned or mirrored") input');
  await page.waitForFunction(() => window.planTasks.state.pins.length === 2);
  await page.check('.rule label.check:has-text("turned or mirrored") input');
  await page.waitForFunction(() => window.planTasks.state.pins.length === 5);
  await page.close();
});

test("a box with nothing inside it says so and keeps the old symbol", async () => {
  const page = await open();
  await boxFirstDoor(page);
  await page.click(".rule button:has-text('Draw the box again')");
  await drawBox(page, 800, 300, 860, 340);
  await page.waitForFunction(() => /no lines/i.test(document.querySelector("#status").textContent));
  assert.equal(await page.evaluate(() => window.planTasks.state.pins.length), 5);
  await page.close();
});

test("a symbol rule survives saving to a file, loading it back, and reloading the page", async () => {
  const page = await open();
  await boxFirstDoor(page);
  await page.fill(".rule-head input", "Patio door");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#save-rules")]);
  const path = await dl.path();
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.rules[0].kind, "symbol");
  assert.equal(saved.rules[0].symbol.paths.length, 5);
  assert.equal(saved.rules[0].strict, 3);

  // reload (remembered in the browser), the sheet comes back with the same five pins
  await page.reload();
  await page.setInputFiles("#file-pdf", PDF);
  await page.waitForFunction(() => window.planTasks.state.pins.length === 5);

  // start over, then load the saved file instead
  page.once("dialog", (d) => d.accept());
  await page.click("#start-over");
  await page.waitForFunction(() => window.planTasks.state.pdf === null);
  await page.setInputFiles("#file-pdf", PDF);
  await page.setInputFiles("#load-rules", path);
  await page.waitForFunction(() => window.planTasks.state.pins.length === 5);
  await page.close();
});

test("a damaged symbol in a rules file is ignored instead of breaking the page", async () => {
  const page = await open();
  const bad = { app: "plandot", version: 1, rules: [{ name: "Broken", kind: "symbol", symbol: { w: 10, h: 10, paths: [{ pts: [[0, "x"], [1, 1]] }] }, title: "{tag}" }] };
  await page.setInputFiles("#load-rules", { name: "bad.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bad)) });
  await page.waitForFunction(() => /Loaded 1 rule/.test(document.querySelector("#status").textContent));
  assert.equal(await page.evaluate(() => window.planTasks.state.pins.length), 0);
  assert.match(await page.textContent(".rule-status"), /Draw a box/);
  await page.close();
});

test("a symbol rule can be exported to the import file with the right positions", async () => {
  const page = await open();
  await boxFirstDoor(page);
  await page.setInputFiles("#file-xlsx", `${root}samples/sample-import-template.xlsx`);
  await page.fill("#plan-name", "Ground floor plan");
  await page.waitForFunction(() => !document.querySelector("#dl-import").disabled);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#dl-import")]);
  const file = `${tmpdir()}/plandot-symbols-${process.pid}.xlsx`; // openpyxl wants the .xlsx ending
  await dl.saveAs(file);
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("python3", ["-I", "-c", `
import sys, openpyxl
ws = openpyxl.load_workbook(sys.argv[1]).worksheets[0]
rows = [[c.value for c in r] for r in ws.iter_rows()]
hdr = next(i for i, r in enumerate(rows) if "X Pos (%)" in r)
x, y = rows[hdr].index("X Pos (%)"), rows[hdr].index("Y Pos (%)")
print([(round(r[x], 1), round(r[y], 1)) for r in rows[hdr + 1:] if r[x] is not None])
`, file], { encoding: "utf8" });
  const got = JSON.parse(out.replace(/\(/g, "[").replace(/\)/g, "]").replace(/'/g, '"'));
  assert.equal(got.length, 5);
  assert.ok(got.every(([a, b]) => a > 0 && a < 100 && b > 0 && b < 100));
  await page.close();
});
