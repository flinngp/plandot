// Stops other sites from showing Plandot inside a frame (clickjacking). GitHub Pages cannot send the
// X-Frame-Options header, so the page checks for itself and hides if it is framed.
if (window.top !== window.self) {
  document.documentElement.style.display = "none";
  try { window.top.location.replace(window.self.location.href); } catch { /* cross-origin top: the page stays hidden */ }
}
