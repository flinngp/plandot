// Exports for checking pins by eye: a PNG of the preview.
/** PNG of the rendered page with numbered pins and a legend. */
export function pinsPng(pdfCanvas, vpWidth, pins, rules, colorOf) {
  const out = document.createElement("canvas");
  out.width = pdfCanvas.width;
  out.height = pdfCanvas.height;
  const ctx = out.getContext("2d");
  ctx.drawImage(pdfCanvas, 0, 0);
  const s = out.width / vpWidth;
  const r = Math.max(11, out.width * 0.0075);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const p of pins) {
    const x = p.x * s, y = p.y * s;
    ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,.95)"; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = colorOf(p.ruleIndex); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `700 ${Math.round(r * (String(p.n).length > 2 ? 0.95 : 1.2))}px sans-serif`;
    ctx.fillText(String(p.n), x, y + 1);
  }
  const used = rules.map((rule, i) => ({ rule, i, count: pins.filter((p) => p.ruleId === rule.id).length })).filter((u) => u.count);
  if (used.length) {
    const fs = Math.max(14, Math.round(out.width * 0.0095));
    const line = fs * 1.7;
    ctx.font = `600 ${fs}px sans-serif`;
    const w = Math.max(...used.map((u) => ctx.measureText(`${u.rule.name} (${u.count})`).width)) + fs * 3.2;
    ctx.fillStyle = "rgba(255,255,255,.94)"; ctx.strokeStyle = "#1c2630"; ctx.lineWidth = 1.5;
    ctx.fillRect(12, 12, w, line * used.length + fs); ctx.strokeRect(12, 12, w, line * used.length + fs);
    ctx.textAlign = "left";
    used.forEach((u, k) => {
      const y = 12 + fs * 0.5 + line * (k + 0.5);
      ctx.beginPath(); ctx.arc(12 + fs * 1.1, y, fs * 0.5, 0, Math.PI * 2); ctx.fillStyle = colorOf(u.i); ctx.fill();
      ctx.fillStyle = "#1c2630"; ctx.fillText(`${u.rule.name} (${u.count})`, 12 + fs * 2, y + 1);
    });
  }
  return new Promise((resolve) => out.toBlob(resolve, "image/png"));
}

export function download(data, filename, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
