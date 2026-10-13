// Plandot: drawing PDF + rules + import template -> task import workbook.
// Everything happens in the browser. Nothing is uploaded.
import { detect, newRule, round2, batchRanges, IMPORT_LIMIT, pinMode, ruleKind, renderTemplate } from "./core.js";
import { openPdf, readPage, readShapes, readGeometry, anchorFinder, renderRegion, renderFull, MAX_SIDE } from "./pdfsource.js";
import { captureSymbol, findSymbolsAsync, sanitizeTemplate } from "./symbols.js";
import { readTemplate, writeImport, buildRows, buildCalibrationRows, extraColumns, orphanedColumns, applyMapping, TemplateError } from "./template.js";
import { startTour } from "./tour.js";
import { rowsToTsv, copyText } from "./batches.js";
import { markedUpPdf, pinsPng, download } from "./markup.js";
import { tr, translateDom, currentLanguage } from "./i18n.js";
import { startAnalytics, track, pinBucket } from "./analytics.js";
import { VERSION } from "./config.js";
import { hydrateInfo, infoSlot, initLanguageMenu, renderFooter, setTourHandler } from "./site.js";

const COLORS = ["#3355ff", "#e08a00", "#1f9d6b", "#8a4fff", "#0fa3b8", "#d6336c", "#7a8a14", "#5b6b7a"];
const colorOf = (i) => COLORS[i % COLORS.length];
const STANDARD = new Set(["id", "title", "priority", "category", "assignee", "start date", "end date", "plan", "x pos (%)", "y pos (%)", "tier 1", "tier 2", "tier 3", "tier 4", "tier 5", "manpower", "cost", "description / hashtags", "related task name", "checklist", "existing file"]);
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const STORE_KEY = "plantasks.v1";
const SVG_NS = "http://www.w3.org/2000/svg";

const $ = (sel) => document.querySelector(sel);
const DEFAULT_PDF_INFO = $("#pdf-info").textContent; // English; shown through tr()
const DEFAULT_TPL_INFO = $("#tpl-info").textContent;
const state = {
  pdf: null, // {name, bytes, doc, pageNo, page, width, height, tokens}
  tpl: null, // {name, parsed}
  rules: [],
  settings: { planName: "", roomPattern: "", roomDistance: 10, area: null, showGrid: false },
  edits: {}, // pin key -> {include?, title?}
  pins: [],
  errors: {},
  areaMode: false,
  boxFor: null, // id of the symbol rule whose box is being drawn
  boxDraft: null,
  animate: false,
  busy: false, // reading the drawing's lines
  zoom: 1, // 1 = the whole sheet fits the window
};
window.planTasks = { state }; // handy when poking around in the console

const hasText = (v) => typeof v === "string" && v.trim() !== "";
const baseName = (n) => n.replace(/\.[^.]+$/, "");
const fmtIn = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const svg = (tag, attrs = {}) => { const e = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}

// ---------------------------------------------------------------- persistence
function save() {
  recordSoon();
  try {
    const { planName, roomPattern, roomDistance, showGrid } = state.settings;
    localStorage.setItem(STORE_KEY, JSON.stringify({ rules: state.rules, settings: { planName, roomPattern, roomDistance, showGrid } }));
  } catch { /* private mode or blocked storage: the app still works, it just won't remember */ }
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved?.rules?.length) state.rules = saved.rules.map((r) => (r.kind === "symbol" ? { ...r, symbol: sanitizeTemplate(r.symbol) } : r));
    if (saved?.settings) Object.assign(state.settings, saved.settings);
  } catch { /* ignore */ }
  if (!state.rules.length) state.rules = [newRule(1)];
}
const saveSoon = debounce(save, 300);

// ---------------------------------------------------------------- undo and redo (rules only)
const symbolIds = new WeakMap();
let symbolCount = 0;
const symId = (sym) => { if (!symbolIds.has(sym)) symbolIds.set(sym, ++symbolCount); return symbolIds.get(sym); };
const snapshot = () => state.rules.map((r) => ({ ...r, columns: { ...(r.columns || {}) } })); // symbols are never edited in place, so they can be shared
const snapKey = (snap) => JSON.stringify(snap.map((r) => ({ ...r, symbol: r.symbol ? symId(r.symbol) : null })));
const history = { past: [], future: [], last: null, key: "" };
function resetHistory() {
  history.past = []; history.future = [];
  history.last = snapshot(); history.key = snapKey(history.last);
  updateUndoButtons();
}
/** Called after every change to the rules; typing in a box counts as one step. */
function recordNow() {
  const snap = snapshot(), key = snapKey(snap);
  if (key === history.key) return;
  history.past.push(history.last);
  if (history.past.length > 60) history.past.shift();
  history.future = [];
  history.last = snap; history.key = key;
  updateUndoButtons();
}
const recordSoon = debounce(recordNow, 500);
function applySnapshot(snap) {
  state.rules = snap.map((r) => ({ ...r, columns: { ...(r.columns || {}) } }));
  history.last = snapshot(); history.key = snapKey(history.last);
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ rules: state.rules, settings: { planName: state.settings.planName, roomPattern: state.settings.roomPattern, roomDistance: state.settings.roomDistance, showGrid: state.settings.showGrid } })); } catch { /* ignore */ }
  cancelSymbolBox(true);
  renderRules(); renderTemplateInfo(); runDetect(); updateUndoButtons();
}
function undo() {
  recordNow(); // fold in anything typed in the last half second
  if (!history.past.length) return;
  history.future.push(history.last);
  applySnapshot(history.past.pop());
  say(tr("Undone."), "ok");
}
function redo() {
  if (!history.future.length) return;
  history.past.push(history.last);
  applySnapshot(history.future.pop());
  say(tr("Redone."), "ok");
}
function updateUndoButtons() {
  $("#undo").disabled = !history.past.length && history.key === snapKey(snapshot());
  $("#redo").disabled = !history.future.length;
}

// ---------------------------------------------------------------- status line
function say(msg, kind = "", detail = "") {
  const s = $("#status");
  s.textContent = msg;
  s.className = `status ${kind}`;
  if (kind === "err" && msg) {
    const text = errorReport(msg, detail);
    const btn = h("button", { type: "button", class: "btn link copy-details", text: tr("Copy details") });
    btn.addEventListener("click", async () => {
      let ok = true;
      try { await navigator.clipboard.writeText(text); } catch { ok = false; }
      if (!ok) { // clipboard blocked: select the text instead so it can be copied by hand
        const ta = h("textarea", { class: "details-box", readonly: true, "aria-label": tr("Error details") }, text);
        btn.replaceWith(ta); ta.focus(); ta.select();
        return;
      }
      btn.textContent = tr("Copied");
      setTimeout(() => { btn.textContent = tr("Copy details"); }, 2000);
    });
    s.append(" ", btn);
  }
}

/** A short, privacy-safe report to paste into an email: no file names and no drawing content. */
function errorReport(msg, detail) {
  const pdf = state.pdf;
  return [
    `Plandot ${VERSION}`,
    `When: ${new Date().toISOString()}`,
    `Browser: ${navigator.userAgent}`,
    `Language: ${currentLanguage()}`,
    pdf ? `Drawing: page ${pdf.pageNo} of ${pdf.doc?.numPages ?? "?"}, ${Math.round(pdf.width || 0)} x ${Math.round(pdf.height || 0)} points` : "Drawing: none loaded",
    `Template: ${state.tpl?.parsed ? "loaded" : "none"}`,
    `Rules: ${state.rules.length}, pins: ${state.pins.length}`,
    `Message: ${msg}`,
    detail ? `Detail: ${detail}` : "",
  ].filter(Boolean).join("\n");
}

/** The first few lines of an error's stack, for the Copy details text. */
const whyText = (err) => (err?.stack ? String(err.stack).split("\n").slice(0, 4).map((l) => l.trim()).join(" | ") : err?.name || "");

// A bar over the drawing for slow work. It only appears if the work takes more than a moment.
const busy = (() => {
  let timer = null, shown = false;
  const el = () => $("#busybar");
  const paint = (label, frac) => {
    const bar = el();
    bar.hidden = false; shown = true;
    bar.querySelector(".busy-label").textContent = label;
    const track = bar.querySelector(".busy-track");
    const fill = bar.querySelector(".busy-fill");
    if (frac == null) { bar.classList.add("indeterminate"); track.removeAttribute("aria-valuenow"); fill.style.width = ""; }
    else { bar.classList.remove("indeterminate"); const pct = Math.max(2, Math.min(100, Math.round(frac * 100))); track.setAttribute("aria-valuenow", String(pct)); fill.style.width = `${pct}%`; }
  };
  return {
    start(label) { clearTimeout(timer); timer = setTimeout(() => paint(label, null), 400); },
    update(label, frac) { if (shown || timer) { clearTimeout(timer); timer = null; paint(label, frac); } },
    stop() { clearTimeout(timer); timer = null; shown = false; el().hidden = true; },
  };
})();

// ---------------------------------------------------------------- file loading
let keyboardActivated = false;
let loadRun = 0; // bumped by every new drawing and by Start over, so a slow read can tell it was overtaken
async function loadPdfFile(file) {
  const mine = ++loadRun;
  say(tr("Reading the drawing…"));
  let bytes, doc;
  try {
    bytes = await file.arrayBuffer();
    doc = await openPdf(bytes);
  } catch (err) {
    if (mine === loadRun) say(err?.name === "PasswordException" ? tr("This PDF is password protected. Save a copy without the password and try again.") : tr("That file couldn't be read as a PDF."), "err", whyText(err));
    return;
  }
  if (mine !== loadRun) { try { doc.destroy?.(); } catch { /* ignore */ } return; }
  state.pdf = { name: file.name, bytes, doc, pageNo: 1 };
  const select = $("#page-select");
  select.replaceChildren(...Array.from({ length: doc.numPages }, (_, i) => h("option", { value: i + 1, text: tr("Page {n}", { n: i + 1 }) })));
  $("#page-field").hidden = doc.numPages < 2;
  await loadPage(1, mine);
  if (mine === loadRun) say("");
}

