// "Report a bug": a small dialog that opens a pre-filled GitHub issue. Nothing is sent from the page itself;
// the user reviews and submits the report on GitHub. To send reports somewhere else, change `openReport` only.
const REPO = "sheuc/fc-scoresheet";
const APP_VERSION = "1.0";
const MAX_ERRORS = 5;

// ---- remember the last few errors so a report can include them (starts as early as possible)
const errors = [];
const remember = text => {
  text = String(text).replace(/\s+/g, " ").slice(0, 200);
  if (text && errors[errors.length - 1] !== text) errors.push(text);
  if (errors.length > MAX_ERRORS) errors.shift();
};
addEventListener("error", e => remember(`${e.message}${e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : ""}`));
addEventListener("unhandledrejection", e => remember(`Unhandled: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));

const $ = id => document.getElementById(id);

function details() {
  return [
    `App: FC Scoresheet ${APP_VERSION}`,
    `Browser: ${navigator.userAgent}`,
    `Screen: ${screen.width}x${screen.height}, window ${innerWidth}x${innerHeight}`,
    `Recent errors: ${errors.length ? errors.map(e => `\n  - ${e}`).join("") : "none"}`,
  ].join("\n");
}

function reportUrl(text, withDetails) {
  const first = text.trim().split("\n")[0].slice(0, 70);
  const body = `**What went wrong**\n${text.trim()}\n` + (withDetails ? `\n**Details**\n\`\`\`\n${details()}\n\`\`\`\n` : "");
  const q = new URLSearchParams({ title: `Bug: ${first}`, body: body.slice(0, 5000), labels: "bug" });
  return `https://github.com/${REPO}/issues/new?${q}`;
}

function openReport(text, withDetails) {
  window.open(reportUrl(text, withDetails), "_blank", "noopener");
}

document.addEventListener("DOMContentLoaded", () => {
  const dialog = $("report-dialog"), open = $("report-open");
  if (!dialog || !open) return;
  const text = $("report-text"), include = $("report-include"), shown = $("report-details"), send = $("report-send");
  let opener = null;

  const refresh = () => { send.disabled = !text.value.trim(); shown.hidden = !include.checked; shown.textContent = details(); };
  function show() {
    opener = document.activeElement; refresh();
    dialog.hidden = false; document.body.classList.add("editing");
    text.focus();
  }
  function hide() {
    dialog.hidden = true; document.body.classList.remove("editing");
    (opener && document.contains(opener) ? opener : open).focus();
  }
  open.addEventListener("click", show);
  $("report-cancel").addEventListener("click", hide);
  dialog.addEventListener("click", e => { if (e.target === dialog) hide(); });
  text.addEventListener("input", refresh);
  include.addEventListener("change", refresh);
  send.addEventListener("click", () => { if (!text.value.trim()) return; openReport(text.value, include.checked); text.value = ""; hide(); });
  document.addEventListener("keydown", e => {
    if (dialog.hidden) return;
    if (e.key === "Escape") { hide(); e.preventDefault(); return; }
    if (e.key !== "Tab") return;                                  // keep keyboard focus inside the dialog
    const items = [...dialog.querySelectorAll("button, textarea, input")].filter(el => !el.disabled && el.offsetParent !== null);
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  });
});
