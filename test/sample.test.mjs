// The made-up sample files in samples/ through the real page: every callout is found, every leader
// ends on the dot the generator drew, and the import file carries those positions.
// If you change samples/make_sample_drawing.py, update EXPECTED to match.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launch } from "./helpers/browser.mjs";

const samples = join(fileURLToPath(new URL("..", import.meta.url)), "samples");
const W = 2448, H = 1584;

// tag, x, y of the dot (points from the top-left); "text" marks the callout with no leader.
const EXPECTED = [
  ["A1", 480, 330], ["A2", 900, 420], ["A2", 1100, 340], ["A3", 520, 800], ["A1", 1240, 1150], ["A2", "text", "text"],
  ["B1", 1000, 1130], ["B1", 1210, 880], ["B1", 1400, 880],
  ["C1", 440, 250], ["C2", 940, 250], ["C3", 1440, 1250], ["C1", 300, 620],
];

let env, page;
const errors = [];
before(async () => {
  env = await launch();
  page = await env.browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${env.server.url}/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});
after(async () => env.close());

test("the sample drawing, template and rules give 13 pins: 12 on dots, 1 on a callout with no leader", async () => {
  await page.setInputFiles("#file-pdf", join(samples, "sample-drawing.pdf"));
  await page.waitForSelector("#sheet:not([hidden])");
  await page.setInputFiles("#file-xlsx", join(samples, "sample-import-template.xlsx"));
  await page.setInputFiles("#load-rules", join(samples, "sample-rules.json"));
  await page.fill("#plan-name", "Sample plan");
  await page.waitForFunction(() => window.planTasks.state.pins.length === 13, null, { timeout: 20000 });
  await page.waitForFunction(() => !window.planTasks.state.busy);

  const pins = await page.evaluate(() => window.planTasks.state.pins.map((p) => ({ tag: p.tag, anchor: p.anchor, x: p.x, y: p.y, room: p.room })));
  assert.equal(pins.length, EXPECTED.length);
  assert.equal(pins.filter((p) => p.anchor === "dot").length, 12);
  assert.equal(pins.filter((p) => p.anchor === "text").length, 1);

  // Each expected dot has exactly one pin on it, within half a point, with the right tag.
  for (const [tag, x, y] of EXPECTED) {
    if (x === "text") continue;
    const hit = pins.filter((p) => p.anchor === "dot" && p.tag === tag && Math.hypot(p.x - x, p.y - y) < 0.5);
    assert.equal(hit.length, 1, `${tag} at ${x},${y}`);
  }
  // Room labels are "the nearest one within range": pins well inside a room get it, pins out on the
  // outer walls may be too far from any label to get one.
  const roomAt = (x, y) => pins.find((p) => p.anchor === "dot" && Math.hypot(p.x - x, p.y - y) < 0.5)?.room;
  assert.equal(roomAt(480, 330), "1-101");
  assert.equal(roomAt(520, 800), "1-104");
});

test("the import file has one row per pin, the custom Zone column filled, and positions inside the sheet", async () => {
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#dl-import")]);
  const dir = mkdtempSync(join(tmpdir(), "plandot-sample-"));
  const file = join(dir, "import.xlsx");
  await download.saveAs(file);
  const code = `
import json, sys, openpyxl
ws = openpyxl.load_workbook(sys.argv[1]).active
hdr = {c.value: c.column for c in ws[4] if c.value}
rows = []
for r in range(5, ws.max_row + 1):
    t = ws.cell(r, hdr["Title"]).value
    if t:
        rows.append({k: ws.cell(r, hdr[k]).value for k in ("ID", "Title", "Category", "Plan", "X Pos (%)", "Y Pos (%)", "Zone")})
print(json.dumps(rows))`;
  const rows = JSON.parse(execFileSync("python3", ["-I", "-c", code, file], { encoding: "utf8" }));
  assert.equal(rows.length, 13);
  assert.ok(rows.every((r) => r.ID == null && r.Plan === "Sample plan" && r.Zone === "Ground floor"), "blank IDs, plan name and Zone on every row");
  assert.ok(rows.every((r) => r["X Pos (%)"] > 0 && r["X Pos (%)"] < 100 && r["Y Pos (%)"] > 0 && r["Y Pos (%)"] < 100));
  assert.deepEqual([...new Set(rows.map((r) => r.Category))].sort(), ["Carpentry", "Electrical"]);
  // The A1 dot at (480, 330) is exported as a percentage of the sheet.
  const a1 = rows.find((r) => r.Title.startsWith("Install socket outlet A1") && Math.abs(r["X Pos (%)"] - (480 / W) * 100) < 0.05);
  assert.ok(a1, "A1 exported at its dot");
  assert.ok(Math.abs(a1["Y Pos (%)"] - (330 / H) * 100) < 0.05);
  assert.deepEqual(errors, []);
});