async function loadPage(n, mine = loadRun) {
  const info = await readPage(state.pdf.doc, n);
  if (mine !== loadRun || !state.pdf) return;
  Object.assign(state.pdf, { pageNo: n, page: info.page, viewport: info.viewport, width: info.width, height: info.height, tokens: info.tokens, geoPromise: null, anchorFor: null, geoFailed: false, shapesPromise: null, shapes: null, symbolCache: new WeakMap() });
  state.edits = {};
  state.pins = [];
  state.settings.area = null;
  state.areaMode = false;
  state.boxFor = null;
  state.boxDraft = null;
  state.zoom = 1;
  $("#stage").classList.remove("drawing");
  showSheet(true);
  $("#draw-area").disabled = false;
  renderPdfInfo();
  await drawSheet();
  state.animate = true;
  await runDetect();
}
function renderPdfInfo() {
  const el = $("#pdf-info");
  if (!state.pdf?.tokens) { el.textContent = tr(DEFAULT_PDF_INFO); el.hidden = false; $("#pdf-alert").hidden = true; return; }
  const words = state.pdf.tokens.length;
  el.textContent = tr("{name} · {n} words of text found on this page.", { name: file(state.pdf.name), n: words.toLocaleString() });
  el.hidden = !words;
  $("#pdf-alert").hidden = words > 0;
}
function renderTplInfo() {
  const el = $("#tpl-info");
  if (state.tplError) el.textContent = tr(state.tplError);
  else if (state.tpl) el.textContent = `${file(state.tpl.name)}${state.tpl.parsed.projectName ? ` · ${state.tpl.parsed.projectName}` : ""}`;
  else el.textContent = tr(DEFAULT_TPL_INFO);
}
const file = (n) => (n.length > 38 ? `${n.slice(0, 35)}…` : n);

async function loadTemplateFile(f) {
  try {
    const parsed = await readTemplate(await f.arrayBuffer());
    state.tpl = { name: f.name, parsed };
    state.tplError = null;
    if (!hasText(state.settings.planName)) { /* leave blank: the user has to confirm the exact plan name */ }
    say("");
  } catch (err) {
    state.tpl = null;
    state.tplError = err instanceof TemplateError ? err.message : "That file couldn't be read as a template.";
    say(tr(state.tplError), "err");
  }
  renderTplInfo();
  renderTemplateInfo();
  renderRules();
  runDetect();
}

// ---------------------------------------------------------------- template chips
function renderTemplateInfo() {
  const box = $("#tpl-chips");
  box.replaceChildren();
  const t = state.tpl?.parsed;
  if (!t) return;
  const custom = [];
  for (const c of t.columns) {
    const isCustom = !STANDARD.has(c.header.trim().toLowerCase().replace(/\s+/g, " "));
    if (isCustom) custom.push(c.header);
    const cls = c.role ? "chip auto" : isCustom ? "chip custom" : "chip";
    box.append(h("span", { class: cls, text: c.role === "id" ? tr("ID (left blank)") : c.header, title: c.role ? tr("Filled in by Plandot") : isCustom ? tr("Custom attribute") : tr("You can set this per rule") }));
  }
  if (t.missing.length) box.append(h("p", { class: "chips-note warn", text: tr("This template has no {list} column, so pins can't be placed on a plan.", { list: t.missing.map(tr).join(` ${tr("or")} `) }) }));
  else box.append(h("p", { class: "chips-note", text: custom.length ? tr("Dark columns are filled in for you; red ones are custom attributes ({list}).", { list: custom.join(", ") }) : tr("Dark columns are filled in for you.") }));
  if (t.missing.length || t.guessed) box.append(mappingForm(t));
  if (t.prefilledRows) box.append(h("p", { class: "chips-note", text: t.prefilledRows === 1 ? tr("This template has 1 pre-filled row (existing IDs). They are left out of the import file so existing pins are never touched.") : tr("This template has {n} pre-filled rows (existing IDs). They are left out of the import file so existing pins are never touched.", { n: t.prefilledRows }) }));
  const orphans = orphanedColumns(state.rules, t);
  if (orphans.length) box.append(h("p", { class: "chips-note warn", text: tr("Rules have values for columns this template doesn't have, so they are ignored: {list}.", { list: orphans.join(", ") }) }));
}

/** For a template whose headings Plandot doesn't recognise: pick which column is which. */
function mappingForm(t) {
  const roles = [["id", "ID (left blank)"], ["title", "Title"], ["plan", "Plan"], ["x", "X Pos (%)"], ["y", "Y Pos (%)"]];
  const selects = roles.map(([role, label]) => {
    const sel = h("select", { "data-role": role, id: `map-${role}`, "aria-label": tr(label) },
      h("option", { value: "", text: tr("(none)") }),
      ...t.columns.map((c) => h("option", { value: c.letters, text: c.header })));
    sel.value = t.columns.find((c) => c.role === role)?.letters || "";
    return h("label", { class: "map-row" }, h("span", { text: tr(label) }), sel);
  });
  const apply = h("button", { type: "button", class: "btn quiet", text: tr("Use these columns"), onclick: () => {
    const picks = {};
    for (const sel of selects.map((l) => l.querySelector("select"))) if (sel.value) picks[sel.dataset.role] = sel.value;
    applyMapping(t, picks);
    renderTemplateInfo(); renderRules(); runDetect(); updateExport();
  } });
  return h("details", { class: "more mapping", open: true }, h("summary", { text: tr("Match the columns yourself") }),
    h("p", { class: "hint", text: tr("Plandot didn't recognise some headings in this template. Say which column is which.") }), ...selects, apply);
}

// ---------------------------------------------------------------- rules UI
/** A label with an (i) button after it. */
/** Marks an English text that is translated later, when the (i) button is built. */
const I = (s) => s;
const lab = (label, info) => h("div", { class: "lab" }, label, infoSlot(info));

function renderRules() {
  const box = $("#rules");
  box.replaceChildren();
  state.rules.forEach((rule, i) => box.append(ruleCard(rule, i)));
  hydrateInfo(box);
  updateRuleStatus();
}

function ruleCard(rule, index) {
  const cols = state.tpl?.parsed ? extraColumns(state.tpl.parsed) : [];
  const set = (patch) => { Object.assign(rule, patch); saveSoon(); if ("symbol" in patch) renderRules(); runDetect(); };
  const filled = () => Object.values(rule.columns || {}).filter(hasText).length;
  const moreSummary = h("summary", { text: tr("Other columns") });
  const refreshSummary = () => { moreSummary.textContent = filled() ? tr("Other columns ({n} set)", { n: filled() }) : tr("Other columns"); };
  const isSymbol = ruleKind(rule) === "symbol";

  const grid = h("div", { class: "more-grid" });
  if (!cols.length) grid.append(h("p", { class: "hint", text: tr("Load the import template to set category, assignee, dates and custom attributes.") }));
  for (const col of cols) {
    const isDate = /\bdate\b/i.test(col.header);
    const input = h("input", { type: "text", value: rule.columns?.[col.header] ?? "", autocomplete: "off", placeholder: isDate ? tr("2026-10-12 or 12/10/2026") : tr("Same for every pin, or use {tag} {room}") });
    input.addEventListener("input", () => { rule.columns = { ...(rule.columns || {}), [col.header]: input.value }; refreshSummary(); saveSoon(); renderTemplateInfo(); runDetect(); });
    grid.append(h("label", {}, h("span", { class: STANDARD.has(col.header.trim().toLowerCase()) ? "" : "tag", text: col.header }), input));
  }
  refreshSummary();

  const name = h("input", { type: "text", value: rule.name, "aria-label": tr("Rule name"), autocomplete: "off" });
  name.addEventListener("input", () => { set({ name: name.value }); updatePreviews(); });
  const tags = h("input", { type: "text", id: `${rule.id}-tags`, value: rule.tags, placeholder: rule.usePattern ? "A[1-3]" : "A1, A2, A3", autocomplete: "off" });
  tags.addEventListener("input", () => set({ tags: tags.value }));
  const pattern = h("input", { type: "checkbox", checked: !!rule.usePattern });
  pattern.addEventListener("change", () => { tags.placeholder = pattern.checked ? "A[1-3]" : "A1, A2, A3"; set({ usePattern: pattern.checked }); });
  const pinAt = h("select", { id: `${rule.id}-pin` },
    h("option", { value: "dot", text: tr("On the location") }),
    h("option", { value: "text", text: tr("On the callout") }));
  pinAt.value = pinMode(rule);
  pinAt.addEventListener("change", () => set({ pinAt: pinAt.value }));

  const kind = h("select", { id: `${rule.id}-kind` },
    h("option", { value: "text", text: tr("Text callout") }),
    h("option", { value: "symbol", text: tr("Draw box") }));
  kind.value = ruleKind(rule);
  kind.addEventListener("change", () => { rule.kind = kind.value; if (state.boxFor === rule.id) cancelSymbolBox(); afterRulesChange(); });

  // Pin title: type it, or click a button to drop a detail into it. A live example shows the result.
  const title = h("input", { type: "text", id: `${rule.id}-title`, value: rule.title, autocomplete: "off", "aria-describedby": `${rule.id}-becomes` });
  title.addEventListener("input", () => { set({ title: title.value }); updatePreviews(); });
  const token = (label, code, tip) => h("button", { type: "button", class: "token", text: label, title: tip, onclick: () => {
    const at = title.selectionStart ?? title.value.length, to = title.selectionEnd ?? at;
    const before = title.value.slice(0, at);
    const lead = before && !/\s$/.test(before) ? " " : "";
    title.setRangeText(`${lead}${code}`, at, to, "end");
    title.dispatchEvent(new Event("input", { bubbles: true }));
    title.focus();
  } });
  const becomes = h("p", { class: "becomes", id: `${rule.id}-becomes`, "data-preview": rule.id });
  const titleField = h("div", { class: "field" },
    lab(h("label", { for: `${rule.id}-title`, text: tr("Pin title") }), I("Names the pin. Use the buttons to add the callout text, the nearest room or a running number.")), title,
    h("div", { class: "insert", role: "group", "aria-label": tr("Add to the title") },
      h("span", { class: "lbl", text: tr("Add") }),
      isSymbol ? token(tr("Symbol name"), "{rule}", tr("The name of this rule")) : token(tr("Callout text"), "{tag}", tr("The text of the callout, for example A1")),
      token(tr("Room"), "{room}", tr("The nearest room label, for example 1-101")),
      token(tr("Room in brackets"), "{room_label}", tr("The nearest room label in brackets, for example (Room 1-101)")),
      token(tr("Number"), "{n}", tr("Counts 1, 2, 3 for each pin from this rule"))),
    becomes);

  const symbolFields = () => {
    const drawing = state.boxFor === rule.id;
    const level = h("input", { type: "range", min: 1, max: 5, step: 1, value: rule.strict ?? 3, id: `${rule.id}-strict`, "aria-label": tr("How closely a copy must match") });
    const levelText = h("span", { class: "level", text: tr(LEVELS[(rule.strict ?? 3) - 1]) });
    level.addEventListener("input", () => { levelText.textContent = tr(LEVELS[Number(level.value) - 1]); });
    level.addEventListener("change", () => set({ strict: Number(level.value) }));
    const rotate = h("input", { type: "checkbox", checked: rule.rotate !== false });
    rotate.addEventListener("change", () => set({ rotate: rotate.checked }));
    const sizes = h("input", { type: "checkbox", checked: !!rule.sizes });
    sizes.addEventListener("change", () => set({ sizes: sizes.checked }));
    return [
      h("div", { class: "field" }, h("span", { class: "label", text: tr("Symbol") }),
        rule.symbol ? symbolPreview(rule, set) : null,
        h("div", { class: "row" }, h("button", { type: "button", class: "btn quiet", text: drawing ? tr("Cancel") : rule.symbol ? tr("Draw the box again") : tr("Draw a box around the symbol"), onclick: () => startSymbolBox(rule) })),
        h("p", { class: "hint", text: rule.symbol ? tr("Click the picture to move where the pin goes. Every copy of this symbol on the sheet gets one pin.") : tr("Draw a box that fully contains one example, such as a single patio door. Lines that stick out of the box are left out.") })),
      rule.symbol ? h("div", { class: "field" }, lab(h("label", { for: `${rule.id}-strict`, text: tr("How closely a copy must match") }), I("Slide towards Loose to catch more copies, or towards Exact to avoid wrong matches.")), h("div", { class: "slider" }, level, levelText),
        h("label", { class: "check" }, rotate, tr("Also find copies that are turned or mirrored")),
        lab(h("label", { class: "check" }, sizes, tr("Also find copies drawn bigger or smaller")), I("Also finds the same symbol drawn at a different scale, from half size to double size. It makes the search slower.")),
        h("p", { class: "hint", text: tr("If some are missed, move the slider towards Loose; if wrong things are picked up, towards Exact. Searching other sizes takes longer.") })) : null,
      titleField,
    ];
  };

  const head = h("div", { class: "rule-head" }, name,
    h("button", { type: "button", class: "icon-btn", text: tr("Duplicate"), "aria-label": `${tr("Duplicate")} ${rule.name}`, onclick: () => { state.rules.splice(index + 1, 0, { ...structuredClone(rule), id: newRule().id, name: `${rule.name} ${tr("copy")}` }); afterRulesChange(); } }),
    h("button", { type: "button", class: "icon-btn", text: tr("Remove"), "aria-label": `${tr("Remove")} ${rule.name}`, onclick: () => { state.rules.splice(index, 1); if (!state.rules.length) state.rules.push(newRule(1)); afterRulesChange(); } }));

  if (isSymbol) {
    return h("div", { class: "rule", "data-id": rule.id, style: `--pin:${colorOf(index)}` },
      head,
      h("div", { class: "field" }, lab(h("label", { for: `${rule.id}-kind`, text: tr("Look for") }), I("Text callout finds words on the drawing, such as door tags. Draw box finds a symbol: draw a box around one example.")), kind),
      ...symbolFields(),
      h("details", { class: "more" }, moreSummary, grid),
      h("p", { class: "rule-status", "data-status": rule.id }));
  }

  return h("div", { class: "rule", "data-id": rule.id, style: `--pin:${colorOf(index)}` },
    head,
    h("div", { class: "pair" },
      h("div", { class: "field" }, lab(h("label", { for: `${rule.id}-kind`, text: tr("Look for") }), I("Text callout finds words on the drawing, such as door tags. Draw box finds a symbol: draw a box around one example.")), kind),
      h("div", { class: "field" }, lab(h("label", { for: `${rule.id}-tags`, text: tr("Text to find") }), I("The exact text on the drawing to match, for example a door tag. Separate several with commas.")), tags)),
    h("label", { class: "check" }, pattern, tr("Match with a pattern instead (regular expression)")),
    titleField,
    h("div", { class: "field" }, lab(h("label", { for: `${rule.id}-pin`, text: tr("Pin placed on") }), I("Where each pin sits: on the spot the leader line points to, or on the callout text itself.")), pinAt,
      h("p", { class: "hint", text: tr("A callout with no leader line keeps its pin on the callout. One with two leaders gets two pins.") })),
    h("details", { class: "more" }, moreSummary, grid),
    h("p", { class: "rule-status", "data-status": rule.id }));
}

