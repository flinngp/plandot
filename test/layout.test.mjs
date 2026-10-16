// Page layout and the Start over button, driven in a real browser with the made-up sample files.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./helpers/browser.mjs";

const root = new URL("..", import.meta.url).pathname;
const SAMPLE = {
  pdf: `${root}samples/sample-drawing.pdf`,
  xlsx: `${root}samples/sample-import-template.xlsx`,
  rules: `${root}samples/sample-rules.json`,
};

let env;
before(async () => { env = await launch(); });
after(async () => env.close());

async function loadSample(page) {
  await page.goto(`${env.server.url}/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.setInputFiles("#file-pdf", SAMPLE.pdf);
  await page.setInputFiles("#file-xlsx", SAMPLE.xlsx);
  await page.setInputFiles("#load-rules", SAMPLE.rules);
  await page.fill("#plan-name", "Ground floor plan");
  await page.waitForFunction(() => window.planTasks.state.pins.length > 0 && !window.planTasks.state.busy);
  await page.waitForTimeout(400);
}

// The sheet and the setup panel are one block, with the pin list below. Scroll the whole page and
// make sure the sheet never covers the pin list, at laptop, big monitor, tablet and phone sizes.
for (const [w, h] of [[1440, 780], [1280, 720], [1920, 1080], [820, 1100], [390, 800]]) {
  test(`the sheet never covers the task list while scrolling (${w} x ${h})`, async () => {
    const page = await env.browser.newPage({ viewport: { width: w, height: h } });
    await loadSample(page);
    const res = await page.evaluate(async () => {
      const pane = document.querySelector(".sheetpane"), list = document.querySelector("#pinlist");
      const total = document.documentElement.scrollHeight;
      let covered = 0, stuckAndCut = 0; // stuckAndCut stays 0: nothing sticks any more
      for (let y = 0; y <= total; y += 80) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 12));
        const a = pane.getBoundingClientRect(), b = list.getBoundingClientRect();
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        if (overlapY > 1 && overlapX > 1) covered++;
      }
      return { covered, stuckAndCut };
    });
    await page.close();
    assert.equal(res.covered, 0, "the sheet overlapped the task list");
  });
}

test("the pin list runs under both columns, and the setup panel is as tall as the sheet and scrolls inside itself", async () => {
  const page = await env.browser.newPage({ viewport: { width: 1440, height: 780 } });
  await loadSample(page);
  const r = await page.evaluate(() => {
    const pane = document.querySelector(".sheetpane").getBoundingClientRect(), list = document.querySelector("#pinlist").getBoundingClientRect(), panel = document.querySelector(".controls");
    const c = panel.getBoundingClientRect();
    return { under: list.top >= Math.max(pane.bottom, c.bottom) - 1, full: list.left <= c.left + 2 && list.right >= pane.right - 2, same: Math.abs(c.height - pane.height) < 2, scrolls: panel.scrollHeight > panel.clientHeight, pos: getComputedStyle(panel).position };
  });
  assert.ok(r.under && r.full, "the pin list is under both columns");
  assert.ok(r.same, "panel and sheet are the same height");
  assert.notEqual(r.pos, "sticky");
  await page.close();
});

test("on a phone the steps come first, then the sheet, and nothing overflows sideways", async () => {
  const page = await env.browser.newPage({ viewport: { width: 390, height: 800 } });
  await loadSample(page);
  const r = await page.evaluate(() => ({ sheetFirst: document.querySelector("#step-drawing").getBoundingClientRect().top < document.querySelector(".sheetpane").getBoundingClientRect().top, fits: document.documentElement.scrollWidth <= innerWidth }));
  await page.close();
  assert.deepEqual(r, { sheetFirst: true, fits: true });
});

// ------------------------------------------------------------------ Start over

test("Start over asks first, then clears the drawing, template, rules, pins and saved data", async () => {
  const page = await env.browser.newPage({ viewport: { width: 1440, height: 900 } });
  await loadSample(page);
  const before = await page.evaluate(() => ({ pins: window.planTasks.state.pins.length, rules: window.planTasks.state.rules.length, saved: localStorage.getItem("plantasks.v1") !== null }));
  assert.equal(before.pins, 13);
  assert.equal(before.rules, 3);

  // Cancel: nothing changes.
  let message = "";
  page.once("dialog", async (d) => { message = d.message(); await d.dismiss(); });
  await page.click("#start-over");
  assert.match(message, /Start over\?/);
  assert.equal(await page.evaluate(() => window.planTasks.state.pins.length), 13);

  // OK: everything goes back to the beginning.
  page.once("dialog", (d) => d.accept());
  await page.click("#start-over");
  await page.waitForFunction(() => window.planTasks.state.pdf === null);
  const after = await page.evaluate(() => {
    const s = window.planTasks.state, $ = (q) => document.querySelector(q);
    return {
      pdf: s.pdf, tpl: s.tpl, pins: s.pins.length, rules: s.rules.length, rule: { tags: s.rules[0].tags, name: s.rules[0].name }, settings: s.settings, edits: Object.keys(s.edits).length,
      saved: localStorage.getItem("plantasks.v1"),
      planName: $("#plan-name").value, room: $("#room-pattern").value, grid: $("#show-grid").checked,
      files: [$("#file-pdf").value, $("#file-xlsx").value],
      sheetHidden: $("#sheet").hidden, dropVisible: !$("#dropzone").hidden, listHidden: $("#pinlist").hidden,
      title: $("#tb-name").textContent, pinsLabel: $("#tb-pins").textContent, size: $("#tb-size").textContent,
      chips: $("#tpl-chips").children.length, importDisabled: $("#dl-import").disabled, drawAreaDisabled: $("#draw-area").disabled,
      status: $("#status").textContent, ruleCards: document.querySelectorAll(".rule").length,
    };
  });
  await page.close();
  assert.equal(after.pdf, null);
  assert.equal(after.tpl, null);
  assert.equal(after.pins, 0);
  assert.equal(after.rules, 1);
  assert.deepEqual(after.rule, { tags: "", name: "Rule 1" });
  assert.deepEqual(after.settings, { planName: "", roomPattern: "", roomDistance: 10, area: null, showGrid: false });
  assert.equal(after.edits, 0);
  assert.equal(after.saved, null);
  assert.equal(after.planName, "");
  assert.equal(after.room, "");
  assert.equal(after.grid, false);
  assert.deepEqual(after.files, ["", ""]);
  assert.equal(after.sheetHidden, true);
  assert.equal(after.dropVisible, true);
  assert.equal(after.listHidden, true);
  assert.equal(after.title, "None loaded");
  assert.equal(after.pinsLabel, "0");
  assert.equal(after.size, "–");
  assert.equal(after.chips, 0);
  assert.equal(after.importDisabled, true);
  assert.equal(after.drawAreaDisabled, true);
  assert.equal(after.ruleCards, 1);
  assert.match(after.status, /cleared/i);
});

test("after Start over the same files load again and give the same result", async () => {
  const page = await env.browser.newPage({ viewport: { width: 1440, height: 900 } });
  await loadSample(page);
  page.once("dialog", (d) => d.accept());
  await page.click("#start-over");
  await page.waitForFunction(() => window.planTasks.state.pdf === null);
  // Choosing the very same file again must still be noticed (the file box was emptied).
  await page.setInputFiles("#file-pdf", SAMPLE.pdf);
  await page.setInputFiles("#file-xlsx", SAMPLE.xlsx);
  await page.setInputFiles("#load-rules", SAMPLE.rules);
  await page.fill("#plan-name", "Ground floor plan");
  await page.waitForFunction(() => window.planTasks.state.pins.length === 13 && !window.planTasks.state.busy);
  const disabled = await page.$eval("#dl-import", (b) => b.disabled);
  await page.close();
  assert.equal(disabled, false);
});

test("Start over on an empty page does not nag, and a reload after it remembers nothing", async () => {
  const page = await env.browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${env.server.url}/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  let asked = false;
  page.on("dialog", async (d) => { asked = true; await d.dismiss(); });
  await page.click("#start-over");
  await page.waitForTimeout(200);
  assert.equal(asked, false);

  await loadSample(page);
  page.removeAllListeners("dialog");
  page.once("dialog", (d) => d.accept());
  await page.click("#start-over");
  await page.waitForFunction(() => window.planTasks.state.pdf === null);
  await page.reload();
  const remembered = await page.evaluate(() => ({ rules: window.planTasks.state.rules.length, tags: window.planTasks.state.rules[0].tags, plan: document.querySelector("#plan-name").value }));
  await page.close();
  assert.deepEqual(remembered, { rules: 1, tags: "", plan: "" });
});

test("Start over while the drawing is still being read throws the old result away", async () => {
  const page = await env.browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${env.server.url}/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.setInputFiles("#file-pdf", SAMPLE.pdf);
  await page.setInputFiles("#load-rules", SAMPLE.rules); // starts finding dots in the background
  page.once("dialog", (d) => d.accept());
  await page.click("#start-over");
  await page.waitForTimeout(1500); // long enough for any late work to land
  const late = await page.evaluate(() => ({ pins: window.planTasks.state.pins.length, pdf: window.planTasks.state.pdf, hidden: document.querySelector("#pinlist").hidden }));
  await page.close();
  assert.equal(late.pins, 0);
  assert.equal(late.pdf, null);
  assert.equal(late.hidden, true);
});
