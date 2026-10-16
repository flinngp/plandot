// Sign-in in the real page, against a pretend Supabase (the browser's requests to it are answered by the test).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launch } from "./helpers/browser.mjs";

const root = new URL("..", import.meta.url).pathname;
const SAMPLE = { pdf: `${root}samples/sample-drawing.pdf`, xlsx: `${root}samples/sample-import-template.xlsx` };
const HOST = "https://abcd1234.supabase.co";
const KEY = "sb_publishable_abcdefghijklmnopqrstuvwxyz012345";
const UID = "11111111-1111-4111-8111-111111111111";
const SESSION_KEY = "plandot.session";
const SETUP = { app: "plandot", version: 2, settings: { planName: "Saved plan", roomPattern: "", roomDistance: 10 }, rules: [{ name: "Saved sockets", tags: "Z9", usePattern: false, title: "{tag}", pinAt: "dot", columns: {} }] };

let env;
before(async () => { env = await launch(); });
after(async () => env.close());

/** The pretend service. Records what the page asks and answers like Supabase would. */
function service(over = {}) {
  const s = { calls: [], rules: null, code: "123456", deleted: false, refreshStatus: 200, otpStatus: 200, seq: 0, ...over };
  s.handler = async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "apikey, authorization, content-type, prefer, accept", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-max-age": "600" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    const path = url.pathname + url.search;
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    const headers = req.headers();
    s.calls.push({ path, method: req.method(), body, headers });
    const send = (status, json) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: json === undefined ? "" : JSON.stringify(json) });
    const session = () => { s.seq += 1; return { access_token: `access-${s.seq}`, refresh_token: `refresh-${s.seq}`, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: UID, email: "bob@example.com" } }; };
    if (url.pathname === "/auth/v1/otp") return s.otpStatus === 200 ? send(200, {}) : send(s.otpStatus, { error_code: "over_email_send_rate_limit" });
    if (url.pathname === "/auth/v1/verify") return body.token === s.code ? send(200, session()) : send(403, { error_code: "otp_expired" });
    if (url.pathname === "/auth/v1/token") return s.refreshStatus === 200 ? send(200, session()) : send(s.refreshStatus, { error_code: "refresh_token_not_found" });
    if (url.pathname === "/auth/v1/logout") return send(204);
    if (url.pathname.startsWith("/rest/v1/")) {
      if (!/^Bearer access-\d+$/.test(headers.authorization || "")) return send(401, { message: "no" });
      if (url.pathname === "/rest/v1/rule_sets" && req.method() === "GET") return send(200, s.rules ? [s.rules] : []);
      if (url.pathname === "/rest/v1/rule_sets" && req.method() === "POST") { s.rules = { data: body.data, updated_at: "2026-10-16T10:00:00Z" }; s.savedFor = body.user_id; return send(201); }
      if (url.pathname === "/rest/v1/profiles") return send(200, [{ plan: "free", created_at: "2026-10-16T09:00:00Z" }]);
      if (url.pathname === "/rest/v1/rpc/delete_my_account") { s.deleted = true; return send(204); }
    }
    return send(404, {});
  };
  return s;
}

/** A page with sign-in switched on and a pretend service behind it. */
async function open({ svc = service(), viewport = { width: 1440, height: 900 }, stored = null, accounts = true, locale = "en-GB" } = {}) {
  const ctx = await env.browser.newContext({ viewport, locale, acceptDownloads: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) page.errors.push(m.text()); });
  if (accounts) {
    await ctx.route("**/js/config.js", async (route) => {
      const res = await route.fetch();
      const text = (await res.text()).replace('export const ACCOUNTS = { url: "", key: "" };', `export const ACCOUNTS = { url: "${HOST}", key: "${KEY}" };`);
      await route.fulfill({ response: res, body: text });
    });
    await ctx.route(`${HOST}/**`, svc.handler);
  }
  await page.goto(`${env.server.url}/index.html`);
  await page.evaluate(([k, v]) => { localStorage.clear(); if (v) localStorage.setItem(k, v); }, [SESSION_KEY, stored ? JSON.stringify(stored) : null]);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#sitefoot")?.children.length > 0);
  return { page, ctx, svc };
}
const liveSession = (extra = {}) => ({ access_token: "access-0", refresh_token: "refresh-0", expires_at: Math.floor(Date.now() / 1000) + 3000, user: { id: UID, email: "bob@example.com" }, ...extra });
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 100)); } };
const visible = (page, sel) => page.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== "none");
const status = (page) => page.$eval("#status", (e) => e.textContent);

