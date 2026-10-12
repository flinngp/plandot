// Small flags for the language menu, drawn as SVG so they look the same on every device
// (flag emoji do not show on Windows). Each is 24 x 16. One flag per language, for the country
// most people expect; the language name always sits beside it.
const f = (body) => `<svg class="flag" viewBox="0 0 24 16" width="24" height="16" aria-hidden="true" focusable="false">${body}</svg>`;
const bars = (dir, ...cols) => cols.map((c, i, a) => (dir === "v" ? `<rect x="${(24 / a.length) * i}" width="${24 / a.length + 0.05}" height="16" fill="${c}"/>` : `<rect y="${(16 / a.length) * i}" width="24" height="${16 / a.length + 0.05}" fill="${c}"/>`)).join("");
const cross = (bg, fg, inner) => `<rect width="24" height="16" fill="${bg}"/>` + (inner
  ? `<rect x="6.5" width="4" height="16" fill="${fg}"/><rect y="6" width="24" height="4" fill="${fg}"/><rect x="7.5" width="2" height="16" fill="${inner}"/><rect y="7" width="24" height="2" fill="${inner}"/>`
  : `<rect x="7" width="3" height="16" fill="${fg}"/><rect y="6.5" width="24" height="3" fill="${fg}"/>`);

export const FLAGS = {
  en: f('<rect width="24" height="16" fill="#012169"/><path d="M0 0l24 16M24 0L0 16" stroke="#fff" stroke-width="3.2"/><path d="M0 0l24 16M24 0L0 16" stroke="#c8102e" stroke-width="1.2"/><path d="M12 0v16M0 8h24" stroke="#fff" stroke-width="5.4"/><path d="M12 0v16M0 8h24" stroke="#c8102e" stroke-width="3.2"/>'),
  fr: f(bars("v", "#0055a4", "#fff", "#ef4135")),
  es: f('<rect width="24" height="16" fill="#aa151b"/><rect y="4" width="24" height="8" fill="#f1bf00"/>'),
  de: f(bars("h", "#000", "#dd0000", "#ffce00")),
  it: f(bars("v", "#009246", "#fff", "#ce2b37")),
  nl: f(bars("h", "#ae1c28", "#fff", "#21468b")),
  pt: f('<rect width="24" height="16" fill="#ff0000"/><rect width="9.6" height="16" fill="#006600"/><circle cx="9.6" cy="8" r="3.2" fill="#ffd200"/><circle cx="9.6" cy="8" r="1.9" fill="#ff0000"/>'),
  da: f(cross("#c8102e", "#fff")),
  sv: f(cross("#006aa7", "#fecc00")),
  no: f(cross("#ba0c2f", "#fff", "#00205b")),
  fi: f(cross("#fff", "#003580")),
  pl: f(bars("h", "#fff", "#dc143c")),
  cs: f('<rect width="24" height="8" fill="#fff"/><rect y="8" width="24" height="8" fill="#d7141a"/><path d="M0 0l12 8L0 16z" fill="#11457e"/>'),
};