/** The "Becomes:" line under each pin title: the first real pin from the rule, or an example. */
function updatePreviews() {
  const hasRoomPattern = hasText(state.settings.roomPattern);
  for (const rule of state.rules) {
    const el = document.querySelector(`[data-preview="${rule.id}"]`);
    if (!el) continue;
    const real = state.pins.find((p) => p.ruleId === rule.id);
    const example = { tag: "A1", room: "1-101", room_label: "(Room 1-101)", n: 1, rule: rule.name };
    const result = renderTemplate(rule.title, real ? real.vars : example) || "…";
    el.replaceChildren(real ? tr("First pin:") : tr("Example:"), " ", h("b", { text: result }));
    if (/\{room(_label)?\}/.test(rule.title || "")) {
      if (!hasRoomPattern) el.append(h("span", { class: "note", text: tr("Room stays empty until you set a room label pattern under \"Search area and room labels\".") }));
      else if (real && !real.room) el.append(h("span", { class: "note", text: tr("No room label was found near this one. Try a larger distance under \"Search area and room labels\".") }));
    }
  }
}

function afterRulesChange() {
  recordNow(); // adding, removing or changing the kind of a rule is a step of its own
  save();
  renderRules();
  renderTemplateInfo();
  runDetect();
}

function updateRuleStatus() {
  updatePreviews();
  for (const rule of state.rules) {
    const p = document.querySelector(`[data-status="${rule.id}"]`);
    if (!p) continue;
    const n = state.pins.filter((x) => x.ruleId === rule.id).length;
    p.className = "rule-status";
    p.replaceChildren();
    if (state.errors[rule.id]) { p.classList.add("err"); const e = state.errors[rule.id]; p.textContent = e.startsWith("Not a valid pattern: ") ? tr("Not a valid pattern: {err}", { err: e.slice(21) }) : tr(e); }
    else if (ruleKind(rule) === "symbol") {
      if (!rule.symbol) p.textContent = tr("Draw a box around the symbol to look for.");
      else if (!state.pdf) p.textContent = tr("Load a drawing to see matches.");
      else {
        p.append(h("span", { class: "found", text: tr("{n} found", { n }) }));
        p.append(` · ${tr("pin colour matches the sheet")}`);
        if (!n) p.append(h("span", { class: "warn", text: `. ${tr("Try a lower match setting, or box the symbol again.")}` }));
        if (state.symbolNotes?.[rule.id]) p.append(h("span", { class: "warn", text: ` ${tr(state.symbolNotes[rule.id])}` }));
      }
    }
    else if (!hasText(rule.tags)) p.textContent = tr("Add the text to look for.");
    else if (!state.pdf) p.textContent = tr("Load a drawing to see matches.");
    else if (!state.pdf.tokens?.length) p.textContent = tr("This page has no selectable text.");
    else if (!n) p.textContent = tr("No callouts found with that text.");
    else {
      const mine = state.pins.filter((x) => x.ruleId === rule.id);
      const callouts = mine.filter((x) => x.anchorIndex === 1).length;
      p.append(h("span", { class: "found", text: tr("{n} found", { n: callouts }) + (mine.length !== callouts ? tr(", {n} pins", { n: mine.length }) : "") }));
      if (pinMode(rule) === "dot" && state.pdf.anchorFor) {
        const count = (kind) => mine.filter((x) => x.anchor === kind).length;
        const fallback = [];
        if (count("leader")) fallback.push(`${count("leader")} on the end of a leader with no dot`);
        if (count("text")) fallback.push(`${count("text")} on the callout (no leader found)`);
        p.append(` · ${count("dot")} on a dot`);
        if (fallback.length) p.append(h("span", { class: "warn", text: `, ${fallback.join(", ")}` }));
      } else p.append(" · pin colour matches the sheet");
    }
  }
}

// ---------------------------------------------------------------- detection
const wantsDots = () => state.rules.some((r) => ruleKind(r) === "text" && hasText(r.tags) && pinMode(r) === "dot");
const symbolRules = () => state.rules.filter((r) => ruleKind(r) === "symbol" && r.symbol);

/** The page's drawn lines, read once and kept (used for leader dots and for symbols). */
function ensureShapes(pdf) {
  pdf.shapesPromise ??= (async () => {
    const page = pdf.page;
    const shapes = await readShapes(page);
    if (pdf.page === page) pdf.shapes = shapes;
    return shapes;
  })();
  return pdf.shapesPromise;
}

/** Read the page's lines once, in the background, the first time a rule wants dots. */
function loadAnchors(pdf) {
  pdf.geoPromise ??= (async () => {
    const page = pdf.page;
    state.busy = true;
    updateExport();
    say(tr("Finding the leader lines and dots on the drawing…"));
    busy.start(tr("Finding the leader lines and dots on the drawing…"));
    try {
      const anchorFor = anchorFinder(await readGeometry(page, await ensureShapes(pdf)), pdf.viewport);
      if (pdf.page === page) pdf.anchorFor = anchorFor;
      say("");
    } catch (err) {
      console.error(err);
      if (pdf.page === page) pdf.geoFailed = true;
      say(tr("Couldn't read the lines on this drawing, so pins are on the callouts instead."), "err");
    } finally {
      state.busy = false;
      busy.stop();
    }
  })();
  return pdf.geoPromise;
}

let detectRun = 0;
/** Work out the pins shortly after the last change. Returns a promise that settles when that run is done. */
const runDetect = (() => {
  let timer, waiting = [];
  return () => new Promise((resolve) => {
    waiting.push(resolve);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = waiting; waiting = [];
      try { await detectNow(); } finally { mine.forEach((r) => r()); }
    }, 120);
  });
})();
async function detectNow() {
  const run = ++detectRun;
  const pdf = state.pdf;
  if (!pdf?.tokens) { state.pins = []; state.errors = {}; refresh(); return; } // no drawing, or still being read: loadPage runs this again when done
  if (wantsDots() && !pdf.geoFailed) {
    await loadAnchors(pdf);
    if (run !== detectRun || state.pdf !== pdf) return; // a newer run (or a new drawing) took over
  }
  const symbolHits = await findAllSymbols(pdf, () => run !== detectRun || state.pdf !== pdf);
  if (run !== detectRun || state.pdf !== pdf) return;
  const { pins, errors } = detect({ tokens: pdf.tokens, width: pdf.width, height: pdf.height, rules: state.rules, anchorFor: wantsDots() ? pdf.anchorFor : null, symbolHits, settings: { area: state.settings.area, roomPattern: state.settings.roomPattern, roomDistance: state.settings.roomDistance } });
  for (const p of pins) {
    const e = state.edits[p.key] || {};
    if (e.title != null) p.title = e.title;
    p.include = e.include !== false;
  }
  state.pins = pins;
  state.errors = errors;
  refresh();
}

