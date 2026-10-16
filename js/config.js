// Settings you may want to change without touching the rest of the code.

export const VERSION = "1.0.0";

// Where "Send feedback" goes. Use ONE of these:
//   url:   a form link (for example a Google Form). It opens in a new tab.
//   email: a shared address such as feedback@yourdomain. It opens the visitor's email app.
// Leave both empty and the feedback link is simply not shown.
export const FEEDBACK = { url: "https://forms.gle/HQUfuJ3h1k2ztf1z9", email: "" };

// Sign-in. Leave both empty and Plandot works without accounts. To switch sign-in on, paste the two values from
// Supabase (Project Settings, then API): the project address and the PUBLIC key (called "publishable" or "anon").
// Both are meant to be seen by every visitor. NEVER paste the "secret" or "service_role" key here: the page refuses it.
export const ACCOUNTS = { url: "https://bugqhjkkjybcbnfjpeke.supabase.co", key: "sb_publishable_HIk_jS2X3763e5ztVhRnCA_NNnxVvLf" };

/** The address behind "Send feedback", or "" when none is set. */
export function feedbackHref(cfg = FEEDBACK, version = VERSION, env = (typeof navigator !== "undefined" ? navigator.userAgent : "")) {
  if (cfg.url) return cfg.url;
  if (!cfg.email) return "";
  const body = `What happened, or what would help?\n\n\n\n---\nPlandot ${version}\n${env}`;
  return `mailto:${cfg.email}?subject=${encodeURIComponent(`Plandot feedback (${version})`)}&body=${encodeURIComponent(body)}`;
}
