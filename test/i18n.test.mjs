// Languages: every pack is complete, and the page really switches, remembers and recovers.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { launch } from "./helpers/browser.mjs";
import { makeTemplate, DEFAULT_HEADERS } from "./helpers/make-template.mjs";

const root = new URL("..", import.meta.url).pathname;
const CODES = ["fr", "es", "de", "it", "nl", "pt", "da", "sv", "no", "fi", "pl", "cs"];
const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();

// every English text the page can show: tr("...") in the code and data-i18n text in the HTML
async function englishTexts() {
  const out = new Set();
  const app = await readFile(`${root}js/app.js`, "utf8");
  for (const m of app.matchAll(/\btr\(("(?:[^"\\]|\\.)*")/g)) out.add(JSON.parse(m[1]));
  const html = await readFile(`${root}index.html`, "utf8");
  for (const m of html.matchAll(/<([a-z0-9]+)[^>]*data-i18n(?!-)[^>]*>([\s\S]*?)<\/\1>/g)) { const t = m[2].replace(/<[^>]+>/g, "").trim(); if (t) out.add(t.replaceAll("&amp;", "&")); }
  // labels set through data-i18n-aria and placeholders through data-i18n-ph
  for (const m of html.matchAll(/<[^>]*data-i18n-aria[^>]*>/g)) { const a = m[0].match(/aria-label="([^"]*)"/); if (a) out.add(a[1]); }
  for (const m of html.matchAll(/<[^>]*data-i18n-ph[^>]*>/g)) { const a = m[0].match(/placeholder="([^"]*)"/); if (a) out.add(a[1]); }
  // the hints shown before anything is loaded come from the HTML but are set from code
  const first = (id) => html.match(new RegExp(`id="${id}">([^<]*)<`))[1].trim();
  out.add(first("pdf-info")); out.add(first("tpl-info").replace("&#39;", "'"));
  return out;
}

test("there is a pack for each of the twelve languages and no stray ones", async () => {
  const files = (await readdir(`${root}js/lang`)).map((f) => f.replace(".js", "")).sort();
  assert.deepEqual(files, [...CODES].sort());
});

for (const code of CODES) {
  test(`${code}: every text on the page is translated, with its placeholders and nothing empty`, async () => {
    const pack = (await import(`../js/lang/${code}.js`)).default;
    const need = await englishTexts();
    const missing = [...need].filter((k) => !(k in pack));
    assert.deepEqual(missing, [], `untranslated: ${missing.join(" | ")}`);
    for (const [k, v] of Object.entries(pack)) {
      assert.ok(typeof v === "string" && v.trim() !== "", `empty: ${k}`);
      assert.equal(ph(v), ph(k), `placeholders differ in: ${k}`);
      assert.equal((v.match(/\n/g) || []).length, (k.match(/\n/g) || []).length, `line breaks differ in: ${k}`);
    }
  });
}

let env;
before(async () => { env = await launch(); });
after(async () => env.close());

async function open(locale = "en-US") {
  const ctx = await env.browser.newContext({ locale, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${env.server.url}/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  return { page, ctx, errors };
}

test("English by default, and the picker lists English plus the twelve", async () => {
  const { page, ctx } = await open("en-GB");
  assert.equal(await page.$eval("html", (e) => e.lang), "en");
  assert.equal(await page.$eval("#start-over", (e) => e.textContent), "Start over");
  assert.equal(await page.$$eval("#lang option", (o) => o.length), 13);
  await ctx.close();
});

test("the browser's language is used when we have it, with Norwegian variants folded in", async () => {
  for (const [locale, code, word] of [["sv-SE", "sv", "Börja om"], ["nb-NO", "no", "Start på nytt"], ["de-AT", "de", "Neu beginnen"], ["ja-JP", "en", "Start over"]]) {
    const { page, ctx } = await open(locale);
    assert.equal(await page.$eval("html", (e) => e.lang), code, locale);
    assert.equal(await page.$eval("#start-over", (e) => e.textContent), word, locale);
    await ctx.close();
  }
});

test("choosing a language changes headings, hints, placeholders and the rule card, and is remembered", async () => {
  const { page, ctx, errors } = await open();
  for (const code of CODES) {
    await page.selectOption("#lang", code);
    await page.waitForFunction((c) => document.documentElement.lang === c, code);
    const pack = (await import(`../js/lang/${code}.js`)).default;
    assert.equal(await page.$eval("#start-over", (e) => e.textContent), pack["Start over"], code);
    assert.equal(await page.$eval("#plan-name", (e) => e.placeholder), pack["Exactly as it appears in the project"], code);
    assert.equal(await page.$eval("#step-rules h2 span:last-child", (e) => e.textContent), pack["Rules"], code);
    assert.equal(await page.$eval("#add-rule", (e) => e.textContent), pack["Add rule"], code);
    assert.equal(await page.$eval(".rule label[for$='-kind']", (e) => e.textContent), pack["Look for"], code);
  }
  await page.selectOption("#lang", "fi");
  await page.reload();
  assert.equal(await page.$eval("#lang", (e) => e.value), "fi");
  assert.equal(await page.$eval("#start-over", (e) => e.textContent), "Aloita alusta");
  await page.selectOption("#lang", "en");
  assert.equal(await page.$eval("#start-over", (e) => e.textContent), "Start over");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("a drawing, messages and the pin table follow the language, and Start over keeps it", async () => {
  const { page, ctx } = await open();
  await page.selectOption("#lang", "de");
  await page.setInputFiles("#file-pdf", `${root}samples/sample-drawing.pdf`);
  await page.setInputFiles("#load-rules", `${root}samples/sample-rules.json`);
  await page.waitForFunction(() => window.planTasks.state.pins.length === 13 && !window.planTasks.state.busy);
  assert.match(await page.textContent("#pdf-info"), /Wörter Text auf dieser Seite gefunden/);
  assert.match(await page.textContent("#pinlist-title"), /Markierungen · 13 von 13 enthalten/);
  assert.match(await page.textContent(".rule-status"), /gefunden/);
  assert.equal(await page.$eval("#pin-rows tr:first-child td:nth-child(6)", (e) => e.textContent), "Punkt");
  assert.match(await page.textContent("#import-why"), /Noch nötig/);
  // switching back re-renders what is already on screen
  await page.selectOption("#lang", "en");
  assert.match(await page.textContent("#pdf-info"), /words of text found on this page/);
  assert.match(await page.textContent("#pinlist-title"), /Pins · 13 of 13 included/);
  await page.selectOption("#lang", "fr");
  let msg = "";
  page.once("dialog", async (d) => { msg = d.message(); await d.accept(); });
  await page.click("#start-over");
  await page.waitForFunction(() => window.planTasks.state.pdf === null);
  assert.match(msg, /^Recommencer \?/);
  assert.equal(await page.$eval("#lang", (e) => e.value), "fr");
  assert.equal(await page.$eval("#tb-name", (e) => e.textContent), "Aucun chargé");
  assert.match(await page.textContent("#pdf-info"), /Les repères doivent être|Callouts must/); // default hint is English only until translated
  await ctx.close();
});

test("a template with headings in another language is read, and one that isn't can be matched by hand", async () => {
  const { page, ctx } = await open();
  const rename = (map) => DEFAULT_HEADERS.map((h) => map[h] ?? h);
  const file = async (name, headers) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(await makeTemplate({ headers })) });
  // German headings are recognised outright
  await page.setInputFiles("#file-xlsx", await file("de.xlsx", rename({ Title: "Titel", "X Pos (%)": "X-Pos. (%)", "Y Pos (%)": "Y-Pos. (%)", Category: "Kategorie", Assignee: "Zugewiesen" })));
  await page.waitForFunction(() => window.planTasks.state.tpl);
  assert.deepEqual(await page.evaluate(() => window.planTasks.state.tpl.parsed.missing), []);
  assert.equal(await page.$(".mapping") !== null, false);

  // Finnish-style headings nobody taught it: the widest row is used and the columns are matched by hand
  await page.setInputFiles("#file-xlsx", await file("fi.xlsx", rename({ Title: "Nimike", Plan: "Kuva", "X Pos (%)": "Vaaka", "Y Pos (%)": "Pysty", Category: "Luokka", Assignee: "Tekijä", Priority: "Tärkeys", "Start date": "Alku", "End date": "Loppu", "Description / Hashtags": "Kuvaus", Checklist: "Lista" })));
  await page.waitForFunction(() => window.planTasks.state.tpl?.name === "fi.xlsx");
  assert.ok(await page.$(".mapping"), "the matching form is shown");
  await page.fill("#plan-name", "Ground floor plan");
  assert.equal(await page.$eval("#dl-import", (b) => b.disabled), true);
  const pick = async (role, header) => page.selectOption(`#map-${role}`, { label: header });
  await pick("title", "Nimike"); await pick("plan", "Kuva"); await pick("x", "Vaaka"); await pick("y", "Pysty");
  await page.click(".mapping button");
  assert.deepEqual(await page.evaluate(() => window.planTasks.state.tpl.parsed.missing), []);
  assert.equal(await page.$(".mapping") !== null, false, "the form goes away once everything is matched");
  await ctx.close();
});
