// The account part of the page: the Sign in button, the sign-in box, the account box, the "sign in first" notice
// and saved rules. The sign-in itself is in auth.js. With no project set in js/config.js all of this stays off
// and Plandot works without accounts.
import { tr } from "./i18n.js";
import { ACCOUNTS } from "./config.js";
import { createAuth, accountSettings, isEmail, isCode, cleanCode, SESSION_KEY } from "./auth.js";

const OFF = Object.freeze({ enabled: false, signedIn: () => true, allowUpload: () => true, noteChange() {}, refreshText() {} });

const RESEND_SECONDS = 60;
const MAX_SETUP_CHARS = 500000; // the database refuses more than 512 KB; stay under it

/** The same text for the same content whatever the order of keys, so a saved copy can be compared with the screen. */
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
export const canon = (v) => JSON.stringify(sortKeys(v));

/**
 * @param say             shows a message in the status line: say(text, "ok" | "err")
 * @param getSetup        () => the rules and settings on screen, in the setup-file format
 * @param applySetup      (setup) => puts saved rules on screen
 * @param hasLocalRules   () => are there real rules on screen (not just the empty first rule, not the sample's)?
 * @param paused          () => true while the sample is loaded: its rules are never saved to the account
 * @param download        (blob, filename, type) => saves a file
 */
export function initAccount({ say, getSetup, applySetup, hasLocalRules, paused = () => false, download, doc = document, win = window, fetchFn }) {
  const cfg = accountSettings(ACCOUNTS);
  if (cfg?.error) console.error(`Plandot sign-in is off: ${cfg.error}`);
  if (!cfg || cfg.error) return OFF;
  return build({ cfg, say, getSetup, applySetup, hasLocalRules, paused, download, doc, win, fetchFn });
}

