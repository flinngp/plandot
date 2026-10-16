// Retakes the annotated screenshots in help/img/ from the real app and the sample files.
// Run:  node scripts/make-howto-shots.mjs   (needs Playwright, see README). Then shrink them if you like.
import { launch } from "../test/helpers/browser.mjs";
const root = new URL("../", import.meta.url).pathname;
const OUT = root + "help/img/";
const { browser, server, close } = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
await page.goto(server.url + "/index.html");
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForTimeout(600);

// annotate: numbered badge at the top-left of an element, optional outline
const mark = (sel, n, { outline = true, dx = -12, dy = -12, nth = 0 } = {}) => page.evaluate(([sel, n, outline, dx, dy, nth]) => {
  const el = document.querySelectorAll(sel)[nth]; if (!el) throw new Error("no " + sel);
  const r = el.getBoundingClientRect();
  if (outline) { const o = document.createElement("div"); o.className = "ann"; o.style.cssText = `position:fixed;z-index:99998;pointer-events:none;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:2.5px solid #ff7a1a;border-radius:10px;`; document.body.append(o); }
  const b = document.createElement("div"); b.className = "ann"; b.textContent = n;
  b.style.cssText = `position:fixed;z-index:99999;pointer-events:none;left:${r.left + dx}px;top:${r.top + dy}px;width:26px;height:26px;border-radius:50%;background:#ff7a1a;color:#fff;font:800 14px/26px Inter,system-ui,sans-serif;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.35);`;
  /* outlines only, no number badges */
}, [sel, n, outline, dx, dy, nth]);
const clear = () => page.evaluate(() => document.querySelectorAll(".ann").forEach((e) => e.remove()));
const rectOf = (sel, pad = 0) => page.$eval(sel, (e, pad) => { const r = e.getBoundingClientRect(); return { x: Math.max(0, r.left - pad), y: Math.max(0, r.top - pad), width: r.width + pad * 2, height: r.height + pad * 2 }; }, pad);
const shot = async (name, clip) => { await page.screenshot({ path: OUT + name, clip }); await clear(); };
const scrollPanel = (sel) => page.evaluate((sel) => { const c = document.querySelector(".controls"); const el = document.querySelector(sel); c.scrollTop = el.offsetTop - 10; }, sel);

// load real files into the real inputs so the screen shows file names
await page.setInputFiles("#file-pdf", root + "samples/sample-drawing.pdf");
await page.waitForFunction(() => window.planTasks.state.pdf?.tokens);
await page.setInputFiles("#file-xlsx", root + "samples/sample-import-template.xlsx");
await page.waitForFunction(() => window.planTasks.state.tpl?.parsed);
await page.setInputFiles("#load-rules", root + "samples/sample-rules.json");
await page.waitForFunction(() => window.planTasks.state.pins.length > 0);
await page.fill("#plan-name", "Ground floor plan");
await page.waitForTimeout(1200);

// 1 files
await page.evaluate(() => document.querySelector(".controls").scrollTop = 0);
await page.waitForTimeout(200);
await page.mouse.click(700, 60); // leave the plan name box: finished steps shrink to a line with a tick
await page.waitForFunction(() => document.querySelector("#step-template").classList.contains("collapsed"));
await page.waitForTimeout(300);
await mark("#sum-drawing", 1, { dx: -14, dy: -16 });
await mark("#sum-template", 2, { dx: -14, dy: -16 });
let a = await rectOf("#step-drawing"), b = await rectOf("#step-template");
await shot("howto-1-files.png", { x: a.x - 6, y: a.y - 6, width: a.width + 12, height: b.y + b.height - a.y + 12 });

// 2 rule
await page.evaluate(() => document.querySelector(".controls").scrollTop = document.querySelector("#step-rules").offsetTop - 10);
await page.waitForTimeout(200);
await mark(".rule .pair .field:nth-child(1)", 1, { dx: -14, dy: -16 });
await mark(".rule .pair .field:nth-child(2)", 2, { dx: -14, dy: -16 });
await mark(".rule .insert", 3, { dx: -14, dy: -12 });
await mark(".rule .becomes", 4, { dx: -14, dy: -12 });
a = await rectOf(".rule");
const panel = await rectOf(".controls");
const ry = Math.max(a.y - 18, panel.y + 2);
await shot("howto-2-rule.png", { x: a.x - 10, y: ry, width: a.width + 20, height: Math.min(a.y + a.height + 14 - ry, 440) });

