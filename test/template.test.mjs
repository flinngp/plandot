import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { launch } from "./helpers/browser.mjs";
import { makeTemplate, DEFAULT_HEADERS, JSZip } from "./helpers/make-template.mjs";

let env, page;
before(async () => {
  env = await launch();
  page = await env.browser.newPage();
  await page.goto(`${env.server.url}/test/harness.html`);
  await page.waitForFunction(() => window.ready);
});
after(async () => env.close());

const b64 = (u8) => Buffer.from(u8).toString("base64");
const dir = mkdtempSync(join(tmpdir(), "plantasks-"));

// Runs in the browser: open a template, build rows from pins, write the workbook, return its bytes (base64).
async function fill({ template, pins, rules, planName = "A2.01-1", rowsOnly = false }) {
  return page.evaluate(async ({ template, pins, rules, planName, rowsOnly }) => {
    const bytes = Uint8Array.from(atob(template), (c) => c.charCodeAt(0));
    const tpl = await T.readTemplate(bytes);
    const rulesById = Object.fromEntries(rules.map((r) => [r.id, r]));
    const rows = T.buildRows(tpl, pins, { planName, rulesById });
    if (rowsOnly) return { rows, columns: tpl.columns.map((c) => c.header), orphans: T.orphanedColumns(rules, tpl), extras: T.extraColumns(tpl).map((c) => c.header) };
    const out = await T.writeImport(tpl, rows);
    let s = ""; for (const b of out) s += String.fromCharCode(b);
    return { b64: btoa(s), rows };
  }, { template, pins, rules, planName, rowsOnly });
}

function dumpWithOpenpyxl(path) {
  const code = `
import json, sys, openpyxl, datetime
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb.active
out = {"sheet": ws.title, "dim": ws.dimensions, "rows": [], "widthB": ws.column_dimensions["B"].width}
for row in ws.iter_rows():
    r = []
    for c in row:
        v = c.value
        if isinstance(v, (datetime.datetime, datetime.date)): v = v.isoformat()
        r.append([c.coordinate, v, c.number_format])
    out["rows"].append(r)
print(json.dumps(out))`;
  return JSON.parse(execFileSync("python3", ["-I", "-c", code, path], { encoding: "utf8" }));
}
const cell = (dump, ref) => { for (const row of dump.rows) for (const [c, v, nf] of row) if (c === ref) return { v, nf }; return { v: null, nf: null }; };

const pins = [
  { ruleId: "s", title: "Install socket A1 (Room 1-105)", px: 12.3456, py: 45.6789, vars: { tag: "A1", room: "1-105", room_label: "(Room 1-105)", n: 1 } },
  { ruleId: "t", title: "Install TV port B1", px: 50, py: 10, vars: { tag: "B1", room: "", room_label: "", n: 1 } },
];
const rules = [
  { id: "s", name: "Sockets", columns: { Category: "Electrical", "Start date": "12/10/2026", "Tier 3": "{room}", Cost: "45.5" } },
  { id: "t", name: "TV", columns: { Category: "Electrical" } },
];

test("reads columns by header, finds the header row and flags required columns", async () => {
  const tpl = await makeTemplate();
  const info = await page.evaluate(async (b) => {
    const t = await T.readTemplate(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
    return { headerNo: t.headerNo, roles: t.columns.filter((c) => c.role).map((c) => `${c.header}=${c.role}`), n: t.columns.length, missing: t.missing, dates: Object.entries(t.styles).filter(([, s]) => t.dateStyleSet.has(s)).map(([l]) => l), project: t.projectName };
  }, b64(tpl));
  assert.equal(info.headerNo, 4);
  assert.deepEqual(info.roles, ["ID=id", "Title=title", "Plan=plan", "X Pos (%)=x", "Y Pos (%)=y"]);
  assert.equal(info.n, 21);
  assert.deepEqual(info.missing, []);
  assert.deepEqual(info.dates, ["F", "G"]);
  assert.equal(info.project, "Test project");
});

test("counts the rows Fieldwire pre-fills so the page can say they are dropped", async () => {
  const count = async (ids) => {
    const tpl = await makeTemplate({ ids });
    return page.evaluate(async (b) => (await T.readTemplate(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)))).prefilledRows, b64(tpl));
  };
  assert.equal(await count([7, 1, 3, 4, 5]), 5);
  assert.equal(await count([]), 0);
});

test("a template without X/Y columns reports what is missing", async () => {
  const tpl = await makeTemplate({ headers: DEFAULT_HEADERS.filter((h) => !/Pos/.test(h)) });
  const missing = await page.evaluate(async (b) => (await T.readTemplate(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)))).missing, b64(tpl));
  assert.deepEqual(missing, ["X Pos (%)", "Y Pos (%)"]);
});

test("rejects files that are not workbooks, and sheets without a header row", async () => {
  const msg = await page.evaluate(async () => { try { await T.readTemplate(new TextEncoder().encode("hello")); } catch (e) { return e.message; } });
  assert.match(msg, /valid \.xlsx/);
  const z = await JSZip.loadAsync(await makeTemplate());
  z.file("xl/sharedStrings.xml", (await z.file("xl/sharedStrings.xml").async("string")).replace(/<t>Title<\/t>/, "<t>Name</t>"));
  const noHeader = await z.generateAsync({ type: "uint8array" });
  const msg2 = await page.evaluate(async (b) => { try { await T.readTemplate(Uint8Array.from(atob(b), (c) => c.charCodeAt(0))); } catch (e) { return e.message; } }, b64(noHeader));
  assert.match(msg2, /header row/);
});

