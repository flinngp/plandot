// Thin wrapper around pdf.js: open a drawing, read one page's text as tokens, draw it to a canvas.
import "./polyfills.js"; // must come first: pdf.js needs it as soon as it loads
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
export async function readShapes(page) {
  const opList = await page.getOperatorList();
  const vp = page.getViewport({ scale: 1 });
  return shapesFromOperatorList(opList, pdfjs.OPS, vp.transform);
}
export const readGeometry = async (page, shapes) => buildGeometry(shapes || (await readShapes(page)));

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

/** Largest side, in device pixels, of the picture drawn at once. */
export const MAX_SIDE = 4096;

/**
 * Draw the page so the whole sheet would be `cssWidth` CSS pixels wide, but only the part inside
 * `region` ([x0, y0, x1, y1] as fractions of the sheet). Zoomed in far, only what you can see (plus
 * a margin) is drawn, so the lines stay sharp at any zoom without a huge picture.
 */
export async function renderRegion(page, canvas, cssWidth, region = [0, 0, 1, 1]) {
  if (running) running.cancel();
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = (cssWidth * dpr) / base.width;
  const viewport = page.getViewport({ scale });
  const [x0, y0, x1, y1] = region;
  canvas.width = Math.max(1, Math.round((x1 - x0) * viewport.width));
  canvas.height = Math.max(1, Math.round((y1 - y0) * viewport.height));
  const task = page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport, transform: [1, 0, 0, 1, -x0 * viewport.width, -y0 * viewport.height] });
  running = task;
  try {
    await task.promise;
    return true;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") throw err;
    return false;
  } finally {
    if (running === task) running = null;
  }
}

/** The whole page in a fresh canvas, `pxWidth` device pixels wide (for the pin image). Independent of the on-screen view. */
export async function renderFull(page, pxWidth) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(pxWidth, 6000) / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas;
}
