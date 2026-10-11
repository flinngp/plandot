// Leader-and-dot pinning through the real pipeline: pdf.js reads a drawing built with pdf-lib,
// the page finds each callout's dot, and the import workbook carries the dot's position.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { launch } from "./helpers/browser.mjs";
import { makeTemplate } from "./helpers/make-template.mjs";

let env, harness;
before(async () => {
  env = await launch();
  harness = await env.browser.newPage();
  await harness.goto(`${env.server.url}/test/harness.html`);
  await harness.waitForFunction(() => window.ready);
});
after(async () => env.close());

const W = 600, H = 400;
const near = (a, b, tol = 0.3) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

/**
 * A 600 x 400 sheet with three callouts drawn the way CAD drawings do it:
 *  - A1: diamond, elbow leader (left, then down) ending on a dot at (270, 130.25)
 *  - A2: diamond, no leader at all
 *  - A3: diamond with two leaders, to dots at (380, 300) and (470, 300)
 * y values are measured from the top of the sheet.
 */
async function makeDrawing() {
  const b64 = await harness.evaluate(async ({ W, H }) => {
    const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
    const doc = await PDFDocument.create();
    const page = doc.addPage([W, H]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const ink = rgb(0, 0, 0);
    const diamond = (cx, cy, tag) => {
      page.drawSvgPath(`M ${cx - 12.4} ${cy} L ${cx} ${cy - 12.4} L ${cx + 12.4} ${cy} L ${cx} ${cy + 12.4} Z`, { x: 0, y: H, borderColor: ink, borderWidth: 1 });
      page.drawText(tag, { x: cx - font.widthOfTextAtSize(tag, 9) / 2, y: H - cy - 3, size: 9, font, color: ink });
    };
    const leader = (path) => page.drawSvgPath(path, { x: 0, y: H, borderColor: ink, borderWidth: 1 });
    const dot = (x, y) => page.drawCircle({ x, y: H - y, size: 2.25, color: ink });
    diamond(300, 100, "A1");
    leader("M 287.6 100 L 270 100 L 270 128");
    dot(270, 130.25);
    diamond(450, 200, "A2");
    diamond(425, 300, "A3");
    leader("M 412.6 300 L 380 300"); // left, ends on a dot
    dot(380, 300);
    leader("M 437.4 300 L 470 300"); // right, ends on a dot
    dot(470, 300);
    page.drawText("Not a callout: a dot far from anything", { x: 40, y: 40, size: 8, font });
    dot(60, 380);
    const bytes = await doc.save();
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }, { W, H });
  return Buffer.from(b64, "base64");
}

test("pdf.js geometry: each callout's dot is found, including a second leader, and a bare callout has none", async () => {
  const pdf = await makeDrawing();
  const r = await harness.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const doc = await P.openPdf(bytes);
    const info = await P.readPage(doc, 1);
    const geo = await P.readGeometry(info.page);
    const find = P.anchorFinder(geo, info.viewport);
    const out = {};
    for (const tag of ["A1", "A2", "A3"]) out[tag] = find(info.tokens.find((t) => t.text === tag));
    return { out, dots: geo.dots.length, h: info.height };
  }, pdf.toString("base64"));

  assert.equal(r.out.A1.length, 1);
  assert.equal(r.out.A1[0].kind, "dot");
  near(r.out.A1[0].x, 270);
  near(r.out.A1[0].y, 130.25);
  near(r.out.A1[0].ux, 270); // PDF user space has y measured from the bottom
  near(r.out.A1[0].uy, H - 130.25);

  assert.deepEqual(r.out.A2, [], "no leader, no anchor");

  assert.equal(r.out.A3.length, 2);
  assert.deepEqual(r.out.A3.map((a) => a.kind), ["dot", "dot"]);
  assert.deepEqual(r.out.A3.map((a) => Math.round(a.x)).sort(), [380, 470]);
  assert.ok(r.dots >= 4, "all the round dots are recognised");
});

// ---- the page --------------------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "plantasks-anchors-"));
function sheet(path, sheetName = "in") {
  const code = `
import json, sys, openpyxl
ws = openpyxl.load_workbook(sys.argv[1])[sys.argv[2]]
hdr = {c.value: c.column for c in ws[4] if c.value}
rows = []
for r in range(5, ws.max_row + 1):
    t = ws.cell(r, hdr["Title"]).value
    if t: rows.append([t, ws.cell(r, hdr["X Pos (%)"]).value, ws.cell(r, hdr["Y Pos (%)"]).value])
print(json.dumps(rows))`;
  return JSON.parse(execFileSync("python3", ["-I", "-c", code, path, sheetName], { encoding: "utf8" }));
}

