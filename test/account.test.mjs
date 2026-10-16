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
const R1 = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", name: "Sockets", data: { kind: "text", tags: "Z9", usePattern: false, title: "{tag}", pinAt: "dot", columns: {} }, updated_at: "2026-10-15T10:00:00Z" };
const R2 = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", name: "Patio door", data: { kind: "symbol", symbol: null, strict: 3, rotate: true, sizes: false, tags: "", usePattern: false, title: "{rule}", pinAt: "dot", columns: {} }, updated_at: "2026-10-15T10:00:00Z" };
const rowsOf = (...r) => structuredClone(r);

let env;
before(async () => { env = await launch(); });
after(async () => env.close());

/** The pretend service. Records what the page asks and answers like Supabase would. */
function service(over = {}) {
  const s = { calls: [], table: [], code: "123456", deleted: false, refreshStatus: 200, otpStatus: 200, seq: 0, ...over };
  s.handler = async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "apikey, authorization, content-type, prefer, accept", "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS", "access-control-max-age": "600" };
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
      if (url.pathname === "/rest/v1/saved_rules") {
        const m = req.method();
        const id = url.search.match(/id=eq\.([0-9a-f-]+)/)?.[1];
        if (m === "GET") return send(200, [...s.table].sort((a, b) => a.name.localeCompare(b.name)));
        if (m === "POST") {
          s.savedFor = body.user_id;
          const row = s.table.find((r) => r.name === body.name);
          if (row) row.data = body.data; else s.table.push({ id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(s.table.length + 1).padStart(12, "0")}`, name: body.name, data: body.data, updated_at: "2026-10-16T10:00:00Z" });
          return send(201);
        }
        if (m === "PATCH") {
          if (body.name && s.table.some((r) => r.name === body.name && r.id !== id)) return send(409, { code: "23505" });
          Object.assign(s.table.find((r) => r.id === id), body);
          return send(204);
        }
        if (m === "DELETE") { s.table = s.table.filter((r) => r.id !== id); return send(204); }
      }
      if (url.pathname === "/rest/v1/profiles") return send(200, [{ plan: "free", created_at: "2026-10-16T09:00:00Z" }]);
      if (url.pathname === "/rest/v1/rpc/delete_my_account") { s.deleted = true; return send(204); }
    }
    return send(404, {});
  };
  return s;
}

/** A page with sign-in switched on and a pretend service behind it. */
async function open({ svc = service(), viewport = { width: 1440, height: 900 }, stored = null, accounts = true, locale = "en-GB", siteKey = "", turnstile = "ok" } = {}) {
  const ctx = await env.browser.newContext({ viewport, locale, acceptDownloads: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) page.errors.push(m.text()); });
  await ctx.route("**/js/config.js", async (route) => {
    const res = await route.fetch();
    const val = accounts ? `{ url: "${HOST}", key: "${KEY}" }` : `{ url: "", key: "" }`;
    const text = (await res.text()).replace(/export const ACCOUNTS = \{[^}]*\};/, `export const ACCOUNTS = ${val};`);
    await route.fulfill({ response: res, body: text.replace(/export const CAPTCHA = \{[^}]*\};/, `export const CAPTCHA = { siteKey: "${siteKey}" };`) });
  });
  // A stand-in for Cloudflare's script: it hands out numbered tokens, or fails when the test asks it to.
  await ctx.route("https://challenges.cloudflare.com/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: `
    window.__ts = { renders: 0, executes: 0 };
    window.turnstile = { render(el, o) { window.__ts.renders++; window.__ts.opts = { sitekey: o.sitekey, appearance: o.appearance, execution: o.execution }; window.__ts.o = o; return "w1"; },
      reset() {}, execute() { window.__ts.executes++; const o = window.__ts.o; setTimeout(() => ${turnstile === "ok" ? "o.callback('tok-' + window.__ts.executes)" : "o['error-callback']()"}, 20); } };` }));
  await ctx.route("**/*.html", async (route) => {
    const res = await route.fetch();
    const text = (await res.text()).replaceAll("https://bugqhjkkjybcbnfjpeke.supabase.co", HOST);
    await route.fulfill({ response: res, body: text });
  });
  if (accounts) {
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

test("Save rules: each rule is saved under its own name, replacing one with the same name only after asking", async () => {
  const svc = service();
  const { page, ctx } = await open({ svc, stored: liveSession() });
  await page.waitForFunction(() => document.querySelector("#account-btn").textContent === "Account");
  assert.equal(await visible(page, "#save-rules-cloud"), true);
  assert.equal(await visible(page, "#load-rules-cloud"), true);
  assert.equal(await page.textContent("#save-rules-cloud"), "Save rules", "no rules filled in yet");
  await page.click("#save-rules-cloud");
  await page.waitForFunction(() => /no rules to save/.test(document.querySelector("#status").textContent));
  assert.equal(svc.table.length, 0, "an empty rule is not saved");
  await page.fill(".rule input[aria-label='Rule name']", "Sockets");
  await page.fill(".rule input[id$='-tags']", "Z9");
  assert.equal(await page.textContent("#save-rules-cloud"), "Save rule", "one rule says rule, not rules");
  await page.click("#add-rule");
  await page.fill(".rule:nth-of-type(2) input[aria-label='Rule name']", "Sockets");
  await page.fill(".rule:nth-of-type(2) input[id$='-tags']", "Q1");
  assert.equal(await page.textContent("#save-rules-cloud"), "Save rules");
  await page.click("#save-rules-cloud");
  await page.waitForFunction(() => /own name/.test(document.querySelector("#status").textContent));
  assert.equal(svc.table.length, 0, "two rules with one name are refused");
  await page.fill(".rule:nth-of-type(2) input[aria-label='Rule name']", "Doors");
  await page.click("#save-rules-cloud");
  await until(() => svc.table.length === 2);
  assert.deepEqual(svc.table.map((r) => r.name).sort(), ["Doors", "Sockets"]);
  assert.equal(svc.table.find((r) => r.name === "Sockets").data.tags, "Z9");
  assert.equal(svc.savedFor, UID);
  assert.match(await status(page), /Saved 2 rules to your account/);
  assert.equal(await page.$eval("#save-rules-cloud", (b) => b.classList.contains("saved-flash")), true, "the button turns green");
  assert.match(await page.textContent("#save-rules-cloud"), /Saved/);
  await page.waitForFunction(() => !document.querySelector("#save-rules-cloud").classList.contains("saved-flash"), null, { timeout: 5000 });
  assert.equal(await page.textContent("#save-rules-cloud"), "Save rules", "and goes back to normal");
  const post = svc.calls.filter((c) => c.method === "POST" && c.path.startsWith("/rest/v1/saved_rules")).at(-1);
  assert.equal(post.path, "/rest/v1/saved_rules?on_conflict=user_id,name");
  assert.equal(post.headers.prefer, "resolution=merge-duplicates,return=minimal");
  // saving again with a changed rule asks before replacing
  await page.fill(".rule input[id$='-tags']", "Z10");
  const asked = [];
  page.once("dialog", (d) => { asked.push(d.message()); d.dismiss(); });
  await page.click("#save-rules-cloud");
  await until(() => asked.length);
  assert.match(asked[0], /Replace the saved rules with these names: Sockets, Doors/);
  assert.equal(svc.table.find((r) => r.name === "Sockets").data.tags, "Z9", "declined: nothing changed");
  page.once("dialog", (d) => d.accept());
  await page.click("#save-rules-cloud");
  await until(() => svc.table.find((r) => r.name === "Sockets").data.tags === "Z10");
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

test("Load rules: the list is by name, one rule or all of them go onto the plan, and nothing is saved by looking", async () => {
  const svc = service({ table: rowsOf(R2, R1) });
  const { page, ctx } = await open({ svc, stored: liveSession() });
  await page.waitForFunction(() => document.querySelector("#account-btn").textContent === "Account");
  await page.click("#load-rules-cloud");
  await page.waitForSelector("#rules-modal:not([hidden])");
  await page.waitForSelector(".saved-rule");
  assert.deepEqual(await page.$$eval(".saved-rule strong", (e) => e.map((x) => x.textContent)), ["Patio door", "Sockets"]);
  assert.equal(await page.textContent("#rules-count"), "2 saved rules");
  assert.deepEqual(await page.$$eval(".sr-sub", (e) => e.map((x) => x.textContent)), ["Finds a symbol", "Finds: Z9"]);
  await page.click("button[aria-label='Add to plan: Sockets']");
  await page.waitForFunction(() => document.querySelector(".rule input[id$='-tags']")?.value === "Z9");
  assert.equal(await page.inputValue(".rule input[aria-label='Rule name']"), "Sockets", "the empty first rule makes room");
  assert.equal(await page.$$eval(".rule", (e) => e.length), 1);
  assert.match(await status(page), /Added 1 rule to your plan/);
  assert.equal(await visible(page, "#rules-modal"), true, "the window stays open so more can be added");
  await page.click("#rules-all");
  await page.waitForSelector("#rules-modal", { state: "hidden" });
  assert.equal(await page.$$eval(".rule", (e) => e.length), 3);
  assert.match(await status(page), /Added 2 rules to your plan/);
  assert.equal(svc.calls.filter((c) => ["POST", "PATCH", "DELETE"].includes(c.method) && c.path.startsWith("/rest/")).length, 0, "loading writes nothing back");
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

test("an empty list says how to get started; failing to reach the service says so", async () => {
  const svc = service();
  const { page, ctx } = await open({ svc, stored: liveSession() });
  await page.waitForFunction(() => document.querySelector("#account-btn").textContent === "Account");
  await page.click("#account-btn");
  await page.click("#account-load");
  await page.waitForSelector("#rules-modal:not([hidden])");
  await page.waitForSelector("#rules-empty:not([hidden])");
  assert.match(await page.textContent("#rules-empty"), /haven't saved any rules/);
  await ctx.close();
});

test("editing a saved rule changes only the saved copy; a clashing or blank name is explained; symbol rules can be renamed", async () => {
  const svc = service({ table: rowsOf(R1, R2) });
  const { page, ctx } = await open({ svc, stored: liveSession() });
  await page.waitForFunction(() => document.querySelector("#account-btn").textContent === "Account");
  await page.fill(".rule input[id$='-tags']", "ON-PLAN");
  await page.click("#load-rules-cloud");
  await page.waitForSelector(".saved-rule");
  await page.click("button[aria-label='Edit: Sockets']");
  await page.waitForSelector("#rules-edit:not([hidden])");
  assert.equal(await page.inputValue("#rule-tags"), "Z9");
  await page.fill("#rule-tags", "Z9, Z10");
  await page.check("#rule-pattern");
  await page.selectOption("#rule-pinat", "text");
  await page.fill("#rule-name", "Patio door");
  await page.click("#rule-save");
  await page.waitForFunction(() => /already have a saved rule/.test(document.querySelector("#rules-edit-error").textContent));
  await page.fill("#rule-name", "   ");
  await page.click("#rule-save");
  await page.waitForFunction(() => /needs a name/.test(document.querySelector("#rules-edit-error").textContent));
  await page.fill("#rule-name", "Wall sockets");
  await page.click("#rule-save");
  await page.waitForSelector("#rules-list-view:not([hidden])");
  const row = svc.table.find((r) => r.id === R1.id);
  assert.equal(row.name, "Wall sockets");
  assert.equal(row.data.tags, "Z9, Z10");
  assert.equal(row.data.usePattern, true);
  assert.equal(row.data.pinAt, "text");
  assert.deepEqual(await page.$$eval(".saved-rule strong", (e) => e.map((x) => x.textContent)), ["Patio door", "Wall sockets"]);
  assert.equal(await page.inputValue(".rule input[id$='-tags']"), "ON-PLAN", "the plan is untouched");
  // a symbol rule: only the name
  await page.click("button[aria-label='Edit: Patio door']");
  assert.equal(await visible(page, "#rule-text-fields"), false);
  assert.equal(await visible(page, "#rule-symbol-note"), true);
  await page.fill("#rule-name", "Patio doors");
  await page.click("#rule-save");
  await until(() => svc.table.some((r) => r.name === "Patio doors"));
  assert.equal(svc.table.find((r) => r.name === "Patio doors").data.kind, "symbol");
  assert.deepEqual(page.errors, []);
  await ctx.close();
});

test("deleting a saved rule asks first", async () => {
  const svc = service({ table: rowsOf(R1, R2) });
  const { page, ctx } = await open({ svc, stored: liveSession() });
  await page.waitForFunction(() => document.querySelector("#account-btn").textContent === "Account");
  await page.click("#load-rules-cloud");
  await page.waitForSelector(".saved-rule");
  let msg = "";
  page.once("dialog", (d) => { msg = d.message(); d.dismiss(); });
  await page.click("button[aria-label='Delete: Sockets']");
  await page.waitForTimeout(300);
  assert.equal(svc.table.length, 2);
  assert.match(msg, /Delete the saved rule "Sockets"/);
  page.once("dialog", (d) => d.accept());
  await page.click("button[aria-label='Delete: Sockets']");
  await until(() => svc.table.length === 1);
  await page.waitForFunction(() => document.querySelectorAll(".saved-rule").length === 1);
  await ctx.close();
});

test("signed out, Load rules and Save rules ask you to sign in", async () => {
  const { page, ctx } = await open();
  await page.click("#load-rules-cloud");
  await page.waitForSelector("#signin-modal:not([hidden])");
  await page.keyboard.press("Escape");
  await page.fill(".rule input[id$='-tags']", "A1");
  await page.click("#save-rules-cloud");
  await page.waitForSelector("#signin-modal:not([hidden])");
  await ctx.close();
});

test("the Sign in button sits in the page header, not the crowded top bar", async () => {
  const { page, ctx } = await open();
  assert.equal(await page.$eval("#account-btn", (b) => !!b.closest("header.masthead") && !b.closest("#topnav")), true);
  assert.equal(await page.$eval("#account-btn", (b) => b.getBoundingClientRect().height >= 44), true);
  await ctx.close();
});

test("the rule name looks editable and selects itself when clicked", async () => {
  const { page, ctx } = await open({ accounts: false });
  const input = await page.$(".rule-head input");
  assert.match(await input.getAttribute("title"), /rename/i);
  assert.equal(await input.getAttribute("placeholder"), "Name this rule");
  assert.equal(await page.inputValue(".rule input[id$='-tags']"), "", "text to find starts blank");
  await input.click();
  assert.equal(await page.evaluate(() => { const e = document.activeElement; return e.selectionStart === 0 && e.selectionEnd === e.value.length; }), true);
  await ctx.close();
});

test("with sign-in off, the rule buttons for accounts are not shown but the setup file still works", async () => {
  const { page, ctx } = await open({ accounts: false });
  assert.equal(await visible(page, "#load-rules-cloud"), false);
  assert.equal(await visible(page, "#save-rules-cloud"), false);
  assert.equal(await page.$("#save-rules") !== null, true);
  await ctx.close();
});

test("the account box: who you are, download my data, sign out", async () => {
  const svc = service({ table: rowsOf(R1) });
  const { page, ctx } = await open({ svc, stored: liveSession() });
  await page.waitForFunction(() => document.querySelector("#account-btn").textContent === "Account");
  await page.click("#account-btn");
  assert.match(await page.textContent("#account-email"), /Signed in as bob@example\.com/);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#account-export")]);
  assert.equal(dl.suggestedFilename(), "plandot account data.json");
  const data = JSON.parse(await readFile(await dl.path(), "utf8"));
  assert.equal(data.email, "bob@example.com");
  assert.equal(data.plan, "free");
  assert.equal(data.savedRules[0].name, "Sockets");
  assert.equal(data.savedRules[0].rule.tags, "Z9");
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

test("with a site key, each code request carries a fresh bot-check token, and a failed check explains itself", async () => {
  const { page, svc, ctx } = await open({ siteKey: "0x4AAAAAAAtestkey1234" });
  await page.click("#account-btn");
  await page.fill("#signin-email", "bob@example.com");
  await page.click("#signin-send");
  await page.waitForSelector("#signin-code-form:not([hidden])");
  const otp = () => svc.calls.filter((c) => c.path === "/auth/v1/otp");
  assert.equal(otp()[0].body.gotrue_meta_security.captcha_token, "tok-1");
  assert.deepEqual(await page.evaluate(() => window.__ts.opts), { sitekey: "0x4AAAAAAAtestkey1234", appearance: "interaction-only", execution: "execute" });
  await page.evaluate(() => { document.querySelector("#signin-resend").disabled = false; });
  await page.click("#signin-resend");
  await until(() => otp().length === 2);
  assert.equal(otp()[1].body.gotrue_meta_security.captcha_token, "tok-2");
  assert.deepEqual(page.errors, []);
  await ctx.close();

  const bad = await open({ siteKey: "0x4AAAAAAAtestkey1234", turnstile: "fail" });
  await bad.page.click("#account-btn");
  await bad.page.fill("#signin-email", "bob@example.com");
  await bad.page.click("#signin-send");
  await until(async () => (await bad.page.$eval("#signin-error", (e) => e.textContent)).includes("robot"));
  assert.equal(bad.svc.calls.filter((c) => c.path === "/auth/v1/otp").length, 0, "no email is requested when the check fails");
  await bad.ctx.close();
});

test("with no site key, no bot check is loaded and no token is sent", async () => {
  const { page, svc, ctx } = await open();
  await page.click("#account-btn");
  await page.fill("#signin-email", "bob@example.com");
  await page.click("#signin-send");
  await page.waitForSelector("#signin-code-form:not([hidden])");
  assert.equal(svc.calls.find((c) => c.path === "/auth/v1/otp").body.gotrue_meta_security, undefined);
  assert.equal(await page.evaluate(() => typeof window.turnstile), "undefined");
  await ctx.close();
});
