// Help pages (How to use, FAQ): the footer in the visitor's language, and a note if these pages aren't.
import { initSite } from "./site.js";
import { currentLanguage, tr } from "./i18n.js";
await initSite();
const note = document.getElementById("lang-note");
if (note) {
  note.hidden = currentLanguage() === "en";
  note.textContent = tr("This page is in English for now. The app itself is available in 13 languages.");
}
