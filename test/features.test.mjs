// Zoom, the fixed left panel, clearer pin titles, undo, setup files, the export preview, the sample,
// scanned pages and keyboard use. Driven in a real browser with the made-up sample files.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { launch } from "./helpers/browser.mjs";

const root = new URL("..", import.meta.url).pathname;
const SAMPLE = { pdf: `${root}samples/sample-drawing.pdf`, xlsx: `${root}samples/sample-import-template.xlsx`, rules: `${root}samples/sample-rules.json`, symbols: `${root}samples/sample-symbols.pdf` };
let env;
before(async () => { env = await launch(); });
after(async () => env.close());

async function fresh(viewport = { width: 1440, height: 900 }) {
  const page = await env.browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text()); });
  await page.goto(`${env.server.url}/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  page.errors = errors;
  return page;
}
async function withSample(viewport) {
  const page = await fresh(viewport);
  await page.setInputFiles("#file-pdf", SAMPLE.pdf);
  await page.setInputFiles("#file-xlsx", SAMPLE.xlsx);
  await page.setInputFiles("#load-rules", SAMPLE.rules);
  await page.fill("#plan-name", "Ground floor plan");
  await page.waitForFunction(() => window.planTasks.state.pins.length === 13 && !window.planTasks.state.busy);
  await page.waitForTimeout(300);
  return page;
}
const box = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const level = (page) => page.$eval("#zoom-level", (e) => e.textContent);

// ------------------------------------------------------------------ wording

test("the new wording is on the page", async () => {
  const page = await withSample();
  assert.equal(await page.textContent(".brand p"), "Turn callouts and symbols on a plan into pins, ready to import.");
  assert.deepEqual(await page.$$eval(".rule select[id$='-kind'] option", (o) => o.map((x) => x.textContent)).then((a) => a.slice(0, 2)), ["Text callout", "Draw box"]);
  const labels = await page.$$eval(".rule:first-child label", (l) => l.map((x) => x.textContent));
  assert.ok(labels.includes("Text to find"));
  assert.ok(labels.includes("Pin placed on"));
  assert.ok(!labels.some((t) => /Tags to find|Pin goes/.test(t)));
  assert.deepEqual(await page.$$eval(".rule:first-child select[id$='-pin'] option", (o) => o.map((x) => x.textContent)), ["On the location", "On the callout"]);
  assert.deepEqual(await page.$$eval(".rule:first-child select[id$='-pin'] option", (o) => o.map((x) => x.value)), ["dot", "text"]);
  assert.equal(page.errors.length, 0);
  await page.close();
});

// ------------------------------------------------------------------ pin title helper

test("buttons put callout text, room and number into the title at the cursor, with a live example", async () => {
  const page = await withSample();
  const title = ".rule:first-child input[id$='-title']";
  await page.fill(title, "Install socket");
  await page.click(".rule:first-child .token:has-text('Callout text')");
  await page.click(".rule:first-child .token:has-text('Room in brackets')");
  assert.equal(await page.inputValue(title), "Install socket {tag} {room_label}");
  await page.waitForFunction(() => window.planTasks.state.pins[0]?.title === "Install socket A1 (Room 1-101)");
  assert.match(await page.textContent(".rule:first-child .becomes"), /First pin: Install socket A1 \(Room 1-101\)/);

  // in the middle of the text
  await page.fill(title, "Check  done");
  await page.evaluate((s) => { const e = document.querySelector(s); e.focus(); e.setSelectionRange(6, 6); }, title);
  await page.click(".rule:first-child .token:has-text('Number')");
  assert.equal(await page.inputValue(title), "Check {n}  done".replace("Check {n}  done", "Check {n} done"));
  await page.close();
});

test("with nothing found yet, the title shows an example, and says when rooms need a pattern", async () => {
  const page = await fresh();
  await page.fill('.rule input[id$="-title"]', "Fit {tag} in {room}");
  const text = await page.textContent(".rule .becomes");
  assert.match(text, /Example: Fit A1 in 1-101/);
  assert.match(text, /room label pattern/);
  await page.close();
});

// ------------------------------------------------------------------ zoom

test("the left panel stays the same size whatever happens to the drawing", async () => {
  for (const vp of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 1100, height: 700 }]) {
    const page = await fresh(vp);
    const empty = await box(page, ".controls");
    await page.setInputFiles("#file-pdf", SAMPLE.pdf);
    await page.setInputFiles("#load-rules", SAMPLE.rules);
    await page.waitForFunction(() => window.planTasks.state.pins.length > 0 && !window.planTasks.state.busy);
    const loaded = await box(page, ".controls");
    for (let i = 0; i < 5; i++) await page.click("#zoom-in");
    await page.waitForTimeout(300);
    const zoomed = await box(page, ".controls");
    assert.equal(Math.round(empty.w), 380, `${vp.width}: width`);
    assert.deepEqual([loaded.w, loaded.h, loaded.x], [empty.w, empty.h, empty.x], `${vp.width}: loading changes nothing`);
    assert.deepEqual([zoomed.w, zoomed.h, zoomed.x, zoomed.y], [empty.w, empty.h, empty.x, empty.y], `${vp.width}: zooming changes nothing`);
    await page.close();
  }
});

test("zooming makes the sheet bigger inside its window, and the window itself does not grow", async () => {
  const page = await withSample();
  const pane = await box(page, "#viewport");
  const fit = await box(page, "#stage");
  assert.equal(await level(page), "100%");
  await page.click("#zoom-in");
  await page.waitForTimeout(150);
  const one = await box(page, "#stage");
  assert.ok(one.w > fit.w * 1.3 && one.w < fit.w * 1.5, `${one.w} vs ${fit.w}`);
  await page.click("#zoom-in"); await page.click("#zoom-in");
  assert.equal(await level(page), "274%");
  assert.deepEqual(await box(page, "#viewport"), pane);
  const three = await box(page, "#stage");
  assert.ok(Math.abs(three.w / fit.w - 2.744) < 0.02);
  await page.click("#zoom-fit");
  await page.waitForTimeout(150);
  assert.equal(await level(page), "100%");
  assert.ok(Math.abs((await box(page, "#stage")).w - fit.w) < 1);
  assert.equal(await page.$eval("#zoom-out", (b) => b.disabled), true);
  await page.close();
});

test("zoomed in, the drawing stays sharp: the picture is drawn at the size you see", async () => {
  const page = await withSample();
  for (let i = 0; i < 6; i++) await page.click("#zoom-in");
  await page.waitForTimeout(900);
  const info = await page.evaluate(() => {
    const c = document.querySelector("#pdf-canvas"), v = document.querySelector("#viewport").getBoundingClientRect(), s = document.querySelector("#stage").getBoundingClientRect(), r = c.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio, 2);
    return { pxPerCss: c.width / r.width, dpr, canvasW: c.width, covers: r.left <= Math.max(v.left, s.left) + 1 && r.right >= Math.min(v.right, s.right) - 1 && r.top <= Math.max(v.top, s.top) + 1 && r.bottom >= Math.min(v.bottom, s.bottom) - 1, stageW: s.width };
  });
  assert.ok(info.stageW > 4096, "the sheet is far bigger than one picture could be");
  assert.ok(Math.abs(info.pxPerCss - info.dpr) < 0.05, `${info.pxPerCss} vs ${info.dpr}`);
  assert.ok(info.canvasW <= 4096);
  assert.ok(info.covers, "the drawn part covers everything you can see");
  await page.close();
});

test("scrolling far when zoomed in redraws the part you moved to", async () => {
  const page = await withSample();
  for (let i = 0; i < 7; i++) await page.click("#zoom-in");
  await page.waitForTimeout(900);
  const left0 = await page.$eval("#pdf-canvas", (c) => c.style.left);
  await page.evaluate(() => { const v = document.querySelector("#viewport"); v.scrollLeft = v.scrollWidth; v.scrollTop = v.scrollHeight; });
  await page.waitForTimeout(1200);
  const left1 = await page.$eval("#pdf-canvas", (c) => c.style.left);
  assert.notEqual(left0, left1);
  const covers = await page.evaluate(() => { const v = document.querySelector("#viewport").getBoundingClientRect(), r = document.querySelector("#pdf-canvas").getBoundingClientRect(); return r.right >= v.right - 1 && r.bottom >= v.bottom - 1; });
  assert.ok(covers);
  await page.close();
});

test("Ctrl + scroll zooms around the pointer, plain scroll pans, and dragging pans", async () => {
  const page = await withSample();
  const st = await box(page, "#stage");
  const px = st.x + st.w * 0.4, py = st.y + st.h * 0.3; // a spot that can stay put as the sheet grows (near the edge it cannot)
  const at = async () => page.evaluate(([x, y]) => { const r = document.querySelector("#stage").getBoundingClientRect(); return [(x - r.left) / r.width, (y - r.top) / r.height]; }, [px, py]);
  const before = await at();
  await page.mouse.move(px, py);
  await page.keyboard.down("Control");
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(40); }
  await page.keyboard.up("Control");
  await page.waitForTimeout(200);
  assert.ok(parseInt(await level(page)) > 150);
  const after = await at();
  assert.ok(Math.abs(after[0] - before[0]) < 0.01 && Math.abs(after[1] - before[1]) < 0.01, `${before} -> ${after}`);
  // plain scroll pans, it does not zoom
  const z = await level(page), top = await page.$eval("#viewport", (e) => e.scrollTop);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(150);
  assert.equal(await level(page), z);
  assert.ok(await page.$eval("#viewport", (e) => e.scrollTop) > top);
  // drag to pan
  const s0 = await page.$eval("#viewport", (e) => [e.scrollLeft, e.scrollTop]);
  await page.mouse.move(px, py); await page.mouse.down(); await page.mouse.move(px - 80, py - 60, { steps: 5 }); await page.mouse.up();
  const s1 = await page.$eval("#viewport", (e) => [e.scrollLeft, e.scrollTop]);
  assert.ok(s1[0] > s0[0] + 40 && s1[1] > s0[1] + 30, `${s0} -> ${s1}`);
  await page.close();
});

test("the rulers get finer as you zoom, and pins stay the same size on screen", async () => {
  const page = await withSample();
  const ticks0 = await page.$$eval("#ruler-x .tick", (t) => t.map((x) => x.textContent));
  const r0 = await page.$eval(".pin .dot", (c) => c.getBoundingClientRect().width);
  for (let i = 0; i < 6; i++) await page.click("#zoom-in");
  await page.waitForTimeout(400);
  const ticks1 = await page.$$eval("#ruler-x .tick", (t) => t.map((x) => x.textContent));
  const r1 = await page.$eval(".pin .dot", (c) => c.getBoundingClientRect().width);
  assert.deepEqual(ticks0.slice(0, 3), ["10", "20", "30"]);
  assert.ok(ticks1.some((t) => t.includes(".")) || ticks1.length > ticks0.length, ticks1.join());
  assert.ok(Math.abs(r1 - r0) < 1.5, `${r0} vs ${r1}`);
  await page.close();
});

test("+, - and 0 zoom from the keyboard once the drawing has focus", async () => {
  const page = await withSample();
  await page.focus("#viewport");
  await page.keyboard.press("+"); await page.keyboard.press("+");
  assert.equal(await level(page), "196%");
  await page.keyboard.press("-");
  assert.equal(await level(page), "140%");
  await page.keyboard.press("0");
  assert.equal(await level(page), "100%");
  await page.close();
});

test("clicking a row in the pin list brings that pin into view", async () => {
  const page = await withSample();
  await page.click("#pin-rows tr:nth-child(10) td:nth-child(2)");
  await page.waitForTimeout(500);
  assert.equal(await level(page), "300%");
  const ok = await page.evaluate(() => {
    const p = window.planTasks.state.pins[9], r = document.querySelector("#stage").getBoundingClientRect(), v = document.querySelector("#viewport").getBoundingClientRect();
    const x = r.left + (p.px / 100) * r.width, y = r.top + (p.py / 100) * r.height;
    return x > v.left && x < v.right && y > v.top && y < v.bottom;
  });
  assert.ok(ok);
  await page.close();
});

test("the pin image still shows the whole sheet after zooming", async () => {
  const page = await withSample();
  for (let i = 0; i < 4; i++) await page.click("#zoom-in");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#dl-png")]);
  const path = `${tmpdir()}/plandot-pins.png`;
  await dl.saveAs(path);
  const buf = await readFile(path);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  assert.ok(w >= 2500 && Math.abs(w / h - 34 / 22) < 0.02, `${w}x${h}`);
  await page.close();
});

// ------------------------------------------------------------------ undo, setup files, export preview

test("Undo and Redo step back through rule edits, including removing a rule", async () => {
  const page = await withSample();
  assert.equal(await page.$$eval(".rule", (r) => r.length), 3);
  const undo = "#undo", redo = "#redo";
  await page.waitForTimeout(700);
  await page.fill(".rule:first-child .rule-head input", "Sockets");
  await page.waitForTimeout(1100);
  await page.click(".rule:nth-child(2) button:has-text('Remove')");
  assert.equal(await page.$$eval(".rule", (r) => r.length), 2);
  await page.waitForTimeout(700);
  assert.equal(await page.$eval(undo, (b) => b.disabled), false);
  await page.click(undo);
  assert.equal(await page.$$eval(".rule", (r) => r.length), 3);
  await page.waitForFunction(() => window.planTasks.state.pins.length === 13);
  await page.click(undo);
  assert.equal(await page.$eval(".rule:first-child .rule-head input", (e) => e.value), "Socket outlet");
  await page.click(redo); await page.click(redo);
  assert.equal(await page.$$eval(".rule", (r) => r.length), 2);
  assert.equal(await page.$eval(".rule:first-child .rule-head input", (e) => e.value), "Sockets");
  assert.equal(await page.$eval(redo, (b) => b.disabled), true);
  // Ctrl+Z outside a text box does the same
  await page.click("#show-grid");
  await page.keyboard.press("Control+z");
  assert.equal(await page.$$eval(".rule", (r) => r.length), 3);
  await page.close();
});

test("Save setup keeps rules, plan name and room settings, and Open setup brings them back", async () => {
  const page = await withSample();
  await page.click("summary:has-text('Search area and room labels')");
  await page.fill("#room-pattern", "\\d-\\d{3}");
  await page.evaluate(() => { document.querySelector("#save-rules").closest("details").open = true; });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#save-rules")]);
  assert.equal(dl.suggestedFilename(), "plandot setup.json");
  const path = `${tmpdir()}/plandot-setup.json`;
  await dl.saveAs(path);
  const data = JSON.parse(await readFile(path, "utf8"));
  assert.equal(data.version, 2);
  assert.equal(data.settings.planName, "Ground floor plan");
  assert.equal(data.rules.length, 3);

  const other = await fresh();
  await other.setInputFiles("#load-rules", path);
  await other.waitForFunction(() => window.planTasks.state.rules.length === 3);
  assert.equal(await other.inputValue("#plan-name"), "Ground floor plan");
  assert.equal(await other.inputValue("#room-pattern"), "\\d-\\d{3}");
  assert.equal(await other.$eval(".rule:first-child .rule-head input", (e) => e.value), "Socket outlet");
  await other.close();
  await page.close();
});

test("an older rules file without a plan name still opens and leaves the plan name alone", async () => {
  const page = await fresh();
  await page.fill("#plan-name", "Keep me");
  await page.setInputFiles("#load-rules", SAMPLE.rules);
  await page.waitForFunction(() => window.planTasks.state.rules.length === 3);
  assert.equal(await page.inputValue("#plan-name"), "Keep me");
  await page.close();
});

test("the export preview says what will be exported and shows the first pins", async () => {
  const page = await withSample();
  assert.equal(await page.textContent("#export-summary"), '13 pins will go onto plan "Ground floor plan".');
  await page.click("#export-preview summary");
  await page.waitForSelector("#preview-table th"); // the table is built when the section opens
  const heads = await page.$$eval("#preview-table th", (t) => t.map((x) => x.textContent));
  assert.ok(heads.includes("Title") && heads.includes("Plan") && heads.includes("Category"), heads.join());
  assert.ok(heads.some((x) => /X Pos/.test(x)));
  assert.equal(await page.$$eval("#preview-table tbody tr", (r) => r.length), 6);
  assert.match(await page.textContent("#preview-table .more-rows"), /and 7 more/);
  // leaving a pin out changes the sentence and the table
  await page.click("#pin-rows tr:first-child input[type=checkbox]");
  assert.match(await page.textContent("#export-summary"), /12 pins.*1 pin is left out/);
  await page.close();
});

test("with no template there is no preview and the 'still needed' list shows", async () => {
  const page = await fresh();
  await page.setInputFiles("#file-pdf", SAMPLE.pdf);
  await page.waitForFunction(() => window.planTasks.state.pdf?.tokens);
  assert.equal(await page.$eval("#export-preview", (e) => e.hidden), true);
  assert.equal(await page.textContent("#export-summary"), "");
  await page.close();
});

// ------------------------------------------------------------------ sample, scans, friendly failures

test("Try with a sample drawing loads the drawing, template and rules in one click", async () => {
  const page = await fresh();
  assert.equal(await page.$eval("#try-sample", (b) => b.hidden), false);
  await page.click("#try-sample");
  await page.waitForFunction(() => window.planTasks.state.pins.length === 13 && !window.planTasks.state.busy, null, { timeout: 20000 });
  assert.equal(await page.inputValue("#plan-name"), "Ground floor plan");
  assert.equal(await page.$eval("#dl-import", (b) => b.disabled), false);
  assert.equal(await page.$eval("#dropzone", (e) => e.hidden), true);
  await page.waitForFunction(() => /made-up sample/.test(document.querySelector("#status").textContent)); // said once everything has settled
  assert.equal(page.errors.length, 0);
  await page.close();
});

test("the sample asks before replacing rules you have already written", async () => {
  const page = await fresh();
  await page.fill(".rule input[id$='-tags']", "Z9");
  let asked = "";
  page.once("dialog", async (d) => { asked = d.message(); await d.dismiss(); });
  await page.click("#try-sample");
  await page.waitForTimeout(300);
  assert.match(asked, /replaces your current rules/);
  assert.equal(await page.evaluate(() => window.planTasks.state.pdf), null);
  await page.close();
});

test("a page with no text says so clearly, in plain words, and the rule says it too", async () => {
  const page = await fresh();
  const blank = await page.evaluate(async () => { const d = await PDFLib.PDFDocument.create(); d.addPage([600, 400]); return Array.from(await d.save()); });
  await page.setInputFiles("#file-pdf", { name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from(blank) });
  await page.waitForFunction(() => window.planTasks.state.pdf?.tokens);
  assert.equal(await page.$eval("#pdf-alert", (e) => e.hidden), false);
  assert.match(await page.textContent("#pdf-alert"), /no selectable text.*scan/s);
  await page.fill(".rule input[id$='-tags']", "A1");
  await page.waitForFunction(() => /no selectable text/.test(document.querySelector(".rule-status").textContent));
  // a drawing with text clears it
  await page.setInputFiles("#file-pdf", SAMPLE.pdf);
  await page.waitForFunction(() => window.planTasks.state.pdf?.tokens?.length > 0);
  assert.equal(await page.$eval("#pdf-alert", (e) => e.hidden), true);
  await page.close();
});

test("a file that isn't a PDF gets a friendly message and nothing breaks", async () => {
  const page = await fresh();
  await page.setInputFiles("#file-pdf", { name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("this is not a pdf") });
  await page.waitForFunction(() => /couldn't be read as a PDF/.test(document.querySelector("#status").textContent));
  assert.equal(await page.evaluate(() => window.planTasks.state.pdf), null);
  assert.equal(await page.$eval("#status", (e) => e.classList.contains("err")), true);
  await page.close();
});

test("a rules file that isn't one is refused kindly", async () => {
  const page = await fresh();
  await page.setInputFiles("#load-rules", { name: "x.json", mimeType: "application/json", buffer: Buffer.from('{"hello":1}') });
  await page.waitForFunction(() => /isn't a Plandot setup file/.test(document.querySelector("#status").textContent));
  await page.close();
});

// ------------------------------------------------------------------ symbols: other sizes, keyboard

test("the symbol card offers 'bigger or smaller' and remembers it in the setup file", async () => {
  const page = await fresh();
  await page.setInputFiles("#file-pdf", SAMPLE.symbols);
  await page.waitForFunction(() => window.planTasks.state.pdf?.tokens);
  await page.selectOption(".rule select[id$=-kind]", "symbol");
  await page.click(".rule button:has-text('Draw a box around the symbol')");
  const r = await box(page, "#stage");
  const f = (x, y) => [r.x + (x / 1200) * r.w, r.y + (y / 800) * r.h];
  const [ax, ay] = f(130, 135), [bx, by] = f(232, 200);
  await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(bx, by, { steps: 4 }); await page.mouse.up();
  await page.waitForFunction(() => window.planTasks.state.rules[0].symbol && window.planTasks.state.pins.length === 5);
  await page.waitForFunction(() => !window.planTasks.state.busy && !/^(Looking|Reading)/.test(document.querySelector("#status").textContent));
  await page.check(".rule label:has-text('bigger or smaller') input");
  await page.waitForFunction(() => window.planTasks.state.rules[0].sizes === true);
  await page.waitForFunction(() => !/^Looking/.test(document.querySelector("#status").textContent));
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.planTasks.state.pins.length), 5); // the sample has the one size only: nothing new appears
  await page.evaluate(() => { document.querySelector("#save-rules").closest("details").open = true; });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#save-rules")]);
  const path = `${tmpdir()}/plandot-sizes.json`;
  await dl.saveAs(path);
  assert.equal(JSON.parse(await readFile(path, "utf8")).rules[0].sizes, true);
  await page.close();
});

test("a symbol box can be drawn with the keyboard alone", async () => {
  const page = await fresh();
  await page.setInputFiles("#file-pdf", SAMPLE.symbols);
  await page.waitForFunction(() => window.planTasks.state.pdf?.tokens);
  await page.selectOption(".rule select[id$=-kind]", "symbol");
  await page.focus(".rule button:has-text('Draw a box around the symbol')");
  await page.keyboard.press("Enter"); // keyboard activation: focus moves to the drawing
  assert.equal(await page.evaluate(() => document.activeElement.id), "viewport");
  assert.match(await page.textContent("#status"), /arrow keys/);
  // Walk the cursor to the first door (about 10.8% across and 17% down to the box corner) and set the corners.
  const goto = async (tx, ty) => {
    for (let guard = 0; guard < 400; guard++) {
      const kb = await page.evaluate(() => { const r = document.querySelector("#readout").textContent.match(/X ([\d.]+)%\s+Y ([\d.]+)%/); return r ? [Number(r[1]), Number(r[2])] : null; });
      const [x, y] = kb || [50, 50];
      const dx = tx - x, dy = ty - y;
      if (Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6) return;
      const key = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "ArrowRight" : "ArrowLeft") : (dy > 0 ? "ArrowDown" : "ArrowUp");
      await page.keyboard.press(Math.abs(Math.abs(dx) >= Math.abs(dy) ? dx : dy) > 6 ? `Shift+${key}` : key);
    }
  };
  await page.keyboard.press("ArrowLeft"); // wakes the cursor
  await goto((130 / 1200) * 100, (135 / 800) * 100);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /First corner set/.test(document.querySelector("#status").textContent)); // the message can lag when the machine is busy
  await goto((232 / 1200) * 100, (200 / 800) * 100);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.planTasks.state.rules[0].symbol, null, { timeout: 8000 });
  await page.waitForFunction(() => window.planTasks.state.pins.length === 5);
  await page.close();
});

test("Escape cancels keyboard drawing", async () => {
  const page = await fresh();
  await page.setInputFiles("#file-pdf", SAMPLE.symbols);
  await page.waitForFunction(() => window.planTasks.state.pdf?.tokens);
  await page.selectOption(".rule select[id$=-kind]", "symbol");
  await page.focus(".rule button:has-text('Draw a box around the symbol')");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => window.planTasks.state.boxFor), null);
  await page.close();
});

test("the page has the basics for keyboard and screen-reader use", async () => {
  const page = await withSample();
  const info = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    skip: document.querySelector(".skip")?.getAttribute("href"),
    viewport: [document.querySelector("#viewport").tabIndex, document.querySelector("#viewport").getAttribute("role"), !!document.querySelector("#viewport").getAttribute("aria-label")],
    zoomLabels: ["#zoom-in", "#zoom-out"].map((s) => document.querySelector(s).getAttribute("aria-label")),
    group: document.querySelector("#zoombar").getAttribute("role"),
    unnamed: [...document.querySelectorAll("button, input, select")].filter((e) => !e.hidden && e.type !== "hidden" && !(e.labels?.length || e.getAttribute("aria-label") || e.textContent.trim() || e.title)).map((e) => e.outerHTML.slice(0, 80)),
    live: document.querySelector("#status").getAttribute("aria-live"),
    pins: [...document.querySelectorAll(".pin")].every((p) => p.tabIndex === 0 && p.getAttribute("role") === "button" && p.getAttribute("aria-label")),
  }));
  assert.equal(info.lang, "en");
  assert.equal(info.skip, "#viewport");
  assert.deepEqual(info.viewport, [0, "region", true]);
  assert.deepEqual(info.zoomLabels, ["Zoom out", "Zoom in"].reverse());
  assert.equal(info.group, "group");
  assert.deepEqual(info.unnamed, []);
  assert.equal(info.live, "polite");
  assert.ok(info.pins);
  await page.close();
});

test("the page works at phone width: one column, the steps first, the plan after the rules, nothing sideways", async () => {
  const page = await withSample({ width: 390, height: 800 });
  const info = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, order: document.querySelector("#step-drawing").getBoundingClientRect().top < document.querySelector("#step-rules").getBoundingClientRect().top && document.querySelector("#step-rules").getBoundingClientRect().top < document.querySelector(".sheetpane").getBoundingClientRect().top && document.querySelector(".sheetpane").getBoundingClientRect().top < document.querySelector("#pinlist").getBoundingClientRect().top }));
  assert.ok(info.over <= 1, `scrolls sideways by ${info.over}`);
  assert.ok(info.order);
  await page.click("#zoom-in");
  assert.equal(await level(page), "140%");
  await page.close();
});

test("the drawing still opens in a browser whose streams can't be looped over (Safari)", async () => {
  const page = await env.browser.newPage();
  await page.addInitScript(() => { delete ReadableStream.prototype[Symbol.asyncIterator]; delete ReadableStream.prototype.values; });
  await page.goto(`${env.server.url}/index.html`);
  await page.setInputFiles("#file-pdf", SAMPLE.pdf);
  await page.waitForFunction(() => window.planTasks?.state.pdf?.tokens?.length > 0, null, { timeout: 20000 });
  await page.close();
});

test("the tour is skippable, remembers that it was closed, and can be taken again from the menu", async () => {
  const page = await fresh();
  assert.equal(await page.locator(".tour-card").count(), 0, "no tour is forced on automated browsers");
  await page.click(".menu-btn");
  await page.click(".tour-link");
  assert.equal(await page.locator(".tour-card").count(), 1);
  assert.match(await page.textContent(".tour-k"), /1 of 4/);
  await page.click(".tour-next");
  assert.match(await page.textContent(".tour-k"), /2 of 4/);
  await page.click(".tour-skip >> text=Back");
  assert.match(await page.textContent(".tour-k"), /1 of 4/);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".tour-card").count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem("plandot-tour-done")), "1", "closing remembers it");
  // clicking through to the end works, and un-ticking the box means it can show again
  await page.click(".menu-btn");
  await page.click(".tour-link");
  for (let i = 0; i < 3; i++) await page.click(".tour-next");
  assert.equal(await page.textContent(".tour-next"), "Done");
  await page.uncheck(".tour-never input");
  await page.click(".tour-next");
  assert.equal(await page.locator(".tour-card").count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem("plandot-tour-done")), null);
  await page.close();
});

test("the tour is a bottom card on a phone and the page still fits", async () => {
  const page = await fresh({ width: 390, height: 800 });
  await page.click(".menu-btn");
  await page.click(".tour-link");
  const r = await page.evaluate(() => { const c = document.querySelector(".tour-card").getBoundingClientRect(); return { inside: c.left >= 0 && c.right <= innerWidth && c.bottom <= innerHeight, ring: document.querySelector(".tour-ring").hidden, fits: document.documentElement.scrollWidth <= innerWidth }; });
  assert.deepEqual(r, { inside: true, ring: true, fits: true });
  // the card's text uses the whole card (it once picked up the drawing's grid class and squashed into a column)
  const w = await page.evaluate(() => ({ p: document.querySelector(".tour-card p").getBoundingClientRect().width, card: document.querySelector(".tour-card").getBoundingClientRect().width }));
  assert.ok(w.p > w.card * 0.7, `tour text is squashed: ${w.p} of ${w.card}`);
  await page.close();
});

test("the page's security rules let everything work: sample, downloads and pin image", async () => {
  const page = await fresh();
  await page.click("#try-sample");
  await page.waitForFunction(() => window.planTasks.state.pins.length === 13 && !window.planTasks.state.busy, null, { timeout: 20000 });
  for (const id of ["#dl-import", "#dl-png"]) {
    const [d] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.click(id)]);
    assert.ok(d.suggestedFilename());
  }
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("clicking a pin row jumps up to the drawing, and a button brings you back to the list", async () => {
  const page = await fresh({ width: 1280, height: 480 });
  await page.click("#try-sample");
  await page.waitForFunction(() => window.planTasks.state.pins.length === 13 && !window.planTasks.state.busy, null, { timeout: 20000 });
  await page.evaluate(() => window.scrollTo(0, 1e6));
  await page.waitForTimeout(300);
  const vb = await page.evaluate(() => document.querySelector("#viewport").getBoundingClientRect().bottom);
  assert.ok(vb < 250, `the drawing is scrolled out of sight (bottom ${vb})`);
  await page.click("#pin-rows tr:nth-child(3) td:nth-child(7) input"); // the title box counts as part of the line
  await page.waitForFunction(() => { const r = document.querySelector("#viewport").getBoundingClientRect(); return r.top >= -2 && r.top < innerHeight * 0.5; }, null, { timeout: 5000 });
  await page.waitForSelector("#back-to-pins:not([hidden])");
  await page.click("#back-to-pins");
  await page.waitForFunction(() => document.querySelector("#pinlist").getBoundingClientRect().top < innerHeight * 0.6, null, { timeout: 5000 });
  await page.waitForSelector("#back-to-pins", { state: "hidden" });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("the header: language sits in the top bar and the drawing details sit above the drawing", async () => {
  const page = await fresh({ width: 1280, height: 700 });
  const r = await page.evaluate(() => {
    const b = (s) => document.querySelector(s).getBoundingClientRect();
    return { langInNav: !!document.querySelector("#topnav #lang-btn"), tbInPane: !!document.querySelector(".sheetpane .titleblock"), mastLang: !!document.querySelector(".masthead #lang-btn"), tbInToolbar: !!document.querySelector(".toolbar > .titleblock"), noPanText: !document.querySelector(".toolbar .tip") };
  });
  assert.deepEqual(r, { langInNav: true, tbInPane: true, mastLang: true, tbInToolbar: true, noPanText: true });
  await page.click("#lang-btn"); await page.click("#lang-fr");
  await page.waitForFunction(() => document.querySelector("#topnav .feedback-link").textContent === "Envoyer un avis");
  await page.close();
});

// ------------------------------------------------------------------ steps, key and import bar

test("finished steps shrink to one line with a tick, and Change opens them again", async () => {
  const page = await withSample();
  assert.equal(await page.$eval("#step-drawing", (e) => e.classList.contains("collapsed")), true, "the drawing step is a one-line summary");
  await page.click("body", { position: { x: 5, y: 5 } }); // leave the plan name box
  await page.waitForFunction(() => document.querySelector("#step-template").classList.contains("collapsed"));
  assert.match(await page.textContent("#sum-drawing-sub"), /sample-drawing\.pdf/);
  assert.match(await page.textContent("#sum-template-sub"), /Ground floor plan/);
  assert.ok(await page.isVisible("#sum-drawing .tick") && await page.isVisible("#sum-template .tick"));
  assert.equal(await page.isVisible("#file-xlsx"), false);
  // the rules (the main step) are now in view without scrolling inside the left column
  const rules = await box(page, "#step-rules"), panel = await box(page, ".controls");
  assert.ok(rules.y + 200 < panel.y + panel.h, "the rules start well inside the panel");
  await page.click("#change-template");
  assert.equal(await page.$eval("#step-template", (e) => e.classList.contains("collapsed")), false);
  await page.click("#change-drawing");
  assert.equal(await page.$eval("#step-drawing", (e) => e.classList.contains("collapsed")), false);
  await page.ctx?.close?.();
});

test("the template step does not shrink under the pointer while you are typing in the plan name", async () => {
  const page = await fresh();
  await page.setInputFiles("#file-xlsx", SAMPLE.xlsx);
  await page.focus("#plan-name");
  await page.keyboard.type("Ground");
  assert.equal(await page.$eval("#step-template", (e) => e.classList.contains("collapsed")), false, "still open while typing");
  await page.click("#show-grid"); // a click elsewhere: the card shrinks after that click, so it still lands
  assert.equal(await page.isChecked("#show-grid"), true);
  await page.waitForFunction(() => document.querySelector("#step-template").classList.contains("collapsed"));
});

test("the pin key lists each rule with its colour and count, and a click leaves that rule's pins out", async () => {
  const page = await withSample();
  const chips = await page.$$eval("#rulekey .rulechip", (c) => c.map((x) => ({ name: x.querySelector(".rn").textContent, n: x.querySelector("i").textContent, pressed: x.getAttribute("aria-pressed") })));
  assert.equal(chips.length, 3);
  assert.deepEqual(chips.map((c) => c.n).sort(), ["3", "4", "6"]);
  assert.ok(chips.every((c) => c.pressed === "true" && c.name));
  // each chip's colour is the colour of its pins on the drawing
  const keyColours = await page.$$eval("#rulekey .rulechip", (c) => c.map((x) => getComputedStyle(x.querySelector(".dot")).backgroundColor));
  const pinColours = await page.$$eval("#overlay .pin .dot", (d) => [...new Set(d.map((x) => x.getAttribute("fill")))]);
  assert.equal(new Set(keyColours).size, 3);
  assert.equal(pinColours.length, 3);
  await page.click("#rulekey .rulechip:first-child");
  const first = chips[0];
  assert.equal(await page.getAttribute("#rulekey .rulechip:first-child", "aria-pressed"), "false");
  assert.equal(await page.textContent("#pinlist-title"), `Pins · ${13 - Number(first.n)} of 13 included`);
  assert.equal(await page.textContent("#tb-pins"), `${13 - Number(first.n)} / 13`);
  await page.click("#rulekey .rulechip:first-child");
  assert.equal(await page.textContent("#pinlist-title"), "Pins · 13 of 13 included");
  await page.ctx?.close?.();
});

test("the import bar sits under the drawing, copies the rows, and floats when it would be out of sight", async () => {
  const page = await withSample({ width: 1440, height: 700 });
  assert.equal(await page.isVisible("#importbar"), true);
  assert.equal(await page.isVisible("#importslot"), true);
  assert.match(await page.textContent("#ib-sum"), /13 pins will go onto plan "Ground floor plan"/);
  assert.equal(await page.textContent("#ib-copy"), "Copy rows");
  assert.equal(await page.$eval("#importbar", (e) => e.classList.contains("floating")), false, "in place while the drawing is on screen");
  const bar = await box(page, "#importbar"), sheet = await box(page, ".sheetpane");
  assert.ok(bar.y + bar.h <= sheet.y + sheet.h + 1, "inside the drawing panel");
  const zoom = await box(page, "#zoombar");
  assert.ok(zoom.y + zoom.h <= bar.y, "the zoom buttons do not sit on top of the bar");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await page.click("#ib-copy");
  await page.waitForFunction(() => document.querySelector("#ib-copy").textContent === "Copy again");
  assert.match(await page.textContent("#status"), /Copied 13 rows/);
  // scroll to the pin list: the bar floats along the bottom of the window
  await page.evaluate(() => window.scrollTo(0, 1e6));
  await page.waitForFunction(() => document.querySelector("#importbar").classList.contains("floating"));
  const fl = await box(page, "#importbar");
  assert.ok(Math.abs(fl.y + fl.h - 700) < 20, "stuck to the bottom edge");
  assert.equal(await page.isVisible("#ib-copy"), true);
  // and goes back when the drawing is in view again
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => !document.querySelector("#importbar").classList.contains("floating"));
  await page.ctx?.close?.();
});

test("the import bar waits until the plan name is in, and the buttons are off meanwhile", async () => {
  const page = await fresh();
  await page.setInputFiles("#file-pdf", SAMPLE.pdf);
  await page.setInputFiles("#file-xlsx", SAMPLE.xlsx);
  await page.setInputFiles("#load-rules", SAMPLE.rules);
  await page.waitForFunction(() => window.planTasks.state.pins.length === 13 && !window.planTasks.state.busy);
  assert.match(await page.textContent("#ib-sum"), /Still needed: enter the plan name/);
  assert.equal(await page.isDisabled("#ib-copy"), true);
  assert.equal(await page.isDisabled("#ib-file"), true);
  await page.fill("#plan-name", "Ground floor plan");
  assert.equal(await page.isDisabled("#ib-copy"), false);
});

test("on a phone the bar floats at the bottom, the page still fits, and the key wraps", async () => {
  const page = await withSample({ width: 390, height: 844 });
  await page.evaluate(() => document.querySelector("#viewport").scrollIntoView({ block: "center" }));
  await page.waitForFunction(() => !document.querySelector("#importbar").classList.contains("floating"));
  assert.equal(await page.$eval("#importbar", (e) => e.classList.contains("floating")), false, "in place while the drawing is on screen");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); // down at the pin list: the bar's own spot is out of sight, so it floats
  await page.waitForFunction(() => document.querySelector("#importbar").classList.contains("floating"));
  const fl = await box(page, "#importbar");
  assert.ok(fl.x >= 0 && fl.x + fl.w <= 390 && Math.abs(fl.y + fl.h - 844) < 20);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "nothing sideways");
  const key = await box(page, "#rulekey");
  assert.ok(key.x >= 0 && key.x + key.w <= 391);
  await page.ctx?.close?.();
});

test("on a phone the rules fold away once there are pins, and Edit rules opens them again; on a desktop they stay open", async () => {
  const phone = await withSample({ width: 390, height: 844 });
  assert.equal(await phone.$eval("#step-rules", (e) => e.classList.contains("collapsed")), true);
  assert.match(await phone.textContent("#sum-rules-sub"), /3 rules · All 13 pins/);
  assert.equal(await phone.$eval("#rules", (e) => getComputedStyle(e).display), "none");
  await phone.click("#change-rules");
  assert.equal(await phone.$eval("#step-rules", (e) => e.classList.contains("collapsed")), false);
  assert.equal(await phone.$eval("#rules", (e) => getComputedStyle(e).display !== "none"), true);
  await phone.close();
  const desk = await withSample({ width: 1440, height: 900 });
  assert.equal(await desk.$eval("#step-rules", (e) => e.classList.contains("collapsed")), false);
  await desk.close();
});

test("the last step: Download is the one filled button, Copy rows is quiet, Review pins jumps to the list", async () => {
  const page = await withSample({ width: 1440, height: 900 });
  assert.equal(await page.$eval("#ib-file", (e) => e.classList.contains("primary")), true);
  assert.equal(await page.$eval("#ib-copy", (e) => e.classList.contains("primary")), false);
  await page.click("#ib-review");
  await page.waitForFunction(() => document.querySelector("#pinlist").getBoundingClientRect().top < innerHeight / 2);
  await page.close();
});

test("the empty state shows the three steps, and on a phone the sample button sits right under the two file steps", async () => {
  const page = await env.browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${env.server.url}/index.html`);
  assert.equal(await page.locator(".dz-steps li").count(), 3);
  const r = await page.evaluate(() => { const y = (s) => document.querySelector(s).getBoundingClientRect().top; return y("#step-template") < y("#try-sample") && y("#try-sample") < y("#step-rules"); });
  assert.equal(r, true);
  await page.close();
});

