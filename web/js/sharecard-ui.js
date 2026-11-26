// The "Share card" panel. The page shows only the finished card with its Download / Share / Copy buttons; the pencil on the
// card opens an editor sheet (Cancel / Save, the live card, tabs along the bottom for Title, Scorers, Stats, Look, Data).
// Everything stays in the page; saved choices are remembered in the browser only.
import { canvasToBlob, CARD_H, CARD_W, DEFAULT_SCORERS, DEFAULT_STATS, DEFAULT_TITLE, drawFitted, loadCardFonts, MAX_SCORERS, MAX_STATS, MIN_SCORERS, MIN_STATS, NAME_MAX, statAvailability, STAT_CHOICES, TITLE_MAX } from "./sharecard.js";

const KEY = "fcstat.card.v1";
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const TABS = ["data", "title", "scorers", "stats", "look"];

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; }
}
function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify({ title: state.title, name: state.name, theme: state.theme, selected: state.selected, scorers: state.scorers })); } catch { /* private mode: fine */ }
}
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "recap";
const today = () => new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * @returns {setScan({stats, scorers}), clearScan(), setAll({stats, scorers}), clearAll()}
 *   `stats` is what computeScanStats / computeStats return, `scorers` is [{name, goals}]
 */
export function initShareCard() {
  const root = $("share-card"), editor = $("card-editor");
  if (!root || !editor) return null;
  const jump = $("jump-share");
  const canvas = $("card-canvas"), editCanvas = $("card-canvas-edit"), note = $("card-note");
  const saved = load();
  const state = {
    title: typeof saved.title === "string" ? saved.title : "", name: typeof saved.name === "string" ? saved.name : "",
    theme: saved.theme === "light" ? "light" : "dark",
    selected: Array.isArray(saved.selected) && saved.selected.length ? saved.selected.filter(k => STAT_CHOICES.some(c => c.key === k)) : [...DEFAULT_STATS],
    scorers: Number.isInteger(saved.scorers) && saved.scorers >= MIN_SCORERS && saved.scorers <= MAX_SCORERS ? saved.scorers : DEFAULT_SCORERS,
    source: "scan", data: { scan: null, all: null }, blob: null,
  };
  $("card-title").value = state.title; $("card-name").value = state.name;
  $("card-title").maxLength = TITLE_MAX; $("card-name").maxLength = NAME_MAX; $("card-title").placeholder = DEFAULT_TITLE;
  document.querySelectorAll('input[name="card-theme"]').forEach(r => { r.checked = r.value === state.theme; });

  const current = () => state.data[state.source];
  let timer = null, token = 0;

  // ---- what the controls show
  function refreshSource() {
    const have = { scan: !!state.data.scan, all: !!state.data.all };
    root.hidden = !have.scan && !have.all;
    jump.hidden = root.hidden;
    if (!have[state.source]) state.source = have.scan ? "scan" : "all";
    document.querySelectorAll('input[name="card-source"]').forEach(r => {
      r.disabled = !have[r.value]; r.checked = r.value === state.source;
      r.closest("label").classList.toggle("is-disabled", !have[r.value]);
    });
  }

  function refreshPicker() {
    const box = $("card-stats"), cur = current();
    const avail = cur ? statAvailability(cur.stats) : STAT_CHOICES.map(c => ({ key: c.key, label: c.label, available: false, why: "" }));
    const chosen = state.selected.filter(k => avail.find(a => a.key === k && a.available));
    const full = chosen.length >= MAX_STATS, atMin = chosen.length <= MIN_STATS;
    box.innerHTML = avail.map(a => {
      const on = chosen.includes(a.key);
      const disabled = !a.available || (!on && full) || (on && atMin && avail.filter(x => x.available).length > MIN_STATS);
      const why = !a.available ? a.why : (!on && full ? `At most ${MAX_STATS} stats fit on the card` : on && atMin ? `Keep at least ${MIN_STATS}` : "");
      return `<label class="chip${on ? " is-on" : ""}${disabled ? " is-disabled" : ""}" title="${esc(why)}"><input type="checkbox" value="${a.key}"${on ? " checked" : ""}${disabled ? " disabled" : ""}>${esc(a.label)}</label>`;
    }).join("");
    $("card-stat-count").textContent = `${chosen.length} of ${MAX_STATS} (at least ${MIN_STATS})`;
  }

  // The stepper only goes as far as there are scorers to show: otherwise pressing + or - would change the number
  // without changing the card (with 3 scorers in the data, 5 -> 4 -> 3 looked like dead buttons).
  const availableScorers = () => { const cur = current(); return cur ? cur.scorers.filter(s => s && s.name && s.goals > 0).length : 0; };
  const maxScorers = () => Math.max(MIN_SCORERS, Math.min(MAX_SCORERS, availableScorers()));
  const effectiveScorers = () => Math.max(MIN_SCORERS, Math.min(state.scorers, maxScorers()));
  function refreshScorers() {
    const e = effectiveScorers(), m = maxScorers(), a = availableScorers();
    $("card-scorers").textContent = String(e);
    $("card-scorers-minus").disabled = e <= MIN_SCORERS;
    $("card-scorers-plus").disabled = e >= m;
    $("card-scorers-hint").textContent = !a ? "No goals recorded in this data yet."
      : `${a} scorer${a === 1 ? "" : "s"} in this data${a > MAX_SCORERS ? `; the card lists up to ${MAX_SCORERS}` : ""}.`;
  }
  const refreshAll = () => { refreshSource(); refreshPicker(); refreshScorers(); };

  // ---- drawing (the page's preview, mirrored into the editor while it is open)
  const editing = () => !editor.hidden;
  function mirror() {
    const c = editCanvas.getContext("2d");
    c.clearRect(0, 0, editCanvas.width, editCanvas.height);
    c.drawImage(canvas, 0, 0);
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(draw, 60); }

  async function draw() {
    const cur = current();
    if (!cur) return;
    const mine = ++token;
    await loadCardFonts();
    if (mine !== token) return;
    canvas.width = CARD_W; canvas.height = CARD_H;
    const { model, report, asked, shown, trimmed } = drawFitted(canvas.getContext("2d"),
      { title: state.title, name: state.name, stats: cur.stats, scorers: cur.scorers, scorerCount: state.scorers, selected: state.selected, source: state.source, theme: state.theme, dateText: today() });
    canvas.dataset.title = model.title; canvas.dataset.tiles = model.tiles.map(t => t.key).join(","); canvas.dataset.source = state.source; canvas.dataset.scorers = String(model.scorers.length);
    canvas.dataset.overflow = report.overflow.join("; "); canvas.dataset.trimmed = trimmed ? "1" : "";
    note.textContent = trimmed ? `Only ${shown} of the ${asked} scorers fit with this title and ${model.tiles.length} stats. Shorten the title or pick fewer stats to fit more.`
      : report.overflow.length ? "Some long text was shortened to fit the card." : "";
    if (editing()) mirror();
    state.blob = null;
    ["card-download", "card-share", "card-copy"].forEach(id => { $(id).disabled = true; });
    try {
      const blob = await canvasToBlob(canvas);
      if (mine !== token) return;
      state.blob = blob; state.fileName = `fc-recap-${slug(model.title)}.png`;
      ["card-download", "card-share", "card-copy"].forEach(id => { $(id).disabled = false; });
    } catch { note.textContent = "Couldn't create the image in this browser."; }
  }

  // ---- the controls (they change the card live; Cancel puts everything back, Save keeps it)
  function changed() { refreshPicker(); refreshScorers(); schedule(); }

  $("card-title").addEventListener("input", e => { state.title = e.target.value; changed(); });
  $("card-name").addEventListener("input", e => { state.name = e.target.value; changed(); });
  document.querySelectorAll('input[name="card-theme"]').forEach(r => r.addEventListener("change", () => { if (r.checked) { state.theme = r.value; changed(); } }));
  document.querySelectorAll('input[name="card-source"]').forEach(r => r.addEventListener("change", () => { if (r.checked && !r.disabled) { state.source = r.value; changed(); } }));
  $("card-stats").addEventListener("change", e => {
    const cb = e.target.closest("input[type=checkbox]");
    if (!cb) return;
    const avail = new Set(statAvailability(current().stats).filter(a => a.available).map(a => a.key));
    let sel = state.selected.filter(k => avail.has(k));
    sel = cb.checked ? [...sel, cb.value] : sel.filter(k => k !== cb.value);
    state.selected = sel;
    changed();
  });
  $("card-reset").addEventListener("click", () => { state.selected = [...DEFAULT_STATS]; changed(); });
  const bump = by => { state.scorers = Math.max(MIN_SCORERS, Math.min(maxScorers(), effectiveScorers() + by)); changed(); };
  $("card-scorers-minus").addEventListener("click", () => bump(-1));
  $("card-scorers-plus").addEventListener("click", () => bump(1));

  // ---- the editor sheet
  let snapshot = null, opener = null;
  const snap = () => ({ title: state.title, name: state.name, theme: state.theme, selected: [...state.selected], scorers: state.scorers, source: state.source });

  function selectTab(name) {
    TABS.forEach(t => {
      const on = t === name;
      const tab = $(`card-tab-${t}`);
      tab.setAttribute("aria-selected", String(on)); tab.tabIndex = on ? 0 : -1;
      $(`card-pane-${t}`).hidden = !on;
    });
  }
  const activeTab = () => TABS.find(t => $(`card-tab-${t}`).getAttribute("aria-selected") === "true") || "data";
  TABS.forEach(t => {
    $(`card-tab-${t}`).addEventListener("click", () => selectTab(t));
    $(`card-tab-${t}`).addEventListener("keydown", e => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const i = (TABS.indexOf(t) + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
      selectTab(TABS[i]); $(`card-tab-${TABS[i]}`).focus(); e.preventDefault();
    });
  });

  function openEditor() {
    if (editing() || !current()) return;
    snapshot = snap(); opener = document.activeElement;
    editor.hidden = false; document.body.classList.add("editing");
    selectTab("data"); refreshAll(); mirror();
    $("card-tab-data").focus();
  }
  function closeEditor(keep) {
    if (!editing()) return;
    if (keep) save(state);
    else {                                                   // Cancel: everything goes back to how it was when the editor opened
      Object.assign(state, snapshot, { selected: [...snapshot.selected] });
      $("card-title").value = state.title; $("card-name").value = state.name;
      document.querySelectorAll('input[name="card-theme"]').forEach(r => { r.checked = r.value === state.theme; });
      refreshAll(); clearTimeout(timer); draw();           // back to the old picture at once, not after the usual short delay
    }
    editor.hidden = true; document.body.classList.remove("editing");
    (opener && document.contains(opener) ? opener : $("card-edit")).focus();
  }
  // the button at the top of Stats: take the user straight to the finished card instead of scrolling for it
  jump.addEventListener("click", () => {
    const calm = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
    $("card-download").focus({ preventScroll: true });
  });
  $("card-edit").addEventListener("click", openEditor);
  $("card-save").addEventListener("click", () => closeEditor(true));
  $("card-cancel").addEventListener("click", () => closeEditor(false));
  document.addEventListener("keydown", e => {
    if (!editing()) return;
    if (e.key === "Escape") { closeEditor(false); e.preventDefault(); return; }
    if (e.key !== "Tab") return;                             // keep keyboard focus inside the sheet
    const items = [...editor.querySelectorAll("button, input, [tabindex]")].filter(el => !el.disabled && el.tabIndex >= 0 && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  });

  // ---- download / share / copy
  $("card-download").addEventListener("click", () => {
    if (!state.blob) return;
    const url = URL.createObjectURL(state.blob), a = document.createElement("a");
    a.href = url; a.download = state.fileName; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    note.textContent = "Saved to your downloads.";
  });
  const fileOf = () => new File([state.blob], state.fileName, { type: "image/png" });
  const canShare = () => typeof navigator.canShare === "function" && typeof navigator.share === "function" && state.blob && navigator.canShare({ files: [fileOf()] });
  $("card-share").hidden = !(typeof navigator.share === "function" && typeof navigator.canShare === "function" && typeof File === "function");
  $("card-share").addEventListener("click", async () => {
    if (!state.blob) return;
    if (!canShare()) { note.textContent = "Sharing isn't available here (it needs https on a phone). Use Download instead."; return; }
    try { await navigator.share({ files: [fileOf()], title: canvas.dataset.title }); }
    catch (e) { if (e?.name !== "AbortError") note.textContent = "Couldn't open the share sheet. Use Download instead."; }
  });
  $("card-copy").hidden = !(navigator.clipboard && typeof navigator.clipboard.write === "function" && typeof ClipboardItem === "function");
  $("card-copy").addEventListener("click", async () => {
    if (!state.blob) return;
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": state.blob })]); note.textContent = "Image copied: paste it into a chat or post."; }
    catch { note.textContent = "Couldn't copy the image here. Use Download instead."; }
  });

  // a scan that has just been confirmed is the card's data (even if a spreadsheet was loaded first); the spreadsheet is a choice in Data
  const set = which => data => { state.data[which] = data; if (which === "scan") state.source = "scan"; refreshAll(); schedule(); };
  const clear = which => () => { state.data[which] = null; refreshAll(); if (current()) schedule(); };
  selectTab("data"); refreshAll();
  return { setScan: set("scan"), setAll: set("all"), clearScan: clear("scan"), clearAll: clear("all") };
}
