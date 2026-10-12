// Page language. English text in the code is the key: tr("Reading the drawing…") gives the English
// back unless a language pack has a translation for exactly that text. A missing translation therefore
// shows English instead of breaking, and English needs no pack at all.
//
// Packs live in js/lang/<code>.js and export default { "English text": "Translation", ... }.

export const LANGUAGES = [
  ["en", "English"], ["fr", "Français"], ["es", "Español"], ["de", "Deutsch"], ["it", "Italiano"], ["nl", "Nederlands"],
  ["pt", "Português"], ["da", "Dansk"], ["sv", "Svenska"], ["no", "Norsk"], ["fi", "Suomi"], ["pl", "Polski"], ["cs", "Čeština"],
];
const CODES = new Set(LANGUAGES.map(([c]) => c));
const KEY = "plandot.lang";

let pack = {};
let current = "en";

export const currentLanguage = () => current;

/** The English text, translated if this language has it. {name} placeholders are filled from vars. */
export function tr(en, vars) {
  let s = Object.prototype.hasOwnProperty.call(pack, en) ? pack[en] : en;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])));
  return s;
}

/** The saved choice, else the browser's language if we have it, else English. */
export function initialLanguage() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && CODES.has(saved)) return saved;
  } catch { /* storage blocked */ }
  for (const l of navigator.languages || [navigator.language || "en"]) {
    let c = String(l).toLowerCase().split("-")[0];
    if (c === "nb" || c === "nn") c = "no";
    if (CODES.has(c)) return c;
  }
  return "en";
}

export async function setLanguage(code, { remember = true } = {}) {
  if (!CODES.has(code)) code = "en";
  pack = code === "en" ? {} : (await import(`./lang/${code}.js`)).default;
  current = code;
  document.documentElement.lang = code;
  if (remember) { try { localStorage.setItem(KEY, code); } catch { /* ignore */ } }
  translateDom();
}

/** Re-translate everything marked in the page's HTML. The English text is remembered on first sight. */
export function translateDom(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.dataset.en ??= el.textContent.trim();
    el.textContent = tr(el.dataset.en);
  }
  for (const [attr, prop] of [["i18nPh", "placeholder"], ["i18nAria", "aria-label"], ["i18nTitle", "title"], ["i18nContent", "content"]]) {
    const dash = attr.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    for (const el of root.querySelectorAll(`[data-${dash}]`)) {
      const stash = `${attr}En`;
      el.dataset[stash] ??= el.getAttribute(prop) || "";
      el.setAttribute(prop, tr(el.dataset[stash]));
    }
  }
}
