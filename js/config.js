// Settings you may want to change without touching the rest of the code.

export const VERSION = "0.5.0";

// Where "Send feedback" goes. Use ONE of these:
//   url:   a form link (for example a Google Form). It opens in a new tab.
//   email: a shared address such as feedback@yourdomain. It opens the visitor's email app.
// Leave both empty and the feedback link is simply not shown.
export const FEEDBACK = { url: "", email: "" };

// Shown under "What's new" in the footer, newest first. Plain English.
export const WHATS_NEW = [
  {
    version: "0.5.0",
    items: [
      "Everything now says \"pin\" instead of \"task\".",
      "A small (i) next to the main fields explains what each one does.",
      "Flags next to the language names.",
      "How to use and FAQ pages, a feedback link and a footer.",
      "A progress bar while symbols are being searched for, and a Copy details button on error messages.",
    ],
  },
  {
    version: "0.4.0",
    items: [
      "New look, zoom and pan, undo and redo, Save and Open setup, export preview, a sample drawing, and symbols drawn at different sizes.",
    ],
  },
];

/** The address behind "Send feedback", or "" when none is set. */
export function feedbackHref(cfg = FEEDBACK, version = VERSION, env = (typeof navigator !== "undefined" ? navigator.userAgent : "")) {
  if (cfg.url) return cfg.url;
  if (!cfg.email) return "";
  const body = `What happened, or what would help?\n\n\n\n---\nPlandot ${version}\n${env}`;
  return `mailto:${cfg.email}?subject=${encodeURIComponent(`Plandot feedback (${version})`)}&body=${encodeURIComponent(body)}`;
}