/** Look for each symbol rule's symbol on this page. Results are remembered until the symbol or its settings change. */
async function findAllSymbols(pdf, shouldStop = () => false) {
  const out = {};
  const rules = symbolRules();
  if (!rules.length) return out;
  state.symbolNotes = {};
  let shapes;
  try { shapes = pdf.shapes || await ensureShapes(pdf); } catch (err) {
    console.error(err);
    for (const r of rules) state.symbolNotes[r.id] = "Couldn't read the lines on this drawing.";
    return out;
  }
  for (const rule of rules) {
    const params = `${rule.strict ?? 3}|${rule.rotate === false ? 0 : 1}|${rule.sizes ? 1 : 0}`;
    let perTemplate = pdf.symbolCache.get(rule.symbol);
    if (!perTemplate) pdf.symbolCache.set(rule.symbol, (perTemplate = new Map()));
    let res = perTemplate.get(params);
    if (!res) {
      const label = tr("Looking for \"{name}\" on the drawing…", { name: rule.name });
      say(label);
      busy.start(label);
      await new Promise((r) => setTimeout(r, 20)); // let the message paint before the search starts
      try {
        res = await findSymbolsAsync(shapes.paths, rule.symbol, { level: rule.strict ?? 3, rotate: rule.rotate !== false, sizes: !!rule.sizes, shouldStop }, (f) => busy.update(label, f));
      } finally { busy.stop(); }
      if (res.stopped) return out; // a newer search took over; this one is not kept
      perTemplate.set(params, res);
      say("");
    }
    if (res.note) state.symbolNotes[rule.id] = res.note;
    out[rule.id] = res.hits.map((hit) => { const [ux, uy] = pdf.viewport.convertToPdfPoint(hit.x, hit.y); return { ...hit, ux, uy }; });
  }
  return out;
}

const included = () => state.pins.filter((p) => p.include);

function refresh() {
  renderOverlay();
  renderTable();
  updateRuleStatus();
  updateTitleBlock();
  updateExport();
  updateAreaInfo();
  state.animate = false;
}

// ---------------------------------------------------------------- sheet viewer
// The drawing sits in a scrolling viewport. Zoom 1 fits the whole sheet in the window; zooming in makes
// the sheet bigger inside the viewport (the left panel never changes). Only the part you can see is
// drawn at full sharpness, so lines stay clear however far you zoom.
const RW = 24; // ruler width in CSS pixels
const MIN_ZOOM = 1, MAX_ZOOM = 16;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function showSheet(on) {
  $("#viewport").hidden = !on;
  $("#zoombar").hidden = !on;
  $("#sheet").hidden = !on;
  $("#dropzone").hidden = on;
}

/** The sheet's size on screen at the current zoom, in CSS pixels. */
function stageSize() {
  const vp = $("#viewport"), pdf = state.pdf;
  const outer = vp.getBoundingClientRect(); // not clientWidth: that changes when scroll bars appear and would make the sheet jump
  const availW = Math.max(120, outer.width - RW - 14), availH = Math.max(120, outer.height - RW - 14);
  const ratio = pdf.width / pdf.height;
  const w = Math.min(availW, availH * ratio) * state.zoom;
  return [w, w / ratio];
}

function layoutSheet() {
  if (!state.pdf) return;
  const [w, h] = stageSize();
  const sheet = $("#sheet");
  sheet.style.setProperty("--stage-w", `${w}px`);
  sheet.style.setProperty("--stage-h", `${h}px`);
  $("#stage").classList.toggle("zoomed", state.zoom > 1.001);
  $("#viewport").classList.toggle("fitted", state.zoom <= 1.001);
  $("#zoom-level").textContent = `${Math.round(state.zoom * 100)}%`;
  $("#zoom-out").disabled = state.zoom <= MIN_ZOOM + 1e-6;
  $("#zoom-in").disabled = state.zoom >= MAX_ZOOM - 1e-6;
}

const trimNum = (v) => String(Math.round(v * 1000) / 1000);
/** Percentage rulers: finer ticks the further you zoom in. */
function buildRulers() {
  if (!state.pdf) return;
  const [sw, sh] = stageSize();
  const steps = [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05];
  for (const [ruler, size] of [[$("#ruler-x"), sw], [$("#ruler-y"), sh]]) {
    ruler.querySelectorAll(".tick, .minor").forEach((e) => e.remove());
    const horizontal = ruler.id === "ruler-x";
    const major = steps.filter((st) => (size * st) / 100 >= 56).pop() ?? 10;
    const at = (pct) => (horizontal ? `left:${pct}%` : `top:${pct}%`);
    for (let i = 1; i * (major / 2) < 100 - 1e-9; i++) {
      const pct = i * (major / 2);
      const isMajor = i % 2 === 0;
      ruler.append(isMajor ? h("span", { class: "tick", style: at(pct), text: trimNum(pct) }) : h("span", { class: "minor", style: at(pct) }));
    }
  }
}

let tile = null; // the part of the sheet currently drawn, as fractions [x0, y0, x1, y1]; null = all of it
let drawRun = 0;
async function drawCanvas() {
  const pdf = state.pdf;
  if (!pdf || $("#viewport").hidden) return;
  const run = ++drawRun;
  const [sw, sh] = stageSize();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const maxCss = MAX_SIDE / dpr;
  let region = [0, 0, 1, 1];
  if (sw > maxCss || sh > maxCss) {
    const vr = $("#viewport").getBoundingClientRect(), sr = $("#stage").getBoundingClientRect();
    const cx = clamp((vr.left + vr.right) / 2 - sr.left, 0, sw), cy = clamp((vr.top + vr.bottom) / 2 - sr.top, 0, sh);
    const tw = Math.min(sw, maxCss), th = Math.min(sh, maxCss);
    const x0 = clamp(cx - tw / 2, 0, sw - tw), y0 = clamp(cy - th / 2, 0, sh - th);
    region = [x0 / sw, y0 / sh, (x0 + tw) / sw, (y0 + th) / sh];
  }
  const off = document.createElement("canvas");
  const done = await renderRegion(pdf.page, off, sw, region);
  if (!done || run !== drawRun || state.pdf !== pdf) return;
  const canvas = $("#pdf-canvas");
  canvas.width = off.width;
  canvas.height = off.height;
  canvas.getContext("2d").drawImage(off, 0, 0);
  // sized as fractions of the sheet, so it stretches with the sheet while a sharper one is being drawn
  Object.assign(canvas.style, { left: `${region[0] * 100}%`, top: `${region[1] * 100}%`, width: `${(region[2] - region[0]) * 100}%`, height: `${(region[3] - region[1]) * 100}%` });
  tile = region[2] - region[0] < 0.9999 || region[3] - region[1] < 0.9999 ? region : null;
}
const drawCanvasSoon = debounce(drawCanvas, 140);

/** After scrolling: if the visible part has left the drawn tile, draw a new one. */
const checkTile = debounce(() => {
  if (!tile || !state.pdf) return;
  const vr = $("#viewport").getBoundingClientRect(), sr = $("#stage").getBoundingClientRect();
  const [x0, y0, x1, y1] = [tile[0] * sr.width + sr.left, tile[1] * sr.height + sr.top, tile[2] * sr.width + sr.left, tile[3] * sr.height + sr.top];
  const left = Math.max(vr.left, sr.left), top = Math.max(vr.top, sr.top), right = Math.min(vr.right, sr.right), bottom = Math.min(vr.bottom, sr.bottom);
  if (left < x0 - 1 && x0 > sr.left + 1 || right > x1 + 1 && x1 < sr.right - 1 || top < y0 - 1 && y0 > sr.top + 1 || bottom > y1 + 1 && y1 < sr.bottom - 1) drawCanvas();
}, 180);

async function drawSheet() {
  layoutSheet();
  buildRulers();
  renderOverlay();
  await drawCanvas();
}

let overlayQueued = false;
function afterZoom() {
  layoutSheet();
  if (!overlayQueued) {
    overlayQueued = true;
    requestAnimationFrame(() => { overlayQueued = false; buildRulers(); renderOverlay(); });
  }
  drawCanvasSoon();
}

/** Zoom to `z`, keeping the point under (clientX, clientY) where it is. */
function setZoom(z, at) {
  if (!state.pdf) return;
  z = clamp(z, MIN_ZOOM, MAX_ZOOM);
  if (Math.abs(z - state.zoom) < 1e-4) return;
  const vp = $("#viewport"), stage = $("#stage");
  const vr = vp.getBoundingClientRect();
  const cx = at?.clientX ?? (vr.left + vr.right) / 2, cy = at?.clientY ?? (vr.top + vr.bottom) / 2;
  const r = stage.getBoundingClientRect();
  const fx = clamp((cx - r.left) / r.width, 0, 1), fy = clamp((cy - r.top) / r.height, 0, 1);
  state.zoom = z;
  layoutSheet();
  const r2 = stage.getBoundingClientRect();
  vp.scrollLeft += r2.left + fx * r2.width - cx;
  vp.scrollTop += r2.top + fy * r2.height - cy;
  afterZoom();
}
const stepZoom = (dir, at) => setZoom(state.zoom * (dir > 0 ? 1.4 : 1 / 1.4), at);
function fitZoom() {
  state.zoom = 1;
  $("#viewport").scrollTo(0, 0);
  afterZoom();
}

