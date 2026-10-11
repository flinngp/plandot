// Makes samples/sample-import-template.xlsx: a made-up import template shaped like a real one
// (title block, header row on row 4, a few pre-filled ID rows) plus one custom column, "Zone",
// so the demo shows custom attributes appearing as fields.
//
// Rebuild it with:  node scripts/make-sample-template.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HEADERS, makeTemplate } from "../test/helpers/make-template.mjs";

const bytes = await makeTemplate({ headers: [...DEFAULT_HEADERS, "Zone"], ids: [1, 2, 3], project: "Sample project" });
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "samples", "sample-import-template.xlsx");
writeFileSync(out, bytes);
console.log("wrote", out);
