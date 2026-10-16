// Cloudflare Turnstile: a free check that the person signing in is not a bot, so nobody can use the sign-in box to
// send floods of emails. Switched on by putting the public "site key" in js/config.js (the secret key lives only in
// Supabase). With no site key nothing here runs and nothing is loaded.
//
// Turnstile runs in "interaction only" mode: most people never see it. A token works once, so a new one is
// requested for every code that is sent.

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const isSiteKey = (k) => typeof k === "string" && /^[0-9A-Za-z_-]{10,80}$/.test(k);

export function createCaptcha({ siteKey, container, doc = document, win = window, timeoutMs = 30000 }) {
  if (!isSiteKey(siteKey)) return null;
  let loading = null, widget = null, pending = null;

  function load() {
    if (win.turnstile) return Promise.resolve();
    loading ||= new Promise((resolve, reject) => {
      const s = doc.createElement("script");
      s.src = SCRIPT;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { loading = null; reject(new Error("blocked")); };
      doc.head.append(s);
    });
    return loading;
  }
  const settle = (fn, value) => { const p = pending; pending = null; if (p) { clearTimeout(p.timer); p[fn](value); } };

  return {
    enabled: true,
    /** Gets a fresh one-use token. Rejects if the check fails, is blocked or takes too long. */
    async token() {
      await load();
      if (widget === null) {
        widget = win.turnstile.render(container, {
          sitekey: siteKey,
          execution: "execute",
          appearance: "interaction-only",
          size: "flexible",
          callback: (t) => settle("resolve", t),
          "error-callback": () => settle("reject", new Error("failed")),
          "expired-callback": () => {},
          "timeout-callback": () => settle("reject", new Error("timeout")),
        });
      } else {
        win.turnstile.reset(widget);
      }
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, timer: setTimeout(() => settle("reject", new Error("timeout")), timeoutMs) };
        win.turnstile.execute(widget);
      });
    },
  };
}
