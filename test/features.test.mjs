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

test("the page works at phone width: one column, the drawing first, nothing sideways", async () => {
  const page = await withSample({ width: 390, height: 800 });
  const info = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, order: document.querySelector(".sheetpane").getBoundingClientRect().top < document.querySelector(".controls").getBoundingClientRect().top }));
  assert.ok(info.over <= 1, `scrolls sideways by ${info.over}`);
  assert.ok(info.order);
  await page.click("#zoom-in");
  assert.equal(await level(page), "140%");
  await page.close();
});
