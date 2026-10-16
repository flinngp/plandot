// Sign-in with an emailed code, through Supabase's plain web interface.
//
// There is no third-party library here on purpose: fewer moving parts, nothing extra to keep patched, and every
// request the page can make to the account service is on this one page of code.
//
// What is stored where:
//   * the browser keeps the session (a short-lived pass and a refresh token) under SESSION_KEY in localStorage,
//   * Supabase keeps the email address, the plan and the saved rules (see supabase/schema.sql),
//   * drawings and templates are never sent anywhere.
//
// Pure of the page: everything it needs (fetch, storage, clock, lock) is passed in, so it is tested in Node.

export const SESSION_KEY = "plandot.session";
const REFRESH_MARGIN = 60; // renew the pass when it has less than this many seconds left
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** kind is one of: badEmail, badCode, badName, exists, limit, rate, offline, failed, signedOut. The page turns it into a sentence. */
export class AuthError extends Error {
  constructor(kind, status = 0) {
    super(kind);
    this.kind = kind;
    this.status = status;
  }
}

export const isEmail = (s) => typeof s === "string" && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
/** People paste codes as "123 456" or "123-456". */
export const cleanCode = (s) => String(s ?? "").replace(/[\s-]/g, "");
/** A rule's name as the database wants it: no stray spaces, 1 to 80 characters. Empty when unusable. */
export const cleanName = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
export const isCode = (s) => /^\d{6,10}$/.test(s);

const b64urlJson = (part) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));

/** Secret keys must never be in a web page. Catch the mistake before it is published. */
export function looksSecret(key) {
  if (/^sb_secret_/i.test(key)) return true;
  const parts = key.split(".");
  if (parts.length === 3) {
    try { return b64urlJson(parts[1]).role === "service_role"; } catch { /* not a readable key */ }
  }
  return false;
}

/** Checks the two values in js/config.js. null: sign-in is switched off. {error}: set up wrongly. {url, key}: ready. */
export function accountSettings(cfg) {
  const url = String(cfg?.url ?? "").trim().replace(/\/+$/, "");
  const key = String(cfg?.key ?? "").trim();
  if (!url && !key) return null;
  if (!url || !key) return { error: "Both the project address and the public key are needed in js/config.js." };
  let u;
  try { u = new URL(url); } catch { return { error: "The project address in js/config.js is not a web address." }; }
  if (u.protocol !== "https:" || u.pathname !== "/" || u.search || u.hash) return { error: "The project address in js/config.js must look like https://yourproject.supabase.co" };
  if (!/^[A-Za-z0-9._-]{20,}$/.test(key)) return { error: "The public key in js/config.js is not in the expected form." };
  if (looksSecret(key)) return { error: "That is a SECRET key. Only the public (publishable or anon) key belongs in js/config.js. Rotate the secret key in Supabase." };
  return { url: u.origin, key };
}

const canLocks = () => typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function";
/** One tab at a time may renew the pass, because each refresh token works once. */
const defaultLock = (fn) => (canLocks() ? navigator.locks.request("plandot-session-refresh", fn) : fn());

function browserStorage() {
  try {
    const s = globalThis.localStorage;
    s.getItem(SESSION_KEY);
    return s;
  } catch {
    const mem = new Map(); // storage blocked: sign-in lasts until the tab is closed
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, String(v)), removeItem: (k) => void mem.delete(k) };
  }
}