/** Bring a pin into the middle of the view, zooming in if the sheet is shown whole. */
function showPin(key) {
  const p = state.pins.find((x) => x.key === key);
  if (!p || !state.pdf) return;
  const stage = $("#stage"), vp = $("#viewport");
  const fx = p.px / 100, fy = p.py / 100;
  if (state.zoom < 3) {
    const r = stage.getBoundingClientRect();
    setZoom(3, { clientX: r.left + fx * r.width, clientY: r.top + fy * r.height });
  }
  const r = stage.getBoundingClientRect(), vr = vp.getBoundingClientRect();
  vp.scrollLeft += r.left + fx * r.width - (vr.left + vr.width / 2);
  vp.scrollTop += r.top + fy * r.height - (vr.top + vr.height / 2);
  const g = document.querySelector(`.pin[data-key="${CSS.escape(key)}"]`);
  if (g) { g.classList.add("hot"); setTimeout(() => g.classList.remove("hot"), 1200); }
  bringDrawingIntoView(key);
}
/** Clicking a pin in the list jumps up to the drawing if it is off screen, and offers a button to come back to the list. */
function bringDrawingIntoView(key) {
  const pane = document.querySelector(".sheetpane"), vp = $("#viewport");
  const r = vp.getBoundingClientRect();
  const visible = r.top >= -2 && r.bottom <= innerHeight + 2 || (r.top >= 0 && r.top < innerHeight * 0.4);
  if (visible) return;
  const row = document.querySelector(`#pin-rows tr[data-key="${CSS.escape(key)}"]`);
  const smooth = !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  pane.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
  let back = $("#back-to-pins");
  if (!back) {
    back = h("button", { type: "button", id: "back-to-pins", class: "btn dark back-to-pins" });
    document.body.append(back);
    back.addEventListener("click", () => {
      const target = document.querySelector(`#pin-rows tr[data-key="${CSS.escape(back.dataset.key)}"]`) || $("#pinlist");
      target.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
      back.hidden = true;
    });
    window.addEventListener("scroll", () => { // gone once the list is back on screen
      const l = $("#pinlist").getBoundingClientRect();
      if (back.hidden) return;
      if (l.top >= innerHeight * 0.6) back.dataset.armed = "1"; // the list has left the screen...
      else if (back.dataset.armed) { back.hidden = true; delete back.dataset.armed; } // ...and now it is back
    }, { passive: true });
  }
  back.textContent = `↓ ${tr("Back to the pins")}`;
  back.dataset.key = key; delete back.dataset.armed; back.hidden = !row;
}

const pxToUnits = () => state.pdf.width / $("#stage").clientWidth;

function renderOverlay() {
  const o = $("#overlay");
  o.replaceChildren();
  const pdf = state.pdf;
  if (!pdf?.width) return;
  const { width: W, height: H } = pdf;
  o.setAttribute("viewBox", `0 0 ${W} ${H}`);
  o.setAttribute("preserveAspectRatio", "none");
  const k = pxToUnits();

  if (state.settings.showGrid) {
    const g = svg("g");
    for (let i = 1; i < 10; i++) {
      g.append(svg("line", { class: "gridline", x1: (W * i) / 10, y1: 0, x2: (W * i) / 10, y2: H }));
      g.append(svg("line", { class: "gridline", x1: 0, y1: (H * i) / 10, x2: W, y2: (H * i) / 10 }));
    }
    o.append(g);
  }

  const a = state.areaDraft || state.settings.area;
  if (a) {
    const [x0, y0, x1, y1] = [a[0] * W, a[1] * H, a[2] * W, a[3] * H];
    o.append(svg("path", { class: "area-dim", d: `M0 0H${W}V${H}H0Z M${x0} ${y0}V${y1}H${x1}V${y0}Z` }));
    o.append(svg("rect", { class: "area-edge", x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
  }

  const bd = state.boxDraft;
  if (bd) o.append(svg("rect", { class: "area-edge symbol-box", x: bd[0] * W, y: bd[1] * H, width: (bd[2] - bd[0]) * W, height: (bd[3] - bd[1]) * H }));

  const tethers = svg("g");
  for (const p of state.pins) {
    if (p.anchor === "text" || p.anchor === "symbol") continue;
    tethers.append(svg("line", { class: "tether", x1: p.tx, y1: p.ty, x2: p.x, y2: p.y }));
  }
  o.append(tethers);

  const pins = svg("g");
  const rpx = clamp($("#stage").clientWidth / 60, 7, 11); // pins are 11 px on a big view, a little smaller when the whole sheet is tiny
  const u = rpx / 11;
  const r = 11 * u * k;
  state.pins.forEach((p, i) => {
    const g = svg("g", { class: `pin${p.include ? "" : " off"}${state.animate ? " enter" : ""}`, "data-key": p.key, tabindex: 0, role: "button", "aria-pressed": String(p.include), "aria-label": `${tr("Pin")} ${p.n}, ${p.title || p.tag}, ${p.include ? tr("included") : tr("excluded")}` });
    if (state.animate) g.style.setProperty("--i", Math.min(i, 60));
    g.append(svg("circle", { class: "halo", cx: p.x, cy: p.y, r: r + 2.2 * u * k }));
    const dot = svg("circle", { class: "dot", cx: p.x, cy: p.y, r, fill: colorOf(p.ruleIndex) });
    g.append(dot);
    const t = svg("text", { x: p.x, y: p.y, "font-size": `${(p.n > 99 ? 9 : 12) * u * k}px` });
    t.textContent = String(p.n);
    g.append(t);
    const tip = svg("title");
    tip.textContent = `#${p.n} · ${p.ruleName} · ${p.tag} · ${pinnedOn(p)} · X ${round2(p.px)}%  Y ${round2(p.py)}%`;
    g.append(tip);
    g.addEventListener("click", (ev) => { if (!state.areaMode) { ev.stopPropagation(); togglePin(p.key); } });
    g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); togglePin(p.key); } });
    g.addEventListener("pointerenter", () => hot(p.key, true));
    g.addEventListener("pointerleave", () => hot(p.key, false));
    pins.append(g);
  });
  o.append(pins);

  const cross = svg("g", { id: "cross", visibility: "hidden" });
  cross.append(svg("line", { class: "cross", id: "cross-v", x1: 0, y1: 0, x2: 0, y2: H }));
  cross.append(svg("line", { class: "cross", id: "cross-h", x1: 0, y1: 0, x2: W, y2: 0 }));
  o.append(cross);
}

function hot(key, on) {
  document.querySelector(`.pin[data-key="${CSS.escape(key)}"]`)?.classList.toggle("hot", on);
  document.querySelector(`tr[data-key="${CSS.escape(key)}"]`)?.classList.toggle("hot", on);
}

function togglePin(key, to) {
  const pin = state.pins.find((p) => p.key === key);
  if (!pin) return;
  pin.include = to ?? !pin.include;
  state.edits[key] = { ...(state.edits[key] || {}), include: pin.include };
  renderOverlay();
  const row = document.querySelector(`tr[data-key="${CSS.escape(key)}"]`);
  if (row) { row.classList.toggle("off", !pin.include); row.querySelector('input[type="checkbox"]').checked = pin.include; }
  updateTitleBlock(); updateExport(); updateTableHead();
}

// pointer: readout, crosshair, rulers, panning, and drawing the search area or a symbol box
function stagePoint(ev) {
  const r = $("#stage").getBoundingClientRect();
  return [clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1)];
}
const drawing = () => state.areaMode || !!state.boxFor;

/** Show the crosshair, the ruler markers and the readout at (fx, fy), fractions of the sheet. */
function pointAt(fx, fy) {
  if (!state.pdf?.width) return;
  $("#readout").textContent = `X ${(fx * 100).toFixed(1)}%   Y ${(fy * 100).toFixed(1)}%`;
  const cross = $("#cross");
  if (cross) {
    cross.setAttribute("visibility", "visible");
    const v = $("#cross-v"), hl = $("#cross-h");
    v.setAttribute("x1", fx * state.pdf.width); v.setAttribute("x2", fx * state.pdf.width);
    hl.setAttribute("y1", fy * state.pdf.height); hl.setAttribute("y2", fy * state.pdf.height);
  }
  const mx = $("#marker-x"), my = $("#marker-y");
  mx.style.display = my.style.display = "block";
  mx.style.left = `${fx * 100}%`; my.style.top = `${fy * 100}%`;
  if (state.areaStart) {
    const [sx, sy] = state.areaStart;
    const box = [Math.min(sx, fx), Math.min(sy, fy), Math.max(sx, fx), Math.max(sy, fy)];
    if (state.boxFor) state.boxDraft = box; else state.areaDraft = box;
    renderOverlay();
    $("#cross")?.setAttribute("visibility", "visible");
  }
}

function finishDraw() {
  const stage = $("#stage");
  if (state.boxFor && state.areaStart) { finishSymbolBox(); return; }
  if (!state.areaMode || !state.areaStart) return;
  const a = state.areaDraft;
  state.areaStart = null; state.areaDraft = null;
  state.areaMode = false;
  stage.classList.remove("drawing");
  $("#draw-area").textContent = tr("Draw on sheet");
  if (a && a[2] - a[0] > 0.01 && a[3] - a[1] > 0.01) state.settings.area = a;
  runDetect();
  refresh();
}

/** Keyboard drawing: arrows move a cursor over the sheet, Enter sets the first and then the second corner, Escape cancels. */
const kb = { x: 0.5, y: 0.5, on: false };
function kbDraw(ev) {
  const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
  if (move) {
    if (!kb.on) { // start in the middle of what is on screen
      const vr = $("#viewport").getBoundingClientRect(), sr = $("#stage").getBoundingClientRect();
      kb.x = clamp(((vr.left + vr.right) / 2 - sr.left) / sr.width, 0, 1);
      kb.y = clamp(((vr.top + vr.bottom) / 2 - sr.top) / sr.height, 0, 1);
      kb.on = true;
    }
    const step = ev.shiftKey ? 0.05 : ev.altKey ? 0.002 : 0.01;
    kb.x = clamp(kb.x + move[0] * step / Math.max(1, state.zoom), 0, 1);
    kb.y = clamp(kb.y + move[1] * step / Math.max(1, state.zoom), 0, 1);
    ev.preventDefault();
    pointAt(kb.x, kb.y);
    // keep the cursor on screen when zoomed in
    const vp = $("#viewport"), sr = $("#stage").getBoundingClientRect(), vr = vp.getBoundingClientRect();
    const px = sr.left + kb.x * sr.width, py = sr.top + kb.y * sr.height;
    if (px < vr.left + RW + 30) vp.scrollLeft -= vr.left + RW + 30 - px; else if (px > vr.right - 30) vp.scrollLeft += px - (vr.right - 30);
    if (py < vr.top + RW + 30) vp.scrollTop -= vr.top + RW + 30 - py; else if (py > vr.bottom - 30) vp.scrollTop += py - (vr.bottom - 30);
    return true;
  }
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    if (!kb.on) { kbDraw({ key: "ArrowLeft", preventDefault() {}, shiftKey: false }); kb.x += 0.01; }
    if (!state.areaStart) { state.areaStart = [kb.x, kb.y]; state.areaDraft = null; state.boxDraft = null; say(tr("First corner set. Move to the opposite corner and press Enter.")); }
    else { pointAt(kb.x, kb.y); finishDraw(); kb.on = false; }
    return true;
  }
  if (ev.key === "Escape") {
    ev.preventDefault();
    if (state.boxFor) cancelSymbolBox();
    else { state.areaMode = false; state.areaStart = null; state.areaDraft = null; $("#stage").classList.remove("drawing"); $("#draw-area").textContent = tr("Draw on sheet"); updateAreaInfo(); renderOverlay(); say(""); }
    kb.on = false;
    return true;
  }
  return false;
}

