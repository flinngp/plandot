// Pin wording, (i) pop-ups, the flag language menu, footer, feedback link, copy-details, help pages and the phone tagline.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launch } from "./helpers/browser.mjs";
import { feedbackHref, VERSION } from "../js/config.js";

const root = new URL("..", import.meta.url).pathname;
const SAMPLE = { pdf: `${root}samples/sample-drawing.pdf`, xlsx: `${root}samples/sample-import-template.xlsx`, rules: `${root}samples/sample-rules.json` };
let env;
before(async () => { env = await launch(); });
after(async () => env.close());

async function fresh(viewport = { width: 1440, height: 900 }, ctxOpts = {}) {
  const ctx = await env.browser.newContext({ viewport, ...ctxOpts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") page.errors.push(m.text()); });
  await page.goto(`${env.server.url}/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  page.ctx = ctx;
  return page;
}
async function loaded(viewport, ctxOpts) {
  const page = await fresh(viewport, ctxOpts);
  await page.setInputFiles("#file-pdf", SAMPLE.pdf);
  await page.setInputFiles("#file-xlsx", SAMPLE.xlsx);
  await page.setInputFiles("#load-rules", SAMPLE.rules);
  await page.fill("#plan-name", "Ground floor plan");
  await page.waitForFunction(() => window.planTasks.state.pins.length === 13 && !window.planTasks.state.busy);
  return page;
}

// ---------------------------------------------------------------- pin wording
test("the page says pin, not task, outside the template's own column names", async () => {
  const page = await loaded();
  await page.click("#export-preview summary");
  const text = await page.evaluate(() => {
    const skip = new Set(["tpl-chips", "preview-table"]); // the template's own column names stay as they are
    const skipClass = ["more-grid"];
    const out = [];
    const walk = (el) => {
      if (skip.has(el.id) || el.hidden || skipClass.some((c) => el.classList?.contains(c))) return;
      for (const n of el.childNodes) {
        if (n.nodeType === 3) out.push(n.textContent);
        else if (n.nodeType === 1 && !["SCRIPT", "STYLE", "OPTION"].includes(n.tagName)) walk(n);
      }
      for (const a of ["aria-label", "placeholder", "title", "data-info"]) if (el.getAttribute?.(a)) out.push(el.getAttribute(a));
    };
    walk(document.body);
    return out.join(" | ");
  });
  const hits = text.match(/.{0,30}\btasks?\b.{0,30}/gi) || [];
  assert.deepEqual(hits, [], "the word task is still shown");
  assert.equal(page.errors.length, 0, page.errors.join("\n"));
  await page.ctx.close();
});

test("exported file names say pin", async () => {
  const page = await loaded();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#dl-import")]);
  assert.match(dl.suggestedFilename(), /pin import\.xlsx$/);
  await page.ctx.close();
});

// ---------------------------------------------------------------- info pop-ups
test("a dozen (i) buttons explain the main fields, and open and close with the mouse and the keyboard", async () => {
  const page = await loaded();
  await page.evaluate(() => document.querySelectorAll("details.settings").forEach((d) => (d.open = true)));
  const count = await page.$$eval(".info-btn", (b) => b.length);
  assert.ok(count >= 12, `only ${count}`);
  // every button names what it explains and is wired to its text
  const bad = await page.$$eval(".info-btn", (bs) => bs.filter((b) => !b.getAttribute("aria-label")?.startsWith("About ") || b.getAttribute("aria-expanded") !== "false" || !document.getElementById(b.getAttribute("aria-controls"))?.textContent.trim()).length);
  assert.equal(bad, 0);
  const btn = page.locator(".rule:first-child .lab:has(label[for$='-title']) .info-btn");
  assert.equal(await btn.getAttribute("aria-label"), "About Pin title");
  await btn.click();
  assert.equal(await btn.getAttribute("aria-expanded"), "true");
  const pop = page.locator("#" + (await btn.getAttribute("aria-controls")));
  assert.equal(await pop.textContent(), "Names the pin. Use the buttons to add the callout text, the nearest room or a running number.");
  const r = await pop.evaluate((e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: innerWidth, h: innerHeight }; });
  assert.ok(r.l >= 0 && r.r <= r.w && r.t >= 0 && r.b <= r.h, "the pop-up is fully on screen");
  await page.keyboard.press("Escape");
  assert.equal(await btn.getAttribute("aria-expanded"), "false");
  assert.equal(await page.evaluate(() => document.activeElement.className), "info-btn", "focus returns to the button");
  // keyboard: Enter opens, clicking elsewhere closes, only one is open at a time
  await page.keyboard.press("Enter");
  assert.equal(await btn.getAttribute("aria-expanded"), "true");
  await page.click("#plan-name");
  assert.equal(await btn.getAttribute("aria-expanded"), "false");
  await btn.click();
  await page.locator("#step-template .info-btn").first().click();
  assert.equal(await page.$$eval(".info-btn[aria-expanded=true]", (b) => b.length), 1);
  await page.ctx.close();
});

test("the (i) text is translated and stays on screen on a phone", async () => {
  const page = await loaded({ width: 390, height: 800 });
  await page.click("#lang-btn");
  await page.click("#lang-list [data-lang=de]");
  await page.waitForFunction(() => document.documentElement.lang === "de");
  const btn = page.locator("#step-template .info-btn").first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const pop = page.locator("#" + (await btn.getAttribute("aria-controls")));
  assert.match(await pop.textContent(), /Fieldwire-Projekt/);
  assert.match(await btn.getAttribute("aria-label"), /^Info zu: /);
  const r = await pop.evaluate((e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, w: innerWidth }; });
  assert.ok(r.l >= 0 && r.r <= r.w, `pop-up off screen ${JSON.stringify(r)}`);
  await page.ctx.close();
});

// ---------------------------------------------------------------- language menu with flags
test("every language has a flag in the menu, and the menu works from the keyboard", async () => {
  const page = await fresh();
  assert.equal(await page.$$eval("#lang-list svg.flag", (f) => f.length), 13);
  assert.equal(await page.$$eval("#lang-btn svg.flag", (f) => f.length), 1);
  assert.equal(await page.getAttribute("#lang-btn", "aria-label"), "Language: English");
  await page.focus("#lang-btn");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.getAttribute("#lang-btn", "aria-expanded"), "true");
  assert.equal(await page.evaluate(() => document.activeElement.id), "lang-list");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  assert.equal(await page.getAttribute("#lang-btn", "aria-expanded"), "false");
  assert.match(await page.getAttribute("#lang-btn", "aria-label"), /^Langue : Français$|^Langue: Français$/);
  assert.equal(await page.evaluate(() => document.activeElement.id), "lang-btn");
  // Escape closes without changing; typing a letter jumps
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  assert.equal(await page.getAttribute("#lang-btn", "aria-expanded"), "false");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("Sv");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.documentElement.lang === "sv");
  // it is remembered
  await page.reload();
  await page.waitForFunction(() => document.documentElement.lang === "sv");
  assert.equal(page.errors.length, 0, page.errors.join("\n"));
  await page.ctx.close();
});

test("the menu opens fully on screen on a phone", async () => {
  const page = await fresh({ width: 390, height: 800 });
  await page.click("#lang-btn");
  const r = await page.$eval("#lang-list", (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, w: innerWidth }; });
  assert.ok(r.l >= 0 && r.r <= r.w, JSON.stringify(r));
  await page.ctx.close();
});

// ---------------------------------------------------------------- footer, feedback, what's new
test("the footer is short: independent-tool note, privacy line and copyright, with no version", async () => {
  const page = await fresh();
  const text = await page.textContent("#sitefoot");
  assert.match(text, /independent tool, not made or endorsed by Fieldwire by Hilti/);
  assert.match(text, /never uploaded/);
  assert.match(text, /All rights reserved/);
  assert.doesNotMatch(text, /as is|Version|Check the pins/);
  const pkg = JSON.parse(await readFile(`${root}package.json`, "utf8"));
  assert.equal(pkg.version, VERSION, "package.json and js/config.js disagree");
  assert.equal(VERSION, "1.0.0");
  assert.equal(await page.$(".whatsnew-btn, #whatsnew"), null, "the What's new box is gone");
  await page.ctx.close();
});

test("the menu bar at the top links to the how to guide and the FAQ, on every page", async () => {
  const page = await fresh();
  const links = await page.$$eval("#topnav a", (a) => a.map((x) => [x.textContent, x.getAttribute("href")]));
  assert.deepEqual(links.slice(0, 3), [["Take the tour", "#"], ["How to guide", "howto.html"], ["FAQ", "faq.html"]]);
  assert.ok(!/null|undefined/.test(await page.textContent("#topnav")), "stray text in the menu");
  assert.ok(await page.$eval("#topnav", (n) => n.getBoundingClientRect().bottom <= document.querySelector(".masthead").getBoundingClientRect().top + 1), "the menu sits above the header");
  await page.click("#topnav a[href='howto.html']");
  await page.waitForURL(/howto\.html/);
  await page.waitForSelector("#topnav a");
  assert.equal(await page.getAttribute("#topnav a[href='howto.html']", "aria-current"), "page");
  assert.equal(await page.textContent("#topnav a:first-child"), "Open Plandot");
  assert.equal(await page.textContent("h1:not(.brand h1)"), "How to guide");
  await page.click("#topnav a[href='faq.html']");
  await page.waitForURL(/faq\.html/);
  await page.waitForSelector("#topnav a");
  assert.equal(await page.getAttribute("#topnav a[href='faq.html']", "aria-current"), "page");
  await page.click("#topnav a[href='index.html']");
  await page.waitForURL(/index\.html/);
  await page.waitForSelector("#topnav a");
  await page.ctx.close();
});

test("the menu is in the chosen language and fits a phone", async () => {
  const page = await fresh({ width: 360, height: 800 });
  await page.click("#lang-btn");
  await page.click("#lang-list [data-lang=de]");
  await page.waitForFunction(() => document.documentElement.lang === "de");
  assert.equal(await page.textContent("#topnav a[href='howto.html']"), "Anleitung");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.ctx.close();
});

test("the feedback link builds from a form address or a shared email, and is hidden when neither is set", async () => {
  assert.equal(feedbackHref({ url: "", email: "" }), "");
  assert.equal(feedbackHref({ url: "https://forms.example/abc", email: "x@y.z" }), "https://forms.example/abc");
  const mail = feedbackHref({ url: "", email: "feedback@example.com" }, "9.9.9", "TestBrowser");
  assert.match(mail, /^mailto:feedback@example\.com\?subject=/);
  assert.match(decodeURIComponent(mail), /Plandot feedback \(9\.9\.9\)/);
  assert.match(decodeURIComponent(mail), /TestBrowser/);
  const page = await fresh();
  const configured = (await readFile(`${root}js/config.js`, "utf8")).match(/export const FEEDBACK = \{ url: "([^"]*)", email: "([^"]*)" \}/);
  const shown = (await page.$(".feedback-link")) !== null;
  assert.equal(shown, Boolean(configured[1] || configured[2]));
  await page.ctx.close();
});

// ---------------------------------------------------------------- errors: copy details
test("an error offers Copy details, and the text holds the version and browser but no file name", async () => {
  const page = await fresh({ width: 1440, height: 900 }, { permissions: ["clipboard-read", "clipboard-write"] });
  await page.setInputFiles("#file-pdf", { name: "secret-project-plan.pdf", mimeType: "application/pdf", buffer: Buffer.from("this is not a pdf") });
  await page.waitForSelector("#status .copy-details");
  assert.match(await page.textContent("#status"), /couldn't be read as a PDF/);
  await page.click("#status .copy-details");
  await page.waitForFunction(() => document.querySelector("#status .copy-details")?.textContent === "Copied");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, new RegExp(`^Plandot ${VERSION.replaceAll(".", "\\.")}`));
  assert.match(clip, /Browser: /);
  assert.match(clip, /Message: That file couldn't be read as a PDF\./);
  assert.ok(!/secret-project-plan/.test(clip), "the file name leaked into the details");
  await page.ctx.close();
});

// ---------------------------------------------------------------- phone tagline
test("the tagline under the logo shows in full on a phone", async () => {
  for (const w of [320, 360, 390]) {
    const page = await fresh({ width: w, height: 800 });
    const r = await page.$eval(".brand p", (p) => { const s = getComputedStyle(p); const b = p.getBoundingClientRect(); return { clipped: p.scrollWidth > p.clientWidth + 1, ws: s.whiteSpace, ov: s.textOverflow, right: b.right, vw: innerWidth, h: b.height }; });
    assert.equal(r.clipped, false, `clipped at ${w}`);
    assert.notEqual(r.ws, "nowrap");
    assert.ok(r.right <= r.vw, "runs off the screen");
    assert.ok(r.h > 18, "wrapped onto more than one line");
    await page.ctx.close();
  }
});

// ---------------------------------------------------------------- help pages
for (const name of ["howto", "faq"]) {
  test(`${name}.html loads cleanly, its images show, and it fits a phone`, async () => {
    for (const w of [1280, 390]) {
      const page = await env.browser.newPage({ viewport: { width: w, height: 900 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      await page.goto(`${env.server.url}/${name}.html`);
      await page.waitForSelector("#topnav a");
      await page.evaluate(() => document.querySelectorAll("img").forEach((i) => { i.loading = "eager"; }));
      await page.waitForFunction(() => [...document.images].every((i) => i.complete));
      const broken = await page.$$eval("img", (imgs) => imgs.filter((i) => i.naturalWidth === 0).map((i) => i.src));
      assert.deepEqual(broken, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `sideways scroll at ${w}`);
      assert.ok(await page.$("h1"));
      assert.match(await page.textContent("#sitefoot"), /independent tool, not made or endorsed by Fieldwire by Hilti/);
      assert.deepEqual(errors, []);
      await page.close();
    }
  });
}

test("every image on the how-to page has a description", async () => {
  const html = await readFile(`${root}howto.html`, "utf8");
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(imgs.length >= 5);
  for (const tag of imgs) assert.match(tag, /alt="[^"]{10,}"/);
});

test("the FAQ answers can be opened", async () => {
  const page = await env.browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${env.server.url}/faq.html`);
  const n = await page.$$eval("details", (d) => d.length);
  assert.equal(n, 9);
  await page.click("summary >> nth=0");
  assert.equal(await page.$eval("details", (d) => d.open), true);
  assert.match(await page.textContent("details[open]"), /never sent to a server|runs entirely in your browser/);
  await page.close();
});

test("the help pages show a note when the app language isn't English", async () => {
  const page = await env.browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => localStorage.setItem("plandot.lang", "de"));
  await page.goto(`${env.server.url}/howto.html`);
  await page.waitForFunction(() => !document.getElementById("lang-note").hidden);
  assert.match(await page.textContent("#lang-note"), /Englisch/);
  await page.close();
});

