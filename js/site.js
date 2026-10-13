// Parts shared by the app and the help pages: the footer, the (i) pop-ups and the language menu.
import { tr, LANGUAGES, currentLanguage, setLanguage, initialLanguage, translateDom } from "./i18n.js";
import { FLAGS } from "./flags.js";
import { startAnalytics } from "./analytics.js";
import { FEEDBACK, feedbackHref } from "./config.js";

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}

// ---------------------------------------------------------------- (i) pop-ups
let infoCount = 0;
let openSlot = null;

/** An empty slot that hydrateInfo() turns into an (i) button. Put it right after the label it explains. */
export const infoSlot = (text) => h("span", { class: "info-slot", "data-info": text });

function closeInfo(returnFocus = false) {
  if (!openSlot) return;
  const btn = openSlot.querySelector(".info-btn");
  const pop = openSlot.querySelector(".info-pop");
  if (pop) pop.hidden = true;
  if (btn) { btn.setAttribute("aria-expanded", "false"); if (returnFocus) btn.focus(); }
  openSlot = null;
}

function placePop(btn, pop) {
  const r = btn.getBoundingClientRect();
  const w = Math.min(280, window.innerWidth - 16);
  pop.style.width = `${w}px`;
  const left = Math.max(8, Math.min(r.left - 10, window.innerWidth - w - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${r.bottom + 8}px`;
  const ph = pop.offsetHeight;
  if (r.bottom + 8 + ph > window.innerHeight - 8 && r.top - 8 - ph > 8) pop.style.top = `${r.top - 8 - ph}px`;
  pop.style.setProperty("--arrow", `${Math.max(12, Math.min(w - 12, r.left + r.width / 2 - left))}px`);
}

/** Build the (i) buttons for every slot under root. Safe to call again after a language change. */
export function hydrateInfo(root = document) {
  closeInfo();
  for (const slot of root.querySelectorAll(".info-slot")) {
    const text = tr(slot.dataset.info);
    const name = (slot.previousElementSibling?.textContent || "").trim();
    const id = slot.dataset.popId ||= `info-${++infoCount}`;
    const btn = h("button", { type: "button", class: "info-btn", "aria-expanded": "false", "aria-controls": id, "aria-label": name ? tr("About {name}", { name }) : tr("More information"), text: "i" });
    const pop = h("span", { class: "info-pop", id, role: "note", hidden: true, text });
    slot.replaceChildren(btn, pop);
    btn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const wasOpen = openSlot === slot;
      closeInfo();
      if (wasOpen) return;
      pop.hidden = false; btn.setAttribute("aria-expanded", "true"); openSlot = slot;
      placePop(btn, pop);
    });
  }
}
document.addEventListener("click", (e) => { if (openSlot && !openSlot.contains(e.target)) closeInfo(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openSlot) { e.stopPropagation(); closeInfo(true); } }, true);
document.addEventListener("focusin", (e) => { if (openSlot && !openSlot.contains(e.target)) closeInfo(); });
// If the page scrolls or resizes while a pop-up is open, keep it next to its button (or close it if the button is gone).
function keepPlaced() {
  if (!openSlot) return;
  const btn = openSlot.querySelector(".info-btn"), pop = openSlot.querySelector(".info-pop");
  const r = btn.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight || r.width === 0) closeInfo(); else placePop(btn, pop);
}
window.addEventListener("resize", keepPlaced);
window.addEventListener("scroll", keepPlaced, true);

// ---------------------------------------------------------------- language menu with flags
const CHEVRON = '<svg class="chev" viewBox="0 0 12 8" width="12" height="8" aria-hidden="true"><path d="M1.5 1.5 6 6l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Turns #lang-btn and #lang-list into a menu of flags and language names. onChange runs after the page language changed. */
export async function initLanguageMenu({ onChange } = {}) {
  const btn = document.getElementById("lang-btn");
  const list = document.getElementById("lang-list");
  if (!btn || !list) return;
  let active = 0;
  const items = LANGUAGES.map(([code, name], i) => {
    const li = h("li", { role: "option", id: `lang-${code}`, "data-lang": code, "aria-selected": "false" });
    li.innerHTML = `${FLAGS[code] || ""}<span>${name}</span>`;
    li.addEventListener("click", () => choose(code));
    li.addEventListener("pointermove", () => setActive(i, false));
    return li;
  });
  list.replaceChildren(...items);

  const nameOf = (code) => LANGUAGES.find(([c]) => c === code)?.[1] || code;
  function paint() {
    const code = currentLanguage();
    btn.innerHTML = `${FLAGS[code] || ""}<span class="lang-name">${nameOf(code)}</span>${CHEVRON}`;
    btn.setAttribute("aria-label", `${tr("Language")}: ${nameOf(code)}`);
    list.setAttribute("aria-label", tr("Language"));
    items.forEach((li) => li.setAttribute("aria-selected", String(li.dataset.lang === code)));
  }
  function setActive(i, scroll = true) {
    active = (i + items.length) % items.length;
    items.forEach((li, k) => li.classList.toggle("active", k === active));
    list.setAttribute("aria-activedescendant", items[active].id);
    if (scroll) items[active].scrollIntoView({ block: "nearest" });
  }
  const isOpen = () => !list.hidden;
  function place() { // under the button, kept inside the window
    const r = btn.getBoundingClientRect();
    const w = Math.min(210, window.innerWidth - 16);
    list.style.width = `${w}px`;
    list.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    list.style.top = `${r.bottom + 8}px`;
    list.style.maxHeight = `${Math.max(160, Math.min(520, window.innerHeight - r.bottom - 20))}px`;
  }
  function open() {
    list.hidden = false; btn.setAttribute("aria-expanded", "true");
    place();
    setActive(Math.max(0, LANGUAGES.findIndex(([c]) => c === currentLanguage())));
    list.focus({ preventScroll: true });
  }
  function close(returnFocus = true) {
    if (!isOpen()) return;
    list.hidden = true; btn.setAttribute("aria-expanded", "false");
    if (returnFocus) btn.focus();
  }
  async function choose(code) {
    close();
    if (code !== currentLanguage()) {
      await setLanguage(code);
      paint();
      hydrateInfo();
      renderNav();
      renderFooter();
      await onChange?.(code);
    }
  }
  window.addEventListener("resize", () => { if (isOpen()) place(); });
  window.addEventListener("scroll", () => { if (isOpen()) place(); }, true);
  btn.addEventListener("click", () => (isOpen() ? close() : open()));
  btn.addEventListener("keydown", (e) => { if (["ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); open(); } });
  let typed = "", typedAt = 0;
  list.addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (k === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (k === "Home") { e.preventDefault(); setActive(0); }
    else if (k === "End") { e.preventDefault(); setActive(items.length - 1); }
    else if (k === "Enter" || k === " ") { e.preventDefault(); choose(items[active].dataset.lang); }
    else if (k === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (k === "Tab") close(false);
    else if (k.length === 1 && /\S/.test(k)) { // type the first letters of a language to jump to it
      typed = Date.now() - typedAt > 700 ? k.toLowerCase() : typed + k.toLowerCase(); typedAt = Date.now();
      const hit = LANGUAGES.findIndex(([, n]) => n.toLowerCase().startsWith(typed));
      if (hit >= 0) setActive(hit);
    }
  });
  document.addEventListener("click", (e) => { if (isOpen() && !btn.contains(e.target) && !list.contains(e.target)) close(false); });
  document.addEventListener("focusin", (e) => { if (isOpen() && !btn.contains(e.target) && !list.contains(e.target)) close(false); });

  await setLanguage(initialLanguage(), { remember: false });
  paint();
}

// ---------------------------------------------------------------- top menu and footer
/** The menu bar at the top of every page. */
let tourHandler = null;
/** The app registers what "Take the tour" does; help pages have no tour, so they show no link. */
export function setTourHandler(fn) { tourHandler = fn; renderNav(); }

const HOME_ICON = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M3 9.5 10 3l7 6.5M5 8.5V16h10V8.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** The "Home" button on help pages: an icon and a word, as a clear pill. */
function homeLink() {
  const a = h("a", { href: "index.html", class: "nav-app" });
  a.innerHTML = `${HOME_ICON}<span></span>`;
  a.lastChild.textContent = tr("Home");
  return a;
}

export function renderNav() {
  const nav = document.getElementById("topnav");
  if (!nav) return;
  const here = location.pathname.split("/").pop() || "index.html";
  const onApp = here === "" || here === "index.html";
  const href = feedbackHref();
  const link = (to, text, extra = {}) => h("a", { href: to, text, ...(here === to ? { "aria-current": "page" } : {}), ...extra });
  nav.setAttribute("aria-label", tr("More about Plandot"));
  nav.querySelectorAll(":scope > a").forEach((a) => a.remove()); // the language menu stays
  nav.prepend(
    ...(onApp ? [] : [homeLink()]),
    ...(onApp && tourHandler ? [h("a", { href: "#", class: "tour-link", text: tr("Take the tour"), onclick: (e) => { e.preventDefault(); tourHandler(); } })] : []),
    link("howto.html", tr("How to guide")),
    link("faq.html", tr("FAQ")),
    ...(href ? [h("a", { href, class: "feedback-link", ...(FEEDBACK.url ? { target: "_blank", rel: "noopener" } : {}), text: tr("Send feedback") })] : []));
}

export function renderFooter() {
  const foot = document.getElementById("sitefoot");
  if (!foot) return;
  foot.replaceChildren(
    h("p", { text: tr("Plandot is an independent tool, not made or endorsed by Fieldwire by Hilti.") }),
    h("p", { text: tr("Your drawings stay in your browser and are never uploaded.") }),
    h("p", { class: "copy", text: tr("© 2026 Plandot. All rights reserved.") }));
}

/** Pages other than the app call this: it applies the saved language and draws the menu and footer. */
export async function initSite() {
  startAnalytics();
  await setLanguage(initialLanguage(), { remember: false });
  translateDom();
  hydrateInfo();
  renderNav();
  renderFooter();
}
