// The how to guide in every language: the right number of entries, the same markup and the same
// example text as English, the app's own button names, and the page really switches language.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launch } from "./helpers/browser.mjs";

const root = new URL("..", import.meta.url).pathname;
const CODES = ["fr", "es", "de", "it", "nl", "pt", "da", "sv", "no", "fi", "pl", "cs"];
const html = await readFile(`${root}howto.html`, "utf8");

// The English text of each numbered piece, straight from the page.
const english = [];
for (const m of html.matchAll(/<(\w+)\b[^>]*\bdata-h="(\d+)"[^>]*>([\s\S]*?)<\/\1>/g)) english[Number(m[2])] = m[3];
for (const m of html.matchAll(/data-ha="(\d+)"/g)) english[Number(m[1])] ??= "(alt)";
for (const m of html.matchAll(/data-hl="(\d+)"/g)) english[Number(m[1])] ??= "(label)";
const tagsOf = (s) => (s.match(/<\/?(strong|em|code|kbd|a)\b[^>]*>/g) || []).map((t) => t.replace(/\s+href="[^"]*"/, "")).join("");
const codeOf = (s) => (s.match(/<code>[\s\S]*?<\/code>/g) || []).join("|");

for (const code of CODES) {
  test(`how to guide, ${code}: every piece is there, with the same markup and examples`, async () => {
    const pack = (await import(`../js/lang/howto/${code}.js`)).default;
    assert.equal(pack.length, english.length + 1, "one entry for every numbered piece, plus the screenshot note");
    for (let i = 0; i < english.length; i++) {
      assert.equal(typeof pack[i], "string");
      assert.ok(pack[i].trim().length > 0, `entry ${i} is empty`);
      if (english[i].startsWith("(")) continue;
      assert.equal(tagsOf(pack[i]), tagsOf(english[i]), `entry ${i}: different bold, code or link markup`);
      if (i !== 24) assert.equal(codeOf(pack[i]), codeOf(english[i]), `entry ${i}: the example text changed`);
    }
    assert.ok(pack[24].includes("{tag}") && pack[24].includes("{room_label}"), "the title example keeps the real placeholders");
    assert.match(pack[84], /faq\.html/, "the FAQ link is kept");
  });

  test(`how to guide, ${code}: button names match the app's own wording`, async () => {
    const pack = (await import(`../js/lang/howto/${code}.js`)).default;
    const app = (await import(`../js/lang/${code}.js`)).default;
    let checked = 0;
    for (let i = 0; i < english.length; i++) {
      if (english[i].startsWith("(")) continue;
      for (const m of english[i].matchAll(/<(strong|em)>(.*?)<\/\1>/g)) {
        const label = m[2].replace(/\.$/, "");
        if (!(label in app)) continue;
        checked++;
        assert.ok(pack[i].includes(app[label]), `entry ${i}: "${label}" should read "${app[label]}"`);
      }
    }
    assert.ok(checked >= 12, `only ${checked} button names were checked`);
  });
}

let env;
before(async () => { env = await launch(); });
after(async () => env.close());

test("the how to guide switches language with the app, and English stays as it was", async () => {
  const page = await env.browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text()); });
  await page.goto(`${env.server.url}/howto.html`);
  await page.evaluate(() => localStorage.setItem("plandot.lang", "fr"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("h1:not(.brand h1)").textContent === "Guide pratique");
  assert.equal(await page.textContent("#s2 h2 [data-h]"), "Créer une règle");
  assert.equal(await page.locator("#s2 h2 .num").textContent(), "2", "the step number stays");
  assert.match(await page.textContent("#lang-note"), /anglais/);
  assert.equal(await page.isHidden("#lang-note"), false);
  assert.match(await page.getAttribute("#s1 img", "alt"), /Plan/);
  assert.match(await page.getAttribute("#s1 video", "aria-label"), /vidéo/);
  assert.match(await page.title(), /Guide pratique/);
  // links inside translated text still work
  assert.equal(await page.getAttribute("#keys a", "href"), "faq.html");
  // back to English
  await page.evaluate(() => localStorage.setItem("plandot.lang", "en"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("h1:not(.brand h1)").textContent === "How to guide");
  assert.equal(await page.isHidden("#lang-note"), true);
  assert.equal(await page.textContent("#s2 h2 [data-h]"), "Make a rule");
  assert.deepEqual(errors, []);
  await page.close();
});

test("a language without a guide falls back to English with the usual note", async () => {
  const page = await env.browser.newPage();
  await page.goto(`${env.server.url}/howto.html`);
  await page.evaluate(() => localStorage.setItem("plandot.lang", "ja"));
  await page.reload();
  assert.equal(await page.textContent("h1:not(.brand h1)"), "How to guide");
  await page.close();
});

test("the translated guide fits a small phone screen in every language", async () => {
  for (const code of ["en", ...CODES]) {
    const ctx = await env.browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(`${env.server.url}/howto.html`);
    await page.evaluate((c) => localStorage.setItem("plandot.lang", c), code);
    await page.reload();
    await page.waitForTimeout(250);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${code}: the page scrolls sideways`);
    await ctx.close();
  }
});