test("the share preview tags and image exist", async () => {
  const html = await readFile(`${root}index.html`, "utf8");
  for (const t of ["og:title", "og:description", "og:image", "twitter:card"]) assert.match(html, new RegExp(t));
  const img = html.match(/og:image" content="([^"]+)"/)[1];
  if (!/^https?:/.test(img)) await readFile(`${root}${img}`); // a local path must exist
});

test("the FAQ says what it should and leaves out what it shouldn't", async () => {
  const html = await readFile(`${root}faq.html`, "utf8");
  assert.match(html, /<summary[^>]*>What does Plandot cost\?<\/summary>\s*<p[^>]*>It.s completely free!<\/p>/);
  assert.match(html, /<summary[^>]*>Which browsers and languages does Plandot support\?<\/summary>/);
  assert.match(html, /<summary[^>]*>Something went wrong\? Let us know<\/summary>/);
  assert.match(html, /<a id="faq-feedback" href="https:\/\/forms\.gle\//);
  assert.doesNotMatch(html, /usage|statistic|analytic|visits|counts? |cookie/i);
  assert.doesNotMatch(html, /haven't been tested|hasn't been tested|not been tested|untested/i);
  assert.doesNotMatch(html, /How to use|who makes it/);
});

test("the FAQ's feedback link follows the setting in config.js", async () => {
  const page = await env.browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${env.server.url}/faq.html`);
  await page.click("summary:has-text('Something went wrong')");
  assert.equal(await page.getAttribute("#faq-feedback", "href"), feedbackHref());
  assert.equal(await page.getAttribute("#faq-feedback", "target"), "_blank");
  await page.close();
});

test("the how to guide walks through finding symbols with pictures", async () => {
  const html = await readFile(`${root}howto.html`, "utf8");
  const section = html.slice(html.indexOf('id="symbols"'), html.indexOf('id="reuse"'));
  assert.ok((section.match(/<img\b/g) || []).length >= 3);
  assert.match(section, /patio door/i);
});

// ---------------------------------------------------------------- more than 500 pins
test("1,200 pins download as one file and say to paste it in 3 batches of up to 500", async () => {
  globalThis.self ??= globalThis;
  await import("../vendor/pdf-lib.min.js");
  const { PDFDocument, StandardFonts } = globalThis.PDFLib;
  const doc = await PDFDocument.create();
  const pg = doc.addPage([2000, 1500]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 1200; i++) pg.drawText("A1", { x: 50 + (i % 40) * 48, y: 1450 - Math.floor(i / 40) * 46, size: 12, font });
  const bytes = Buffer.from(await doc.save());

  const page = await fresh({ width: 1440, height: 900 }, { acceptDownloads: true });
  await page.setInputFiles("#file-pdf", { name: "big.pdf", mimeType: "application/pdf", buffer: bytes });
  await page.setInputFiles("#file-xlsx", SAMPLE.xlsx);
  await page.fill("#plan-name", "Big plan");
  await page.fill(".rule:first-child input[id$='-tags']", "A1");
  await page.selectOption(".rule:first-child select[id$='-pin']", "text");
  await page.waitForFunction(() => window.planTasks.state.pins.length === 1200 && !window.planTasks.state.busy);
  await page.waitForFunction(() => !document.querySelector("#export-split").hidden);
  assert.equal(await page.textContent("#export-split"), "Fieldwire's task importer takes up to 500 pins at a time, so paste this file in 3 batches (pins 1–500, 501–1,000 and 1,001–1,200).");
  assert.equal(await page.textContent("#dl-import"), "Download import file");
  assert.match(await page.textContent("#export-summary"), /^1200 pins will go onto plan "Big plan"\.$/);
  const names = [];
  page.on("download", (d) => names.push(d.suggestedFilename()));
  await page.click("#dl-import");
  await page.waitForFunction(() => /Downloaded 1200 pins for plan/.test(document.querySelector("#status").textContent));
  await page.waitForTimeout(300);
  assert.deepEqual(names, ["big - pin import.xlsx"]);
  // Copy rows: one button per batch, 500 / 500 / 200 lines, tab-separated, no headings unless asked
  await page.ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  assert.equal(await page.locator("#batches .batch").count(), 3);
  assert.deepEqual(await page.locator("#batches .batch .t span").allTextContents(), ["Pins 1–500", "Pins 501–1,000", "Pins 1,001–1,200"]);
  const copy = async (n) => { await page.locator("#batches .batch").nth(n).locator("button").click(); await page.waitForFunction(() => /^Copied \d+ rows/.test(document.querySelector("#status").textContent)); return page.evaluate(() => navigator.clipboard.readText()); };
  let text = await copy(0);
  assert.equal(text.split("\n").length, 500);
  assert.ok(text.split("\n")[0].includes("\t"), "columns are tab-separated");
  assert.ok(!/^ID\t/.test(text), "no headings by default");
  assert.equal(await page.locator("#batches .batch.done").count(), 1);
  assert.match(await page.locator("#batches .batch").first().textContent(), /copied/);
  assert.equal((await copy(2)).split("\n").length, 200);
  await page.check("#batch-heads");
  assert.equal(await page.locator("#batches .batch.done").count(), 0, "changing the option starts the batches again");
  text = await copy(1);
  assert.equal(text.split("\n").length, 501, "500 rows plus the heading line");
  assert.match(text.split("\n")[0], /Title/);
  // fewer pins: the notice goes away
  await page.click("#all-off");
  await page.waitForFunction(() => document.querySelector("#export-split").hidden);
  assert.equal(await page.textContent("#dl-import"), "Download import file");
  await page.ctx.close();
});

test("counting visits switches on only for the live site, and events never throw", async () => {
  const { startAnalytics, track, pinBucket, isLiveSite } = await import("../js/analytics.js");
  assert.ok(isLiveSite("plandot.uk") && isLiveSite("www.plandot.uk"));
  assert.ok(!isLiveSite("localhost") && !isLiveSite("flinngp.github.io"));
  const made = [];
  const doc = { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { append: (e) => made.push(e) } };
  assert.equal(startAnalytics({ hostname: "localhost" }, doc), false);
  assert.equal(made.length, 0);
  assert.equal(startAnalytics({ hostname: "plandot.uk" }, doc), true);
  assert.equal(made[0].src, "https://gc.zgo.at/count.js");
  assert.equal(made[0].dataset.goatcounter, "https://plandot.goatcounter.com/count");
  track("exported"); // no counter on the page: nothing happens
  assert.deepEqual([1, 50, 51, 200, 201, 500, 501].map(pinBucket), ["1-50", "1-50", "51-200", "51-200", "201-500", "201-500", "over-500"]);
});

// ---------------------------------------------------------------- short clips in the how to guide
test("the how to guide has five short clips, each with a poster and two video formats", async () => {
  const html = await readFile(`${root}howto.html`, "utf8");
  const tags = html.match(/<video\b[^>]*>[\s\S]*?<\/video>/g) || [];
  assert.equal(tags.length, 5);
  for (const t of tags) {
    assert.match(t, /aria-label="[^"]{30,}"/);
    assert.match(t, /\bmuted\b/);
    for (const f of [t.match(/poster="([^"]+)"/)[1], ...[...t.matchAll(/src="([^"]+)"/g)].map((m) => m[1])]) await readFile(`${root}${f}`); // each file exists
    assert.equal([...t.matchAll(/<source /g)].length, 2);
  }
});

test("the clips play while they are on screen, can be paused, and stay still for reduced motion", async () => {
  const page = await env.browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${env.server.url}/howto.html`);
  await page.waitForSelector(".clip-btn");
  assert.equal(await page.$eval(".clip-video", (v) => v.hasAttribute("controls")), false, "the page's own button replaces the browser controls");
  await page.locator(".clip-video").first().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => !document.querySelector(".clip-video").paused, null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector(".clip-btn").textContent === "Pause");
  await page.click(".clip-btn");
  await page.waitForFunction(() => document.querySelector(".clip-video").paused && document.querySelector(".clip-btn").textContent === "Play"); // the label follows the pause event a moment later
  await page.close();

  const ctx = await env.browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const calm = await ctx.newPage();
  await calm.goto(`${env.server.url}/howto.html`);
  await calm.locator(".clip-video").first().scrollIntoViewIfNeeded();
  await calm.waitForTimeout(1500);
  assert.equal(await calm.$eval(".clip-video", (v) => v.paused), true);
  await calm.waitForFunction(() => document.querySelector(".clip-btn").textContent === "Play");
  await ctx.close();
});
