// Thin wrapper around pdf.js: open a drawing, read one page's text as tokens, draw it to a canvas.
import * as pdfjs from "../vendor/pdf.min.mjs";
import { extractTokens } from "./core.js";
import { buildGeometry, findAnchors, shapesFromOperatorList } from "./leaders.js";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;

export async function openPdf(bytes) {
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  return pdfjs.getDocument({ data: new Uint8Array(bytes).slice(), isEvalSupported: false }).promise;
}

/** Page size as displayed (rotation applied) plus every word with its centre point. */
export async function readPage(doc, pageNo) {
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  const { items } = await page.getTextContent();
  const tokens = extractTokens(items, (x, y) => vp.convertToViewportPoint(x, y));
  return { page, viewport: vp, width: vp.width, height: vp.height, tokens };
}

/**
 * The page's drawn lines and small filled shapes, indexed so each callout's leader and dot can be
 * found. Slower than reading the text (about a second on a busy 34 x 22 sheet), so it is only done
 * when a rule asks for it.
 */
export async function readGeometry(page) {
  const opList = await page.getOperatorList();
  const vp = page.getViewport({ scale: 1 });
  return buildGeometry(shapesFromOperatorList(opList, pdfjs.OPS, vp.transform));
}

/**
 * A function that maps a tag token to where its task(s) belong: the dot at the end of each of the
 * callout's leader lines, or the end of the leader when it has no dot. Returns an empty list when
 * the callout has no leader. Positions come back both in viewport points and in PDF user space
 * (for the marked-up PDF).
 */
export function anchorFinder(geometry, viewport) {
  return (token) =>
    findAnchors(geometry, token).map((found) => {
      const [ux, uy] = viewport.convertToPdfPoint(found.x, found.y);
      return { ...found, ux, uy };
    });
}

let running = null;

/** Draw the page into a canvas so it is `cssWidth` CSS pixels wide, sharp on high-DPI screens. */
export async function renderInto(page, canvas, cssWidth) {
  if (running) running.cancel();
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let scale = (cssWidth * dpr) / base.width;
  if (base.width * scale > 5000) scale = 5000 / base.width;
  const viewport = page.getViewport({ scale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport });
  running = task;
  try {
    await task.promise;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") throw err;
  }
}
