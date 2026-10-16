// Sign-in client: checked against a fake of Supabase's web interface (no network, no library).
import test from "node:test";
import assert from "node:assert/strict";
import { createAuth, accountSettings, isEmail, cleanCode, isCode, looksSecret, SESSION_KEY } from "../js/auth.js";

const URL_ = "https://abcd1234.supabase.co";
const KEY = "sb_publishable_abcdefghijklmnopqrstuvwxyz012345";
const UID = "11111111-1111-4111-8111-111111111111";

/** A tiny pretend Supabase. Records every request so tests can look at what was sent. */
function fake({ code = "123456", ttl = 3600, now = () => 1_000_000_000_000 } = {}) {
  const f = {
    calls: [], rules: null, deleted: false, otpStatus: 200, offline: false, refreshStatus: 200, rejectOnce: false, rejectAll: false, refreshCount: 0, seq: 0,
    now,
    fetch: async (url, init = {}) => {
      if (f.offline) throw new TypeError("network down");
      const path = url.replace(URL_, "");
      const headers = init.headers || {};
      const body = init.body ? JSON.parse(init.body) : undefined;
      f.calls.push({ path, method: init.method || "GET", headers, body, init });
      const send = (status, json) => ({ status, text: async () => (json === undefined ? "" : JSON.stringify(json)) });
      const session = () => {
        f.seq += 1;
        return { access_token: `access-${f.seq}`, refresh_token: `refresh-${f.seq}`, expires_in: ttl, expires_at: Math.floor(now() / 1000) + ttl, user: { id: UID, email: "bob@example.com" } };
      };
      if (path === "/auth/v1/otp") return f.otpStatus === 200 ? send(200, {}) : send(f.otpStatus, { error_code: f.otpStatus === 429 ? "over_email_send_rate_limit" : "unexpected_failure" });
      if (path === "/auth/v1/verify") return body.token === code && body.type === "email" ? send(200, session()) : send(403, { error_code: "otp_expired", msg: "Token has expired or is invalid" });
      if (path.startsWith("/auth/v1/token")) { f.refreshCount += 1; return f.refreshStatus === 200 ? send(200, session()) : send(f.refreshStatus, { error_code: "refresh_token_not_found" }); }
      if (path.startsWith("/auth/v1/logout")) return send(204);
      if (path.startsWith("/rest/v1/")) {
        const bearer = String(headers.Authorization || "");
        if (f.rejectAll) return send(401, { message: "JWT expired" });
        if (f.rejectOnce) { f.rejectOnce = false; return send(401, { message: "JWT expired" }); }
        if (!/^Bearer access-\d+$/.test(bearer)) return send(401, { message: "no" });
        if (path.startsWith("/rest/v1/saved_rules")) {
          f.table ||= [];
          const method = init.method || "GET";
          const id = (path.match(/[?&]id=eq\.([0-9a-f-]+)/) || [])[1];
          if (method === "GET") return send(200, f.table);
          if (method === "POST") {
            f.savedFor = body.user_id;
            const row = f.table.find((r) => r.name === body.name);
            if (row) row.data = body.data; else f.table.push({ id: `00000000-0000-4000-8000-${String(f.table.length + 1).padStart(12, "0")}`, name: body.name, data: body.data, updated_at: "2026-10-16T10:00:00Z" });
            return send(201);
          }
          if (method === "PATCH") { const row = f.table.find((r) => r.id === id); if (f.table.some((r) => r.name === body.name && r.id !== id)) return send(409, { code: "23505" }); Object.assign(row, body); return send(204); }
          if (method === "DELETE") { f.table = f.table.filter((r) => r.id !== id); return send(204); }
        }
        if (path.startsWith("/rest/v1/profiles")) return send(200, [{ plan: "free", created_at: "2026-10-16T10:00:00Z" }]);
        if (path.startsWith("/rest/v1/rpc/delete_my_account")) { f.deleted = true; return send(204); }
      }
      return send(404, {});
    },
  };
  return f;
}
function store() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), m };
}
function make(opts = {}) {
  const f = opts.fake || fake(opts);
  const storage = opts.storage || store();
  const clock = { t: f.now() };
  const auth = createAuth({ url: URL_, key: KEY, fetchFn: f.fetch, storage, now: () => clock.t, lock: (fn) => fn() });
  return { f, storage, auth, clock };
}

