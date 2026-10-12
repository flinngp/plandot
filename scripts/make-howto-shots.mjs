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
  document.body.append(b);
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
await mark("#file-pdf", 1, { dx: -14, dy: -16 });
await mark("#file-xlsx", 2, { dx: -14, dy: -16 });
await mark("#plan-name", 3, { dx: -14, dy: -16 });
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
await shot("howto-2-rule.png", { x: a.x - 20, y: a.y - 22, width: a.width + 36, height: Math.min(a.height + 34, 520) });

// 3 sheet
await page.evaluate(() => document.querySelector(".controls").scrollTop = 0);
await page.mouse.move(5, 5);
const sp = await rectOf(".sheetpane");
const pin = await page.$eval("#overlay .pin", (e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
await page.evaluate(([x, y]) => { const o = document.createElement("div"); o.className = "ann"; o.style.cssText = `position:fixed;z-index:99998;pointer-events:none;left:${x - 22}px;top:${y - 22}px;width:44px;height:44px;border:2.5px solid #ff7a1a;border-radius:50%;`; document.body.append(o); const b = document.createElement("div"); b.className = "ann"; b.textContent = "1"; b.style.cssText = `position:fixed;z-index:99999;left:${x - 46}px;top:${y - 34}px;width:26px;height:26px;border-radius:50%;background:#ff7a1a;color:#fff;font:800 14px/26px Inter,sans-serif;text-align:center;`; document.body.append(b); }, pin);
await mark("#zoombar", 2, { dx: -16, dy: -16 });
await mark("#show-grid", 3, { outline: false, dx: 150, dy: -4 });
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
await mark("#export-preview summary", 2, { dx: -14, dy: -16, outline: false });
await mark("#dl-import", 3, { dx: -14, dy: -16 });
a = await rectOf("#step-export");
await shot("howto-5-download.png", { x: a.x - 6, y: a.y - 6, width: a.width + 12, height: Math.min(a.height + 12, 700) });

// symbols
await close();
