// Help pages (How to guide, FAQ): the footer in the visitor's language, and a note if these pages aren't.
import { initSite, initLanguageMenu } from "./site.js";
import { currentLanguage, tr } from "./i18n.js";
import { FEEDBACK, feedbackHref } from "./config.js";
await initSite();
await initLanguageMenu({ onChange: () => location.reload() }); // the pages are written in the chosen language, so load them again
// The how to guide has a translation for each app language (js/lang/howto/<code>.js): one entry for each
// data-h / data-ha / data-hl number in the page, with the last entry holding the note about the screenshots.
async function translateGuide() {
  const lang = currentLanguage();
  if (lang === "en" || !document.querySelector("[data-h]")) return null;
  let pack;
  const folder = document.body.dataset.guide === "faq" ? "faq" : "howto";
  try { pack = (await import(`./lang/${folder}/${lang}.js`)).default; } catch { return null; }
  for (const [attr, set] of [["h", (el, v) => { el.dataset.hEn ??= el.innerHTML; el.innerHTML = v; }], ["ha", (el, v) => el.setAttribute("alt", v)], ["hl", (el, v) => el.setAttribute("aria-label", v)]]) {
    for (const el of document.querySelectorAll(`[data-${attr}]`)) { const v = pack[Number(el.dataset[attr])]; if (typeof v === "string") set(el, v); }
  }
  document.title = `${pack[0]} · Plandot`;
  return pack[pack.length - 1] ?? "";
}
const guideNote = await translateGuide();
const note = document.getElementById("lang-note");
if (note) {
  if (guideNote === "") note.hidden = true;
  else if (guideNote) { note.hidden = false; note.textContent = guideNote; }
  else {
    note.hidden = currentLanguage() === "en";
    note.textContent = tr("This page is in English for now. The app itself is available in 13 languages.");
  }
}
// A "Back to top" link at the end of each card, and on the guide a button that opens the app with the sample loaded.
for (const card of document.querySelectorAll("main .card, .doc > .card")) {
  const a = Object.assign(document.createElement("a"), { href: "#", textContent: `↑ ${tr("Back to top")}` });
  a.addEventListener("click", (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); });
  const p = document.createElement("p"); p.className = "card-top"; p.append(a); card.append(p);
}
const sampleSlot = document.getElementById("try-sample-slot");
if (sampleSlot) sampleSlot.replaceWith(Object.assign(document.createElement("a"), { className: "btn primary try-sample", href: "index.html?sample=1", textContent: tr("Try with a sample drawing") }));
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
