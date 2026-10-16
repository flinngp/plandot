// The account part of the page: the Sign in button, the sign-in box, the account box, the "sign in first" notice
// and saved rules. The sign-in itself is in auth.js. With no project set in js/config.js all of this stays off
// and Plandot works without accounts.
import { tr } from "./i18n.js";
import { ACCOUNTS } from "./config.js";
import { createAuth, accountSettings, isEmail, isCode, cleanCode, SESSION_KEY } from "./auth.js";

const OFF = Object.freeze({ enabled: false, signedIn: () => true, allowUpload: () => true, openRules() {}, saveRules() {}, noteChange() {}, refreshText() {} });

const RESEND_SECONDS = 60;
const MAX_RULE_CHARS = 250000; // the database refuses a rule over 256 KB; stay under it

/**
 * @param say             shows a message in the status line: say(text, "ok" | "err")
 * @param getRules        () => the rules on the plan that have something in them: [{name, data}]
 * @param addRules        ([{name, data}]) => adds saved rules to the plan
 * @param download        (blob, filename, type) => saves a file
 */
export function initAccount({ say, getRules, addRules, download, doc = document, win = window, fetchFn }) {
  const cfg = accountSettings(ACCOUNTS);
  if (cfg?.error) console.error(`Plandot sign-in is off: ${cfg.error}`);
  if (!cfg || cfg.error) return OFF;
  return build({ cfg, say, getRules, addRules, download, doc, win, fetchFn });
}