test("the pins table on a phone shows only the columns you check", async () => {
  const page = await withSample({ width: 390, height: 844 });
  const shown = await page.$$eval(".pinlist thead th", (t) => t.filter((x) => getComputedStyle(x).display !== "none").length);
  assert.ok(shown <= 6, `${shown} columns`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.close();
});

test("the menu button holds the links; it opens, closes with Escape or a click elsewhere, and the header controls are one size", async () => {
  for (const [w, label] of [[1280, true], [390, false]]) {
    const page = await fresh({ width: w, height: 800 });
    assert.equal(await page.$eval(".menu-pop", (p) => p.hidden), true);
    await page.click(".menu-btn");
    assert.equal(await page.getAttribute(".menu-btn", "aria-expanded"), "true");
    assert.equal(await page.$eval("#topnav a[href='faq.html']", (a) => getComputedStyle(a).display !== "none"), true);
    const r = await page.evaluate(() => { const b = (s) => document.querySelector(s).getBoundingClientRect(); const p = b(".menu-pop"); return { inside: p.left >= 0 && p.right <= innerWidth, h: [b("#lang-btn").height, b(".menu-btn").height] }; });
    assert.equal(r.inside, true, "the list fits the window");
    assert.equal(r.h[0], r.h[1], "same height controls");
    assert.equal(await page.$eval(".menu-btn .menu-label", (s) => getComputedStyle(s).display !== "none"), label);
    await page.keyboard.press("Escape");
    assert.equal(await page.getAttribute(".menu-btn", "aria-expanded"), "false");
    await page.click(".menu-btn");
    await page.mouse.click(5, 400);
    assert.equal(await page.$eval(".menu-pop", (p) => p.hidden), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.close();
  }
});