export function createAuth({ url, key, fetchFn = (...a) => globalThis.fetch(...a), storage = browserStorage(), now = () => Date.now(), lock = defaultLock, timeoutMs = 15000 }) {
  const listeners = new Set();
  const nowSec = () => Math.floor(now() / 1000);

  // ---------------------------------------------------------------- the stored session
  function readStored() {
    try {
      const s = JSON.parse(storage.getItem(SESSION_KEY) || "null");
      if (s && typeof s.access_token === "string" && typeof s.refresh_token === "string" && Number.isFinite(s.expires_at) && s.user && UUID.test(s.user.id)) {
        return { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, user: { id: s.user.id, email: String(s.user.email ?? "") } };
      }
    } catch { /* unreadable: treat as signed out */ }
    return null;
  }
  let sess = readStored();

  function persist(s) {
    try { if (s) storage.setItem(SESSION_KEY, JSON.stringify(s)); else storage.removeItem(SESSION_KEY); } catch { /* the session then lasts until the tab closes */ }
  }
  function emit() { for (const fn of [...listeners]) { try { fn(sess ? { ...sess.user } : null); } catch { /* a listener must not break sign-in */ } } }
  function setSession(s) { sess = s; persist(s); emit(); }
  function clearSession() { if (sess || readStored()) setSession(null); }

  /** Reads a response from Supabase's sign-in service into a session we are happy to keep. */
  function toSession(j, fallbackUser) {
    const user = j?.user && UUID.test(j.user.id) ? j.user : fallbackUser;
    if (!j || typeof j.access_token !== "string" || typeof j.refresh_token !== "string" || !user || !UUID.test(user.id)) throw new AuthError("failed");
    const expires = Number(j.expires_at) || nowSec() + (Number(j.expires_in) || 3600);
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: expires, user: { id: user.id, email: String(user.email ?? "") } };
  }

  // ---------------------------------------------------------------- talking to Supabase
  async function api(path, { method = "GET", body, token, headers = {} } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchFn(url + path, {
        method,
        signal: ctl.signal,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { apikey: key, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      return { status: res.status, json };
    } catch {
      throw new AuthError("offline");
    } finally {
      clearTimeout(timer);
    }
  }
  const ok = (r) => r.status >= 200 && r.status < 300;
  const code = (r) => String(r.json?.error_code ?? r.json?.code ?? "");

  async function sendCode(email) {
    if (!isEmail(email)) throw new AuthError("badEmail");
    const r = await api("/auth/v1/otp", { method: "POST", body: { email, create_user: true } });
    if (ok(r)) return;
    if (r.status === 429 || code(r) === "over_email_send_rate_limit" || code(r) === "over_request_rate_limit") throw new AuthError("rate", r.status);
    if (code(r) === "email_address_invalid" || code(r) === "validation_failed") throw new AuthError("badEmail", r.status);
    throw new AuthError("failed", r.status);
  }

  async function verifyCode(email, token) {
    if (!isEmail(email)) throw new AuthError("badEmail");
    const t = cleanCode(token);
    if (!isCode(t)) throw new AuthError("badCode");
    const r = await api("/auth/v1/verify", { method: "POST", body: { type: "email", email, token: t } });
    if (ok(r)) { setSession(toSession(r.json)); return { ...sess.user }; }
    if (r.status === 429) throw new AuthError("rate", r.status);
    if ([400, 401, 403, 404, 422].includes(r.status)) throw new AuthError("badCode", r.status);
    throw new AuthError("failed", r.status);
  }

  // ---------------------------------------------------------------- keeping the pass fresh
  let refreshing = null;
  function refresh() {
    refreshing ||= lock(async () => {
      const stored = readStored();
      if (stored && (!sess || stored.refresh_token !== sess.refresh_token)) { // another tab already renewed it
        sess = stored;
        if (sess.expires_at - nowSec() > REFRESH_MARGIN) { emit(); return sess; }
      }
      if (!sess) throw new AuthError("signedOut");
      const r = await api("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: sess.refresh_token } });
      if (ok(r)) { const next = toSession(r.json, sess.user); sess = next; persist(next); return next; }
      if ([400, 401, 403, 404, 422].includes(r.status)) { clearSession(); throw new AuthError("signedOut", r.status); }
      throw new AuthError("failed", r.status);
    }).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function fresh(force = false) {
    if (!sess) throw new AuthError("signedOut");
    if (!force && sess.expires_at - nowSec() > REFRESH_MARGIN) return sess;
    return refresh();
  }

  /** A request to the database as the signed-in person. Renews the pass first, and once more if it is refused. */
  async function rest(path, opts = {}) {
    let s = await fresh();
    let r = await api(path, { ...opts, token: s.access_token });
    if (r.status === 401) {
      s = await fresh(true);
      r = await api(path, { ...opts, token: s.access_token });
      if (r.status === 401) { clearSession(); throw new AuthError("signedOut", 401); }
    }
    if (r.status === 409) throw new AuthError("exists", r.status);
    if (String(r.json?.code) === "54000") throw new AuthError("limit", r.status);
    if (!ok(r)) throw new AuthError("failed", r.status);
    return r.json;
  }

  // ---------------------------------------------------------------- what the page uses
  return {
    signedIn: () => !!sess,
    user: () => (sess ? { ...sess.user } : null),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Call once at start-up. Returns the user, or null. Being offline keeps you signed in. */
    async start() {
      if (!sess) return null;
      try { await fresh(); } catch (e) { if (e.kind === "signedOut") return null; }
      return sess ? { ...sess.user } : null;
    },
    /** Another tab signed in or out: pick that up. */
    reload() { sess = readStored(); emit(); },
    sendCode,
    verifyCode,
    async signOut() {
      const s = sess;
      clearSession();
      if (s) { try { await api("/auth/v1/logout?scope=local", { method: "POST", token: s.access_token }); } catch { /* signed out here either way */ } }
    },
    /** Every saved rule of this person: [{id, name, data, updated_at}], by name. */
    async listRules() {
      const rows = await rest("/rest/v1/saved_rules?select=id,name,data,updated_at&order=name.asc&limit=200");
      return (Array.isArray(rows) ? rows : []).filter((r) => r && UUID.test(r.id) && typeof r.name === "string" && r.data && typeof r.data === "object");
    },
    /** Saves a rule under its name. A rule with the same name is replaced. */
    async saveRule(name, data) {
      const s = await fresh();
      const n = cleanName(name);
      if (!n) throw new AuthError("badName");
      await rest("/rest/v1/saved_rules?on_conflict=user_id,name", { method: "POST", body: { user_id: s.user.id, name: n, data }, headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
    },
    /** Changes the name and/or content of one saved rule. */
    async updateRule(id, patch) {
      if (!UUID.test(id)) throw new AuthError("failed");
      const body = {};
      if (patch.name !== undefined) { body.name = cleanName(patch.name); if (!body.name) throw new AuthError("badName"); }
      if (patch.data !== undefined) body.data = patch.data;
      await rest(`/rest/v1/saved_rules?id=eq.${id}`, { method: "PATCH", body, headers: { Prefer: "return=minimal" } });
    },
    async deleteRule(id) {
      if (!UUID.test(id)) throw new AuthError("failed");
      await rest(`/rest/v1/saved_rules?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    },
    async profile() {
      const rows = await rest("/rest/v1/profiles?select=plan,created_at&limit=1");
      return Array.isArray(rows) && rows[0] ? rows[0] : null;
    },
    /** Deletes the account and everything stored with it, then signs out here. */
    async deleteAccount() {
      await rest("/rest/v1/rpc/delete_my_account", { method: "POST", body: {} });
      clearSession();
    },
  };
}
