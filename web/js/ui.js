// ui.js - presentation-only behaviour (theme toggle + dropzone feedback).
// Purely additive: it never changes what script.js sends to the backend.
document.addEventListener("DOMContentLoaded", () => {
  // ---------- dark / light theme ----------
  const root = document.documentElement;
  const toggle = document.getElementById("themeToggle");

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    const bar = document.querySelector('meta[name="theme-color"]');       // the phone's status bar follows the theme
    if (bar) bar.setAttribute("content", theme === "light" ? "#eef2f9" : "#0b1220");
    if (toggle) {
      const next = theme === "dark" ? "light" : "dark";
      toggle.setAttribute("aria-label", `Switch to ${next} mode`);
      const label = toggle.querySelector(".label");
      if (label) label.textContent = theme === "dark" ? "Dark" : "Light";
    }
  }

  applyTheme(root.getAttribute("data-theme") === "light" ? "light" : "dark");

  if (toggle) {
    toggle.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      applyTheme(next);
      try { localStorage.setItem("fc-theme", next); } catch (e) { /* storage unavailable */ }
    });
  }

  // ---------- full-screen sheets (card editor, bug report) follow the *visible* viewport ----------
  // On iOS the on-screen keyboard covers the page without resizing it; --vvh / --vvt keep the sheets above the keyboard.
  const vv = window.visualViewport;
  if (vv) {
    const sync = () => {
      const s = document.documentElement.style;
      if (vv.scale > 1.01) { s.removeProperty("--vvh"); s.removeProperty("--vvt"); return; }      // pinch-zoomed: leave the layout alone
      s.setProperty("--vvh", `${vv.height}px`); s.setProperty("--vvt", `${vv.offsetTop}px`);
    };
    vv.addEventListener("resize", sync); vv.addEventListener("scroll", sync); sync();
  }

  // ---------- dropzones: drag highlight + "N files selected" ----------
  function describe(files) {
    if (!files || files.length === 0) return "";
    const names = Array.from(files).map(f => f.name);
    if (names.length === 1) return names[0];
    const shown = names.slice(0, 2).join(", ");
    const rest = names.length - 2;
    return `${names.length} files selected: ${shown}${rest > 0 ? ` +${rest} more` : ""}`;
  }

  document.querySelectorAll(".dropzone").forEach(zone => {
    const input = zone.querySelector('input[type="file"]');
    const status = zone.querySelector(".dz-status");
    if (!input) return;

    const refresh = () => {
      const text = describe(input.files);
      if (status) status.textContent = text;
      zone.classList.toggle("has-files", text !== "");
    };

    input.addEventListener("change", refresh);
    ["dragenter", "dragover"].forEach(ev =>
      zone.addEventListener(ev, () => zone.classList.add("is-dragover")));
    ["dragleave", "drop"].forEach(ev =>
      zone.addEventListener(ev, () => zone.classList.remove("is-dragover")));

    // script.js clears #sheetFile when switching back to "new spreadsheet"
    // without firing "change", so re-sync after it has run.
    document.querySelectorAll('input[name="sheetMode"]').forEach(r =>
      r.addEventListener("change", () => setTimeout(refresh, 0)));
  });
});
