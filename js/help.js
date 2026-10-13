// Help pages (How to guide, FAQ): the footer in the visitor's language, and a note if these pages aren't.
import { initSite } from "./site.js";
import { currentLanguage, tr } from "./i18n.js";
import { FEEDBACK, feedbackHref } from "./config.js";
await initSite();
const note = document.getElementById("lang-note");
if (note) {
  note.hidden = currentLanguage() === "en";
  note.textContent = tr("This page is in English for now. The app itself is available in 13 languages.");
}
// The feedback link in the FAQ follows the setting in js/config.js (a form, or an email, or nothing).
const fb = document.getElementById("faq-feedback");
if (fb) {
  const href = feedbackHref();
  if (href) { fb.href = href; if (FEEDBACK.url) { fb.target = "_blank"; fb.rel = "noopener"; } else { fb.removeAttribute("target"); fb.removeAttribute("rel"); } }
  else fb.replaceWith(document.createTextNode("feedback form"));
}

// The short clips play quietly while they are on screen, and stay still for anyone who prefers less motion.
const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const watcher = "IntersectionObserver" in globalThis ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    const v = e.target;
    if (e.isIntersecting && !v.dataset.userPaused && !reduce) v.play().catch(() => {});
    else if (!e.isIntersecting) v.pause();
  }
}, { threshold: 0.6 }) : null;
for (const v of document.querySelectorAll("video.clip-video")) {
  v.removeAttribute("controls");
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "clip-btn";
  const label = () => { btn.textContent = v.paused ? "Play" : "Pause"; btn.setAttribute("aria-label", `${v.paused ? "Play" : "Pause"} clip`); };
  btn.addEventListener("click", () => {
    if (v.paused) { delete v.dataset.userPaused; v.play().catch(() => {}); } else { v.dataset.userPaused = "1"; v.pause(); }
  });
  v.addEventListener("play", label); v.addEventListener("pause", label);
  v.parentElement.append(btn); label();
  watcher?.observe(v);
}