test("settings: off when empty, clear errors when half-filled, secret keys refused", () => {
  assert.equal(accountSettings({ url: "", key: "" }), null);
  assert.match(accountSettings({ url: URL_, key: "" }).error, /Both/);
  assert.match(accountSettings({ url: "http://abcd.supabase.co", key: KEY }).error, /https/);
  assert.match(accountSettings({ url: "https://abcd.supabase.co/rest/v1", key: KEY }).error, /https/);
  assert.match(accountSettings({ url: "not a url", key: KEY }).error, /web address/);
  assert.match(accountSettings({ url: URL_, key: "short" }).error, /expected form/);
  assert.match(accountSettings({ url: URL_, key: "sb_secret_abcdefghijklmnopqrstuvwxyz0123" }).error, /SECRET/);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const serviceJwt = `${b64({ alg: "HS256" })}.${b64({ role: "service_role" })}.sig_sig_sig_sig_sig`;
  const anonJwt = `${b64({ alg: "HS256" })}.${b64({ role: "anon" })}.sig_sig_sig_sig_sig`;
  assert.ok(looksSecret(serviceJwt));
  assert.ok(!looksSecret(anonJwt));
  assert.match(accountSettings({ url: URL_, key: serviceJwt }).error, /SECRET/);
  assert.deepEqual(accountSettings({ url: `${URL_}/`, key: KEY }), { url: URL_, key: KEY });
  assert.deepEqual(accountSettings({ url: URL_, key: anonJwt }), { url: URL_, key: anonJwt });
});

test("emails and codes are checked before anything is sent", async () => {
  for (const bad of ["", "bob", "bob@", "@x.co", "a b@x.co", "bob@x", "x".repeat(250) + "@x.co"]) assert.ok(!isEmail(bad), bad);
  assert.ok(isEmail("bob@example.com"));
  assert.equal(cleanCode(" 123 456\n"), "123456");
  assert.equal(cleanCode("123-456"), "123456");
  assert.ok(isCode("123456") && isCode("12345678") && !isCode("12345") && !isCode("12a456") && !isCode(""));
  const { auth, f } = make();
  await assert.rejects(() => auth.sendCode("nope"), { kind: "badEmail" });
  await assert.rejects(() => auth.verifyCode("bob@example.com", "12"), { kind: "badCode" });
  assert.equal(f.calls.length, 0);
});

test("sending a code: the request carries only the public key, and failures are told apart", async () => {
  const { auth, f } = make();
  await auth.sendCode("bob@example.com");
  const c = f.calls[0];
  assert.equal(c.path, "/auth/v1/otp");
  assert.deepEqual(c.body, { email: "bob@example.com", create_user: true });
  assert.equal(c.headers.apikey, KEY);
  assert.ok(!("Authorization" in c.headers));
  assert.equal(c.init.credentials, "omit");
  f.otpStatus = 429;
  await assert.rejects(() => auth.sendCode("bob@example.com"), { kind: "rate" });
  f.otpStatus = 500;
  await assert.rejects(() => auth.sendCode("bob@example.com"), { kind: "failed" });
  f.offline = true;
  await assert.rejects(() => auth.sendCode("bob@example.com"), { kind: "offline" });
});

test("verifying: a wrong code is refused, the right one (pasted with a space) signs in and is remembered", async () => {
  const { auth, f, storage } = make();
  const seen = [];
  auth.onChange((u) => seen.push(u?.email ?? null));
  await assert.rejects(() => auth.verifyCode("bob@example.com", "000000"), { kind: "badCode" });
  assert.ok(!auth.signedIn());
  const user = await auth.verifyCode("bob@example.com", "123 456");
  assert.deepEqual(user, { id: UID, email: "bob@example.com" });
  assert.ok(auth.signedIn());
  assert.deepEqual(seen, ["bob@example.com"]);
  assert.deepEqual(f.calls.at(-1).body, { type: "email", email: "bob@example.com", token: "123456" });
  assert.ok(!("Authorization" in f.calls.at(-1).headers));
  // a new page load in the same browser is still signed in, without asking the service anything
  const before = f.calls.length;
  const again = createAuth({ url: URL_, key: KEY, fetchFn: f.fetch, storage, now: () => f.now(), lock: (fn) => fn() });
  assert.ok(again.signedIn());
  assert.deepEqual(await again.start(), { id: UID, email: "bob@example.com" });
  assert.equal(f.calls.length, before);
});