function setupStage() {
  const stage = $("#stage"), vp = $("#viewport");
  let pan = null;
  stage.addEventListener("pointermove", (ev) => {
    if (!state.pdf) return;
    if (pan) {
      vp.scrollLeft = pan.sl - (ev.clientX - pan.x);
      vp.scrollTop = pan.st - (ev.clientY - pan.y);
      return;
    }
    const [fx, fy] = stagePoint(ev);
    pointAt(fx, fy);
  });
  stage.addEventListener("pointerleave", () => {
    if (kb.on && drawing()) return;
    $("#readout").innerHTML = "X –&nbsp; Y –";
    $("#cross")?.setAttribute("visibility", "hidden");
    $("#marker-x").style.display = $("#marker-y").style.display = "none";
  });
  stage.addEventListener("pointerdown", (ev) => {
    if (drawing()) {
      ev.preventDefault();
      stage.setPointerCapture(ev.pointerId);
      state.areaStart = stagePoint(ev);
      state.areaDraft = null;
      state.boxDraft = null;
      return;
    }
    // drag the sheet around when it is bigger than the window
    if (ev.button !== 0 || ev.target.closest?.(".pin") || (vp.scrollWidth <= vp.clientWidth && vp.scrollHeight <= vp.clientHeight)) return;
    pan = { x: ev.clientX, y: ev.clientY, sl: vp.scrollLeft, st: vp.scrollTop };
    stage.setPointerCapture(ev.pointerId);
    stage.classList.add("panning");
  });
  const endPan = () => { if (pan) { pan = null; stage.classList.remove("panning"); } };
  stage.addEventListener("pointercancel", endPan);
  stage.addEventListener("pointerup", () => { if (pan) { endPan(); return; } finishDraw(); });

  // zoom: Ctrl/Cmd + scroll (this is also what a trackpad pinch sends), the buttons, and + - 0 on the keyboard
  vp.addEventListener("wheel", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || !state.pdf) return;
    ev.preventDefault();
    setZoom(state.zoom * Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0022)), ev);
  }, { passive: false });
  vp.addEventListener("keydown", (ev) => {
    if (!state.pdf || ev.target !== vp) return;
    if (drawing() && kbDraw(ev)) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); stepZoom(1); }
    else if (ev.key === "-" || ev.key === "_") { ev.preventDefault(); stepZoom(-1); }
    else if (ev.key === "0") { ev.preventDefault(); fitZoom(); }
  });
  vp.addEventListener("scroll", checkTile, { passive: true });
  $("#zoom-in").addEventListener("click", () => stepZoom(1));
  $("#zoom-out").addEventListener("click", () => stepZoom(-1));
  $("#zoom-fit").addEventListener("click", fitZoom);

  // the window or the panel layout changed: keep the same zoom, redraw
  new ResizeObserver(debounce(() => { if (state.pdf && !$("#viewport").hidden) { layoutSheet(); buildRulers(); renderOverlay(); drawCanvas(); } }, 120)).observe(vp);
}

// ---------------------------------------------------------------- symbols
function startSymbolBox(rule) {
  if (!state.pdf) { say(tr("Load a drawing first, then draw a box around the symbol."), "err"); return; }
  if (state.boxFor === rule.id) { cancelSymbolBox(); return; }
  state.areaMode = false;
  $("#draw-area").textContent = tr("Draw on sheet");
  state.boxFor = rule.id;
  $("#stage").classList.add("drawing");
  say(tr("Drag a box on the sheet that fully contains the symbol. Without a mouse: use the arrow keys, Enter for each corner, Escape to cancel."));
  renderRules();
  if (keyboardActivated) $("#viewport").focus();
}
function cancelSymbolBox(silent = false) {
  state.boxFor = null; state.boxDraft = null; state.areaStart = null; kb.on = false;
  $("#stage").classList.remove("drawing");
  if (!silent) say("");
  renderRules();
  renderOverlay();
}
async function finishSymbolBox() {
  const rule = state.rules.find((r) => r.id === state.boxFor);
  const [a, b, c, d] = state.boxDraft || [0, 0, 0, 0];
  state.areaStart = null; state.boxDraft = null; state.boxFor = null;
  $("#stage").classList.remove("drawing");
  renderRules();
  renderOverlay();
  if (!rule || c - a < 0.002 || d - b < 0.002) { say(tr("That box was too small. Drag from one corner of the symbol to the other."), "err"); return; }
  const pdf = state.pdf;
  say(tr("Reading the symbol…"));
  try {
    const shapes = await ensureShapes(pdf);
    const { template, error } = captureSymbol(shapes.paths, [a * pdf.width, b * pdf.height, c * pdf.width, d * pdf.height]);
    if (state.pdf !== pdf) return;
    if (error) { say(tr(error), "err"); return; }
    rule.symbol = template;
    rule.kind = "symbol";
    track("symbol-box");
    save();
    renderRules();
    runDetect();
    say("");
  } catch (err) {
    console.error(err);
    say(tr("Couldn't read the lines on this drawing."), "err");
  }
}

const LEVELS = ["Loose", "Relaxed", "Balanced", "Strict", "Exact"];

/** A small drawing of the symbol; click it to move the pin. */
function symbolPreview(rule, set) {
  const t = rule.symbol;
  const pad = Math.max(t.w, t.h) * 0.06 + 1;
  const el = svg("svg", { class: "sym-preview", viewBox: `${-t.w / 2 - pad} ${-t.h / 2 - pad} ${t.w + pad * 2} ${t.h + pad * 2}`, role: "img", "aria-label": tr("The symbol being searched for. Click to move where the pin goes.") });
  el.append(svg("rect", { class: "sym-box", x: -t.w / 2, y: -t.h / 2, width: t.w, height: t.h }));
  for (const p of t.paths) {
    const d = p.pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join("") + (p.closed ? "Z" : "");
    el.append(svg("path", { class: "sym-line", d }));
  }
  const r = Math.max(t.w, t.h) * 0.045 + 0.8;
  el.append(svg("circle", { class: "sym-pin", cx: t.pin[0], cy: t.pin[1], r }));
  el.addEventListener("click", (ev) => {
    const m = el.getScreenCTM();
    if (!m) return;
    const pt = el.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const q = pt.matrixTransform(m.inverse());
    set({ symbol: { ...t, pin: [round2(Math.max(-t.w / 2, Math.min(t.w / 2, q.x))), round2(Math.max(-t.h / 2, Math.min(t.h / 2, q.y)))] } });
  });
  return el;
}

function updateAreaInfo() {
  const a = state.settings.area;
  $("#reset-area").disabled = !a;
  $("#area-info").textContent = state.areaMode
    ? tr("Drag a box on the sheet around the part that holds the callouts.")
    : a
      ? tr("Searching x {x0}–{x1}% and y {y0}–{y1}% of the sheet.", { x0: Math.round(a[0] * 100), x1: Math.round(a[2] * 100), y0: Math.round(a[1] * 100), y1: Math.round(a[3] * 100) })
      : tr("Ignore keynotes and the title block by limiting the search to part of the sheet.");
}

// ---------------------------------------------------------------- pin table
const pinnedOn = (p) =>
  p.anchor === "symbol" ? tr("Symbol")
  : p.anchor === "dot" ? (p.anchorCount > 1 ? tr("Dot {i} of {n}", { i: p.anchorIndex, n: p.anchorCount }) : tr("Dot"))
  : p.anchor === "leader" ? tr("Leader end (no dot)")
  : tr("Callout");

function renderTable() {
  const wrap = $("#pinlist");
  wrap.hidden = !state.pdf;
  const body = $("#pin-rows");
  body.replaceChildren();
  if (!state.pdf) return;
  if (!state.pins.length) {
    body.append(h("tr", {}, h("td", { colspan: 9, class: "empty", text: tr("No pins yet. Add the text to look for in a rule and they appear here and on the sheet.") })));
  }
  const LIMIT = 1000;
  state.pins.slice(0, LIMIT).forEach((p) => {
    const box = h("input", { type: "checkbox", checked: p.include, "aria-label": `${tr("Include pin")} ${p.n}` });
    box.addEventListener("change", () => togglePin(p.key, box.checked));
    const title = h("input", { type: "text", value: p.title, "aria-label": `${tr("Title for pin")} ${p.n}` });
    title.addEventListener("input", () => { p.title = title.value; state.edits[p.key] = { ...(state.edits[p.key] || {}), title: title.value }; });
    const row = h("tr", { "data-key": p.key, class: p.include ? "" : "off", style: `--pin:${colorOf(p.ruleIndex)}` },
      h("td", {}, box), h("td", { text: String(p.n) }),
      h("td", { class: "rulecell" }, h("span", { class: "dot" }), p.ruleName),
      h("td", { text: p.tag }), h("td", { text: p.room }), h("td", { class: p.anchor === "dot" ? "" : "muted", text: pinnedOn(p) }), h("td", {}, title),
      h("td", { class: "num-col", text: round2(p.px).toFixed(2) }), h("td", { class: "num-col", text: round2(p.py).toFixed(2) }));
    row.addEventListener("pointerenter", () => hot(p.key, true));
    row.addEventListener("pointerleave", () => hot(p.key, false));
    row.addEventListener("click", (ev) => { if (!ev.target.closest("input[type=checkbox], button")) showPin(p.key); }); // anywhere on the line, including the title box
    row.title = tr("Click to find this pin on the drawing");
    body.append(row);
  });
  if (state.pins.length > LIMIT) body.append(h("tr", {}, h("td", { colspan: 9, class: "empty", text: tr("Showing the first {limit} of {n} pins. All of them are still exported.", { limit: LIMIT, n: state.pins.length }) })));
  updateTableHead();
}
function updateTableHead() {
  $("#pinlist-title").textContent = tr("Pins · {a} of {b} included", { a: included().length, b: state.pins.length });
}

