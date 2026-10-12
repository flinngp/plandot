// Plandot: drawing PDF + rules + import template -> task import workbook.
// Everything happens in the browser. Nothing is uploaded.
import { detect, newRule, round2, chunk, IMPORT_LIMIT, pinMode, ruleKind } from "./core.js";
import { openPdf, readPage, readShapes, readGeometry, anchorFinder, renderInto } from "./pdfsource.js";
import { captureSymbol, findSymbols, sanitizeTemplate } from "./symbols.js";
import { readTemplate, writeImport, buildRows, buildCalibrationRows, extraColumns, orphanedColumns, applyMapping, TemplateError } from "./template.js";
import { markedUpPdf, pinsPng, download } from "./markup.js";
import { tr, LANGUAGES, initialLanguage, setLanguage, currentLanguage } from "./i18n.js";

const COLORS = ["#1f6fb4", "#d98200", "#2a9d6a", "#7a56c2", "#14a3b5", "#c23f7f", "#8a8d1e", "#5b6b7a"];
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

// ---------------------------------------------------------------- status line
function say(msg, kind = "") {
  const s = $("#status");
  s.textContent = msg;
  s.className = `status ${kind}`;
}

// ---------------------------------------------------------------- file loading
let loadRun = 0; // bumped by every new drawing and by Start over, so a slow read can tell it was overtaken
async function loadPdfFile(file) {
  const mine = ++loadRun;
  say(tr("Reading the drawing…"));
  let bytes, doc;
  try {
    bytes = await file.arrayBuffer();
    doc = await openPdf(bytes);
  } catch {
    if (mine === loadRun) say(tr("That file couldn't be read as a PDF."), "err");
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
  $("#stage").classList.remove("drawing");
  $("#sheet").hidden = false;
  $("#dropzone").hidden = true;
  $("#draw-area").disabled = false;
  const words = info.tokens.length;
  renderPdfInfo();
  await drawSheet();
  state.animate = true;
  runDetect();
}
function renderPdfInfo() {
  const el = $("#pdf-info");
  if (!state.pdf?.tokens) { el.textContent = tr(DEFAULT_PDF_INFO); el.classList.remove("warn"); return; }
  const words = state.pdf.tokens.length;
  el.textContent = words
    ? tr("{name} · {n} words of text found on this page.", { name: file(state.pdf.name), n: words.toLocaleString() })
    : tr("This page has no selectable text, so it is probably a scan. Callouts can't be found on it yet.");
  el.classList.toggle("warn", !words);
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
  if (t.missing.length) box.append(h("p", { class: "chips-note warn", text: tr("This template has no {list} column, so tasks can't be placed on a plan.", { list: t.missing.map(tr).join(` ${tr("or")} `) }) }));
  else box.append(h("p", { class: "chips-note", text: custom.length ? tr("Dark columns are filled in for you; red ones are custom attributes ({list}).", { list: custom.join(", ") }) : tr("Dark columns are filled in for you.") }));
  if (t.missing.length || t.guessed) box.append(mappingForm(t));
  if (t.prefilledRows) box.append(h("p", { class: "chips-note", text: t.prefilledRows === 1 ? tr("This template has 1 pre-filled row (task IDs). They are left out of the import file so existing tasks are never touched.") : tr("This template has {n} pre-filled rows (task IDs). They are left out of the import file so existing tasks are never touched.", { n: t.prefilledRows }) }));
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
function renderRules() {
  const box = $("#rules");
  box.replaceChildren();
  state.rules.forEach((rule, i) => box.append(ruleCard(rule, i)));
  updateRuleStatus();
}

function ruleCard(rule, index) {
  const cols = state.tpl?.parsed ? extraColumns(state.tpl.parsed) : [];
  const set = (patch) => { Object.assign(rule, patch); saveSoon(); if ("symbol" in patch) renderRules(); runDetect(); };
  const filled = () => Object.values(rule.columns || {}).filter(hasText).length;
  const moreSummary = h("summary", { text: tr("Other columns") });
  const refreshSummary = () => { moreSummary.textContent = filled() ? tr("Other columns ({n} set)", { n: filled() }) : tr("Other columns"); };

  const grid = h("div", { class: "more-grid" });
  if (!cols.length) grid.append(h("p", { class: "hint", text: tr("Load the import template to set category, assignee, dates and custom attributes.") }));
  for (const col of cols) {
    const isDate = /\bdate\b/i.test(col.header);
    const input = h("input", { type: "text", value: rule.columns?.[col.header] ?? "", autocomplete: "off", placeholder: isDate ? tr("2026-10-12 or 12/10/2026") : tr("Same for every task, or use {tag} {room}") });
    input.addEventListener("input", () => { rule.columns = { ...(rule.columns || {}), [col.header]: input.value }; refreshSummary(); saveSoon(); renderTemplateInfo(); runDetect(); });
    grid.append(h("label", {}, h("span", { class: STANDARD.has(col.header.trim().toLowerCase()) ? "" : "tag", text: col.header }), input));
  }
  refreshSummary();

  const name = h("input", { type: "text", value: rule.name, "aria-label": tr("Rule name"), autocomplete: "off" });
  name.addEventListener("input", () => set({ name: name.value }));
  const tags = h("input", { type: "text", id: `${rule.id}-tags`, value: rule.tags, placeholder: rule.usePattern ? "A[1-3]" : "A1, A2, A3", autocomplete: "off" });
  tags.addEventListener("input", () => set({ tags: tags.value }));
  const pattern = h("input", { type: "checkbox", checked: !!rule.usePattern });
  pattern.addEventListener("change", () => { tags.placeholder = pattern.checked ? "A[1-3]" : "A1, A2, A3"; set({ usePattern: pattern.checked }); });
  const title = h("input", { type: "text", id: `${rule.id}-title`, value: rule.title, autocomplete: "off" });
  title.addEventListener("input", () => set({ title: title.value }));
  const pinAt = h("select", { id: `${rule.id}-pin` },
    h("option", { value: "dot", text: tr("On the dot at the end of the leader line") }),
    h("option", { value: "text", text: tr("On the callout itself") }));
  pinAt.value = pinMode(rule);
  pinAt.addEventListener("change", () => set({ pinAt: pinAt.value }));

  const kind = h("select", { id: `${rule.id}-kind` },
    h("option", { value: "text", text: tr("A callout tag, like A1 or B2") }),
    h("option", { value: "symbol", text: tr("A symbol I draw a box around") }));
  kind.value = ruleKind(rule);
  kind.addEventListener("change", () => { rule.kind = kind.value; if (state.boxFor === rule.id) cancelSymbolBox(); afterRulesChange(); });

  const symbolFields = () => {
    const drawing = state.boxFor === rule.id;
    const level = h("input", { type: "range", min: 1, max: 5, step: 1, value: rule.strict ?? 3, id: `${rule.id}-strict`, "aria-label": tr("How closely a copy must match") });
    const levelText = h("span", { class: "level", text: tr(LEVELS[(rule.strict ?? 3) - 1]) });
    level.addEventListener("input", () => { levelText.textContent = tr(LEVELS[Number(level.value) - 1]); });
    level.addEventListener("change", () => set({ strict: Number(level.value) }));
    const rotate = h("input", { type: "checkbox", checked: rule.rotate !== false });
    rotate.addEventListener("change", () => set({ rotate: rotate.checked }));
    return [
      h("div", { class: "field" }, h("span", { class: "label", text: tr("Symbol") }),
        rule.symbol ? symbolPreview(rule, set) : null,
        h("div", { class: "row" }, h("button", { type: "button", class: "btn quiet", text: drawing ? tr("Cancel") : rule.symbol ? tr("Draw the box again") : tr("Draw a box around the symbol"), onclick: () => startSymbolBox(rule) })),
        h("p", { class: "hint", text: rule.symbol ? tr("Click the picture to move where the pin goes. Every copy of this symbol on the sheet gets one pin.") : tr("Draw a box that fully contains one example, such as a single patio door. Lines that stick out of the box are left out.") })),
      rule.symbol ? h("div", { class: "field" }, h("label", { for: `${rule.id}-strict`, text: tr("How closely a copy must match") }), h("div", { class: "slider" }, level, levelText),
        h("label", { class: "check" }, rotate, tr("Also find copies that are turned or mirrored")),
        h("p", { class: "hint", text: tr("Copies must be the same size as the one you boxed. If some are missed, move the slider towards Loose; if wrong things are picked up, towards Exact.") })) : null,
      h("div", { class: "field" }, h("label", { for: `${rule.id}-title`, text: tr("Task title") }), title,
        h("p", { class: "hint", text: tr("Fill-ins: {tag} (the rule name) {room} {room_label} {n}") })),
    ];
  };

  if (ruleKind(rule) === "symbol") {
    return h("div", { class: "rule", "data-id": rule.id, style: `--pin:${colorOf(index)}` },
      h("div", { class: "rule-head" }, name,
        h("button", { type: "button", class: "icon-btn", text: tr("Duplicate"), "aria-label": `${tr("Duplicate")} ${rule.name}`, onclick: () => { state.rules.splice(index + 1, 0, { ...structuredClone(rule), id: newRule().id, name: `${rule.name} ${tr("copy")}` }); afterRulesChange(); } }),
        h("button", { type: "button", class: "icon-btn", text: tr("Remove"), "aria-label": `${tr("Remove")} ${rule.name}`, onclick: () => { state.rules.splice(index, 1); if (!state.rules.length) state.rules.push(newRule(1)); afterRulesChange(); } })),
      h("div", { class: "field" }, h("label", { for: `${rule.id}-kind`, text: tr("Look for") }), kind),
      ...symbolFields(),
      h("details", { class: "more" }, moreSummary, grid),
      h("p", { class: "rule-status", "data-status": rule.id }));
  }

  return h("div", { class: "rule", "data-id": rule.id, style: `--pin:${colorOf(index)}` },
    h("div", { class: "rule-head" }, name,
      h("button", { type: "button", class: "icon-btn", text: tr("Duplicate"), "aria-label": `${tr("Duplicate")} ${rule.name}`, onclick: () => { state.rules.splice(index + 1, 0, { ...structuredClone(rule), id: newRule().id, name: `${rule.name} ${tr("copy")}` }); afterRulesChange(); } }),
      h("button", { type: "button", class: "icon-btn", text: tr("Remove"), "aria-label": `${tr("Remove")} ${rule.name}`, onclick: () => { state.rules.splice(index, 1); if (!state.rules.length) state.rules.push(newRule(1)); afterRulesChange(); } })),
    h("div", { class: "field" }, h("label", { for: `${rule.id}-kind`, text: tr("Look for") }), kind),
    h("div", { class: "field" }, h("label", { for: `${rule.id}-tags`, text: tr("Tags to find") }), tags,
      h("label", { class: "check" }, pattern, tr("Match with a pattern instead (regular expression)"))),
    h("div", { class: "field" }, h("label", { for: `${rule.id}-title`, text: tr("Task title") }), title,
      h("p", { class: "hint", text: tr("Fill-ins: {tag} {room} {room_label} {n}") })),
    h("div", { class: "field" }, h("label", { for: `${rule.id}-pin`, text: tr("Pin goes") }), pinAt,
      h("p", { class: "hint", text: tr("A callout with no leader line keeps its pin on the callout. One with two leaders gets two pins.") })),
    h("details", { class: "more" }, moreSummary, grid),
    h("p", { class: "rule-status", "data-status": rule.id }));
}

function afterRulesChange() {
  save();
  renderRules();
  renderTemplateInfo();
  runDetect();
}

function updateRuleStatus() {
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
    else if (!hasText(rule.tags)) p.textContent = tr("Add the tags to look for.");
    else if (!state.pdf) p.textContent = tr("Load a drawing to see matches.");
    else if (!n) p.textContent = tr("No callouts found with those tags.");
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
    }
  })();
  return pdf.geoPromise;
}

