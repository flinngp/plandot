// Records the short silent clips in help/vid/ from the real app and the sample files.
// Run:  node scripts/make-howto-videos.mjs   (needs Playwright and ffmpeg, see README).
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { launch } from "../test/helpers/browser.mjs";

const root = new URL("../", import.meta.url).pathname;
const OUT = root + "help/vid/";
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(tmpdir() + "/plandot-vid-");
const W = 1280, H = 800;
const { browser, server, close } = await launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A visible pointer and a ring on every click, because a headless browser draws neither.
const POINTER = () => {
  const mk = () => {
    const c = document.createElement("div");
    c.id = "fakecursor";
    c.style.cssText = "position:fixed;z-index:2147483647;left:-40px;top:-40px;width:26px;height:26px;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));transition:none;";
    c.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l15 9-6.6 1.6L9.6 19z" fill="#fff" stroke="#172033" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const st = document.createElement("style");
    st.textContent = "@keyframes rip{from{transform:translate(-50%,-50%) scale(.2);opacity:.9}to{transform:translate(-50%,-50%) scale(1.6);opacity:0}}";
    document.head.append(st); document.body.append(c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX - 4 + "px"; c.style.top = e.clientY - 2 + "px"; }, true);
    addEventListener("mousedown", (e) => {
      const r = document.createElement("div");
      r.style.cssText = `position:fixed;z-index:2147483646;left:${e.clientX}px;top:${e.clientY}px;width:46px;height:46px;border-radius:50%;border:3px solid #ff7a1a;pointer-events:none;animation:rip .55s ease-out forwards;`;
      document.body.append(r); setTimeout(() => r.remove(), 700);
    }, true);
  };
  if (document.body) mk(); else addEventListener("DOMContentLoaded", mk);
};

let pos = [60, 60];
const glide = async (page, x, y, ms = 650) => {
  const n = Math.max(10, Math.round(ms / 28)), [x0, y0] = pos;
  for (let i = 1; i <= n; i++) {
    const t = i / n, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
    await sleep(ms / n);
  }
  pos = [x, y];
};
const centre = async (page, sel) => { await page.locator(sel).first().scrollIntoViewIfNeeded(); const b = await page.locator(sel).first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
const to = async (page, sel, ms) => { const [x, y] = await centre(page, sel); await glide(page, x, y, ms); };
const click = async (page, sel) => { await to(page, sel); await sleep(150); await page.mouse.down(); await sleep(80); await page.mouse.up(); await sleep(250); };
const pickFile = async (page, sel, file) => {
  const [x, y] = await centre(page, sel); await glide(page, x, y); await sleep(150);
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.locator(sel).first().click()]); // a plain mouse click does not open the chooser in headless Chrome
  await fc.setFiles(root + file); await sleep(300);
};
const scrollPanelTo = async (page, sel) => { await page.evaluate((sel) => { const c = document.querySelector(".controls"); c.scrollTo({ top: document.querySelector(sel).offsetTop - 10, behavior: "smooth" }); }, sel); await sleep(900); };

const only = process.argv[2]; // optional: record just one clip, e.g. clip-4-download
async function record(name, { setup, act }) {
  if (only && only !== name) return;
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: tmp, size: { width: W, height: H } } });
  await ctx.addInitScript(POINTER);
  const page = await ctx.newPage();
  const t0 = Date.now();
  pos = [W - 80, 120];
  await page.goto(server.url + "/index.html"); await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.waitForTimeout(500);
  if (setup) await setup(page);
  await page.mouse.move(pos[0], pos[1]);
  const start = (Date.now() - t0) / 1000 + 0.3;
  await page.waitForTimeout(300);
  await act(page);
  await page.waitForTimeout(900);
  const end = (Date.now() - t0) / 1000;
  const video = page.video();
  await ctx.close();
  const src = await video.path();
  const dur = (end - start).toFixed(2);
  const common = ["-y", "-loglevel", "error", "-ss", start.toFixed(2), "-t", dur, "-i", src, "-an", "-vf", "scale=960:-2,fps=20"];
  execFileSync("ffmpeg", [...common, "-c:v", "libx264", "-crf", "31", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT + name + ".mp4"]);
  execFileSync("ffmpeg", [...common, "-c:v", "libvpx-vp9", "-crf", "40", "-b:v", "0", OUT + name + ".webm"]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", (start + Math.min(dur * 0.75, dur - 0.5)).toFixed(2), "-i", src, "-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "5", OUT + name + ".jpg"]);
  console.log(name, dur + "s", Math.round(statSync(OUT + name + ".mp4").size / 1024) + " KB mp4", Math.round(statSync(OUT + name + ".webm").size / 1024) + " KB webm");
}

