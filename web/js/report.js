// "Report a bug": a small form whose message goes privately to the developer's inbox through Web3Forms
// (https://web3forms.com). The access key lives in <meta name="report-key"> in index.html; it can only deliver mail
// to the address it was created for, so it is safe to publish. Without a key the "Report a bug" link stays hidden.
const ENDPOINT = "https://api.web3forms.com/submit";
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

// Sends one report. Resolves true when the form service accepted it.
async function sendReport(key, text, email, withDetails) {
  const first = text.trim().split("\n")[0].slice(0, 70);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      access_key: key,
      subject: `FC Scoresheet bug: ${first}`,
      from_name: "FC Scoresheet",
      message: text.trim() + (withDetails ? `\n\n---\n${details()}` : ""),
      ...(email ? { email } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok && data.success !== false;
}

document.addEventListener("DOMContentLoaded", () => {
  const key = (document.querySelector('meta[name="report-key"]')?.content || "").trim();
  const dialog = $("report-dialog"), open = $("report-open"), opens = [...document.querySelectorAll("[data-report-open]")];   // the footer link and the button at the top
  if (!dialog || !open) return;
  if (!key) { opens.forEach(b => { b.hidden = true; }); return; }                       // not set up yet: no link rather than a broken one
  const text = $("report-text"), email = $("report-email"), include = $("report-include"), shown = $("report-details");
  const send = $("report-send"), trap = $("report-website"), status = $("report-status"), form = $("report-form"), done = $("report-done");
  let opener = null, busy = false;

  const refresh = () => { send.disabled = busy || !text.value.trim(); shown.hidden = !include.checked; shown.textContent = details(); };
  function show() {
    opener = document.activeElement; status.textContent = ""; form.hidden = false; done.hidden = true; refresh();
    dialog.hidden = false; document.body.classList.add("editing");
    text.focus();
  }
  function hide() {
    dialog.hidden = true; document.body.classList.remove("editing");
    (opener && document.contains(opener) ? opener : open).focus();
  }
  opens.forEach(b => b.addEventListener("click", show));
  $("report-cancel").addEventListener("click", hide);
  $("report-close").addEventListener("click", hide);
  dialog.addEventListener("click", e => { if (e.target === dialog) hide(); });
  text.addEventListener("input", refresh);
  include.addEventListener("change", refresh);

  send.addEventListener("click", async () => {
    if (busy || !text.value.trim()) return;
    busy = true; send.textContent = "Sending..."; status.textContent = ""; refresh();
    let ok = false;
    try { ok = trap.value ? true : await sendReport(key, text.value, email.value.trim(), include.checked); }   // a filled hidden field is a bot: pretend it worked
    catch { ok = false; }
    busy = false; send.textContent = "Send report";
    if (ok) {
      text.value = ""; form.hidden = true; done.hidden = false; $("report-close").focus();
    } else {
      status.textContent = "Couldn't send the report. Check your connection and try again."; refresh();
    }
  });

  document.addEventListener("keydown", e => {
    if (dialog.hidden) return;
    if (e.key === "Escape") { hide(); e.preventDefault(); return; }
    if (e.key !== "Tab") return;                                  // keep keyboard focus inside the dialog
    const items = [...dialog.querySelectorAll("button, textarea, input")].filter(el => !el.disabled && el.offsetParent !== null && el !== trap);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  });
});
