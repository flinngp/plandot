// Plandot: drawing PDF + rules + import template -> task import workbook.
// Everything happens in the browser. Nothing is uploaded.
import { detect, newRule, round2, chunk, IMPORT_LIMIT, pinMode } from "./core.js";
import { openPdf, readPage, readGeometry, anchorFinder, renderInto } from "./pdfsource.js";
import { readTemplate, writeImport, buildRows, buildCalibrationRows, extraColumns, orphanedColumns, TemplateError } from "./template.js";
import { markedUpPdf, pinsPng, download } from "./markup.js";

const COLORS = ["#1f6fb4", "#d98200", "#2a9d6a", "#7a56c2", "#14a3b5", "#c23f7f", "#8a8d1e", "#5b6b7a"];
const colorOf = (i) => COLORS[i % COLORS.length];
const STANDARD = new Set(["id", "title", "priority", "category", "assignee", "start date", "end date", "plan", "x pos (%)", "y pos (%)", "tier 1", "tier 2", "tier 3", "tier 4", "tier 5", "manpower", "cost", "description / hashtags", "related task name", "checklist", "existing file"]);
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const STORE_KEY = "plantasks.v1";
const SVG_NS = "http://www.w3.org/2000/svg";

const $ = (sel) => document.querySelector(sel);
const state = {
  pdf: null, // {name, bytes, doc, pageNo, page, width, height, tokens}
  tpl: null, // {name, parsed}
  rules: [],
  settings: { planName: "", roomPattern: "", roomDistance: 10, area: null, showGrid: false },
  edits: {}, // pin key -> {include?, title?}
  pins: [],
  errors: {},
  areaMode: false,
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
    if (saved?.rules?.length) state.rules = saved.rules;
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
async function loadPdfFile(file) {
  say("Reading the drawing…");
  let bytes, doc;
  try {
    bytes = await file.arrayBuffer();
    doc = await openPdf(bytes);
  } catch {
    say("That file couldn't be read as a PDF.", "err");
    return;
  }
  state.pdf = { name: file.name, bytes, doc, pageNo: 1 };
  const select = $("#page-select");
  select.replaceChildren(...Array.from({ length: doc.numPages }, (_, i) => h("option", { value: i + 1, text: `Page ${i + 1}` })));
  $("#page-field").hidden = doc.numPages < 2;
  await loadPage(1);
  say("");
}

async function loadPage(n) {
  const info = await readPage(state.pdf.doc, n);
  Object.assign(state.pdf, { pageNo: n, page: info.page, viewport: info.viewport, width: info.width, height: info.height, tokens: info.tokens, geoPromise: null, anchorFor: null, geoFailed: false });
  state.edits = {};
  state.pins = [];
  state.settings.area = null;
  state.areaMode = false;
  $("#sheet").hidden = false;
  $("#dropzone").hidden = true;
  $("#draw-area").disabled = false;
  const words = info.tokens.length;
  $("#pdf-info").textContent = words
    ? `${file(state.pdf.name)} · ${words.toLocaleString()} words of text found on this page.`
    : "This page has no selectable text, so it is probably a scan. Callouts can't be found on it yet.";
  $("#pdf-info").classList.toggle("warn", !words);
  await drawSheet();
  state.animate = true;
  runDetect();
}
const file = (n) => (n.length > 38 ? `${n.slice(0, 35)}…` : n);

async function loadTemplateFile(f) {
  try {
    const parsed = await readTemplate(await f.arrayBuffer());
    state.tpl = { name: f.name, parsed };
    $("#tpl-info").textContent = `${file(f.name)}${parsed.projectName ? ` · ${parsed.projectName}` : ""}`;
    if (!hasText(state.settings.planName)) { /* leave blank: the user has to confirm the exact plan name */ }
    say("");
  } catch (err) {
    state.tpl = null;
    $("#tpl-info").textContent = err instanceof TemplateError ? err.message : "That file couldn't be read as a template.";
    say(err instanceof TemplateError ? err.message : "That file couldn't be read as a template.", "err");
  }
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
    box.append(h("span", { class: cls, text: c.role === "id" ? "ID (left blank)" : c.header, title: c.role ? "Filled in by Plandot" : isCustom ? "Custom attribute" : "You can set this per rule" }));
  }
  if (t.missing.length) box.append(h("p", { class: "chips-note warn", text: `This template has no ${t.missing.join(" or ")} column, so tasks can't be placed on a plan.` }));
  else box.append(h("p", { class: "chips-note", text: `Dark columns are filled in for you${custom.length ? `; red ones are custom attributes (${custom.join(", ")})` : ""}.` }));
  if (t.prefilledRows) box.append(h("p", { class: "chips-note", text: `This template has ${t.prefilledRows} pre-filled row${t.prefilledRows === 1 ? "" : "s"} (task IDs). They are left out of the import file so existing tasks are never touched.` }));
  const orphans = orphanedColumns(state.rules, t);
  if (orphans.length) box.append(h("p", { class: "chips-note warn", text: `Rules have values for columns this template doesn't have, so they are ignored: ${orphans.join(", ")}.` }));
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
  const set = (patch) => { Object.assign(rule, patch); saveSoon(); runDetect(); };
  const filled = () => Object.values(rule.columns || {}).filter(hasText).length;
  const moreSummary = h("summary", { text: "Other columns" });
  const refreshSummary = () => { moreSummary.textContent = `Other columns${filled() ? ` (${filled()} set)` : ""}`; };

  const grid = h("div", { class: "more-grid" });
  if (!cols.length) grid.append(h("p", { class: "hint", text: "Load the import template to set category, assignee, dates and custom attributes." }));
  for (const col of cols) {
    const isDate = /\bdate\b/i.test(col.header);
    const input = h("input", { type: "text", value: rule.columns?.[col.header] ?? "", autocomplete: "off", placeholder: isDate ? "2026-10-12 or 12/10/2026" : "Same for every task, or use {tag} {room}" });
    input.addEventListener("input", () => { rule.columns = { ...(rule.columns || {}), [col.header]: input.value }; refreshSummary(); saveSoon(); renderTemplateInfo(); runDetect(); });
    grid.append(h("label", {}, h("span", { class: STANDARD.has(col.header.trim().toLowerCase()) ? "" : "tag", text: col.header }), input));
  }
  refreshSummary();

  const name = h("input", { type: "text", value: rule.name, "aria-label": "Rule name", autocomplete: "off" });
  name.addEventListener("input", () => set({ name: name.value }));
  const tags = h("input", { type: "text", id: `${rule.id}-tags`, value: rule.tags, placeholder: rule.usePattern ? "A[1-3]" : "A1, A2, A3", autocomplete: "off" });
  tags.addEventListener("input", () => set({ tags: tags.value }));
  const pattern = h("input", { type: "checkbox", checked: !!rule.usePattern });
  pattern.addEventListener("change", () => { tags.placeholder = pattern.checked ? "A[1-3]" : "A1, A2, A3"; set({ usePattern: pattern.checked }); });
  const title = h("input", { type: "text", id: `${rule.id}-title`, value: rule.title, autocomplete: "off" });
  title.addEventListener("input", () => set({ title: title.value }));
  const pinAt = h("select", { id: `${rule.id}-pin` },
    h("option", { value: "dot", text: "On the dot at the end of the leader line" }),
    h("option", { value: "text", text: "On the callout itself" }));
  pinAt.value = pinMode(rule);
  pinAt.addEventListener("change", () => set({ pinAt: pinAt.value }));

  return h("div", { class: "rule", "data-id": rule.id, style: `--pin:${colorOf(index)}` },
    h("div", { class: "rule-head" }, name,
      h("button", { type: "button", class: "icon-btn", text: "Duplicate", "aria-label": `Duplicate ${rule.name}`, onclick: () => { state.rules.splice(index + 1, 0, { ...structuredClone(rule), id: newRule().id, name: `${rule.name} copy` }); afterRulesChange(); } }),
      h("button", { type: "button", class: "icon-btn", text: "Remove", "aria-label": `Remove ${rule.name}`, onclick: () => { state.rules.splice(index, 1); if (!state.rules.length) state.rules.push(newRule(1)); afterRulesChange(); } })),
    h("div", { class: "field" }, h("label", { for: `${rule.id}-tags`, text: "Tags to find" }), tags,
      h("label", { class: "check" }, pattern, "Match with a pattern instead (regular expression)")),
    h("div", { class: "field" }, h("label", { for: `${rule.id}-title`, text: "Task title" }), title,
      h("p", { class: "hint", text: "Fill-ins: {tag} {room} {room_label} {n}" })),
    h("div", { class: "field" }, h("label", { for: `${rule.id}-pin`, text: "Pin goes" }), pinAt,
      h("p", { class: "hint", text: "A callout with no leader line keeps its pin on the callout. One with two leaders gets two pins." })),
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
    if (state.errors[rule.id]) { p.classList.add("err"); p.textContent = state.errors[rule.id]; }
    else if (!hasText(rule.tags)) p.textContent = "Add the tags to look for.";
    else if (!state.pdf) p.textContent = "Load a drawing to see matches.";
    else if (!n) p.textContent = "No callouts found with those tags.";
    else {
      const mine = state.pins.filter((x) => x.ruleId === rule.id);
      const callouts = mine.filter((x) => x.anchorIndex === 1).length;
      p.append(h("span", { class: "found", text: `${callouts} found${mine.length !== callouts ? `, ${mine.length} pins` : ""}` }));
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
const wantsDots = () => state.rules.some((r) => hasText(r.tags) && pinMode(r) === "dot");

/** Read the page's lines once, in the background, the first time a rule wants dots. */
function loadAnchors(pdf) {
  pdf.geoPromise ??= (async () => {
    const page = pdf.page;
    state.busy = true;
    updateExport();
    say("Finding the leader lines and dots on the drawing…");
    try {
      const anchorFor = anchorFinder(await readGeometry(page), pdf.viewport);
      if (pdf.page === page) pdf.anchorFor = anchorFor;
      say("");
    } catch (err) {
      console.error(err);
      if (pdf.page === page) pdf.geoFailed = true;
      say("Couldn't read the lines on this drawing, so pins are on the callouts instead.", "err");
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
  const { pins, errors } = detect({ tokens: pdf.tokens, width: pdf.width, height: pdf.height, rules: state.rules, anchorFor: wantsDots() ? pdf.anchorFor : null, settings: { area: state.settings.area, roomPattern: state.settings.roomPattern, roomDistance: state.settings.roomDistance } });
  for (const p of pins) {
    const e = state.edits[p.key] || {};
    if (e.title != null) p.title = e.title;
    p.include = e.include !== false;
  }
  state.pins = pins;
  state.errors = errors;
  refresh();
}, 120);

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

  const tethers = svg("g");
  for (const p of state.pins) {
    if (p.anchor === "text") continue;
    tethers.append(svg("line", { class: "tether", x1: p.tx, y1: p.ty, x2: p.x, y2: p.y }));
  }
  o.append(tethers);

  const pins = svg("g");
  const r = 11 * k;
  state.pins.forEach((p, i) => {
    const g = svg("g", { class: `pin${p.include ? "" : " off"}${state.animate ? " enter" : ""}`, "data-key": p.key, tabindex: 0, role: "button", "aria-pressed": String(p.include), "aria-label": `Pin ${p.n}, ${p.title || p.tag}, ${p.include ? "included" : "excluded"}` });
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
      state.areaDraft = [Math.min(sx, fx), Math.min(sy, fy), Math.max(sx, fx), Math.max(sy, fy)];
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
    if (!state.areaMode) return;
    ev.preventDefault();
    stage.setPointerCapture(ev.pointerId);
    state.areaStart = stagePoint(ev);
    state.areaDraft = null;
  });
  stage.addEventListener("pointerup", () => {
    if (!state.areaMode || !state.areaStart) return;
    const a = state.areaDraft;
    state.areaStart = null; state.areaDraft = null;
    state.areaMode = false;
    stage.classList.remove("drawing");
    $("#draw-area").textContent = "Draw on sheet";
    if (a && a[2] - a[0] > 0.01 && a[3] - a[1] > 0.01) state.settings.area = a;
    runDetect();
    refresh();
  });
  new ResizeObserver(debounce(() => { if (state.pdf && !$("#sheet").hidden) drawSheet(); }, 150)).observe(stage);
}

function updateAreaInfo() {
  const a = state.settings.area;
  $("#reset-area").disabled = !a;
  $("#area-info").textContent = state.areaMode
    ? "Drag a box on the sheet around the part that holds the callouts."
    : a
      ? `Searching x ${Math.round(a[0] * 100)}–${Math.round(a[2] * 100)}% and y ${Math.round(a[1] * 100)}–${Math.round(a[3] * 100)}% of the sheet.`
      : "Ignore keynotes and the title block by limiting the search to part of the sheet.";
}

// ---------------------------------------------------------------- pin table
const pinnedOn = (p) =>
  p.anchor === "dot" ? (p.anchorCount > 1 ? `Dot ${p.anchorIndex} of ${p.anchorCount}` : "Dot")
  : p.anchor === "leader" ? "Leader end (no dot)"
  : "Callout";

function renderTable() {
  const wrap = $("#pinlist");
  wrap.hidden = !state.pdf;
  const body = $("#pin-rows");
  body.replaceChildren();
  if (!state.pdf) return;
  if (!state.pins.length) {
    body.append(h("tr", {}, h("td", { colspan: 9, class: "empty", text: "No pins yet. Add the tags to look for in a rule and they appear here and on the sheet." })));
  }
  const LIMIT = 1000;
  state.pins.slice(0, LIMIT).forEach((p) => {
    const box = h("input", { type: "checkbox", checked: p.include, "aria-label": `Include pin ${p.n}` });
    box.addEventListener("change", () => togglePin(p.key, box.checked));
    const title = h("input", { type: "text", value: p.title, "aria-label": `Task title for pin ${p.n}` });
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
  if (state.pins.length > LIMIT) body.append(h("tr", {}, h("td", { colspan: 9, class: "empty", text: `Showing the first ${LIMIT} of ${state.pins.length} pins. All of them are still exported.` })));
  updateTableHead();
}
function updateTableHead() {
  $("#pinlist-title").textContent = `Pins · ${included().length} of ${state.pins.length} included`;
}

// ---------------------------------------------------------------- title block + exports
function updateTitleBlock() {
  const pdf = state.pdf;
  $("#tb-name").textContent = pdf ? baseName(pdf.name) : "None loaded";
  $("#tb-name").title = pdf ? pdf.name : "";
  $("#tb-size").textContent = pdf ? `${fmtIn(pdf.width / 72)} × ${fmtIn(pdf.height / 72)} in` : "–";
  $("#tb-pins").textContent = state.pins.length ? `${included().length} / ${state.pins.length}` : "0";
}

function updateExport() {
  const t = state.tpl?.parsed;
  const plan = hasText(state.settings.planName);
  const inc = included().length;
  const need = [];
  if (!state.pdf) need.push("load a drawing");
  else if (!inc) need.push("include at least one pin");
  if (!t) need.push("load the import template");
  else if (t.missing.length) need.push(`use a template with ${t.missing.join(" and ")}`);
  if (!plan) need.push("enter the plan name");
  if (state.busy) need.push("wait for the drawing's lines to finish loading");
  $("#dl-import").disabled = need.length > 0;
  const parts = Math.ceil(inc / IMPORT_LIMIT);
  $("#import-why").textContent = need.length
    ? `Still needed: ${need.join(", ")}.`
    : parts > 1
      ? `Fieldwire imports up to ${IMPORT_LIMIT} tasks at a time, so this downloads ${parts} files. Import them one after another.`
      : "Tasks import with a blank ID, so they are created as new tasks.";
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
    const suffix = groups.length > 1 ? ` (part ${i + 1} of ${groups.length})` : "";
    download(bytes, `${baseName(state.pdf.name)} - task import${suffix}.xlsx`, XLSX_MIME);
  }
  const files = groups.length > 1 ? ` in ${groups.length} files` : "";
  say(`Downloaded ${rows.length} task${rows.length === 1 ? "" : "s"}${files} for plan "${state.settings.planName.trim()}".`, "ok");
}

async function exportPdf() {
  const bytes = await markedUpPdf(state.pdf.bytes, state.pdf.pageNo, included(), colorOf);
  download(bytes, `${baseName(state.pdf.name)} - marked up.pdf`, "application/pdf");
  say("Downloaded the marked-up PDF.", "ok");
}

async function exportPng() {
  const blob = await pinsPng($("#pdf-canvas"), state.pdf.width, included(), state.rules, colorOf);
  download(blob, `${baseName(state.pdf.name)} - pins.png`, "image/png");
  say("Downloaded the pin image.", "ok");
}

async function exportCalibration() {
  const t = state.tpl.parsed;
  const bytes = await writeImport(t, buildCalibrationRows(t, state.settings.planName.trim()));
  download(bytes, "calibration tasks.xlsx", XLSX_MIME);
  say("Downloaded 9 calibration tasks at 10%, 50% and 90%.", "ok");
}

const guarded = (fn) => async () => {
  try { await fn(); } catch (err) { console.error(err); say(`Something went wrong: ${err.message || err}`, "err"); }
};

// ---------------------------------------------------------------- rule files
function saveRules() {
  const payload = { app: "plandot", version: 1, settings: { roomPattern: state.settings.roomPattern, roomDistance: state.settings.roomDistance }, rules: state.rules.map(({ name, tags, usePattern, title, columns, pinAt }) => ({ name, tags, usePattern: !!usePattern, title, pinAt: pinMode({ pinAt }), columns: columns || {} })) };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), "plandot rules.json", "application/json");
  say(`Saved ${payload.rules.length} rule${payload.rules.length === 1 ? "" : "s"}.`, "ok");
}
async function loadRules(f) {
  try {
    const data = JSON.parse(await f.text());
    if (!["plandot", "plan-tasks"].includes(data.app) || !Array.isArray(data.rules)) throw new Error("not a Plandot rules file");
    state.rules = data.rules.map((r, i) => ({ ...newRule(i + 1), name: String(r.name ?? `Rule ${i + 1}`), tags: String(r.tags ?? ""), usePattern: !!r.usePattern, title: String(r.title ?? "{tag}"), pinAt: r.pinAt === "text" ? "text" : "dot", columns: typeof r.columns === "object" && r.columns ? r.columns : {} }));
    if (data.settings) {
      state.settings.roomPattern = String(data.settings.roomPattern ?? "");
      state.settings.roomDistance = Number(data.settings.roomDistance) || 10;
      $("#room-pattern").value = state.settings.roomPattern;
      $("#room-distance").value = state.settings.roomDistance;
    }
    afterRulesChange();
    say(`Loaded ${state.rules.length} rule${state.rules.length === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    say(`That isn't a Plandot rules file (${err.message}).`, "err");
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
    $("#draw-area").textContent = state.areaMode ? "Cancel" : "Draw on sheet";
    updateAreaInfo();
  });
  $("#reset-area").addEventListener("click", () => { state.settings.area = null; runDetect(); refresh(); });
  $("#all-on").addEventListener("click", () => { state.pins.forEach((p) => (state.edits[p.key] = { ...(state.edits[p.key] || {}), include: true })); runDetect(); });
  $("#all-off").addEventListener("click", () => { state.pins.forEach((p) => (state.edits[p.key] = { ...(state.edits[p.key] || {}), include: false })); runDetect(); });
  $("#dl-import").addEventListener("click", guarded(exportImport));
  $("#dl-pdf").addEventListener("click", guarded(exportPdf));
  $("#dl-png").addEventListener("click", guarded(exportPng));
  $("#dl-calibration").addEventListener("click", guarded(exportCalibration));

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
      else say(`"${f.name}" isn't a PDF drawing, an .xlsx template or a rules file.`, "err");
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
renderRules();
refresh();