const ready = (page) => page.waitForFunction(() => window.planTasks.state.pdf?.tokens && !window.planTasks.state.busy);

// 1: choose the drawing and the import template, name the plan
await record("clip-1-files", {
  act: async (page) => {
    await pickFile(page, "#file-pdf", "samples/sample-drawing.pdf");
    await ready(page); await sleep(700);
    await pickFile(page, "#file-xlsx", "samples/sample-import-template.xlsx");
    await page.waitForFunction(() => window.planTasks.state.tpl?.parsed); await sleep(600);
    await click(page, "#plan-name");
    await page.keyboard.type("Ground floor plan", { delay: 90 });
    await sleep(700);
  },
});

// 2: type the text to find, watch the pins appear
await record("clip-2-rule", {
  setup: async (page) => {
    await page.setInputFiles("#file-pdf", root + "samples/sample-drawing.pdf"); await ready(page);
    await page.setInputFiles("#file-xlsx", root + "samples/sample-import-template.xlsx");
    await page.waitForFunction(() => window.planTasks.state.tpl?.parsed);
    await page.fill("#plan-name", "Ground floor plan");
    await page.evaluate(() => { document.querySelector(".controls").scrollTop = document.querySelector("#step-rules").offsetTop - 10; });
    await sleep(600);
  },
  act: async (page) => {
    await click(page, ".rule input[id$='-tags']");
    await page.keyboard.type("A1, A2, A3", { delay: 110 });
    await page.waitForFunction(() => window.planTasks.state.pins.length > 0); await sleep(500);
    const pin = await page.$eval("#overlay .pin", (e) => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await glide(page, pin[0] + 120, pin[1] + 80, 700);
    await glide(page, pin[0], pin[1], 600); await sleep(900);
  },
});

// 3: draw a box around a symbol
await record("clip-3-symbol", {
  setup: async (page) => {
    await page.setInputFiles("#file-pdf", root + "samples/sample-symbols.pdf"); await ready(page);
    await page.evaluate(() => { document.querySelector(".controls").scrollTop = document.querySelector("#step-rules").offsetTop - 10; });
    await sleep(500);
  },
  act: async (page) => {
    await to(page, ".rule select[id$=-kind]"); await sleep(200);
    await page.mouse.down(); await page.mouse.up(); await sleep(200);
    await page.selectOption(".rule select[id$=-kind]", "symbol"); await sleep(900);
    await click(page, ".rule button:has-text('Draw a box around the symbol')");
    const st = await page.$eval("#stage", (e) => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; });
    const at = (x, y) => [st[0] + (x / 1200) * st[2], st[1] + (y / 800) * st[3]];
    const [ax, ay] = at(130, 135), [bx, by] = at(232, 200);
    await glide(page, ax, ay, 900); await sleep(200);
    await page.mouse.down(); await sleep(150);
    await glide(page, bx, by, 900); await sleep(250);
    await page.mouse.up();
    await page.waitForFunction(() => window.planTasks.state.rules[0].symbol && window.planTasks.state.pins.length > 0);
    await page.waitForFunction(() => !window.planTasks.state.busy && !/^(Looking|Reading)/.test(document.querySelector("#status").textContent));
    await glide(page, bx + 260, by + 260, 700); await sleep(1400);
  },
});

// 4: open the preview, copy the rows, then download the import file
await record("clip-4-download", {
  setup: async (page) => {
    await page.setInputFiles("#file-pdf", root + "samples/sample-drawing.pdf"); await ready(page);
    await page.setInputFiles("#file-xlsx", root + "samples/sample-import-template.xlsx");
    await page.waitForFunction(() => window.planTasks.state.tpl?.parsed);
    await page.setInputFiles("#load-rules", root + "samples/sample-rules.json");
    await page.waitForFunction(() => window.planTasks.state.pins.length > 0);
    await page.fill("#plan-name", "Ground floor plan");
    await page.evaluate(() => { const c = document.querySelector(".controls"); c.scrollTop = document.querySelector("#step-export").offsetTop - 10; });
    await sleep(900);
  },
  act: async (page) => {
    await to(page, "#export-summary", 700); await sleep(700);
    await click(page, "#export-preview summary"); await sleep(1200);
    await scrollPanelTo(page, "#step-export");
    await click(page, "#batches .btn"); await sleep(1500); // Copy rows
    await Promise.all([page.waitForEvent("download"), click(page, "#dl-import")]);
    await sleep(1600);
  },
});

rmSync(tmp, { recursive: true, force: true });
await close();