export function build({ cfg, say, getRules, addRules, download, doc, win, fetchFn, auth: injected }) {
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
  const focusables = (box) => [...box.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]")].filter((e) => !e.closest("[hidden]"));
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
  for (const box of [el("signin-modal"), el("account-modal"), el("rules-modal")]) box.addEventListener("mousedown", (e) => { if (e.target === box) closeBox(); });
  el("signin-x").addEventListener("click", () => closeBox());
  el("account-x").addEventListener("click", () => closeBox());
  el("rules-x").addEventListener("click", () => closeBox());

  // ---------------------------------------------------------------- what the page shows for each state
  const messageFor = (err) => ({
    badEmail: tr("That doesn't look like an email address."),
    badCode: tr("That code didn't work. Check it, or send a new one."),
    rate: tr("Too many attempts. Wait a minute and try again."),
    offline: tr("Can't reach the sign-in service. Check your connection and try again."),
    badName: tr("A saved rule needs a name."),
    exists: tr("You already have a saved rule with that name."),
    limit: tr("You can keep up to 200 saved rules."),
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
  el("account-load").addEventListener("click", () => openRules());
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
      const [rules, profile] = await Promise.all([auth.listRules(), auth.profile()]);
      const u = auth.user();
      const data = { app: "plandot", exportedAt: new Date().toISOString(), email: u?.email ?? "", plan: profile?.plan ?? "", accountCreated: profile?.created_at ?? "", savedRules: rules.map((r) => ({ name: r.name, updated: r.updated_at, rule: r.data })) };
      download(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), "plandot account data.json", "application/json");
    } catch (err) { setError("account-error", messageFor(err)); }
  });
  // ---------------------------------------------------------------- saved rules
  const mk = (tag, props = {}, ...kids) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  let saved = [], loadingRules = false;
  const nRules = (n, one, many) => (n === 1 ? tr(one) : tr(many, { n }));

  function showList() { el("rules-list-view").hidden = false; el("rules-edit").hidden = true; }
  function paintRules() {
    const ul = el("rules-list");
    ul.replaceChildren();
    el("rules-empty").hidden = loadingRules || saved.length > 0;
    for (const r of saved) {
      const symbol = r.data.kind === "symbol";
      const sub = symbol ? tr("Draw box") : String(r.data.tags ?? "").slice(0, 60);
      ul.append(mk("li", { class: "saved-rule" },
        mk("div", { class: "sr-main" }, mk("strong", { text: r.name }), mk("span", { class: "sr-sub", text: sub })),
        mk("div", { class: "sr-actions" },
          mk("button", { type: "button", class: "btn quiet", text: tr("Add to plan"), "aria-label": `${tr("Add to plan")}: ${r.name}`, onclick: () => { addRules([{ name: r.name, data: structuredClone(r.data) }]); say(tr("Added 1 rule to your plan."), "ok"); } }),
          mk("button", { type: "button", class: "btn quiet", text: tr("Edit"), "aria-label": `${tr("Edit")}: ${r.name}`, onclick: () => editRule(r) }),
          mk("button", { type: "button", class: "btn quiet danger-text", text: tr("Delete"), "aria-label": `${tr("Delete")}: ${r.name}`, onclick: () => removeRule(r) }))));
    }
    el("rules-all").hidden = saved.length < 2;
  }
  async function refreshRules() {
    loadingRules = true; setError("rules-error", ""); paintRules();
    try { saved = await auth.listRules(); }
    catch (err) { saved = []; setError("rules-error", messageFor(err)); }
    finally { loadingRules = false; paintRules(); }
  }
  function openRules() {
    if (!auth.signedIn()) { openSignIn(); return; }
    showList();
    showBox(el("rules-modal"), null);
    refreshRules();
  }

  let editing = null;
  function editRule(r) {
    editing = r;
    const symbol = r.data.kind === "symbol";
    setError("rules-edit-error", "");
    el("rule-name").value = r.name;
    el("rule-tags").value = String(r.data.tags ?? "");
    el("rule-pattern").checked = !!r.data.usePattern;
    el("rule-title").value = String(r.data.title ?? "{tag}");
    el("rule-pinat").value = r.data.pinAt === "text" ? "text" : "dot";
    el("rule-text-fields").hidden = symbol;
    el("rule-symbol-note").hidden = !symbol;
    el("rules-list-view").hidden = true;
    el("rules-edit").hidden = false;
    el("rule-name").focus();
  }
  el("rule-back").addEventListener("click", () => { editing = null; showList(); });
  el("rules-edit").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!editing) return;
    const symbol = editing.data.kind === "symbol";
    const data = symbol ? editing.data : { ...editing.data, tags: el("rule-tags").value, usePattern: el("rule-pattern").checked, title: el("rule-title").value || "{tag}", pinAt: el("rule-pinat").value === "text" ? "text" : "dot" };
    if (JSON.stringify(data).length > MAX_RULE_CHARS) { setError("rules-edit-error", tr("That rule is too large to save.")); return; }
    el("rule-save").disabled = true; setError("rules-edit-error", "");
    try {
      await auth.updateRule(editing.id, { name: el("rule-name").value, data });
      editing = null;
      showList();
      await refreshRules();
      say(tr("Changes saved."), "ok");
    } catch (err) { setError("rules-edit-error", messageFor(err)); }
    finally { el("rule-save").disabled = false; }
  });
  async function removeRule(r) {
    if (!win.confirm(tr("Delete the saved rule \"{name}\"? This cannot be undone.", { name: r.name }))) return;
    setError("rules-error", "");
    try { await auth.deleteRule(r.id); await refreshRules(); }
    catch (err) { setError("rules-error", messageFor(err)); }
  }
  el("rules-all").addEventListener("click", () => {
    addRules(saved.map((r) => ({ name: r.name, data: structuredClone(r.data) })));
    closeBox();
    say(nRules(saved.length, "Added 1 rule to your plan.", "Added {n} rules to your plan."), "ok");
  });

  /** Saves every rule on the plan that has something in it, each under its own name. */
  let savingRules = false;
  async function saveRules() {
    if (!auth.signedIn()) { openSignIn(); return; }
    if (savingRules) return;
    const rules = getRules();
    if (!rules.length) { say(tr("There are no rules to save yet. Fill in a rule first."), "err"); return; }
    const names = rules.map((r) => r.name.trim().toLowerCase());
    if (new Set(names).size !== names.length || rules.some((r) => !r.name.trim())) { say(tr("Give each rule its own name before saving."), "err"); return; }
    if (rules.some((r) => JSON.stringify(r.data).length > MAX_RULE_CHARS)) { say(tr("A rule is too large to save. Try a smaller symbol."), "err"); return; }
    savingRules = true;
    try {
      const existing = new Set((await auth.listRules()).map((r) => r.name.toLowerCase()));
      const clash = rules.filter((r) => existing.has(r.name.trim().toLowerCase())).map((r) => r.name.trim());
      if (clash.length && !win.confirm(tr("Replace the saved rules with these names: {names}?", { names: clash.join(", ") }))) return;
      for (const r of rules) await auth.saveRule(r.name, r.data);
      say(nRules(rules.length, "Saved 1 rule to your account.", "Saved {n} rules to your account."), "ok");
    } catch (err) {
      if (err?.kind !== "signedOut") say(messageFor(err), "err");
    } finally { savingRules = false; }
  }

  // ---------------------------------------------------------------- reacting to the session
  let wasSignedIn = auth.signedIn();
  auth.onChange((user) => {
    const now = !!user;
    paint();
    if (!now && wasSignedIn) {
      saved = []; editing = null;
      if (!leaving) { openSignIn(tr("Your session ended. Sign in again to continue.")); }
      else if (openBox === el("account-modal") || openBox === el("rules-modal")) closeBox(false);
    }
    wasSignedIn = now;
  });
  win.addEventListener("storage", (e) => { if (e.key === SESSION_KEY || e.key === null) auth.reload(); });

  paint();
  auth.start().then((user) => {
    paint();
    if (user) wasSignedIn = true;
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
    openRules,
    saveRules,
    noteChange() {},
    /** After a language change. */
    refreshText: paint,
    _auth: auth,
  };
}
