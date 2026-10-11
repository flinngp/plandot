// Reads a Task Importer workbook and fills it with new rows by editing the sheet XML
// directly. Everything else in the file (styles, widths, header block, document
// properties) is left exactly as the template had it.
//
// Columns are found by header text, never by position, because the template changes
// when custom task attributes are added or standard attributes are hidden.

import { renderTemplate, round2 } from "./core.js";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Columns the app fills itself. Anything else is a field the user can set per rule. */
export function roleOf(header) {
  const h = norm(header);
  if (h === "id") return "id";
  if (h === "title") return "title";
  if (h === "plan") return "plan";
  if (/^x pos/.test(h)) return "x";
  if (/^y pos/.test(h)) return "y";
  return null;
}

const HEADER_HINTS = new Set(["id", "title", "priority", "category", "assignee", "start date", "end date", "plan", "description / hashtags", "checklist"]);

export class TemplateError extends Error {}

export function colLetter(n) {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
export function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
const splitRef = (ref) => {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  return { col: colIndex(m[1]), letters: m[1], row: Number(m[2]) };
};

const parseXml = (text) => {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new TemplateError("The template contains invalid XML.");
  return doc;
};
const serialize = (doc) => XML_DECL + new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/, "");
const kids = (el, name) => Array.from(el.children).filter((c) => c.localName === name);

function readSharedStrings(doc) {
  if (!doc) return [];
  return kids(doc.documentElement, "si").map((si) =>
    Array.from(si.getElementsByTagNameNS(NS, "t")).map((t) => t.textContent).join(""),
  );
}

const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function dateStyles(stylesDoc) {
  const result = new Set();
  if (!stylesDoc) return result;
  const codes = new Map();
  for (const nf of Array.from(stylesDoc.getElementsByTagNameNS(NS, "numFmt"))) codes.set(Number(nf.getAttribute("numFmtId")), nf.getAttribute("formatCode") || "");
  const cellXfs = stylesDoc.getElementsByTagNameNS(NS, "cellXfs")[0];
  if (!cellXfs) return result;
  kids(cellXfs, "xf").forEach((xf, i) => {
    const id = Number(xf.getAttribute("numFmtId") || 0);
    const code = (codes.get(id) || "").replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
    if (BUILTIN_DATE_IDS.has(id) || (codes.has(id) && /[ymd]/i.test(code))) result.add(String(i));
  });
  return result;
}

function cellText(c, sst) {
  const t = c.getAttribute("t");
  if (t === "s") return sst[Number(c.getElementsByTagNameNS(NS, "v")[0]?.textContent)] ?? "";
  if (t === "inlineStr") return Array.from(c.getElementsByTagNameNS(NS, "t")).map((x) => x.textContent).join("");
  return c.getElementsByTagNameNS(NS, "v")[0]?.textContent ?? "";
}

/**
 * Open a template.
 * @param {ArrayBuffer|Uint8Array} data  the .xlsx bytes
 */