// 3 sheet
await page.evaluate(() => document.querySelector(".controls").scrollTop = 0);
await page.mouse.move(5, 5);
const sp = await rectOf(".sheetpane");
const pin = await page.$eval("#overlay .pin", (e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
await page.evaluate(([x, y]) => { const o = document.createElement("div"); o.className = "ann"; o.style.cssText = `position:fixed;z-index:99998;pointer-events:none;left:${x - 22}px;top:${y - 22}px;width:44px;height:44px;border:2.5px solid #ff7a1a;border-radius:50%;`; document.body.append(o); const b = document.createElement("div"); b.className = "ann"; b.textContent = "1"; b.style.cssText = `position:fixed;z-index:99999;left:${x - 46}px;top:${y - 34}px;width:26px;height:26px;border-radius:50%;background:#ff7a1a;color:#fff;font:800 14px/26px Inter,sans-serif;text-align:center;`; /* outlines only, no number badges */ }, pin);
await mark("#zoombar", 2, { dx: -16, dy: -16 });
await mark("#show-grid", 3, { dx: -4, dy: -4 });
await mark("#importbar", 4, { dx: -4, dy: -4 });
await shot("howto-3-sheet.png", sp);

// 4 pin table with one pin switched off
await page.setViewportSize({ width: 1440, height: 1500 }); await page.waitForTimeout(600);
await page.evaluate(() => { const w = document.querySelector(".tablewrap"); w.style.maxHeight = "none"; w.style.overflow = "visible"; document.querySelector("#pinlist").scrollIntoView(); });
await page.waitForTimeout(300);
await page.click("#pin-rows tr:nth-child(3) input[type=checkbox]");
await page.waitForTimeout(300);
await page.waitForTimeout(1500);
await mark("#pin-rows tr:nth-child(3) td:nth-child(1)", 1, { dx: -4, dy: -14, outline: true });
await mark("#pin-rows tr:nth-child(2) td:nth-child(7)", 2, { dx: -16, dy: -10, outline: true });
await mark("#rulekey", 3, { dx: -16, dy: -10, outline: true });
const pl = await rectOf("#pinlist");
await shot("howto-4-pins.png", { x: pl.x - 8, y: pl.y - 8, width: pl.width + 16, height: Math.min(pl.height, 300) + 16 });
await page.click("#pin-rows tr:nth-child(3) input[type=checkbox]");

await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(600);
// 5 download
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(900);
await page.evaluate(() => { const c = document.querySelector(".controls"); c.scrollTop = document.querySelector("#step-export").offsetTop - 10; });
await page.click("#export-preview summary");
await page.waitForSelector("#preview-table th");
await page.waitForTimeout(300);
await page.evaluate(() => { const c = document.querySelector(".controls"); c.scrollTop = document.querySelector("#step-export").offsetTop - 10; });
await mark("#export-summary", 1, { dx: -24, dy: -16 });
await mark("#export-preview summary", 2, { dx: -14, dy: -16 });
await mark("#batches .btn", 3, { dx: -14, dy: -16 });
await mark("#dl-import", 4, { dx: -14, dy: -16 });
a = await rectOf("#step-export");
await shot("howto-5-download.png", { x: a.x - 6, y: a.y - 6, width: a.width + 12, height: Math.min(a.height + 12, 700) });

// 6 reuse your setup
await page.evaluate(() => { const c = document.querySelector(".controls"); c.scrollTop = document.querySelector("#step-rules").scrollHeight - 200 + document.querySelector("#step-rules").offsetTop; });
await page.evaluate(() => { const b = document.querySelector("#save-rules"); b.closest("details").open = true; b.scrollIntoView({ block: "center" }); });
await page.waitForTimeout(300);
await mark("#save-rules", 1, { dx: -14, dy: -16 });
await mark("#load-rules-btn", 2, { dx: -14, dy: -16 });
{
  const box = await page.$eval("#save-rules", (e) => { const r = e.closest("details").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  await shot("howto-6-reuse.png", { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 });
}

// symbols

// ---- finding symbols: the made-up patio doors
const sym = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
const tagEl = async (pg, loc, name) => { await pg.locator(loc).first().evaluate((e, n) => { e.dataset.shot = n; }, name); return `[data-shot=${name}]`; };
const markOn = (pg, sel, n, { outline = true, dx = -12, dy = -12, nth = 0 } = {}) => pg.evaluate(([sel, n, outline, dx, dy, nth]) => {
  const el = document.querySelectorAll(sel)[nth]; const r = el.getBoundingClientRect();
  if (outline) { const o = document.createElement("div"); o.className = "ann"; o.style.cssText = `position:fixed;z-index:99998;pointer-events:none;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:2.5px solid #ff7a1a;border-radius:10px;`; document.body.append(o); }
  const b = document.createElement("div"); b.className = "ann"; b.textContent = n;
  b.style.cssText = `position:fixed;z-index:99999;pointer-events:none;left:${r.left + dx}px;top:${r.top + dy}px;width:26px;height:26px;border-radius:50%;background:#ff7a1a;color:#fff;font:800 14px/26px Inter,system-ui,sans-serif;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.35);`;
  /* outlines only, no number badges */
}, [sel, n, outline, dx, dy, nth]);
// a ring and badge at a spot on the 1200 x 800 sample, in PDF points from the top-left
const markAt = (pg, x, y, n, { r = 34, dx = -r - 8, dy = -r - 8, ring = true } = {}) => pg.evaluate(async ([x, y, n, r, dx, dy, ring]) => {
  const st = document.querySelector("#stage").getBoundingClientRect();
  const cx = st.left + (x / 1200) * st.width, cy = st.top + (y / 800) * st.height;
  if (ring) { const o = document.createElement("div"); o.className = "ann"; o.style.cssText = `position:fixed;z-index:99998;pointer-events:none;left:${cx - r}px;top:${cy - r}px;width:${r * 2}px;height:${r * 2}px;border:2.5px solid #ff7a1a;border-radius:50%;`; document.body.append(o); }
  const b = document.createElement("div"); b.className = "ann"; b.textContent = n;
  b.style.cssText = `position:fixed;z-index:99999;pointer-events:none;left:${cx + dx}px;top:${cy + dy}px;width:26px;height:26px;border-radius:50%;background:#ff7a1a;color:#fff;font:800 14px/26px Inter,system-ui,sans-serif;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.35);`;
  /* outlines only, no number badges */
}, [x, y, n, r, dx, dy, ring]);
await sym.goto(server.url + "/index.html"); await sym.evaluate(() => localStorage.clear()); await sym.reload();
await sym.setInputFiles("#file-pdf", root + "samples/sample-symbols.pdf");
await sym.waitForFunction(() => window.planTasks.state.pdf?.tokens);
await sym.selectOption(".rule select[id$=-kind]", "symbol");
await sym.waitForTimeout(800);
await sym.evaluate(() => { document.querySelector(".controls").scrollTop = document.querySelector("#step-rules").offsetTop - 10; });
await sym.waitForTimeout(900);
await markOn(sym, ".rule .field:has(select[id$=-kind])", 1, { dx: -14, dy: -16 });
await markOn(sym, await tagEl(sym, ".rule button:has-text('Draw a box around the symbol')", "drawbtn"), 2, { dx: -14, dy: -16 });
let r1 = await sym.$eval(".rule", (e) => { const b = e.getBoundingClientRect(); const top = Math.max(b.top - 20, document.querySelector(".controls").getBoundingClientRect().top); return { x: b.left - 10, y: top + 2, width: b.width + 20, height: Math.min(b.bottom + 10 - top, 380) }; });
await sym.screenshot({ path: OUT + "symbols-1-start.png", clip: r1 });
await sym.evaluate(() => document.querySelectorAll(".ann").forEach((e) => e.remove()));

// draw the box around the first door (shown mid-drag)
await sym.click(".rule button:has-text('Draw a box around the symbol')");
const st = await sym.$eval("#stage", (e) => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; });
const at = (x, y) => [st[0] + (x / 1200) * st[2], st[1] + (y / 800) * st[3]];
const [ax, ay] = at(130, 135), [bx, by] = at(232, 200);
await sym.mouse.move(ax, ay); await sym.mouse.down(); await sym.mouse.move(bx, by, { steps: 6 });
await sym.waitForTimeout(300);
await markAt(sym, 180, 168, 1, { r: 62, dx: 56, dy: -78 });
const symPane = await sym.$eval(".sheetpane", (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; });
await sym.screenshot({ path: OUT + "symbols-2-box.png", clip: symPane });
await sym.evaluate(() => document.querySelectorAll(".ann").forEach((e) => e.remove()));
await sym.mouse.up();
await sym.waitForFunction(() => window.planTasks.state.rules[0].symbol && window.planTasks.state.pins.length > 0);
await sym.waitForFunction(() => !window.planTasks.state.busy && !/^(Looking|Reading)/.test(document.querySelector("#status").textContent));
await sym.mouse.move(5, 5);
await sym.waitForTimeout(900);

// result: pins on every door, none on the windows
await markAt(sym, 200, 150, 1, { r: 40, dx: -52, dy: -50 });
await markAt(sym, 1140, 560, 1, { r: 40, dx: -62, dy: -58 });
await markAt(sym, 1000, 150, 2, { r: 36, dx: -48, dy: -42 });
await markAt(sym, 60, 560, 2, { r: 36, dx: 24, dy: -62 });
await markAt(sym, 500, 700, 2, { r: 36, dx: -48, dy: 16 });
// (the guide no longer shows a separate "found" picture)
await sym.evaluate(() => document.querySelectorAll(".ann").forEach((e) => e.remove()));

// the rule card after the box: picture of the symbol and the match settings
await sym.evaluate(() => { document.querySelector(".controls").scrollTop = document.querySelector("#step-rules").offsetTop - 10; });
await sym.waitForTimeout(900);
await markOn(sym, ".rule .sym-preview", 1, { dx: -14, dy: -14 });
await markOn(sym, ".rule .slider", 2, { dx: -14, dy: -16 });
await markOn(sym, await tagEl(sym, ".rule label.check:has-text('turned or mirrored')", "turned"), 3, { dx: -16, dy: -16, outline: false });
await markOn(sym, await tagEl(sym, ".rule label.check:has-text('bigger or smaller')", "sizes"), 4, { dx: -16, dy: -16, outline: false });
const r4 = await sym.$eval(".rule", (e) => { const b = e.getBoundingClientRect(); const top = Math.max(b.top - 20, document.querySelector(".controls").getBoundingClientRect().top); return { x: b.left - 20, y: top, width: b.width + 40, height: Math.min(b.bottom + 10 - top, 640) }; });
await sym.screenshot({ path: OUT + "symbols-4-settings.png", clip: r4 });
await close();
