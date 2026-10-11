// Copies the browser builds (pdf.js "legacy" build: it polyfills newer JavaScript so older managed browsers work) of the libraries from node_modules into vendor/.
// Run `npm install && npm run vendor` after bumping a version in package.json.
// The site loads everything from vendor/, so it works offline and on any static host.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const files = [
  ["pdfjs-dist/legacy/build/pdf.min.mjs", "vendor/pdf.min.mjs"],
  ["pdfjs-dist/legacy/build/pdf.worker.min.mjs", "vendor/pdf.worker.min.mjs"],
  ["jszip/dist/jszip.min.js", "vendor/jszip.min.js"],
  ["pdf-lib/dist/pdf-lib.min.js", "vendor/pdf-lib.min.js"],
];
mkdirSync(join(root, "vendor"), { recursive: true });
for (const [from, to] of files) {
  const src = join(nm, from);
  if (!existsSync(src)) throw new Error(`Missing ${from}. Run npm install first.`);
  copyFileSync(src, join(root, to));
  console.log("copied", to);
}