async function signIn(page, { email = "bob@example.com", code = "123456" } = {}) {
  await page.click("#account-btn");
  await page.fill("#signin-email", email);
  await page.click("#signin-send");
  await page.waitForSelector("#signin-code-form:not([hidden])");
  await page.fill("#signin-code", code);
  await page.click("#signin-verify");
  await page.waitForSelector("#signin-modal", { state: "hidden" });
}

test("with no project set, there is no sign-in and nothing changes", async () => {
  const { page, ctx } = await open({ accounts: false });
  assert.equal(await visible(page, "#account-btn"), false);
  assert.equal(await visible(page, "#gate"), false);
  await page.setInputFiles("#file-pdf", SAMPLE.pdf);
  await page.waitForFunction(() => window.planTasks.state.pdf);
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

test("signed out: a notice, a Sign in button, the sample works, own files ask you to sign in", async () => {
  const { page, ctx, svc } = await open();
  assert.equal(await page.$eval("#account-btn", (e) => e.textContent), "Sign in");
  assert.equal(await visible(page, "#gate"), true);
  // choosing a file opens the sign-in box, not the file picker
  let chooser = false;
  page.on("filechooser", () => { chooser = true; });
  await page.click("#file-pdf");
  await page.waitForSelector("#signin-modal:not([hidden])");
  await page.waitForTimeout(300);
  assert.equal(chooser, false);
  await page.keyboard.press("Escape");
  await page.waitForSelector("#signin-modal", { state: "hidden" });
  // a file that arrives some other way is refused too
  await page.setInputFiles("#file-pdf", SAMPLE.pdf);
  await page.waitForSelector("#signin-modal:not([hidden])");
  assert.equal(await page.evaluate(() => window.planTasks.state.pdf), null);
  await page.keyboard.press("Escape");
  // a dropped file as well
  await page.evaluate(async () => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], "x.xlsx"));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector("#signin-modal:not([hidden])");
  assert.equal(await page.evaluate(() => window.planTasks.state.tpl), null);
  await page.keyboard.press("Escape");
  // the sample needs no account
  await page.click("#try-sample");
  await page.waitForFunction(() => window.planTasks.state.pins.length === 13 && !window.planTasks.state.busy);
  assert.equal(svc.calls.filter((c) => c.path.startsWith("/rest/")).length, 0, "nothing is asked of the service while signed out");
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

test("signing in with an emailed code: wrong code, right code, then own files work and the choice sticks", async () => {
  const { page, ctx, svc } = await open();
  await page.click("#account-btn");
  // a mistyped email is caught before anything is sent
  await page.fill("#signin-email", "bob@");
  await page.click("#signin-send");
  assert.match(await page.textContent("#signin-error"), /email address/);
  assert.equal(svc.calls.length, 0);
  await page.fill("#signin-email", "  Bob@Example.com ");
  await page.click("#signin-send");
  await page.waitForSelector("#signin-code-form:not([hidden])");
  assert.deepEqual(svc.calls.at(-1).body, { email: "bob@example.com", create_user: true });
  assert.equal(svc.calls.at(-1).headers.authorization, undefined);
  assert.match(await page.textContent("#signin-sent"), /bob@example\.com/);
  assert.equal(await page.$eval("#signin-resend", (e) => e.disabled), true, "a new code can't be asked for straight away");
  assert.match(await page.textContent("#signin-resend"), /Send a new code in \d+s/);
  await page.fill("#signin-code", "000000");
  await page.click("#signin-verify");
  await page.waitForFunction(() => !document.querySelector("#signin-error").hidden);
  assert.match(await page.textContent("#signin-error"), /didn't work/);
  await page.fill("#signin-code", "123 456"); // pasted with a space
  await page.click("#signin-verify");
  await page.waitForSelector("#signin-modal", { state: "hidden" });
  assert.match(await status(page), /signed in/);
  assert.equal(await page.$eval("#account-btn", (e) => e.textContent), "Account");
  assert.equal(await visible(page, "#gate"), false);
  // own files now open the picker
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#file-pdf")]);
  await chooser.setFiles(SAMPLE.pdf);
  await page.waitForFunction(() => window.planTasks.state.pdf);
  // still signed in after a reload, without asking for a code again
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#account-btn").textContent === "Account");
  assert.equal(await visible(page, "#gate"), false);
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

test("a rate-limited or unreachable service gives a plain message", async () => {
  const svc = service({ otpStatus: 429 });
  const { page, ctx } = await open({ svc });
  await page.click("#account-btn");
  await page.fill("#signin-email", "bob@example.com");
  await page.click("#signin-send");
  await page.waitForFunction(() => !document.querySelector("#signin-error").hidden);
  assert.match(await page.textContent("#signin-error"), /Too many attempts/);
  assert.equal(await visible(page, "#signin-code-form"), false);
  await ctx.route(`${HOST}/**`, (r) => r.abort());
  svc.otpStatus = 200;
  await page.click("#signin-send");
  await page.waitForFunction(() => /Can't reach/.test(document.querySelector("#signin-error").textContent));
  await ctx.close();
});

test("saved rules: they are saved to the account after a change, and come back on another device", async () => {
  const { page, ctx, svc } = await open();
  await signIn(page);
  await page.fill(".rule input[id$='-tags']", "A1");
  await until(() => svc.rules);
  assert.equal(svc.savedFor, UID);
  assert.equal(svc.rules.data.rules[0].tags, "A1");
  assert.equal(svc.calls.filter((c) => c.method === "POST" && c.path.startsWith("/rest/v1/rule_sets")).at(-1).headers.prefer, "resolution=merge-duplicates,return=minimal");
  // a different computer: nothing on the screen, same account
  await page.evaluate(() => localStorage.removeItem("plantasks.v1"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".rule input[id$='-tags']")?.value === "A1");
  assert.match(await status(page), /Loaded your saved rules/);
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

test("an untouched screen never overwrites saved rules, and neither does the sample", async () => {
  const svc = service({ rules: { data: SETUP, updated_at: "2026-10-15T10:00:00Z" } });
  const { page, ctx } = await open({ svc, stored: liveSession() });
  await page.waitForFunction(() => document.querySelector(".rule input[id$='-tags']")?.value === "Z9");
  await page.waitForTimeout(2200);
  assert.equal(svc.calls.filter((c) => c.method === "POST" && c.path.startsWith("/rest/")).length, 0, "loading saved rules writes nothing back");
  // the sample replaces the rules on screen but is never saved
  page.once("dialog", (d) => d.accept());
  await page.click("#try-sample");
  await page.waitForFunction(() => window.planTasks.state.pins.length === 13 && !window.planTasks.state.busy);
  await page.fill(".rule input[id$='-tags']", "EDITED");
  await page.waitForTimeout(2500);
  assert.equal(svc.calls.filter((c) => c.method === "POST" && c.path.startsWith("/rest/")).length, 0, "the sample is not saved");
  assert.equal(svc.rules.data.rules[0].tags, "Z9");
  // "Load my saved rules" brings them back and saving resumes
  await page.click("#account-btn");
  await page.click("#account-load");
  await page.waitForFunction(() => document.querySelector(".rule input[id$='-tags']")?.value === "Z9");
  await page.fill(".rule input[id$='-tags']", "Z9 Y8");
  await until(() => svc.rules.data.rules[0].tags === "Z9 Y8");
  await ctx.close();
});

test("different rules on screen and in the account: you are asked, and keeping yours replaces the saved ones on the next change", async () => {
  const svc = service({ rules: { data: SETUP, updated_at: "2026-10-15T10:00:00Z" } });
  const { page, ctx } = await open({ svc });
  await page.fill(".rule input[id$='-tags']", "LOCAL1");
  await page.waitForTimeout(500);
  const asked = [];
  page.on("dialog", (d) => { asked.push(d.message()); d.dismiss(); });
  await signIn(page);
  await until(() => asked.length);
  assert.match(asked[0], /Replace the rules on this screen/);
  assert.equal(await page.inputValue(".rule input[id$='-tags']"), "LOCAL1");
  assert.equal(svc.rules.data.rules[0].tags, "Z9", "not overwritten until something changes");
  await page.fill(".rule input[id$='-tags']", "LOCAL2");
  await until(() => svc.rules.data.rules[0].tags === "LOCAL2");
  await ctx.close();
});

test("the account box: who you are, download my data, sign out", async () => {
  const svc = service({ rules: { data: SETUP, updated_at: "2026-10-15T10:00:00Z" } });
  const { page, ctx } = await open({ svc, stored: liveSession() });
  await page.waitForFunction(() => document.querySelector("#account-btn").textContent === "Account");
  await page.click("#account-btn");
  assert.match(await page.textContent("#account-email"), /Signed in as bob@example\.com/);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#account-export")]);
  assert.equal(dl.suggestedFilename(), "plandot account data.json");
  const data = JSON.parse(await readFile(await dl.path(), "utf8"));
  assert.equal(data.email, "bob@example.com");
  assert.equal(data.plan, "free");
  assert.equal(data.savedRules.rules[0].tags, "Z9");
  await page.click("#account-signout");
  await page.waitForFunction(() => document.querySelector("#account-btn").textContent === "Sign in");
  await page.waitForFunction(() => /signed out/.test(document.querySelector("#status").textContent));
  assert.equal(await visible(page, "#gate"), true);
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY), null);
  assert.ok(svc.calls.some((c) => c.path.startsWith("/auth/v1/logout")));
  assert.equal(await visible(page, "#signin-modal"), false, "signing out yourself does not pop up 'session ended'");
  await ctx.close();
});

test("deleting the account asks first, then deletes and signs out", async () => {
  const svc = service();
  const { page, ctx } = await open({ svc, stored: liveSession() });
  await page.waitForFunction(() => document.querySelector("#account-btn").textContent === "Account");
  await page.click("#account-btn");
  page.once("dialog", (d) => d.dismiss());
  await page.click("#account-delete");
  await page.waitForTimeout(300);
  assert.equal(svc.deleted, false);
  page.once("dialog", (d) => { assert.match(d.message(), /permanently removes your email/); d.accept(); });
  await page.click("#account-delete");
  await until(() => svc.deleted);
  await page.waitForFunction(() => document.querySelector("#account-btn").textContent === "Sign in");
  await page.waitForFunction(() => /deleted/.test(document.querySelector("#status").textContent));
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), SESSION_KEY), null);
  await ctx.close();
});

test("a session the service no longer accepts sends you back to sign in, with a reason", async () => {
  const svc = service({ refreshStatus: 400 });
  const { page, ctx } = await open({ svc, stored: liveSession({ expires_at: Math.floor(Date.now() / 1000) - 10 }) });
  await page.waitForSelector("#signin-modal:not([hidden])");
  assert.match(await page.textContent("#signin-error"), /session ended/);
  assert.equal(await page.$eval("#account-btn", (e) => e.textContent), "Sign in");
  await ctx.close();
});

test("the boxes behave: Escape closes, Tab stays inside, focus goes back, the backdrop closes", async () => {
  const { page, ctx } = await open();
  await page.focus("#account-btn");
  await page.keyboard.press("Enter");
  await page.waitForSelector("#signin-modal:not([hidden])");
  assert.equal(await page.evaluate(() => document.activeElement.id), "signin-email");
  const seen = new Set();
  for (let i = 0; i < 8; i++) { await page.keyboard.press("Tab"); seen.add(await page.evaluate(() => document.activeElement.closest("#signin-modal") ? "in" : "out")); }
  assert.deepEqual([...seen], ["in"]);
  await page.keyboard.press("Escape");
  await page.waitForSelector("#signin-modal", { state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement.id), "account-btn");
  await page.click("#account-btn");
  await page.mouse.click(5, 5);
  await page.waitForSelector("#signin-modal", { state: "hidden" });
  await page.click("#gate-signin");
  await page.click("#signin-x");
  await page.waitForSelector("#signin-modal", { state: "hidden" });
  await ctx.close();
});

test("in French the button, the boxes and the messages are in French", async () => {
  const { page, ctx } = await open();
  await page.click("#lang-btn");
  await page.click('#lang-list [data-lang="fr"]');
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  assert.equal(await page.$eval("#account-btn", (e) => e.textContent), "Se connecter");
  await page.click("#account-btn");
  assert.equal(await page.textContent("#signin-title"), "Se connecter à Plandot");
  await page.fill("#signin-email", "bob@");
  await page.click("#signin-send");
  assert.match(await page.textContent("#signin-error"), /adresse e-mail/);
  assert.equal(await page.getAttribute("#signin-x", "aria-label"), "Fermer");
  await ctx.close();
});

test("on a phone the boxes fit the screen and the page does not scroll sideways", async () => {
  const { page, ctx } = await open({ viewport: { width: 375, height: 667 } });
  await page.click("#account-btn");
  const r = await page.$eval("#signin-modal .modal-card", (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, w: innerWidth }; });
  assert.ok(r.l >= 0 && r.r <= r.w, JSON.stringify(r));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const fs = await page.$eval("#signin-email", (e) => parseFloat(getComputedStyle(e).fontSize));
  assert.ok(fs >= 16, "16px or more so phones do not zoom in");
  await ctx.close();
});

test("the privacy and terms pages open, link back, and are linked from the footer and the boxes", async () => {
  const { page, ctx } = await open();
  const links = await page.$$eval("#sitefoot a", (a) => a.map((x) => [x.textContent, x.getAttribute("href")]));
  assert.deepEqual(links, [["Terms", "terms.html"], ["Privacy", "privacy.html"]]);
  for (const [file, heading] of [["privacy.html", "Privacy notice"], ["terms.html", "Terms of use"]]) {
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text()); });
    await p.goto(`${env.server.url}/${file}`);
    await p.waitForFunction(() => document.querySelector("#sitefoot")?.children.length > 0);
    assert.equal(await p.textContent("main h1"), heading);
    assert.ok((await p.$$eval("main .card", (c) => c.length)) >= 5);
    assert.equal(await p.$eval('a[id$="-feedback"]', (a) => a.getAttribute("href")), "https://forms.gle/HQUfuJ3h1k2ztf1z9");
    assert.deepEqual(errors, [], file);
    await p.close();
  }
  await ctx.close();
});

test("with sign-in on, the page hides itself when shown inside another site's page", async () => {
  const { ctx } = await open();
  const outer = await ctx.newPage();
  await outer.setContent(`<iframe id="f" src="${env.server.url}/index.html" width="900" height="600"></iframe>`);
  const frame = await (await outer.waitForSelector("#f")).contentFrame();
  await frame.waitForFunction(() => document.documentElement.hidden === true);
  const shown = await frame.evaluate(() => getComputedStyle(document.body).display !== "none" && document.documentElement.getBoundingClientRect().height > 0);
  assert.equal(shown, false);
  await ctx.close();
});
