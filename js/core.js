// Detection core. Pure functions only (no DOM, no PDF library), so it can be
// unit-tested in Node and reused anywhere.
//
// Coordinates: tokens carry a position in "viewport points" (origin top-left of the
// page as displayed, y increasing downward) and in PDF user space (origin as the PDF
// defines it). Percent positions are x / pageWidth and y / pageHeight, matching the
// X Pos (%) / Y Pos (%) columns of the task import template.

export const DEDUPE_DISTANCE = 1.5; // points; CAD exports often overprint the same text twice

/**
 * Split pdf.js text items into whole words with a centre point.
 * @param items     pdf.js getTextContent().items
 * @param project   (userX, userY) => [viewportX, viewportY]
 */
export function extractTokens(items, project) {
  const tokens = [];
  for (const it of items) {
    if (typeof it.str !== "string" || !it.str.trim() || !Array.isArray(it.transform)) continue;
    const [a, b, c, d, e, f] = it.transform;
    const norm = Math.hypot(a, b) || 1;
    const dir = [a / norm, b / norm];
    const perp = [-dir[1], dir[0]];
    const height = it.height || Math.hypot(c, d) || 0;
    const width = it.width || 0;
    const len = it.str.length;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(it.str))) {
      const mid = (m.index + m[0].length / 2) / len; // fraction along the item
      const along = width * mid;
      const ux = e + dir[0] * along + perp[0] * height * 0.35;
      const uy = f + dir[1] * along + perp[1] * height * 0.35;
      const [x, y] = project(ux, uy);
      tokens.push({ text: m[0], x, y, ux, uy });
    }
  }
  return dedupeTokens(tokens);
}

export function dedupeTokens(tokens) {
  const kept = [];
  for (const t of tokens) {
    if (!kept.some((k) => k.text === t.text && Math.hypot(k.x - t.x, k.y - t.y) < DEDUPE_DISTANCE)) kept.push(t);
  }
  return kept;
}

