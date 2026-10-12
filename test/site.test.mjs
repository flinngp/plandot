// Pin wording, (i) pop-ups, the flag language menu, footer, feedback link, copy-details, help pages and the phone tagline.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launch } from "./helpers/browser.mjs";
import { feedbackHref, VERSION, WHATS_NEW } from "../js/config.js";

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
test("the footer carries the disclaimer, privacy line, as-is note and links", async () => {
  const page = await fresh();
  const text = await page.textContent("#sitefoot");
  assert.match(text, /not made, endorsed or supported by Fieldwire or Hilti/);
  assert.match(text, /never uploaded/);
  assert.match(text, /Check the pins before you import them/);
  assert.match(text, /All rights reserved/);
  assert.equal(await page.getAttribute("#sitefoot a[href='howto.html']", "href"), "howto.html");
  assert.equal(await page.getAttribute("#sitefoot a[href='faq.html']", "href"), "faq.html");
  await page.evaluate(() => { document.documentElement.lang = "en"; });
  await page.ctx.close();
});

test("What's new opens a dialog with the version and closes again", async () => {
  const page = await fresh();
  const pkg = JSON.parse(await readFile(`${root}package.json`, "utf8"));
  assert.equal(pkg.version, VERSION, "package.json and js/config.js disagree");
  assert.match(await page.textContent(".whatsnew-btn"), new RegExp(`v${VERSION.replaceAll(".", "\\.")}`));
  await page.click(".whatsnew-btn");
  assert.equal(await page.$eval("#whatsnew", (d) => d.open), true);
  assert.equal(await page.$$eval("#whatsnew li", (l) => l.length), WHATS_NEW.reduce((n, r) => n + r.items.length, 0));
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval("#whatsnew", (d) => d.open), false);
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
      await page.waitForSelector("#sitefoot a");
      await page.evaluate(() => document.querySelectorAll("img").forEach((i) => { i.loading = "eager"; }));
      await page.waitForFunction(() => [...document.images].every((i) => i.complete));
      const broken = await page.$$eval("img", (imgs) => imgs.filter((i) => i.naturalWidth === 0).map((i) => i.src));
      assert.deepEqual(broken, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `sideways scroll at ${w}`);
      assert.ok(await page.$("h1"));
      assert.match(await page.textContent("#sitefoot"), /not made, endorsed or supported by Fieldwire or Hilti/);
      assert.deepEqual(errors, []);
      await page.close();
    }
  });
}

test("every image on the how-to page has a description", async () => {
  const html = await readFile(`${root}howto.html`, "utf8");
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(imgs.length >= 5);
  for (const tag of imgs) assert.match(tag, /alt="[^"]{15,}"/);
});

test("the FAQ answers can be opened", async () => {
  const page = await env.browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${env.server.url}/faq.html`);
  const n = await page.$$eval("details", (d) => d.length);
  assert.ok(n >= 12);
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
