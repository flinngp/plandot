// The "Copy rows" helper: pin rows as tab-separated text, ready to paste into Fieldwire's task importer.

const cell = (v) => {
  if (v === undefined || v === null) return "";
  if (typeof v === "object" && v.date) { const { y, m, d } = v.date; return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
  const s = String(v);
  return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One line per row, one tab between columns, in the template's own column order (the ID column stays blank). */
export function rowsToTsv(tpl, rows, { headings = false } = {}) {
  const cols = [...tpl.columns].sort((a, b) => a.index - b.index);
  const lines = rows.map((r) => cols.map((c) => cell(r[c.header])).join("\t"));
  if (headings) lines.unshift(cols.map((c) => cell(c.header)).join("\t"));
  return lines.join("\n");
}

/** Put text on the clipboard. Returns false if the browser refuses. */
export async function copyText(text, doc = document) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall back to the old way, which Safari and locked-down browsers still allow after a click */ }
  const ta = doc.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;left:-9999px;top:0";
  doc.body.append(ta); ta.select();
  let ok = false;
  try { ok = doc.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}
