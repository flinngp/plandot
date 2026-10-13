// A short, skippable tour of the four steps. Shown once to a new visitor; "Take the tour" in the menu brings it back.
import { tr } from "./i18n.js";

const KEY = "plandot-tour-done";
const STEPS = [
  { target: "#step-drawing", title: "Start with your drawing", body: "Choose the PDF exported from your design software. Nothing leaves your computer." },
  { target: "#step-template", title: "Add your import template", body: "Download the import template from your Fieldwire project, then choose it here and type the plan name exactly as it appears in the project." },
  { target: "#step-rules", title: "Tell Plandot what to pin", body: "Each rule turns every callout or symbol it finds into a pin. Type the text to find, or draw a box round a symbol." },
  { target: "#step-export", title: "Copy or download the pins", body: "Press Copy rows and paste into Fieldwire's task importer, up to 500 pins at a time. Or download the import file." },
];

export const tourSeen = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };
const remember = (on) => { try { if (on) localStorage.setItem(KEY, "1"); else localStorage.removeItem(KEY); } catch { /* private window */ } };

let active = null;

export function closeTour() { active?.close(); }

export function startTour({ force = false } = {}) {
  if (active) return;
  if (!force && tourSeen()) return;
  const narrow = () => matchMedia("(max-width: 1000px)").matches;
  let i = 0;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const ring = el("div", "tour-ring");
  const card = el("div", "tour-card");
  card.setAttribute("role", "dialog"); card.setAttribute("aria-label", tr("Quick tour"));
  const x = el("button", "tour-x", "×"); x.type = "button"; x.setAttribute("aria-label", tr("Close tour"));
  const kicker = el("div", "tour-k"), title = el("h3"), body = el("p");
  const dots = el("div", "tour-dots"); STEPS.forEach(() => dots.append(el("i")));
  const back = el("button", "tour-skip", tr("Back")); back.type = "button";
  const skip = el("button", "tour-skip", tr("Skip tour")); skip.type = "button";
  const next = el("button", "btn primary tour-next"); next.type = "button";
  const foot = el("div", "tour-foot"); foot.append(dots, back, skip, next);
  const never = el("label", "tour-never"); const tick = el("input"); tick.type = "checkbox"; tick.checked = true;
  never.append(tick, el("span", "", tr("Don't show this again")));
  card.append(x, kicker, title, body, foot, never);

  const place = () => {
    const t = document.querySelector(STEPS[i].target);
    if (!t) return;
    const r = t.getBoundingClientRect();
    if (narrow()) {
      ring.hidden = true;
      card.classList.add("tour-bottom"); card.style.left = card.style.top = "";
      return;
    }
    ring.hidden = false; card.classList.remove("tour-bottom");
    Object.assign(ring.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
    const w = card.offsetWidth, hgt = card.offsetHeight;
    const left = Math.min(r.right + 24, innerWidth - w - 12);
    card.style.left = `${Math.max(12, left)}px`;
    card.style.top = `${Math.max(12, Math.min(r.top + 8, innerHeight - hgt - 12))}px`;
  };
  const show = () => {
    const s = STEPS[i];
    kicker.textContent = tr("Quick tour · {n} of {total}", { n: i + 1, total: STEPS.length });
    title.textContent = tr(s.title); body.textContent = tr(s.body);
    [...dots.children].forEach((d, k) => d.classList.toggle("on", k === i));
    back.hidden = i === 0;
    next.textContent = i === STEPS.length - 1 ? tr("Done") : tr("Next");
    const t = document.querySelector(s.target);
    t?.scrollIntoView({ block: narrow() ? "start" : "nearest", behavior: "auto" });
    place();
    next.focus({ preventScroll: true });
  };
  const close = () => {
    remember(tick.checked);
    removeEventListener("resize", place); removeEventListener("keydown", key, true);
    ring.remove(); card.remove(); active = null;
  };
  const key = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  x.addEventListener("click", close); skip.addEventListener("click", close);
  back.addEventListener("click", () => { i = Math.max(0, i - 1); show(); });
  next.addEventListener("click", () => { if (i === STEPS.length - 1) close(); else { i += 1; show(); } });
  addEventListener("resize", place); addEventListener("keydown", key, true);
  document.body.append(ring, card);
  active = { close };
  show();
}