test("a damaged or foreign stored session is ignored", async () => {
  for (const junk of ["{", "null", JSON.stringify({ access_token: "a" }), JSON.stringify({ access_token: "a", refresh_token: "b", expires_at: 1, user: { id: "not-a-uuid" } })]) {
    const storage = store();
    storage.setItem(SESSION_KEY, junk);
    const { auth } = make({ storage });
    assert.ok(!auth.signedIn(), junk);
    assert.equal(await auth.start(), null);
  }
});

test("the pass is renewed before it runs out, and the new one is used and kept", async () => {
  const { auth, f, clock, storage } = make({ ttl: 3600 });
  await auth.verifyCode("bob@example.com", "123456");
  clock.t += (3600 - 30) * 1000; // 30 seconds left: inside the margin
  await auth.listRules();
  assert.equal(f.refreshCount, 1);
  const get = f.calls.at(-1);
  assert.equal(get.headers.Authorization, "Bearer access-2");
  assert.equal(JSON.parse(storage.getItem(SESSION_KEY)).refresh_token, "refresh-2");
  assert.deepEqual(f.calls.find((c) => c.path.startsWith("/auth/v1/token")).body, { refresh_token: "refresh-1" });
});

test("two requests at once renew the pass only once", async () => {
  const { auth, f, clock } = make();
  await auth.verifyCode("bob@example.com", "123456");
  clock.t += 3590 * 1000;
  await Promise.all([auth.listRules(), auth.profile(), auth.listRules()]);
  assert.equal(f.refreshCount, 1);
});

test("if the service refuses the renewal, the person is signed out here", async () => {
  const { auth, f, clock, storage } = make();
  await auth.verifyCode("bob@example.com", "123456");
  const seen = [];
  auth.onChange((u) => seen.push(u));
  clock.t += 3590 * 1000;
  f.refreshStatus = 400;
  await assert.rejects(() => auth.listRules(), { kind: "signedOut" });
  assert.ok(!auth.signedIn());
  assert.equal(storage.getItem(SESSION_KEY), null);
  assert.deepEqual(seen, [null]);
});

test("being offline does not sign anyone out", async () => {
  const { auth, f, clock, storage } = make();
  await auth.verifyCode("bob@example.com", "123456");
  clock.t += 3590 * 1000;
  f.offline = true;
  assert.deepEqual(await auth.start(), { id: UID, email: "bob@example.com" });
  await assert.rejects(() => auth.listRules(), { kind: "offline" });
  assert.ok(auth.signedIn());
  assert.ok(storage.getItem(SESSION_KEY));
});

test("a request the database refuses as expired is retried once with a renewed pass", async () => {
  const { auth, f } = make();
  await auth.verifyCode("bob@example.com", "123456");
  f.rejectOnce = true;
  assert.deepEqual(await auth.listRules(), []);
  assert.equal(f.refreshCount, 1);
  assert.equal(f.calls.at(-1).headers.Authorization, "Bearer access-2");
});

test("a pass the database keeps refusing ends the session", async () => {
  const { auth, f, storage } = make();
  await auth.verifyCode("bob@example.com", "123456");
  f.rejectAll = true;
  await assert.rejects(() => auth.listRules(), { kind: "signedOut" });
  assert.ok(!auth.signedIn());
  assert.equal(storage.getItem(SESSION_KEY), null);
});

test("each saved rule has a name, is sent with the right headers, and comes back in a list", async () => {
  const { auth, f } = make();
  await auth.verifyCode("bob@example.com", "123456");
  assert.deepEqual(await auth.listRules(), []);
  await auth.saveRule("  Doors   north ", { tags: "D1" });
  const post = f.calls.at(-1);
  assert.equal(post.path, "/rest/v1/saved_rules?on_conflict=user_id,name");
  assert.equal(post.method, "POST");
  assert.equal(post.headers.Prefer, "resolution=merge-duplicates,return=minimal");
  assert.equal(post.headers.apikey, KEY);
  assert.equal(post.headers.Authorization, "Bearer access-1");
  assert.equal(post.init.credentials, "omit");
  assert.equal(JSON.parse(post.init.body).name, "Doors north", "spaces are tidied");
  assert.equal(f.savedFor, UID);
  await auth.saveRule("Doors north", { tags: "D2" }); // same name replaces
  await auth.saveRule("Sockets", { tags: "S1" });
  const rows = await auth.listRules();
  assert.deepEqual(rows.map((r) => [r.name, r.data.tags]), [["Doors north", "D2"], ["Sockets", "S1"]]);
  assert.match(f.calls.at(-1).path, /order=name\.asc/);
  assert.equal((await auth.profile()).plan, "free");
});