test("the page pins on the dots by default, says where each pin is, and the workbook carries the dot positions", async () => {
  const pdf = await makeDrawing();
  const template = Buffer.from(await makeTemplate({ ids: [] }));
  const page = await env.browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${env.server.url}/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.setInputFiles("#file-pdf", { name: "plan.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.waitForSelector("#sheet:not([hidden])");
  await page.setInputFiles("#file-xlsx", { name: "template.xlsx", mimeType: "application/octet-stream", buffer: template });
  await page.fill("#plan-name", "Plan A");
  await page.fill('.rule input[id$="-tags"]', "A1, A2, A3");
  await page.fill('.rule input[id$="-title"]', "Socket {tag}");
  await page.waitForFunction(() => window.planTasks.state.pins.length === 4);

  const pins = await page.evaluate(() => window.planTasks.state.pins.map((p) => ({ tag: p.tag, anchor: p.anchor, i: p.anchorIndex, n: p.anchorCount, x: p.x, y: p.y, tx: p.tx, ty: p.ty })));
  const byTag = (tag) => pins.filter((p) => p.tag === tag);
  assert.equal(byTag("A1")[0].anchor, "dot");
  near(byTag("A1")[0].x, 270);
  near(byTag("A1")[0].y, 130.25);
  assert.equal(byTag("A2")[0].anchor, "text", "no leader: stays on the callout");
  near(byTag("A2")[0].x, byTag("A2")[0].tx, 0.001);
  assert.deepEqual(byTag("A3").map((p) => [p.i, p.n]), [[1, 2], [2, 2]]);

  // What the user sees.
  assert.deepEqual(await page.$$eval("#pin-rows tr td:nth-child(6)", (c) => c.map((x) => x.textContent)), ["Dot", "Callout", "Dot 1 of 2", "Dot 2 of 2"]);
  assert.equal(await page.$$eval("#overlay .tether", (l) => l.length), 3, "a tether from each callout to its pin; none where the pin is on the callout");
  const status = await page.textContent(".rule-status");
  assert.match(status, /3 found, 4 pins/);
  assert.match(status, /3 on a dot/);
  assert.match(status, /1 on the callout \(no leader found\)/);

  // What goes into Fieldwire.
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#dl-import")]);
  const file = join(dir, "import.xlsx");
  await download.saveAs(file);
  const rows = sheet(file);
  const find = (title) => rows.filter((r) => r[0] === title);
  const a1 = find("Socket A1")[0];
  near(a1[1], (270 / W) * 100, 0.06);
  near(a1[2], (130.25 / H) * 100, 0.06);
  assert.equal(rows.length, 4);

  // Switch the rule to "on the callout itself": the same callouts, pinned on the text.
  await page.selectOption('.rule select[id$="-pin"]', "text");
  await page.waitForFunction(() => window.planTasks.state.pins.length === 3);
  const onText = await page.evaluate(() => window.planTasks.state.pins.map((p) => p.anchor));
  assert.deepEqual(onText, ["text", "text", "text"]);

  // The choice is saved with the rules and survives loading them back.
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("plantasks.v1") || "{}").rules?.[0]?.pinAt === "text"); // saved after a short delay
  assert.equal(await page.evaluate(() => window.planTasks.state.rules[0].pinAt), "text");
  assert.deepEqual(errors, []);
  await page.close();
});

test("an old rules file without the setting loads as 'on the dot', and the dot is the default for new rules", async () => {
  const page = await env.browser.newPage();
  await page.goto(`${env.server.url}/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const legacy = JSON.stringify({ app: "plan-tasks", version: 1, settings: {}, rules: [{ name: "Old", tags: "A1", usePattern: false, title: "{tag}", columns: {} }] });
  await page.setInputFiles("#load-rules", { name: "rules.json", mimeType: "application/json", buffer: Buffer.from(legacy) });
  await page.waitForSelector('.rule select[id$="-pin"]');
  assert.equal(await page.inputValue('.rule select[id$="-pin"]'), "dot");
  assert.equal(await page.evaluate(() => window.planTasks.state.rules[0].pinAt), "dot");
  await page.close();
});
