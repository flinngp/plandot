// The FAQ in every language: same number of entries, same markup, the app's own button names, and the page switches.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launch } from "./helpers/browser.mjs";

const root = new URL("..", import.meta.url).pathname;
const CODES = ["fr", "es", "de", "it", "nl", "pt", "da", "sv", "no", "fi", "pl", "cs"];
const html = await readFile(`${root}faq.html`, "utf8");
const english = [];
for (const m of html.matchAll(/<(\w+)\b[^>]*\bdata-h="(\d+)"[^>]*>([\s\S]*?)<\/\1>/g)) english[Number(m[2])] = m[3];
const tagsOf = (s) => (s.match(/<\/?(strong|em|code|kbd|a)\b[^>]*>/g) || []).map((t) => t.replace(/\s+(href|id|target|rel)="[^"]*"/g, "")).join("");

test("the English FAQ has 36 numbered pieces", () => {
  assert.equal(english.length, 36);
  for (let i = 0; i < 36; i++) assert.ok(english[i], `piece ${i} missing`);
});

for (const code of CODES) {
  test(`FAQ, ${code}: every piece is there with the same markup`, async () => {
    const pack = (await import(`../js/lang/faq/${code}.js`)).default;
    assert.equal(pack.length, english.length + 1);
    assert.equal(pack[pack.length - 1], "", "no language note");
    for (let i = 0; i < english.length; i++) {
      assert.ok(pack[i].trim().length > 0, `entry ${i} is empty`);
      assert.equal(tagsOf(pack[i]), tagsOf(english[i]), `entry ${i}: different markup`);
    }
    assert.match(pack[2], /href="howto\.html"/);
    assert.match(pack[29], /id="faq-feedback" href="https:\/\/forms\.gle\/HQUfuJ3h1k2ztf1z9" target="_blank" rel="noopener"/);
  });

  test(`FAQ, ${code}: button names match the app's own wording`, async () => {
    const pack = (await import(`../js/lang/faq/${code}.js`)).default;
    const app = (await import(`../js/lang/${code}.js`)).default;
    let checked = 0;
    for (let i = 0; i < english.length; i++) {
      for (const m of english[i].matchAll(/<(strong|em)>(.*?)<\/\1>/g)) {
        const label = m[2].replace(/[.:]$/, "");
        if (!(label in app)) continue;
        checked++;
        assert.ok(pack[i].includes(app[label]), `entry ${i}: "${label}" should read "${app[label]}"`);
      }
    }
    assert.ok(checked >= 5, `only ${checked} checked`);
  });
}

let env;
before(async () => { env = await launch(); });
after(async () => env.close());

test("the FAQ switches language, keeps its feedback link, and English is unchanged", async () => {
  const page = await env.browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${env.server.url}/faq.html`);
  await page.evaluate(() => localStorage.setItem("plandot.lang", "fr"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("h1:not(.brand h1)").textContent === "Questions fréquentes");
  assert.equal(await page.isHidden("#lang-note"), true);
  assert.equal(await page.getAttribute("#faq-feedback", "href"), "https://forms.gle/HQUfuJ3h1k2ztf1z9");
  assert.equal(await page.getAttribute("#faq-feedback", "target"), "_blank");
  assert.match(await page.title(), /Questions fréquentes/);
  await page.evaluate(() => localStorage.setItem("plandot.lang", "en"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("h1:not(.brand h1)").textContent === "Frequently asked questions");
  assert.deepEqual(errors, []);
  await page.close();
});

test("the FAQ fits a small phone screen in every language", async () => {
  for (const code of ["en", ...CODES]) {
    const ctx = await env.browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(`${env.server.url}/faq.html`);
    await page.evaluate((c) => localStorage.setItem("plandot.lang", c), code);
    await page.reload();
    await page.waitForTimeout(200);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${code}: scrolls sideways`);
    await ctx.close();
  }
});