export const MAX_PATTERN = 300;
/** Patterns that can make the browser hang on certain text: a repeat inside a repeat, such as (a+)+ . */
export function riskyPattern(raw) {
  if (raw.length > MAX_PATTERN) return true;
  if (/\([^()]*[+*][^()]*\)\s*[+*{]/.test(raw)) return true;
  if (/\([^()]*\|[^()]*\)\s*[+*{]\s*[^)]*$/.test(raw) && /\(\?:?[^()]*\|/.test(raw) && /(\.\*|\.\+)[^()]*(\.\*|\.\+)[^()]*(\.\*|\.\+)/.test(raw)) return true;
  return false;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Turn a rule's tag field into a whole-word tester. Returns {test} or {error}. */
export function compileMatcher(rule) {
  const raw = (rule.tags || "").trim();
  if (!raw) return { empty: true, test: () => false };
  try {
    if (rule.usePattern) {
      if (riskyPattern(raw)) return { error: "That pattern is too long or too complicated and could freeze the page. Simplify it.", test: () => false };
      const re = new RegExp(`^(?:${raw})$`);
      return { test: (t) => re.test(t) };
    }
    const tags = raw.split(/[\s,;]+/).filter(Boolean);
    const re = new RegExp(`^(?:${tags.map(escapeRe).join("|")})$`);
    return { test: (t) => re.test(t) };
  } catch (err) {
    return { error: `Not a valid pattern: ${err.message}`, test: () => false };
  }
}

/** Fill {placeholders}. Unknown ones become empty; spaces are tidied. */
export function renderTemplate(template, vars) {
  if (!template) return "";
  const out = String(template).replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
  return out.replace(/\s+/g, " ").trim();
}

function compileRoom(settings) {
  const raw = (settings.roomPattern || "").trim();
  if (!raw || riskyPattern(raw)) return null;
  try {
    return new RegExp(`^(?:${raw})$`);
  } catch {
    return null;
  }
}

/** What a rule looks for: "text" (callout tags) or "symbol" (copies of a symbol the user boxed). */
export const ruleKind = (rule) => (rule.kind === "symbol" ? "symbol" : "text");

/** Where a rule puts its pins: "dot" (the dot at the end of the callout's leader) or "text". Dot is the default. */
export const pinMode = (rule) => (rule.pinAt === "text" ? "text" : "dot");

/**
 * Run all rules over the tokens.
 * @param anchorFor  optional (token) => [{kind, x, y, ux, uy}], the dot(s) at the end of the callout's
 *                   leader line(s). Rules set to pin on the dot use it; a callout it finds nothing for
 *                   keeps its pin on the callout text.
 * @param symbolHits optional {ruleId: [{x, y, ux, uy}]}, the places each symbol rule found its symbol
 * @returns {{pins: object[], errors: Record<string,string>}}
 */
export function detect({ tokens, width, height, rules, settings = {}, anchorFor = null, symbolHits = null }) {
  const errors = {};
  const area = settings.area; // [x0,y0,x1,y1] fractions, or null
  const roomRe = compileRoom(settings);
  if ((settings.roomPattern || "").trim() && !roomRe) errors.room = "Room label pattern is not a valid pattern.";
  const roomMax = ((settings.roomDistance ?? 10) / 100) * width;
  const roomTokens = roomRe ? tokens.filter((t) => roomRe.test(t.text)) : [];

  const inArea = (t) =>
    !area || (t.x >= area[0] * width && t.x <= area[2] * width && t.y >= area[1] * height && t.y <= area[3] * height);

  const pins = [];
  rules.forEach((rule, ruleIndex) => {
    if (ruleKind(rule) === "symbol") {
      const found = (symbolHits && symbolHits[rule.id]) || [];
      const mine = found.filter((at) => inArea(at)).sort((p, q) => p.y - q.y || p.x - q.x);
      mine.forEach((at, k) => {
        let room = "";
        let best = roomMax;
        for (const r of roomTokens) {
          const dist = Math.hypot(r.x - at.x, r.y - at.y);
          if (dist <= best) { best = dist; room = r.text; }
        }
        const tag = rule.name;
        const vars = { tag, room, room_label: room ? `(Room ${room})` : "", n: k + 1, rule: rule.name };
        pins.push({
          ruleId: rule.id, ruleIndex, ruleName: rule.name, tag, room,
          x: at.x, y: at.y, ux: at.ux, uy: at.uy, tx: at.x, ty: at.y,
          anchor: "symbol", anchorIndex: 1, anchorCount: 1,
          px: (at.x / width) * 100, py: (at.y / height) * 100,
          title: renderTemplate(rule.title, vars), vars,
          key: `${rule.id}|symbol|${Math.round(at.cx ?? at.x)}|${Math.round(at.cy ?? at.y)}`,
        });
      });
      return;
    }
    const matcher = compileMatcher(rule);
    if (matcher.error) errors[rule.id] = matcher.error;
    if (matcher.empty || matcher.error) return;
    const useDots = anchorFor && pinMode(rule) === "dot";
    const hits = tokens.filter((t) => matcher.test(t.text) && inArea(t));
    hits.sort((p, q) => p.y - q.y || p.x - q.x);
    let count = 0;
    hits.forEach((t) => {
      const found = useDots ? anchorFor(t) : [];
      const places = found && found.length ? found : [{ kind: "text", x: t.x, y: t.y, ux: t.ux, uy: t.uy }];
      places.forEach((at, k) => {
        let room = "";
        let best = roomMax;
        for (const r of roomTokens) {
          const dist = Math.hypot(r.x - at.x, r.y - at.y);
          if (dist <= best) {
            best = dist;
            room = r.text;
          }
        }
        count += 1;
        const vars = { tag: t.text, room, room_label: room ? `(Room ${room})` : "", n: count, rule: rule.name };
        pins.push({
          ruleId: rule.id,
          ruleIndex,
          ruleName: rule.name,
          tag: t.text,
          room,
          x: at.x,
          y: at.y,
          ux: at.ux,
          uy: at.uy,
          tx: t.x, // the callout text, kept so the pin can be tied back to its callout
          ty: t.y,
          anchor: at.kind, // "dot", "leader" (a leader with no dot) or "text"
          anchorIndex: k + 1,
          anchorCount: places.length,
          px: (at.x / width) * 100,
          py: (at.y / height) * 100,
          title: renderTemplate(rule.title, vars),
          vars,
          // Built from the callout, not the dot, so edits survive switching where the pin goes.
          key: `${rule.id}|${t.text}|${Math.round(t.x)}|${Math.round(t.y)}${k ? `|${k + 1}` : ""}`,
        });
      });
    });
  });

  pins.sort((p, q) => p.ruleIndex - q.ruleIndex || p.ty - q.ty || p.tx - q.tx || p.anchorIndex - q.anchorIndex);
  pins.forEach((p, i) => (p.n = i + 1));
  return { pins, errors };
}

export const round2 = (v) => Math.round(v * 100) / 100;

/** Fieldwire's task importer takes at most this many rows pasted in at a time. */
export const IMPORT_LIMIT = 500;

/** The pin ranges to paste one after another: batchRanges(1200) is [[1, 500], [501, 1000], [1001, 1200]]. */
export function batchRanges(total, size = IMPORT_LIMIT) {
  const out = [];
  for (let from = 1; from <= total; from += size) out.push([from, Math.min(from + size - 1, total)]);
  return out;
}

export function newRule(n = 1) {
  return {
    id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: `Rule ${n}`,
    tags: "",
    usePattern: false,
    title: "{tag}",
    pinAt: "dot",
    columns: {},
    kind: "text",
  };
}
