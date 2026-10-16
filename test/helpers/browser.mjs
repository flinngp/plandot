// Test helpers: a tiny static server for web/ plus headless Chromium via Playwright.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)), "..");
const require = createRequire(import.meta.url);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".woff": "font/woff", ".json": "application/json", ".txt": "text/plain" };

function loadPlaywright() {
  for (const p of ["playwright", process.env.PLAYWRIGHT_PATH, "/opt/npm-tools/node_modules/playwright"].filter(Boolean)) {
    try { return require(p); } catch { /* try next */ }
  }
  throw new Error("Playwright not found. Run npm install in web/, or set PLAYWRIGHT_PATH.");
}

export async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
      const file = join(root, path === "/" ? "index.html" : path);
      let body = await readFile(file);
      // Tests run with sign-in off unless a test switches it on, whatever js/config.js holds for the live site.
      if (/[/\\]js[/\\]config\.js$/.test(file)) body = Buffer.from(String(body).replace(/export const ACCOUNTS = \{[^}]*\};/, 'export const ACCOUNTS = { url: "", key: "" };'));
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

export async function launch() {
  const { chromium } = loadPlaywright();
  const server = await startServer();
  const browser = await chromium.launch();
  return { browser, server, close: async () => { await browser.close(); await server.close(); } };
}