// ---------------------------------------------------------------- title block + exports
function updateTitleBlock() {
  const pdf = state.pdf;
  $("#tb-name").textContent = pdf ? baseName(pdf.name) : tr("None loaded");
  $("#tb-name").title = pdf ? pdf.name : "";
  $("#tb-size").textContent = pdf ? `${fmtIn(pdf.width / 72)} × ${fmtIn(pdf.height / 72)} in` : "–";
  $("#tb-pins").textContent = state.pins.length ? `${included().length} / ${state.pins.length}` : "0";
}

const listAnd = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${tr("and")} ${items[items.length - 1]}`);

function updateExport() {
  const t = state.tpl?.parsed;
  const plan = hasText(state.settings.planName);
  const inc = included().length;
  const need = [];
  if (!state.pdf) need.push(tr("load a drawing"));
  else if (!inc) need.push(tr("include at least one pin"));
  if (!t) need.push(tr("load the import template"));
  else if (t.missing.length) need.push(tr("use a template with {list}", { list: t.missing.map(tr).join(` ${tr("and")} `) }));
  if (!plan) need.push(tr("enter the plan name"));
  if (state.busy) need.push(tr("wait for the drawing's lines to finish loading"));
  $("#dl-import").disabled = need.length > 0;
  const batches = batchRanges(inc);
  $("#import-why").textContent = need.length
    ? tr("Still needed: {list}.", { list: need.join(", ") })
    : batches.length > 1
      ? tr("Open the file, copy the pin rows and paste them into Fieldwire's task importer, one batch at a time.")
      : tr("Pins import with a blank ID, so they are always created as new pins.");
  $("#dl-import").textContent = tr("Download import file");
  const split = $("#export-split");
  split.hidden = need.length > 0 || batches.length < 2;
  if (!split.hidden) {
    const nf = new Intl.NumberFormat(currentLanguage());
    const span = ([a, b]) => `${nf.format(a)}–${nf.format(b)}`;
    const ranges = batches.length <= 6
      ? listAnd(batches.map(span))
      : `${span(batches[0])}, ${span(batches[1])} … ${span(batches[batches.length - 1])}`;
    split.textContent = tr("Fieldwire's task importer takes up to {limit} pins at a time, so paste this file in {n} batches (pins {ranges}).", { limit: IMPORT_LIMIT, n: batches.length, ranges });
  }
  renderExportPreview(need.length === 0);
  renderBatches(need.length === 0, batches);
  $("#dl-pdf").disabled = !(state.pdf && inc) || state.busy;
  $("#dl-png").disabled = !(state.pdf && inc) || state.busy;
  $("#dl-calibration").disabled = !(t && !t.missing.length && plan);
}

/** What the import file will hold: a sentence, and a small table of the first few tasks. */
const PREVIEW_ROWS = 6;
function renderExportPreview(ready) {
  const t = state.tpl?.parsed, box = $("#preview-table"), summary = $("#export-summary");
  const inc = included();
  const details = $("#export-preview");
  details.hidden = !(t && !t.missing.length && inc.length);
  if (!ready) { summary.textContent = ""; box.replaceChildren(); return; }
  const plan = state.settings.planName.trim();
  const skipped = state.pins.length - inc.length;
  summary.textContent = (inc.length === 1 ? tr("1 pin will go onto plan \"{plan}\".", { plan }) : tr("{n} pins will go onto plan \"{plan}\".", { n: inc.length, plan })) + (skipped ? ` ${skipped === 1 ? tr("1 pin is left out.") : tr("{n} pins are left out.", { n: skipped })}` : "");
  if (!details.open) return; // the table is only built while it is open
  const rulesById = Object.fromEntries(state.rules.map((r) => [r.id, r]));
  const rows = buildRows(t, inc.slice(0, PREVIEW_ROWS).map((p) => ({ ...p, title: hasText(p.title) ? p.title : p.tag })), { planName: plan, rulesById });
  const heads = t.columns.filter((c) => c.role !== "id" && rows.some((r) => r[c.header] != null && r[c.header] !== "")).map((c) => c.header);
  box.replaceChildren(h("table", {},
    h("thead", {}, h("tr", {}, heads.map((x) => h("th", { scope: "col", text: x })))),
    h("tbody", {}, rows.map((r) => h("tr", {}, heads.map((x) => h("td", { text: r[x] == null ? "" : String(r[x]), title: r[x] == null ? "" : String(r[x]) })))))),
    inc.length > PREVIEW_ROWS ? h("p", { class: "more-rows", text: tr("…and {n} more.", { n: inc.length - PREVIEW_ROWS }) }) : null);
}

/** One "Copy rows" button per batch of up to 500 pins, so nothing has to be selected by hand. */
const copiedBatches = new Set();
let batchSignature = "";
function renderBatches(ready, batches) {
  const box = $("#batches"), wrap = $("#batch-heads-wrap");
  box.hidden = wrap.hidden = !ready || !batches.length;
  if (box.hidden) { box.replaceChildren(); return; }
  const sig = `${$("#plan-name").value}|${included().map((p) => `${p.n}:${p.title}:${p.px}:${p.py}`).join(",")}`;
  if (sig !== batchSignature) { batchSignature = sig; copiedBatches.clear(); }
  const nf = new Intl.NumberFormat(currentLanguage());
  const next = batches.findIndex((_, i) => !copiedBatches.has(i));
  box.replaceChildren(...batches.map(([from, to], i) => {
    const done = copiedBatches.has(i);
    const range = from === to ? nf.format(from) : `${nf.format(from)}–${nf.format(to)}`;
    const sub = batches.length === 1
      ? (to === 1 ? tr("1 pin", {}) : tr("All {n} pins", { n: nf.format(to) }))
      : tr("Pins {range}", { range });
    const btn = h("button", { type: "button", class: `btn${i === next || batches.length === 1 && !done ? " primary" : ""}`, text: done ? tr("Copy again") : tr("Copy rows") });
    btn.addEventListener("click", () => copyBatch(i, from, to));
    return h("div", { class: `batch${done ? " done" : ""}` },
      h("div", { class: "n", text: done ? "✓" : String(i + 1) }),
      h("div", { class: "t" }, h("b", { text: batches.length === 1 ? tr("Pin rows") : tr("Batch {n}", { n: i + 1 }) }), h("span", { text: done ? `${sub} · ${tr("copied")}` : sub })),
      btn);
  }));
}

async function copyBatch(i, from, to) {
  const t = state.tpl.parsed;
  const pins = included().map((p) => ({ ...p, title: hasText(p.title) ? p.title : p.tag }));
  const rulesById = Object.fromEntries(state.rules.map((r) => [r.id, r]));
  const rows = buildRows(t, pins, { planName: state.settings.planName.trim(), rulesById }).slice(from - 1, to);
  const ok = await copyText(rowsToTsv(t, rows, { headings: $("#batch-heads").checked }));
  if (!ok) { say(tr("The browser wouldn't let Plandot copy. Use Download import file instead."), "err"); return; }
  track("copied-rows");
  copiedBatches.add(i);
  updateExport();
  say(tr("Copied {n} rows. Paste them into Fieldwire's task importer.", { n: rows.length }), "ok");
}

async function exportImport() {
  const t = state.tpl.parsed;
  const pins = included().map((p) => ({ ...p, title: hasText(p.title) ? p.title : p.tag }));
  const rulesById = Object.fromEntries(state.rules.map((r) => [r.id, r]));
  const rows = buildRows(t, pins, { planName: state.settings.planName.trim(), rulesById });
  const bytes = await writeImport(t, rows);
  download(bytes, `${baseName(state.pdf.name)} - pin import.xlsx`, XLSX_MIME);
  track("exported");
  track(`export-pins-${pinBucket(rows.length)}`);
  const plan = state.settings.planName.trim();
  say(rows.length === 1 ? tr("Downloaded 1 pin for plan \"{plan}\".", { plan }) : tr("Downloaded {n} pins for plan \"{plan}\".", { n: rows.length, plan }), "ok");
}

async function exportPdf() {
  const bytes = await markedUpPdf(state.pdf.bytes, state.pdf.pageNo, included(), colorOf);
  download(bytes, `${baseName(state.pdf.name)} - marked up.pdf`, "application/pdf");
  say(tr("Downloaded the marked-up PDF."), "ok");
}

async function exportPng() {
  const full = await renderFull(state.pdf.page, 3000);
  const blob = await pinsPng(full, state.pdf.width, included(), state.rules, colorOf);
  download(blob, `${baseName(state.pdf.name)} - pins.png`, "image/png");
  say(tr("Downloaded the pin image."), "ok");
}

async function exportCalibration() {
  const t = state.tpl.parsed;
  const bytes = await writeImport(t, buildCalibrationRows(t, state.settings.planName.trim()));
  download(bytes, "calibration pins.xlsx", XLSX_MIME);
  say(tr("Downloaded 9 calibration pins at 10%, 50% and 90%."), "ok");
}

// ---------------------------------------------------------------- sample drawing
async function trySample() {
  if (state.rules.some((r) => hasText(r.tags) || r.symbol) && !window.confirm(tr("Load the sample? It replaces your current rules."))) return;
  say(tr("Loading the sample…"));
  const get = async (name) => {
    const res = await fetch(new URL(`samples/${name}`, document.baseURI));
    if (!res.ok) throw new Error(`${name}: ${res.status}`);
    return res;
  };
  let pdf, xlsx, rules;
  try {
    [pdf, xlsx, rules] = await Promise.all([get("sample-drawing.pdf").then((r) => r.blob()), get("sample-import-template.xlsx").then((r) => r.blob()), get("sample-rules.json").then((r) => r.blob())]);
  } catch (e) {
    const fromFile = location.protocol === "file:";
    say(fromFile ? tr("The sample couldn't be loaded. It needs the page to be opened from its web address, not as a file on your computer.")
      : tr("The sample couldn't be loaded ({file}). Reload the page and try again.", { file: String(e?.message || e).slice(0, 80) }), "err");
    return;
  }
  state.settings.planName = "Ground floor plan";
  $("#plan-name").value = state.settings.planName;
  await loadTemplateFile(new File([xlsx], "sample-import-template.xlsx"));
  await loadRules(new File([rules], "sample-rules.json"));
  await loadPdfFile(new File([pdf], "sample-drawing.pdf", { type: "application/pdf" }));
  save();
  say(tr("This is a made-up sample. Try the rules on the left, then download the import file."), "ok");
  if (globalThis.matchMedia?.("(max-width: 1000px)").matches) document.querySelector(".sheetpane")?.scrollIntoView({ block: "start" }); // on a phone, show the plan
}

// ---------------------------------------------------------------- start over
const DEFAULT_SETTINGS = { planName: "", roomPattern: "", roomDistance: 10, area: null, showGrid: false };


/** Is there anything on the page the user would lose? */
function hasWork() {
  return !!(state.pdf || state.tpl || hasText(state.settings.planName) || state.rules.length > 1 || state.rules.some((r) => hasText(r.tags) || r.symbol));
}

function startOver() {
  if (hasWork() && !window.confirm(tr("Start over? This clears your drawing, template, rules and pins. Choose Save setup first to keep your rules."))) return;
  loadRun++;
  detectRun++; // anything still being worked out for the old drawing is thrown away
  try { state.pdf?.doc?.destroy?.(); } catch { /* already gone */ }
  Object.assign(state, { pdf: null, tpl: null, rules: [newRule(1)], settings: { ...DEFAULT_SETTINGS }, edits: {}, pins: [], errors: {}, areaMode: false, areaStart: null, areaDraft: null, boxFor: null, boxDraft: null, animate: false, busy: false, zoom: 1 });
  kb.on = false;
  resetHistory();
  try { localStorage.removeItem(STORE_KEY); } catch { /* storage blocked: nothing to clear */ }

  for (const id of ["#file-pdf", "#file-xlsx", "#load-rules"]) $(id).value = ""; // so choosing the same file again still counts
  $("#plan-name").value = "";
  $("#room-pattern").value = "";
  $("#room-distance").value = 10;
  $("#show-grid").checked = false;
  $("#page-field").hidden = true;
  $("#page-select").replaceChildren();
  state.tplError = null;
  renderPdfInfo();
  renderTplInfo();
  $("#draw-area").disabled = true;
  $("#draw-area").textContent = tr("Draw on sheet");
  $("#stage").classList.remove("drawing");
  const canvas = $("#pdf-canvas");
  canvas.width = 0;
  canvas.height = 0;
  showSheet(false);
  $("#readout").innerHTML = "X –&nbsp; Y –";

  renderTemplateInfo();
  renderRules();
  refresh();
  window.scrollTo({ top: 0 });
  say(tr("Everything is cleared. Drop a drawing to begin again."), "ok");
}

const guarded = (fn) => async () => {
  try { await fn(); } catch (err) { console.error(err); say(tr("Something went wrong: {err}", { err: err.message || err }), "err", whyText(err)); }
};

// ---------------------------------------------------------------- rule files
function saveRules() {
  const payload = { app: "plandot", version: 2, settings: { planName: state.settings.planName, roomPattern: state.settings.roomPattern, roomDistance: state.settings.roomDistance }, rules: state.rules.map((r) => {
    const { name, tags, usePattern, title, columns, pinAt } = r;
    const base = { name, tags, usePattern: !!usePattern, title, pinAt: pinMode({ pinAt }), columns: columns || {} };
    return ruleKind(r) === "symbol" ? { ...base, kind: "symbol", symbol: r.symbol || null, strict: r.strict ?? 3, rotate: r.rotate !== false, sizes: !!r.sizes } : base;
  }) };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), "plandot setup.json", "application/json");
  say(payload.rules.length === 1 ? tr("Saved 1 rule.") : tr("Saved {n} rules.", { n: payload.rules.length }), "ok");
}
async function loadRules(f) {
  try {
    const data = JSON.parse(await f.text());
    if (!["plandot", "plan-tasks"].includes(data.app) || !Array.isArray(data.rules)) throw new Error("not a Plandot setup file");
    state.rules = data.rules.map((r, i) => ({ ...newRule(i + 1), name: String(r.name ?? `Rule ${i + 1}`), tags: String(r.tags ?? ""), usePattern: !!r.usePattern, title: String(r.title ?? "{tag}"), pinAt: r.pinAt === "text" ? "text" : "dot", columns: typeof r.columns === "object" && r.columns ? r.columns : {}, ...(r.kind === "symbol" ? { kind: "symbol", symbol: sanitizeTemplate(r.symbol), strict: [1, 2, 3, 4, 5].includes(r.strict) ? r.strict : 3, rotate: r.rotate !== false, sizes: !!r.sizes } : {}) }));
    if (data.settings) {
      if (hasText(data.settings.planName)) { state.settings.planName = String(data.settings.planName); $("#plan-name").value = state.settings.planName; }
      state.settings.roomPattern = String(data.settings.roomPattern ?? "");
      state.settings.roomDistance = Number(data.settings.roomDistance) || 10;
      $("#room-pattern").value = state.settings.roomPattern;
      $("#room-distance").value = state.settings.roomDistance;
    }
    afterRulesChange();
    updateExport();
    say(state.rules.length === 1 ? tr("Loaded 1 rule.") : tr("Loaded {n} rules.", { n: state.rules.length }), "ok");
  } catch (err) {
    say(tr("That isn't a Plandot setup file ({err}).", { err: err.message }), "err");
  }
}

// ---------------------------------------------------------------- wiring
function wire() {
  $("#file-pdf").addEventListener("change", (e) => e.target.files[0] && loadPdfFile(e.target.files[0]));
  $("#file-xlsx").addEventListener("change", (e) => e.target.files[0] && loadTemplateFile(e.target.files[0]));
  $("#page-select").addEventListener("change", (e) => loadPage(Number(e.target.value)));
  $("#plan-name").addEventListener("input", (e) => { state.settings.planName = e.target.value; saveSoon(); updateExport(); });
  $("#room-pattern").addEventListener("input", (e) => { state.settings.roomPattern = e.target.value; saveSoon(); runDetect(); });
  $("#room-distance").addEventListener("input", (e) => { state.settings.roomDistance = Number(e.target.value) || 10; saveSoon(); runDetect(); });
  $("#show-grid").addEventListener("change", (e) => { state.settings.showGrid = e.target.checked; saveSoon(); renderOverlay(); });
  $("#add-rule").addEventListener("click", () => { state.rules.push(newRule(state.rules.length + 1)); afterRulesChange(); });
  $("#save-rules").addEventListener("click", saveRules);
  $("#load-rules-btn").addEventListener("click", () => $("#load-rules").click());
  $("#load-rules").addEventListener("change", (e) => { if (e.target.files[0]) loadRules(e.target.files[0]); e.target.value = ""; });
  $("#draw-area").addEventListener("click", () => {
    state.areaMode = !state.areaMode;
    state.areaStart = null; state.areaDraft = null; kb.on = false;
    $("#stage").classList.toggle("drawing", state.areaMode);
    $("#draw-area").textContent = state.areaMode ? tr("Cancel") : tr("Draw on sheet");
    updateAreaInfo();
    if (state.areaMode) say(tr("Without a mouse: use the arrow keys, Enter for each corner, Escape to cancel."));
    else renderOverlay();
    if (state.areaMode && keyboardActivated) $("#viewport").focus();
  });
  $("#reset-area").addEventListener("click", () => { state.settings.area = null; runDetect(); refresh(); });
  $("#all-on").addEventListener("click", () => { state.pins.forEach((p) => (state.edits[p.key] = { ...(state.edits[p.key] || {}), include: true })); runDetect(); });
  $("#all-off").addEventListener("click", () => { state.pins.forEach((p) => (state.edits[p.key] = { ...(state.edits[p.key] || {}), include: false })); runDetect(); });
  $("#dl-import").addEventListener("click", guarded(exportImport));
  $("#batch-heads").addEventListener("change", () => copiedBatches.clear() || updateExport());
  $("#dl-pdf").addEventListener("click", guarded(exportPdf));
  $("#dl-png").addEventListener("click", guarded(exportPng));
  $("#dl-calibration").addEventListener("click", guarded(exportCalibration));
  $("#start-over").addEventListener("click", startOver);
  $("#undo").addEventListener("click", undo);
  $("#redo").addEventListener("click", redo);
  $("#try-sample").addEventListener("click", guarded(trySample));
  $("#export-preview").addEventListener("toggle", updateExport);
  // Was the last click made with the keyboard (Enter or Space on a button)? Then moving focus to the drawing helps.
  document.addEventListener("click", (e) => { keyboardActivated = e.detail === 0; }, true);
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "z") return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || (t.tagName === "INPUT" && !["checkbox", "radio", "range", "button"].includes(t.type)) || t.tagName === "TEXTAREA")) return; // typing boxes keep their own undo
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  });
  window.addEventListener("error", (e) => { if (!/ResizeObserver/.test(e.message || "")) say(tr("Something went wrong: {err}", { err: e.message || "unknown" }), "err", whyText(e.error)); });
  window.addEventListener("unhandledrejection", (e) => { say(tr("Something went wrong: {err}", { err: e.reason?.message || e.reason || "unknown" }), "err", whyText(e.reason)); });

  // Drop files anywhere: a .pdf is the drawing, a .xlsx is the template, a .json is a rules file.
  let depth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault(); depth = 0; document.body.classList.remove("dragging");
    for (const f of e.dataTransfer?.files || []) {
      const n = f.name.toLowerCase();
      if (n.endsWith(".pdf")) await loadPdfFile(f);
      else if (n.endsWith(".xlsx")) await loadTemplateFile(f);
      else if (n.endsWith(".json")) await loadRules(f);
      else say(tr("\"{name}\" isn't a PDF drawing, an .xlsx template or a setup file.", { name: f.name }), "err");
    }
  });
}

restore();
resetHistory();
$("#plan-name").value = state.settings.planName || "";
$("#room-pattern").value = state.settings.roomPattern || "";
$("#room-distance").value = state.settings.roomDistance || 10;
$("#show-grid").checked = !!state.settings.showGrid;
wire();
setupStage();
startAnalytics();
await initLanguageMenu({
  onChange: async () => {
    renderPdfInfo(); renderTplInfo(); renderTemplateInfo(); renderRules(); updateAreaInfo(); refresh();
    $("#draw-area").textContent = state.areaMode ? tr("Cancel") : tr("Draw on sheet");
  },
});
translateDom();
hydrateInfo();
setTourHandler(() => startTour({ force: true }));
renderFooter();
renderPdfInfo();
renderTplInfo();
renderRules();
refresh();

// A new visitor gets the short tour once. Not for returning visitors with work saved, and not for automated browsers.
if (!navigator.webdriver && !hasWork()) setTimeout(() => { if (!hasWork()) startTour(); }, 600);