test("a saved rule can be renamed, changed and deleted, and a clash or blank name is explained", async () => {
  const { auth, f } = make();
  await auth.verifyCode("bob@example.com", "123456");
  await auth.saveRule("A", { tags: "1" });
  await auth.saveRule("B", { tags: "2" });
  const [a, b] = await auth.listRules();
  await auth.updateRule(a.id, { name: "A2", data: { tags: "9" } });
  const patch = f.calls.at(-1);
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.path, `/rest/v1/saved_rules?id=eq.${a.id}`);
  assert.deepEqual(JSON.parse(patch.init.body), { name: "A2", data: { tags: "9" } });
  await assert.rejects(() => auth.updateRule(b.id, { name: "A2" }), { kind: "exists" });
  await assert.rejects(() => auth.updateRule(b.id, { name: "   " }), { kind: "badName" });
  await assert.rejects(() => auth.saveRule("", {}), { kind: "badName" });
  await assert.rejects(() => auth.updateRule("not-an-id", { name: "x" }), { kind: "failed" });
  await auth.deleteRule(a.id);
  assert.equal(f.calls.at(-1).method, "DELETE");
  assert.deepEqual((await auth.listRules()).map((r) => r.name), ["B"]);
  await assert.rejects(() => auth.deleteRule("1; drop table"), { kind: "failed" });
});

test("signing out clears this browser first, and tells the service which session to end", async () => {
  const { auth, f, storage } = make();
  await auth.verifyCode("bob@example.com", "123456");
  const p = auth.signOut();
  assert.ok(!auth.signedIn());
  assert.equal(storage.getItem(SESSION_KEY), null);
  await p;
  const out = f.calls.at(-1);
  assert.equal(out.path, "/auth/v1/logout?scope=local");
  assert.equal(out.headers.Authorization, "Bearer access-1");
  // and it still works if the service cannot be reached
  await auth.verifyCode("bob@example.com", "123456");
  f.offline = true;
  await auth.signOut();
  assert.ok(!auth.signedIn());
});

test("deleting the account calls the delete function and signs out", async () => {
  const { auth, f, storage } = make();
  await auth.verifyCode("bob@example.com", "123456");
  await auth.deleteAccount();
  assert.ok(f.deleted);
  assert.equal(f.calls.at(-1).path, "/rest/v1/rpc/delete_my_account");
  assert.ok(!auth.signedIn());
  assert.equal(storage.getItem(SESSION_KEY), null);
});

test("calls need a session", async () => {
  const { auth, f } = make();
  await assert.rejects(() => auth.listRules(), { kind: "signedOut" });
  await assert.rejects(() => auth.saveRule("A", {}), { kind: "signedOut" });
  assert.equal(f.calls.length, 0);
});

test("another tab that already renewed the pass is trusted instead of renewing again", async () => {
  const shared = store();
  const a = make({ storage: shared });
  await a.auth.verifyCode("bob@example.com", "123456");
  const before = a.f.refreshCount;
  // tab B renews: it writes a newer session into the shared storage
  const newer = { access_token: "access-77", refresh_token: "refresh-77", expires_at: Math.floor(a.f.now() / 1000) + 7200, user: { id: UID, email: "bob@example.com" } };
  a.clock.t += 3590 * 1000; // tab A thinks its own pass is about to end
  shared.setItem(SESSION_KEY, JSON.stringify({ ...newer, expires_at: Math.floor(a.clock.t / 1000) + 3600 }));
  await a.auth.listRules();
  assert.equal(a.f.refreshCount, before, "no second renewal");
  assert.equal(a.f.calls.at(-1).headers.Authorization, "Bearer access-77");
});

test("reload() picks up a sign-out made in another tab", async () => {
  const shared = store();
  const { auth } = make({ storage: shared });
  await auth.verifyCode("bob@example.com", "123456");
  const seen = [];
  auth.onChange((u) => seen.push(u));
  shared.removeItem(SESSION_KEY);
  auth.reload();
  assert.ok(!auth.signedIn());
  assert.deepEqual(seen, [null]);
});