export async function readTemplate(data) {
  let zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new TemplateError("That file isn't a valid .xlsx workbook.");
  }
  const wbFile = zip.file("xl/workbook.xml");
  if (!wbFile) throw new TemplateError("That file isn't a valid .xlsx workbook.");
  const wb = parseXml(await wbFile.async("string"));
  const sheetEl = wb.getElementsByTagNameNS(NS, "sheet")[0];
  if (!sheetEl) throw new TemplateError("The workbook has no sheets.");
  const rid = sheetEl.getAttributeNS(REL_NS, "id");
  const rels = parseXml(await zip.file("xl/_rels/workbook.xml.rels").async("string"));
  const rel = Array.from(rels.getElementsByTagName("Relationship")).find((r) => r.getAttribute("Id") === rid);
  let target = rel?.getAttribute("Target") || "worksheets/sheet1.xml";
  const sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target}`;

  const sstFile = zip.file("xl/sharedStrings.xml");
  const sstDoc = sstFile ? parseXml(await sstFile.async("string")) : null;
  const sst = readSharedStrings(sstDoc);
  const sheetDoc = parseXml(await zip.file(sheetPath).async("string"));
  const stylesFile = zip.file("xl/styles.xml");
  const dateStyleSet = dateStyles(stylesFile ? parseXml(await stylesFile.async("string")) : null);

  const sheetData = sheetDoc.getElementsByTagNameNS(NS, "sheetData")[0];
  const rows = kids(sheetData, "row");

  // The header row is the first one (in the top 30) that has a Title cell and at least
  // three other recognisable headings.
  let headerRow = null;
  for (const row of rows) {
    if (Number(row.getAttribute("r")) > 30) break;
    const texts = kids(row, "c").map((c) => norm(cellText(c, sst)));
    if (texts.includes("title") && texts.filter((t) => HEADER_HINTS.has(t)).length >= 3) {
      headerRow = row;
      break;
    }
  }
  if (!headerRow) throw new TemplateError("Couldn't find the header row. The template needs a row with column names such as ID, Title, Category and Plan.");
  const headerNo = Number(headerRow.getAttribute("r"));

  const columns = [];
  for (const c of kids(headerRow, "c")) {
    const header = cellText(c, sst).trim();
    if (!header) continue;
    const { col, letters } = splitRef(c.getAttribute("r"));
    columns.push({ header, letters, index: col, role: roleOf(header) });
  }

  const firstData = rows.find((r) => Number(r.getAttribute("r")) === headerNo + 1);
  const styles = {};
  if (firstData) for (const c of kids(firstData, "c")) {
    const s = c.getAttribute("s");
    if (s != null) styles[splitRef(c.getAttribute("r")).letters] = s;
  }

  const missing = [];
  for (const [role, label] of [["title", "Title"], ["plan", "Plan"], ["x", "X Pos (%)"], ["y", "Y Pos (%)"]]) {
    if (!columns.some((c) => c.role === role)) missing.push(label);
  }
  const a2 = rows.find((r) => r.getAttribute("r") === "2");
  const a2Cell = a2 && kids(a2, "c")[0];
  const projectName = a2Cell ? cellText(a2Cell, sst) : "";

  // Rows under the header that already hold something (Fieldwire pre-fills task IDs).
  // They are dropped from the output so existing tasks are never touched.
  const prefilledRows = rows.filter(
    (r) => Number(r.getAttribute("r")) > headerNo && kids(r, "c").some((c) => cellText(c, sst).trim() !== ""),
  ).length;

  return { zip, sheetPath, sheetDoc, sstDoc, sst, headerNo, columns, styles, dateStyleSet, missing, projectName, prefilledRows };
}

/** Fields the user can set per rule: every column the app doesn't fill itself. */
export const extraColumns = (tpl) => tpl.columns.filter((c) => c.role === null);

/** Saved rule values whose column no longer exists in this template. */
export function orphanedColumns(rules, tpl) {
  const have = new Set(tpl.columns.map((c) => c.header));
  const out = new Set();
  for (const r of rules) for (const [h, v] of Object.entries(r.columns || {})) if (v && !have.has(h)) out.add(h);
  return [...out];
}

const isDateHeader = (h) => /\bdate\b/i.test(h);
const isNumberHeader = (h) => ["cost", "manpower"].includes(norm(h));

/** @returns Date as {y,m,d} or null */
export function parseDate(text) {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim());
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text.trim());
  if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  return null;
}
const serial = ({ y, m, d }) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);

function coerce(header, text) {
  if (isDateHeader(header)) {
    const d = parseDate(text);
    if (d && d.m >= 1 && d.m <= 12 && d.d >= 1 && d.d <= 31) return { date: d };
  }
  if (isNumberHeader(header) && /^-?\d+(\.\d+)?$/.test(text.trim())) return Number(text);
  return text;
}

/**
 * One row per included pin, keyed by header text.
 * @param pins      detected pins (with .vars, .ruleId, .px, .py and final .title)
 * @param rulesById map ruleId -> rule
 */
export function buildRows(tpl, pins, { planName, rulesById }) {
  return pins.map((pin) => {
    const rule = rulesById[pin.ruleId] || {};
    const row = {};
    for (const col of tpl.columns) {
      if (col.role === "title") row[col.header] = pin.title;
      else if (col.role === "plan") row[col.header] = planName;
      else if (col.role === "x") row[col.header] = round2(pin.px);
      else if (col.role === "y") row[col.header] = round2(pin.py);
      else if (col.role === "id") continue; // left blank so existing tasks are never overwritten
      else {
        const raw = (rule.columns || {})[col.header];
        if (raw && String(raw).trim()) row[col.header] = coerce(col.header, renderTemplate(raw, pin.vars));
      }
    }
    return row;
  });
}

/** Nine tasks on the 10/50/90 grid crossings, to check how the importer reads X/Y. */
export function buildCalibrationRows(tpl, planName) {
  const pts = [];
  for (const y of [10, 50, 90]) for (const x of [10, 50, 90]) pts.push({ x, y });
  return pts.map(({ x, y }) => {
    const row = {};
    for (const col of tpl.columns) {
      if (col.role === "title") row[col.header] = `Calibration X${x} Y${y}`;
      else if (col.role === "plan") row[col.header] = planName;
      else if (col.role === "x") row[col.header] = x;
      else if (col.role === "y") row[col.header] = y;
    }
    return row;
  });
}

/** @returns Uint8Array of the filled workbook */
export async function writeImport(tpl, rows) {
  const sheetDoc = parseXml(serialize(tpl.sheetDoc)); // work on a copy so the template can be reused
  const sstDoc = tpl.sstDoc ? parseXml(serialize(tpl.sstDoc)) : null;
  if (!sstDoc) throw new TemplateError("The template has no shared strings part; unsupported layout.");
  const sst = sstDoc.documentElement;

  let refs = 0;
  const cache = new Map();
  const stringIndex = (text) => {
    refs += 1;
    if (cache.has(text)) return cache.get(text);
    const si = sstDoc.createElementNS(NS, "si");
    const t = sstDoc.createElementNS(NS, "t");
    if (text !== text.trim() || /\n/.test(text)) t.setAttributeNS(XML_NS, "xml:space", "preserve");
    t.textContent = text;
    si.appendChild(t);
    sst.appendChild(si);
    const idx = kids(sst, "si").length - 1;
    cache.set(text, idx);
    return idx;
  };

  const sheetData = sheetDoc.getElementsByTagNameNS(NS, "sheetData")[0];
  for (const row of kids(sheetData, "row")) if (Number(row.getAttribute("r")) > tpl.headerNo) sheetData.removeChild(row);

  rows.forEach((values, i) => {
    const r = tpl.headerNo + 1 + i;
    const rowEl = sheetDoc.createElementNS(NS, "row");
    rowEl.setAttribute("r", String(r));
    for (const col of [...tpl.columns].sort((a, b) => a.index - b.index)) {
      const v = values[col.header];
      const style = tpl.styles[col.letters];
      const empty = v === undefined || v === null || v === "";
      if (empty && style == null) continue;
      const c = sheetDoc.createElementNS(NS, "c");
      c.setAttribute("r", `${col.letters}${r}`);
      if (style != null) c.setAttribute("s", style);
      if (!empty) {
        const val = sheetDoc.createElementNS(NS, "v");
        if (typeof v === "number") {
          val.textContent = String(v);
        } else if (typeof v === "object" && v.date) {
          if (style != null && tpl.dateStyleSet.has(style)) val.textContent = String(serial(v.date));
          else {
            const { y, m, d } = v.date;
            c.setAttribute("t", "s");
            val.textContent = String(stringIndex(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`));
          }
        } else {
          c.setAttribute("t", "s");
          val.textContent = String(stringIndex(String(v)));
        }
        c.appendChild(val);
      }
      rowEl.appendChild(c);
    }
    sheetData.appendChild(rowEl);
  });

  const lastRow = Math.max(tpl.headerNo, tpl.headerNo + rows.length);
  const lastCol = colLetter(Math.max(...tpl.columns.map((c) => c.index)));
  const dim = sheetDoc.getElementsByTagNameNS(NS, "dimension")[0];
  if (dim) dim.setAttribute("ref", `A1:${lastCol}${lastRow}`);

  sst.setAttribute("uniqueCount", String(kids(sst, "si").length));
  sst.setAttribute("count", String(Number(sst.getAttribute("count") || 0) + refs));

  const out = new JSZip();
  // Copy every part of the template across unchanged, in the original order.
  for (const name of Object.keys(tpl.zip.files)) {
    const f = tpl.zip.files[name];
    if (f.dir) continue;
    const opts = { createFolders: false }; // no empty folder entries: strict importers dislike them
    if (name === tpl.sheetPath) out.file(name, serialize(sheetDoc), opts);
    else if (name === "xl/sharedStrings.xml") out.file(name, serialize(sstDoc), opts);
    else out.file(name, await f.async("uint8array"), opts);
  }
  return out.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