let detectRun = 0;
const runDetect = debounce(async () => {
  const run = ++detectRun;
  const pdf = state.pdf;
  if (!pdf) { state.pins = []; state.errors = {}; refresh(); return; }
  if (wantsDots() && !pdf.geoFailed) {
    await loadAnchors(pdf);
    if (run !== detectRun || state.pdf !== pdf) return; // a newer run (or a new drawing) took over
  }
  const symbolHits = await findAllSymbols(pdf);
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
}, 120);

/** Look for each symbol rule's symbol on this page. Results are remembered until the symbol or its settings change. */
async function findAllSymbols(pdf) {
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
    const params = `${rule.strict ?? 3}|${rule.rotate === false ? 0 : 1}`;
    let perTemplate = pdf.symbolCache.get(rule.symbol);
    if (!perTemplate) pdf.symbolCache.set(rule.symbol, (perTemplate = new Map()));
    let res = perTemplate.get(params);
    if (!res) {
      say(tr("Looking for \"{name}\" on the drawing…", { name: rule.name }));
      await new Promise((r) => setTimeout(r, 20)); // let the message paint before the search starts
      res = findSymbols(shapes.paths, rule.symbol, { level: rule.strict ?? 3, rotate: rule.rotate !== false });
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
let rulersBuilt = false;
function buildRulers() {
  if (rulersBuilt) return;
  rulersBuilt = true;
  const rx = $("#ruler-x"), ry = $("#ruler-y");
  for (let i = 0; i <= 100; i += 5) {
    const major = i % 10 === 0;
    if (major && i > 0 && i < 100) {
      rx.append(h("span", { class: "tick", style: `left:${i}%`, text: String(i) }));
      ry.append(h("span", { class: "tick", style: `top:${i}%`, text: String(i) }));
    } else if (!major) {
      rx.append(h("span", { class: "minor", style: `left:${i}%` }));
      ry.append(h("span", { class: "minor", style: `top:${i}%` }));
    }
  }
}

async function drawSheet() {
  buildRulers();
  const stage = $("#stage");
  await renderInto(state.pdf.page, $("#pdf-canvas"), stage.clientWidth);
  renderOverlay();
  updateStick();
}

/** The sheet follows you down the page only when all of it fits in the window. */
function updateStick() {
  const pane = $(".sheetpane");
  pane.classList.toggle("stick", pane.offsetHeight <= window.innerHeight - 28);
}

const pxToUnits = () => state.pdf.width / $("#stage").clientWidth;

function renderOverlay() {
  const o = $("#overlay");
  o.replaceChildren();
  const pdf = state.pdf;
  if (!pdf) return;
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
  const r = 11 * k;
  state.pins.forEach((p, i) => {
    const g = svg("g", { class: `pin${p.include ? "" : " off"}${state.animate ? " enter" : ""}`, "data-key": p.key, tabindex: 0, role: "button", "aria-pressed": String(p.include), "aria-label": `${tr("Pin")} ${p.n}, ${p.title || p.tag}, ${p.include ? tr("included") : tr("excluded")}` });
    if (state.animate) g.style.setProperty("--i", Math.min(i, 60));
    g.append(svg("circle", { class: "halo", cx: p.x, cy: p.y, r: r + 2.2 * k }));
    const dot = svg("circle", { class: "dot", cx: p.x, cy: p.y, r, fill: colorOf(p.ruleIndex) });
    g.append(dot);
    const t = svg("text", { x: p.x, y: p.y, "font-size": `${(p.n > 99 ? 9 : 12) * k}px` });
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

// pointer: readout, crosshair, rulers, and drawing the search area
function stagePoint(ev) {
  const r = $("#stage").getBoundingClientRect();
  return [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))];
}
function setupStage() {
  const stage = $("#stage");
  stage.addEventListener("pointermove", (ev) => {
    if (!state.pdf) return;
    const [fx, fy] = stagePoint(ev);
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
  });
  stage.addEventListener("pointerleave", () => {
    $("#readout").innerHTML = "X –&nbsp; Y –";
    $("#cross")?.setAttribute("visibility", "hidden");
    $("#marker-x").style.display = $("#marker-y").style.display = "none";
  });
  stage.addEventListener("pointerdown", (ev) => {
    if (!state.areaMode && !state.boxFor) return;
    ev.preventDefault();
    stage.setPointerCapture(ev.pointerId);
    state.areaStart = stagePoint(ev);
    state.areaDraft = null;
    state.boxDraft = null;
  });
  stage.addEventListener("pointerup", () => {
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
  });
  new ResizeObserver(debounce(() => { if (state.pdf && !$("#sheet").hidden) drawSheet(); }, 150)).observe(stage);
  window.addEventListener("resize", debounce(updateStick, 100));
}

// ---------------------------------------------------------------- symbols
function startSymbolBox(rule) {
  if (!state.pdf) { say(tr("Load a drawing first, then draw a box around the symbol."), "err"); return; }
  if (state.boxFor === rule.id) { cancelSymbolBox(); return; }
  state.areaMode = false;
  $("#draw-area").textContent = tr("Draw on sheet");
  state.boxFor = rule.id;
  $("#stage").classList.add("drawing");
  say(tr("Drag a box on the sheet that fully contains the symbol."));
  renderRules();
  $("#stage").scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function cancelSymbolBox() {
  state.boxFor = null; state.boxDraft = null; state.areaStart = null;
  $("#stage").classList.remove("drawing");
  say("");
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
    body.append(h("tr", {}, h("td", { colspan: 9, class: "empty", text: tr("No pins yet. Add the tags to look for in a rule and they appear here and on the sheet.") })));
  }
  const LIMIT = 1000;
  state.pins.slice(0, LIMIT).forEach((p) => {
    const box = h("input", { type: "checkbox", checked: p.include, "aria-label": `${tr("Include pin")} ${p.n}` });
    box.addEventListener("change", () => togglePin(p.key, box.checked));
    const title = h("input", { type: "text", value: p.title, "aria-label": `${tr("Task title for pin")} ${p.n}` });
    title.addEventListener("input", () => { p.title = title.value; state.edits[p.key] = { ...(state.edits[p.key] || {}), title: title.value }; });
    const row = h("tr", { "data-key": p.key, class: p.include ? "" : "off", style: `--pin:${colorOf(p.ruleIndex)}` },
      h("td", {}, box), h("td", { text: String(p.n) }),
      h("td", { class: "rulecell" }, h("span", { class: "dot" }), p.ruleName),
      h("td", { text: p.tag }), h("td", { text: p.room }), h("td", { class: p.anchor === "dot" ? "" : "muted", text: pinnedOn(p) }), h("td", {}, title),
      h("td", { class: "num-col", text: round2(p.px).toFixed(2) }), h("td", { class: "num-col", text: round2(p.py).toFixed(2) }));
    row.addEventListener("pointerenter", () => hot(p.key, true));
    row.addEventListener("pointerleave", () => hot(p.key, false));
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
  const parts = Math.ceil(inc / IMPORT_LIMIT);
  $("#import-why").textContent = need.length
    ? tr("Still needed: {list}.", { list: need.join(", ") })
    : parts > 1
      ? tr("Fieldwire imports up to {limit} tasks at a time, so this downloads {parts} files. Import them one after another.", { limit: IMPORT_LIMIT, parts })
      : tr("Tasks import with a blank ID, so they are created as new tasks.");
  $("#dl-pdf").disabled = !(state.pdf && inc) || state.busy;
  $("#dl-png").disabled = !(state.pdf && inc) || state.busy;
  $("#dl-calibration").disabled = !(t && !t.missing.length && plan);
}

async function exportImport() {
  const t = state.tpl.parsed;
  const pins = included().map((p) => ({ ...p, title: hasText(p.title) ? p.title : p.tag }));
  const rulesById = Object.fromEntries(state.rules.map((r) => [r.id, r]));
  const rows = buildRows(t, pins, { planName: state.settings.planName.trim(), rulesById });
  const groups = chunk(rows);
  for (const [i, group] of groups.entries()) {
    const bytes = await writeImport(t, group);
    const suffix = groups.length > 1 ? ` (part ${i + 1} of ${groups.length})` : ""; // file names stay English so they sort the same for everyone
    download(bytes, `${baseName(state.pdf.name)} - task import${suffix}.xlsx`, XLSX_MIME);
  }
  const plan = state.settings.planName.trim();
  say(groups.length > 1
    ? tr("Downloaded {n} tasks in {files} files for plan \"{plan}\".", { n: rows.length, files: groups.length, plan })
    : rows.length === 1 ? tr("Downloaded 1 task for plan \"{plan}\".", { plan }) : tr("Downloaded {n} tasks for plan \"{plan}\".", { n: rows.length, plan }), "ok");
}

async function exportPdf() {
  const bytes = await markedUpPdf(state.pdf.bytes, state.pdf.pageNo, included(), colorOf);
  download(bytes, `${baseName(state.pdf.name)} - marked up.pdf`, "application/pdf");
  say(tr("Downloaded the marked-up PDF."), "ok");
}

async function exportPng() {
  const blob = await pinsPng($("#pdf-canvas"), state.pdf.width, included(), state.rules, colorOf);
  download(blob, `${baseName(state.pdf.name)} - pins.png`, "image/png");
  say(tr("Downloaded the pin image."), "ok");
}

async function exportCalibration() {
  const t = state.tpl.parsed;
  const bytes = await writeImport(t, buildCalibrationRows(t, state.settings.planName.trim()));
  download(bytes, "calibration tasks.xlsx", XLSX_MIME);
  say(tr("Downloaded 9 calibration tasks at 10%, 50% and 90%."), "ok");
}

// ---------------------------------------------------------------- start over
const DEFAULT_SETTINGS = { planName: "", roomPattern: "", roomDistance: 10, area: null, showGrid: false };


/** Is there anything on the page the user would lose? */
function hasWork() {
  return !!(state.pdf || state.tpl || hasText(state.settings.planName) || state.rules.length > 1 || state.rules.some((r) => hasText(r.tags) || r.symbol));
}

function startOver() {
  if (hasWork() && !window.confirm(tr("Start over? This clears the drawing, the import template, your rules and the pins, and takes you back to the beginning.\n\nSaved rules files on your computer are not touched. Choose Save rules first if you want to keep these rules."))) return;
  loadRun++;
  detectRun++; // anything still being worked out for the old drawing is thrown away
  try { state.pdf?.doc?.destroy?.(); } catch { /* already gone */ }
  Object.assign(state, { pdf: null, tpl: null, rules: [newRule(1)], settings: { ...DEFAULT_SETTINGS }, edits: {}, pins: [], errors: {}, areaMode: false, areaStart: null, areaDraft: null, boxFor: null, boxDraft: null, animate: false, busy: false });
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
  $("#sheet").hidden = true;
  $("#dropzone").hidden = false;
  $("#readout").innerHTML = "X –&nbsp; Y –";

  renderTemplateInfo();
  renderRules();
  refresh();
  updateStick();
  window.scrollTo({ top: 0 });
  say(tr("Everything is cleared. Drop a drawing to begin again."), "ok");
}

const guarded = (fn) => async () => {
  try { await fn(); } catch (err) { console.error(err); say(tr("Something went wrong: {err}", { err: err.message || err }), "err"); }
};

// ---------------------------------------------------------------- rule files
function saveRules() {
  const payload = { app: "plandot", version: 1, settings: { roomPattern: state.settings.roomPattern, roomDistance: state.settings.roomDistance }, rules: state.rules.map((r) => {
    const { name, tags, usePattern, title, columns, pinAt } = r;
    const base = { name, tags, usePattern: !!usePattern, title, pinAt: pinMode({ pinAt }), columns: columns || {} };
    return ruleKind(r) === "symbol" ? { ...base, kind: "symbol", symbol: r.symbol || null, strict: r.strict ?? 3, rotate: r.rotate !== false } : base;
  }) };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), "plandot rules.json", "application/json");
  say(payload.rules.length === 1 ? tr("Saved 1 rule.") : tr("Saved {n} rules.", { n: payload.rules.length }), "ok");
}
async function loadRules(f) {
  try {
    const data = JSON.parse(await f.text());
    if (!["plandot", "plan-tasks"].includes(data.app) || !Array.isArray(data.rules)) throw new Error("not a Plandot rules file");
    state.rules = data.rules.map((r, i) => ({ ...newRule(i + 1), name: String(r.name ?? `Rule ${i + 1}`), tags: String(r.tags ?? ""), usePattern: !!r.usePattern, title: String(r.title ?? "{tag}"), pinAt: r.pinAt === "text" ? "text" : "dot", columns: typeof r.columns === "object" && r.columns ? r.columns : {}, ...(r.kind === "symbol" ? { kind: "symbol", symbol: sanitizeTemplate(r.symbol), strict: [1, 2, 3, 4, 5].includes(r.strict) ? r.strict : 3, rotate: r.rotate !== false } : {}) }));
    if (data.settings) {
      state.settings.roomPattern = String(data.settings.roomPattern ?? "");
      state.settings.roomDistance = Number(data.settings.roomDistance) || 10;
      $("#room-pattern").value = state.settings.roomPattern;
      $("#room-distance").value = state.settings.roomDistance;
    }
    afterRulesChange();
    say(state.rules.length === 1 ? tr("Loaded 1 rule.") : tr("Loaded {n} rules.", { n: state.rules.length }), "ok");
  } catch (err) {
    say(tr("That isn't a Plandot rules file ({err}).", { err: err.message }), "err");
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
    $("#stage").classList.toggle("drawing", state.areaMode);
    $("#draw-area").textContent = state.areaMode ? tr("Cancel") : tr("Draw on sheet");
    updateAreaInfo();
  });
  $("#reset-area").addEventListener("click", () => { state.settings.area = null; runDetect(); refresh(); });
  $("#all-on").addEventListener("click", () => { state.pins.forEach((p) => (state.edits[p.key] = { ...(state.edits[p.key] || {}), include: true })); runDetect(); });
  $("#all-off").addEventListener("click", () => { state.pins.forEach((p) => (state.edits[p.key] = { ...(state.edits[p.key] || {}), include: false })); runDetect(); });
  $("#dl-import").addEventListener("click", guarded(exportImport));
  $("#dl-pdf").addEventListener("click", guarded(exportPdf));
  $("#dl-png").addEventListener("click", guarded(exportPng));
  $("#dl-calibration").addEventListener("click", guarded(exportCalibration));
  $("#start-over").addEventListener("click", startOver);

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
      else say(tr("\"{name}\" isn't a PDF drawing, an .xlsx template or a rules file.", { name: f.name }), "err");
    }
  });
}

restore();
$("#plan-name").value = state.settings.planName || "";
$("#room-pattern").value = state.settings.roomPattern || "";
$("#room-distance").value = state.settings.roomDistance || 10;
$("#show-grid").checked = !!state.settings.showGrid;
wire();
setupStage();
{
  const sel = $("#lang");
  for (const [code, name] of LANGUAGES) sel.append(h("option", { value: code, text: name }));
  sel.value = initialLanguage();
  await setLanguage(sel.value, { remember: false });
  sel.addEventListener("change", async () => {
    await setLanguage(sel.value);
    renderPdfInfo(); renderTplInfo(); renderTemplateInfo(); renderRules(); updateAreaInfo(); refresh();
    $("#draw-area").textContent = state.areaMode ? tr("Cancel") : tr("Draw on sheet");
  });
}
renderPdfInfo();
renderTplInfo();
renderRules();
refresh();