test("writes a valid workbook: new rows, blank IDs, real dates, template formatting kept", async () => {
  const tpl = await makeTemplate({ ids: [7, 1, 3, 4, 5] });
  const { b64: out } = await fill({ template: b64(tpl), pins, rules });
  const file = join(dir, "out.xlsx");
  writeFileSync(file, Buffer.from(out, "base64"));
  const d = dumpWithOpenpyxl(file);

  assert.equal(d.sheet, "in");
  assert.equal(d.dim, "A1:U6"); // header block + 2 new rows; the 5 old sample rows are gone
  assert.equal(cell(d, "A1").v, "Task import template (sample)");
  assert.equal(cell(d, "A2").v, "Test project");
  assert.equal(cell(d, "B4").v, "Title");
  assert.equal(d.widthB, 27.5);

  assert.equal(cell(d, "A5").v, null); // ID left blank on purpose
  assert.equal(cell(d, "A6").v, null);
  assert.equal(cell(d, "B5").v, "Install socket A1 (Room 1-105)");
  assert.equal(cell(d, "D5").v, "Electrical");
  assert.equal(cell(d, "H5").v, "A2.01-1");
  assert.equal(cell(d, "I5").v, 12.35);
  assert.equal(cell(d, "J5").v, 45.68);
  assert.equal(cell(d, "M5").v, "1-105"); // Tier 3 from {room}
  assert.equal(cell(d, "Q5").v, 45.5); // Cost stored as a number
  assert.equal(cell(d, "F5").v, "2026-10-12T00:00:00"); // UK date text became a real date
  assert.match(cell(d, "F5").nf, /yyyy/);
  assert.equal(cell(d, "B6").v, "Install TV port B1");
  assert.equal(cell(d, "M6").v, null);
  assert.equal(cell(d, "F6").v, null);
});

test("custom attributes appear as fields and hidden ones drop out without breaking", async () => {
  const headers = DEFAULT_HEADERS.filter((h) => h !== "Manpower").concat("Fire rating");
  const tpl = await makeTemplate({ headers });
  const rulesWithCustom = [
    { id: "s", name: "Sockets", columns: { "Fire rating": "FD30", Manpower: "2", Category: "Electrical" } },
    { id: "t", name: "TV", columns: {} },
  ];
  const r = await fill({ template: b64(tpl), pins, rules: rulesWithCustom, rowsOnly: true });
  assert.ok(r.extras.includes("Fire rating") && !r.extras.includes("Manpower"));
  assert.deepEqual(r.orphans, ["Manpower"]); // saved value with no column in this template
  assert.equal(r.rows[0]["Fire rating"], "FD30");
  assert.ok(!("Manpower" in r.rows[0]));

  const { b64: out } = await fill({ template: b64(tpl), pins, rules: rulesWithCustom });
  const file = join(dir, "custom.xlsx");
  writeFileSync(file, Buffer.from(out, "base64"));
  const d = dumpWithOpenpyxl(file);
  const hdr = d.rows[3].map(([, v]) => v);
  assert.equal(hdr[hdr.length - 1], "Fire rating");
  assert.equal(cell(d, `${String.fromCharCode(64 + hdr.length)}5`).v, "FD30");
});

test("special characters and padded text survive the round trip", async () => {
  const tpl = await makeTemplate();
  const odd = [{ ruleId: "s", title: "Fix <wall> & \"door\" – 45°  ", px: 1, py: 2, vars: {} }];
  const { b64: out } = await fill({ template: b64(tpl), pins: odd, rules });
  const file = join(dir, "odd.xlsx");
  writeFileSync(file, Buffer.from(out, "base64"));
  assert.equal(cell(dumpWithOpenpyxl(file), "B5").v, "Fix <wall> & \"door\" – 45°  ");
});

test("calibration file puts nine tasks on the 10/50/90 grid crossings", async () => {
  const tpl = await makeTemplate();
  const rows = await page.evaluate(async (b) => {
    const t = await T.readTemplate(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
    return T.buildCalibrationRows(t, "Grid");
  }, b64(tpl));
  assert.equal(rows.length, 9);
  assert.deepEqual(rows[0], { Title: "Calibration X10 Y10", Plan: "Grid", "X Pos (%)": 10, "Y Pos (%)": 10 });
  assert.deepEqual(rows[8], { Title: "Calibration X90 Y90", Plan: "Grid", "X Pos (%)": 90, "Y Pos (%)": 90 });
});

test("date parsing accepts ISO and UK formats and rejects nonsense", async () => {
  const r = await page.evaluate(() => [T.parseDate("2026-10-12"), T.parseDate("12/10/2026"), T.parseDate("1.2.2027"), T.parseDate("next week")]);
  assert.deepEqual(r, [{ y: 2026, m: 10, d: 12 }, { y: 2026, m: 10, d: 12 }, { y: 2027, m: 2, d: 1 }, null]);
});
