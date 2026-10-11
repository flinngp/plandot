// Builds a synthetic task-import workbook with the same structure as a real export
// (title block, header on row 4, ID-only sample rows, date-formatted columns).
// Real templates are not committed to the repo because they can carry personal metadata.
// The vendored UMD build registers itself on globalThis when loaded as an ES module.
await import("../../vendor/jszip.min.js");
export const JSZip = globalThis.JSZip;

export const DEFAULT_HEADERS = ["ID", "Title", "Priority", "Category", "Assignee", "Start date", "End date", "Plan", "X Pos (%)", "Y Pos (%)", "Tier 1", "Tier 2", "Tier 3", "Tier 4", "Tier 5", "Manpower", "Cost", "Description / Hashtags", "Related task name", "Checklist", "Existing file"];

const letters = (n) => { let s = ""; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

export async function makeTemplate({ headers = DEFAULT_HEADERS, ids = [7, 1, 3], project = "Test project" } = {}) {
  const strings = ["Task import template (sample)", project, ...headers];
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`;
  const header = headers.map((h, i) => `<c r="${letters(i + 1)}4" s="3" t="s"><v>${i + 2}</v></c>`).join("");
  const dateCol = (h) => /date/i.test(h);
  const data = ids.map((id, k) => {
    const r = 5 + k;
    const cells = headers.map((h, i) => {
      const L = letters(i + 1);
      if (h === "ID") return `<c r="${L}${r}" s="3"><v>${id}</v></c>`;
      if (h === "Title") return `<c r="${L}${r}" s="5"/>`;
      if (dateCol(h)) return `<c r="${L}${r}" s="1"/>`;
      return "";
    }).join("");
    return `<row r="${r}">${cells}</row>`;
  }).join("");
  const last = letters(headers.length);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><dimension ref="A1:${last}${4 + ids.length}"/><sheetFormatPr defaultRowHeight="15"/><cols><col min="2" max="2" width="27.5" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" s="3" t="s"><v>0</v></c></row><row r="2"><c r="A2" s="3" t="s"><v>1</v></c></row><row r="4">${header}</row>${data}</sheetData></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd;@"/></numFmts><fonts count="2"><font><sz val="12"/><name val="Calibri"/></font><font><b/><sz val="12"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf></cellXfs></styleSheet>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="in" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
  zip.file("xl/worksheets/sheet1.xml", sheet);
  zip.file("xl/styles.xml", styles);
  zip.file("xl/sharedStrings.xml", sst);
  return zip.generateAsync({ type: "uint8array" });
}