export function build({ cfg, say, getSetup, applySetup, hasLocalRules, paused, download, doc, win, fetchFn, auth: injected }) {
  const el = (id) => doc.getElementById(id);
  const auth = injected || createAuth({ url: cfg.url, key: cfg.key, ...(fetchFn ? { fetchFn } : {}) });
  const btn = el("account-btn");
  const gate = el("gate");
  btn.hidden = false;

  // With accounts there are buttons that matter (sign out, delete account), so refuse to be shown inside someone
  // else's page, where a visitor could be tricked into clicking them. (A page cannot set X-Frame-Options here.)
  try { if (win.top !== win.self) doc.documentElement.hidden = true; } catch { doc.documentElement.hidden = true; }

  // ---------------------------------------------------------------- boxes (modal dialogs)
  let openBox = null, opener = null;
  const focusables = (box) => [...box.querySelectorAll("button:not([disabled]), input:not([disabled]), a[href]")].filter((e) => !e.closest("[hidden]"));
  function onKey(e) {
    if (!openBox) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeBox(); return; }
    if (e.key !== "Tab") return;
    const list = focusables(openBox);
    if (!list.length) return;
    const first = list[0], last = list.at(-1);
    if (e.shiftKey && (doc.activeElement === first || !openBox.contains(doc.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (doc.activeElement === last || !openBox.contains(doc.activeElement))) { e.preventDefault(); first.focus(); }
  }
  doc.addEventListener("keydown", onKey, true);
  function showBox(box, focusEl) {
    if (openBox) closeBox(false);
    opener = doc.activeElement instanceof win.HTMLElement ? doc.activeElement : null;
    openBox = box;
    box.hidden = false;
    doc.body.classList.add("modal-open");
    (focusEl || focusables(box)[0])?.focus();
  }
  function closeBox(restoreFocus = true) {
    if (!openBox) return;
    openBox.hidden = true;
    openBox = null;
    doc.body.classList.remove("modal-open");
    if (restoreFocus && opener && doc.contains(opener) && !opener.hidden) opener.focus();
    opener = null;
  }
  for (const box of [el("signin-modal"), el("account-modal")]) box.addEventListener("mousedown", (e) => { if (e.target === box) closeBox(); });
  el("signin-x").addEventListener("click", () => closeBox());
  el("account-x").addEventListener("click", () => closeBox());

  // ---------------------------------------------------------------- what the page shows for each state
  const messageFor = (err) => ({
    badEmail: tr("That doesn't look like an email address."),
    badCode: tr("That code didn't work. Check it, or send a new one."),
    rate: tr("Too many attempts. Wait a minute and try again."),
    offline: tr("Can't reach the sign-in service. Check your connection and try again."),
  }[err?.kind] || tr("That didn't work. Try again in a moment."));
  const setError = (id, msg) => { const p = el(id); p.textContent = msg || ""; p.hidden = !msg; };

  function paint() {
    const signed = auth.signedIn();
    btn.textContent = signed ? tr("Account") : tr("Sign in");
    doc.body.classList.toggle("gated", !signed);
    gate.hidden = signed;
    const u = auth.user();
    el("account-email").textContent = u ? tr("Signed in as {email}", { email: u.email }) : "";
    paintSent();
    paintResend();
  }

  // ---------------------------------------------------------------- signing in
  let pendingEmail = "", sending = false, resendAt = 0, tick = 0;
  function step(which) {
    el("signin-email-form").hidden = which !== "email";
    el("signin-code-form").hidden = which !== "code";
    setError("signin-error", "");
    (which === "email" ? el("signin-email") : el("signin-code")).focus();
  }
  function paintSent() { el("signin-sent").textContent = pendingEmail ? tr("We emailed a code to {email}. Enter it below. If it doesn't arrive, check your spam folder.", { email: pendingEmail }) : ""; }
  function paintResend() {
    const left = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
    const b = el("signin-resend");
    b.disabled = left > 0;
    b.textContent = left > 0 ? tr("Send a new code in {s}s", { s: left }) : tr("Send a new code");
    if (left <= 0 && tick) { clearInterval(tick); tick = 0; }
  }
  function cooldown() {
    resendAt = Date.now() + RESEND_SECONDS * 1000;
    clearInterval(tick);
    tick = setInterval(paintResend, 500);
    paintResend();
  }
  function openSignIn(message = "") {
    pendingEmail = "";
    el("signin-code").value = "";
    paintSent();
    showBox(el("signin-modal"), null);
    step("email");
    setError("signin-error", message);
  }

  el("signin-email-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending) return;
    const email = el("signin-email").value.trim().toLowerCase();
    if (!isEmail(email)) { setError("signin-error", messageFor({ kind: "badEmail" })); return; }
    sending = true; el("signin-send").disabled = true; setError("signin-error", "");
    try {
      await auth.sendCode(email);
      pendingEmail = email;
      el("signin-code").value = "";
      paintSent();
      step("code");
      cooldown();
    } catch (err) {
      setError("signin-error", messageFor(err));
    } finally {
      sending = false; el("signin-send").disabled = false;
    }
  });
  el("signin-resend").addEventListener("click", async () => {
    if (sending || !pendingEmail) return;
    sending = true; setError("signin-error", "");
    try { await auth.sendCode(pendingEmail); cooldown(); el("signin-code").focus(); }
    catch (err) { setError("signin-error", messageFor(err)); }
    finally { sending = false; }
  });
  el("signin-back").addEventListener("click", () => { pendingEmail = ""; step("email"); });
  el("signin-code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending) return;
    const code = cleanCode(el("signin-code").value);
    if (!isCode(code)) { setError("signin-error", messageFor({ kind: "badCode" })); return; }
    sending = true; el("signin-verify").disabled = true; setError("signin-error", "");
    try {
      await auth.verifyCode(pendingEmail, code);
      closeBox();
      say(tr("You're signed in. Choose your drawing to continue."), "ok");
    } catch (err) {
      setError("signin-error", messageFor(err));
      el("signin-code").select();
    } finally {
      sending = false; el("signin-verify").disabled = false;
    }
  });

  // ---------------------------------------------------------------- the account box
  btn.addEventListener("click", () => (auth.signedIn() ? (setError("account-error", ""), showBox(el("account-modal"), el("account-load"))) : openSignIn()));
  el("gate-signin").addEventListener("click", () => openSignIn());

  let leaving = false; // the person chose to sign out or delete, so the "session ended" message is not wanted
  el("account-signout").addEventListener("click", async () => {
    leaving = true;
    try { await auth.signOut(); } finally { leaving = false; }
    closeBox(false);
    say(tr("You're signed out."), "ok");
  });
  el("account-delete").addEventListener("click", async () => {
    if (!win.confirm(tr("Delete your account? This permanently removes your email and saved rules from Plandot. Your drawings are not affected because they are never stored. This cannot be undone."))) return;
    leaving = true;
    try {
      await auth.deleteAccount();
      closeBox(false);
      say(tr("Your account was deleted."), "ok");
    } catch (err) {
      setError("account-error", messageFor(err));
    } finally { leaving = false; }
  });
  el("account-export").addEventListener("click", async () => {
    setError("account-error", "");
    try {
      const [rules, profile] = await Promise.all([auth.loadRules(), auth.profile()]);
      const u = auth.user();
      const data = { app: "plandot", exportedAt: new Date().toISOString(), email: u?.email ?? "", plan: profile?.plan ?? "", accountCreated: profile?.created_at ?? "", savedRules: rules?.data ?? null, savedRulesUpdated: rules?.updated_at ?? "" };
      download(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), "plandot account data.json", "application/json");
    } catch (err) { setError("account-error", messageFor(err)); }
  });
  el("account-load").addEventListener("click", async () => {
    setError("account-error", "");
    try {
      const row = await auth.loadRules();
      if (!row) { setError("account-error", tr("You have no saved rules yet.")); return; }
      applySetup(row.data);
      lastSaved = canon(row.data);
      ready = true;
      closeBox(false);
      say(tr("Loaded your saved rules."), "ok");
    } catch (err) { setError("account-error", messageFor(err)); }
  });

  // ---------------------------------------------------------------- saved rules
  let ready = false, lastSaved = "", timer = 0, warned = false, syncing = null;
  const usable = () => auth.signedIn() && ready && !paused() && hasLocalRules();

  async function push() {
    const setup = getSetup();
    const text = canon(setup);
    if (text.length > MAX_SETUP_CHARS) { if (!warned) say(tr("Your rules are too large to save to your account. Use Save setup to keep them as a file."), "err"); warned = true; return; }
    if (text === lastSaved) return;
    await auth.saveRules(setup);
    lastSaved = text;
    warned = false;
  }
  function pushFailed(err) {
    if (err?.kind === "signedOut") return;
    if (!warned) say(tr("Couldn't reach your saved rules. They are still on this device."), "err");
    warned = true;
  }

  /** On sign-in and at start-up: bring saved rules onto the screen, or save the ones on the screen for the first time. */
  function syncDown() {
    syncing ||= (async () => {
      ready = false;
      try {
        const row = await auth.loadRules();
        const local = hasLocalRules() && !paused();
        if (row) {
          const saved = canon(row.data);
          if (!local) { applySetup(row.data); lastSaved = saved; say(tr("Loaded your saved rules."), "ok"); }
          else if (saved === canon(getSetup())) lastSaved = saved;
          else if (win.confirm(tr("Replace the rules on this screen with the ones saved in your account?"))) { applySetup(row.data); lastSaved = saved; say(tr("Loaded your saved rules."), "ok"); }
          else lastSaved = ""; // the rules on screen are kept, and replace the saved ones on the next change
        } else if (local) {
          lastSaved = "";
          await push();
        }
        ready = true;
        warned = false;
      } catch (err) { pushFailed(err); }
    })().finally(() => { syncing = null; });
    return syncing;
  }

  /** The page calls this after any change to rules or settings. */
  function noteChange() {
    if (!usable()) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (usable()) push().catch(pushFailed); }, 1500);
  }

  // ---------------------------------------------------------------- reacting to the session
  let wasSignedIn = auth.signedIn();
  auth.onChange((user) => {
    const now = !!user;
    paint();
    if (now && !wasSignedIn) syncDown();
    if (!now && wasSignedIn) {
      ready = false; clearTimeout(timer); lastSaved = "";
      if (!leaving) { openSignIn(tr("Your session ended. Sign in again to continue.")); }
      else if (openBox === el("account-modal")) closeBox(false);
    }
    wasSignedIn = now;
  });
  win.addEventListener("storage", (e) => { if (e.key === SESSION_KEY || e.key === null) auth.reload(); });
  win.addEventListener("online", () => { if (auth.signedIn() && !ready) syncDown(); });

  paint();
  auth.start().then((user) => {
    paint();
    if (user) { wasSignedIn = true; syncDown(); }
  }).catch(() => paint());

  return {
    enabled: true,
    signedIn: () => auth.signedIn(),
    /** Called before a drawing or template is chosen or dropped. Signed out: opens the sign-in box and says no. */
    allowUpload() {
      if (auth.signedIn()) return true;
      openSignIn();
      return false;
    },
    noteChange,
    /** After a language change. */
    refreshText: paint,
    _auth: auth,
  };
}
