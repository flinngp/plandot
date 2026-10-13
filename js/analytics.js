// Anonymous visit counts through GoatCounter: no cookies, no personal data, nothing from a drawing.
// It switches on only on the live site, so local copies and tests never add to the numbers.
const HOSTS = new Set(["plandot.uk", "www.plandot.uk"]);
const SCRIPT = "https://gc.zgo.at/count.js";
const ENDPOINT = "https://plandot.goatcounter.com/count";

export const isLiveSite = (hostname) => HOSTS.has(hostname);

export function startAnalytics(loc = globalThis.location, doc = globalThis.document) {
  if (!loc || !doc || !isLiveSite(loc.hostname) || doc.querySelector("script[data-goatcounter]")) return false;
  const s = doc.createElement("script");
  s.async = true;
  s.src = SCRIPT;
  s.dataset.goatcounter = ENDPOINT;
  doc.head.append(s);
  return true;
}

/** Count a named event, such as "exported". Does nothing when counting is off or blocked. */
export function track(name) {
  try { globalThis.goatcounter?.count?.({ path: `event/${name}`, title: name, event: true }); } catch { /* counting must never get in the way */ }
}

/** A range, never the exact number of pins. */
export const pinBucket = (n) => (n <= 50 ? "1-50" : n <= 200 ? "51-200" : n <= 500 ? "201-500" : "over-500");
