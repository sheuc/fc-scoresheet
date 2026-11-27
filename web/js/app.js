// UI wiring. A port of frontend/script.js with the server round-trips replaced by local modules:
// everything (scan, spreadsheet update) happens in this page.
import { createOcrPool } from "./ocr.js";
import { processImages } from "./pipeline.js";
import { decodeImage, makeBrowserWorker, toInput, workerCount } from "./browser-ocr.js";
import { readKnownGoals, readNamesFromSheet, readWorkbookStats, readWorkbookTotals, updateWorkbook } from "./excel.js";
import { initShareCard } from "./sharecard-ui.js";
import { buildSave } from "./save.js";
import { computeScanStats } from "./stats.js";
import { capitalizeName, normalize } from "./text.js";
import { buildContribution, communityEnabled, contribute, getOptIn, loadTotals, setOptIn } from "./community.js";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");   // also safe inside attributes
// Competition ranking for a list already sorted high to low: ties share a rank (1, 1, 3).
const ranks = (rows, value) => rows.map((r, i) => { let k = i; while (k > 0 && value(rows[k - 1]) === value(r)) k--; return k + 1; });

// Whole numbers with separators; from 100,000 up, a short form (98.8M, 123K) so the number fits its tile on a phone.
const big = n => (n >= 1e5 ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n) : n.toLocaleString());

const svg = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  trash: svg('<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'),
  undo: svg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  plus: svg('<path d="M5 12h14M12 5v14"/>'),
  chevron: svg('<path d="M6 9l6 6 6-6"/>'),
  warn: svg('<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  check: svg('<path d="M20 6L9 17l-5-5"/>'),
  save: svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  chart: svg('<path d="M5 20V10M12 20V4M19 20v-7"/>'),
};
const ic = name => `<span class="ico">${ICONS[name]}</span>`;

// ---- stats card HTML ----
const METRIC_ROWS = [["Goals", "goals", ""], ["Shots", "shots", ""], ["Shots on target", "sot", ""], ["Possession", "possession", "%"],
                     ["Pass accuracy", "pass", "%"], ["Fouls", "fouls", ""], ["Offsides", "offsides", ""]];
const fmtAvg = (v, unit) => (v == null ? "–" : `${Number.isInteger(v) ? v : v.toFixed(1)}${unit}`);

function averagesHtml(avg) {
  const rows = METRIC_ROWS.map(([label, key, unit]) =>
    `<tr><td>${label}</td><td class="num">${fmtAvg(avg.for[key], unit)}</td><td class="dim">${fmtAvg(avg.against[key], unit)}</td></tr>`).join("");
  return `<div class="table-scroll"><table class="stat-table"><thead><tr><th>Average per game</th><th>You</th><th>Opponent</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const signed = n => (n > 0 ? `+${n}` : String(n));
const pct1 = v => (v == null ? "–" : `${v.toFixed(1)}%`);

/** Team record: games, results, win rate, goals, clean sheets, comebacks and hat-tricks. */
function resultsHtml(r) {
  const rows = [["Games played", r.played], ["Wins", r.wins], ["Draws", r.draws], ["Losses", r.losses], ["Win rate", pct1(r.winRate)],
                ["Goals for", r.goalsFor], ["Goals against", r.goalsAgainst], ["Goal difference", signed(r.goalDiff)],
                ["Clean sheets", r.cleanSheets], ["Comeback wins", r.comebackWins ?? 0], ["Hat-tricks", r.hatTricks]];
  return `<div class="table-scroll"><table class="stat-table"><thead><tr><th>Team record</th><th>Total</th></tr></thead><tbody>${
    rows.map(([label, v]) => `<tr><td>${label}</td><td class="num">${v}</td></tr>`).join("")}</tbody></table></div>`;
}

/** Shot accuracy (on target / shots) and conversion (goals / shots) for you and the opponent. */
function shootingHtml(sh) {
  const row = (label, how, key) => `<tr><td>${label}<span class="how">${how}</span></td><td class="num">${pct1(sh.for[key])}</td><td class="dim">${pct1(sh.against[key])}</td></tr>`;
  return `<div class="table-scroll"><table class="stat-table"><thead><tr><th>Shooting</th><th>You</th><th>Opponent</th></tr></thead><tbody>${
    row("Shot accuracy", "shots on target ÷ shots", "accuracy")}${row("Conversion", "goals ÷ shots", "conversion")}</tbody></table></div>`;
}

/** The biggest win and the heaviest defeat. */
function extremesHtml(ex) {
  const row = (label, e) => `<tr><td>${label}</td><td class="num">${e ? `${e.score[0]}-${e.score[1]}` : "–"}</td><td class="dim opp">${e ? esc(e.opponent || "unknown opponent") : ""}</td></tr>`;
  return `<div class="table-scroll"><table class="stat-table"><thead><tr><th>Best and worst results</th><th>Score</th><th>Opponent</th></tr></thead><tbody>${
    row("Biggest win", ex.biggestWin)}${row("Heaviest defeat", ex.heaviestDefeat)}</tbody></table></div>`;
}

/** Averages and results on the left, hat-tricks and clutch on the right. */
const statsGridHtml = (st, where) => `<div class="stats-grid"><div class="stats-stack">${averagesHtml(st.averages)}${resultsHtml(st.results)}${shootingHtml(st.shooting)}${extremesHtml(st.extremes)}</div>${leaderboardsHtml(st, where)}</div>`;

function leaderboardsHtml(stats, where = "yet") {
  const table = (head, rows, empty) => rows.length
    ? `<div class="table-scroll"><table class="stat-table"><thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map(r =>
        `<tr>${r.map((v, i) => `<td${i === r.length - 1 && i > 0 ? ' class="num"' : ""}>${esc(i === 0 ? capitalizeName(v) : v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
    : `<p class="stat-empty">${empty}</p>`;
  return `<div class="stats-stack"><div><h3>Hat-tricks</h3><p class="sub">Matches with 3+ goals by one player</p>${table(["Player", "Most goals", "Hat-tricks"],
            stats.hatTricks.map(h => [h.name, h.mostGoals, h.hatTricks]), `No hat-tricks ${where}.`)}</div>
          <div><h3>Most clutch players</h3><p class="sub">Stoppage-time (90'+N) winners and equalizers</p>${table(["Player", "Winners", "Equalizers", "Total"],
            stats.clutch.map(c => [c.name, c.winners, c.equalizers, c.total]), `No stoppage-time winners or equalizers ${where}.`)}</div></div>`;
}

document.addEventListener("DOMContentLoaded", () => {
  const scanBtn = $("scanBtn"), resultsDiv = $("results"), confirmContainer = $("confirm-container");
  const errorBox = $("error-message");
  const uploadArea = $("upload-area"), sheetFileInput = $("sheetFile");
  const sheetPreview = $("sheet-preview"), sheetInfo = $("sheet-info");
  const detectBox = $("detectNames"), detectWarning = $("detect-warning"), namesBox = $("names");

  const statsCard = $("stats-card"), statsScan = $("stats-scan"), statsAll = $("stats-alltime");
  // Each stats panel has a collapse button. This scan's stats open (they are what you just asked for); the all-time panel is
  // the secondary one and starts closed. The choice survives re-rendering.
  const statsCollapsed = { scan: false, all: true };
  const collapseBtn = which => {
    const label = `${statsCollapsed[which] ? "Expand" : "Collapse"} these stats`;
    return `<button type="button" class="stats-collapse" data-which="${which}" aria-expanded="${!statsCollapsed[which]}" aria-label="${label}" title="${label}">${ICONS.chevron}</button>`;
  };
  const shareCard = initShareCard();       // the downloadable summary graphic (panel in index.html)
  const refreshStatsCard = () => { statsCard.hidden = !(statsScan.innerHTML.trim() || statsAll.innerHTML.trim()); };
  // Stats of what was just scanned, shown once the results are confirmed (nothing is saved yet).
  // `excluded` = players removed with the trash button; `reduced` = goals subtracted with "-".
  function showScanStats(data, excluded = new Set(), reduced = {}) {
    const st = computeScanStats(data, excluded);
    const n = st.averages.games, played = st.results.played;
    const subtracted = Object.values(reduced).reduce((a, b) => a + b, 0);
    statsScan.innerHTML = (played || n || st.games)
      ? `<section class="stats-block stats-block-scan" aria-label="Stats in this scan"><header class="stats-head"><span class="stats-pill">This scan</span><h3>Stats in this scan</h3>${collapseBtn("scan")}</header>
         <p class="sub">${played} game${played === 1 ? "" : "s"}, ${n} with readable match stats. All of it is saved when you save to the spreadsheet.</p>
         <div class="stats-body" data-which="scan"${statsCollapsed.scan ? " hidden" : ""}>${subtracted ? `<div class="notice">${ic("info")}You subtracted ${subtracted} goal${subtracted === 1 ? "" : "s"} with −. Hat-tricks and clutch can't tell which goals those were, so they still include them. Remove a player with the trash button to take them out entirely.</div>` : ""}
         ${statsGridHtml(st, "in this scan")}</div></section>`
      : "";
    if (statsScan.innerHTML) {
      const scorers = Object.entries(data.counts || {}).filter(([k]) => !excluded.has(k)).map(([k, v]) => ({ name: k, goals: Math.max(0, v - (reduced[k] || 0)) }));
      shareCard?.setScan({ stats: st, scorers });
    } else shareCard?.clearScan();
    refreshStatsCard();
  }
  function showAllTimeStats(stats, preview = false, totals = []) {
    const n = stats.averages.games, played = stats.results.played;
    statsAll.innerHTML = `<section class="stats-block stats-block-sheet" aria-label="Everything in your spreadsheet"><header class="stats-head"><span class="stats-pill">All-time</span><h3>Everything in your spreadsheet</h3>${collapseBtn("all")}</header>
      <p class="sub">${played} game${played === 1 ? "" : "s"} played, ${n} with match stats.${preview ? " <strong>Includes this scan</strong>, which isn't saved until you press Save." : ""}</p>
      <div class="stats-body" data-which="all"${statsCollapsed.all ? " hidden" : ""}>${statsGridHtml(stats)}</div></section>`;
    shareCard?.setAll({ stats, scorers: totals.map(t => ({ name: t.name, goals: t.total })) });
    refreshStatsCard();
  }
  statsCard.addEventListener("click", e => {
    const head = e.target.closest(".stats-head");              // the whole header is the button
    const b = head && head.querySelector(".stats-collapse");
    if (!b) return;
    const which = b.dataset.which;
    statsCollapsed[which] = !statsCollapsed[which];
    statsCard.querySelector(`.stats-body[data-which="${which}"]`).hidden = statsCollapsed[which];
    const label = `${statsCollapsed[which] ? "Expand" : "Collapse"} these stats`;
    b.setAttribute("aria-expanded", String(!statsCollapsed[which])); b.setAttribute("aria-label", label); b.title = label;
  });
  const clearAllTimeStats = () => { statsAll.innerHTML = ""; shareCard?.clearAll(); refreshStatsCard(); };

  // A scan checks every goal against the spreadsheet while it runs (goals already in it are left out). If the spreadsheet
  // is swapped afterwards those results no longer fit it, and saving them would silently drop goals, so they are cleared.
  const dropScanForNewSheet = () => {
    if (!resultsDiv.querySelector(".results-table") && !confirmContainer.innerHTML.trim()) return;
    previewToken++;
    confirmContainer.innerHTML = ""; statsScan.innerHTML = ""; shareCard?.clearScan();
    resultsDiv.innerHTML = `<div class="notice">${ic("info")}You changed the spreadsheet, so the earlier scan was cleared: a scan skips goals that are already in the spreadsheet it was checked against. Scan again to use the new one.</div>`;
    refreshStatsCard();
  };
  let sheet = null;          // {bytes, name}: the user's own spreadsheet, kept in memory only
  let sheetStats = null;     // the all-time stats of that spreadsheet as uploaded
  let sheetScorers = [];     // and its per-player totals
  let previewToken = 0;      // lets a slow preview notice it has been superseded
  let poolPromise = null;    // OCR workers are created once, on first scan

  const showError = msg => { errorBox.textContent = msg; errorBox.style.display = "block"; };
  const clearError = () => { errorBox.textContent = ""; errorBox.style.display = "none"; };
  const sheetMode = () => document.querySelector('input[name="sheetMode"]:checked').value;

  // "Detect for me": the names box is ignored and an own-goal warning is shown
  detectBox.addEventListener("change", () => {
    namesBox.disabled = detectBox.checked;
    namesBox.style.opacity = detectBox.checked ? "0.5" : "1";
    detectWarning.style.display = detectBox.checked ? "block" : "none";
  });

  document.querySelectorAll('input[name="sheetMode"]').forEach(r => r.addEventListener("change", () => {
    if (sheetMode() === "upload") { uploadArea.style.display = "block"; return; }
    uploadArea.style.display = "none";
    if (sheet) dropScanForNewSheet();
    sheet = null; sheetStats = null; sheetScorers = [];
    clearAllTimeStats();
    sheetPreview.style.display = "none"; sheetPreview.innerHTML = "";
    sheetInfo.style.display = "none"; sheetInfo.textContent = "";
    sheetFileInput.value = "";
  }));

  // ---- upload an existing spreadsheet: remember it and autofill the names ----
  sheetFileInput.addEventListener("change", async () => {
    clearError();
    sheetPreview.style.display = "none";
    sheetInfo.style.display = "none"; sheetInfo.textContent = "";
    dropScanForNewSheet();
    sheet = null; sheetStats = null; sheetScorers = [];
    clearAllTimeStats();
    const f = sheetFileInput.files && sheetFileInput.files[0];
    if (!f) return;
    sheetInfo.textContent = "Reading...";
    sheetInfo.style.display = "block";
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const data = await readNamesFromSheet(bytes, f.name);
      sheet = { bytes, name: f.name };
      sheetInfo.textContent = `Loaded: ${f.name} (CSV: ${data.is_csv ? "yes" : "no"})`;
      if (data.names.length) {
        namesBox.value = data.names.join(", ");
        sheetInfo.textContent += ` — autofilled ${data.names.length} names.`;
      }
      try { sheetStats = await readWorkbookStats(bytes, f.name); sheetScorers = await readWorkbookTotals(bytes, f.name); showAllTimeStats(sheetStats, false, sheetScorers); } catch { /* not a tracker file: nothing to show */ }
    } catch (err) {
      showError(err.message || "Failed to read the spreadsheet.");
      sheetInfo.textContent = "Couldn't read that file.";
    }
  });

  // ---- OCR workers (created once; first scan downloads/compiles the model, later scans reuse it) ----
  function getPool() {
    if (!poolPromise) {
      poolPromise = createOcrPool({ makeWorker: makeBrowserWorker, size: workerCount(), toInput });
      poolPromise.catch(() => { poolPromise = null; });
    }
    return poolPromise;
  }
  addEventListener("pagehide", () => { poolPromise?.then(p => p.terminate()).catch(() => {}); });

  // ---- scan ----
  scanBtn.addEventListener("click", async () => {
    clearError();
    confirmContainer.innerHTML = "";
    statsScan.innerHTML = ""; shareCard?.clearScan(); refreshStatsCard();
    const namesInput = namesBox.value;
    const imageFiles = Array.from($("images").files || []);
    const detect = detectBox.checked;

    if ((!detect && !namesInput.trim()) || imageFiles.length === 0) {
      showError(detect ? "Please select screenshots before scanning."
                       : "Please enter names (or tick 'Detect for me') and select screenshots before scanning.");
      resultsDiv.innerHTML = "";
      return;
    }
    const normNames = detect ? [] : namesInput.split(",").map(n => normalize(n.trim())).filter(Boolean);

    resultsDiv.innerHTML = `<div class="progress-row"><div class="progress"><div class="progress-fill" id="progressFill"></div></div>
      <button type="button" class="btn-cancel" id="cancelBtn">Cancel</button></div>
      <p class="small" id="progressLabel">Starting...</p>`;
    const fill = $("progressFill"), label = $("progressLabel");
    const progress = (stage, pct) => { fill.style.width = `${pct}%`; label.textContent = `${stage}... ${pct}%`; };
    const abort = new AbortController();
    $("cancelBtn").addEventListener("click", e => {          // the scan stops at the end of the current step, which can take a few seconds on a phone
      abort.abort(); e.currentTarget.disabled = true; label.textContent = "Cancelling... finishing the current step";
    });

    scanBtn.disabled = true;
    try {
      let knownGoals = [];
      if (sheetMode() === "upload" && sheet) knownGoals = await readKnownGoals(sheet.bytes, sheet.name);

      label.textContent = poolPromise ? "Starting..." : "Loading text recognition (first time only)...";
      let ocr;
      try { ocr = await getPool(); }
      catch (e) {
        throw new Error(navigator.onLine === false
          ? "You're offline, and the text recognition files haven't been downloaded to this device yet. Connect once and scan to download them; after that scanning works offline."
          : "Couldn't load the text recognition files. Check your connection and try again.");
      }

      const data = await processImages(imageFiles, normNames, { detect, ocr, decodeImage, progress, knownGoals, signal: abort.signal });
      renderResults(data, detect, imageFiles.length);
    } catch (err) {
      if (err && err.name === "AbortError") showError("Scan cancelled.");
      else { console.error(err); showError(err.message || "Scan failed. See console for details."); }
      resultsDiv.innerHTML = "";
    } finally {
      scanBtn.disabled = false;
    }
  });

  // ---- results ----
  function renderResults(data, detect, nImages) {
    const summary = data.summary;
    const counts = summary.aggregated_goals || {};
    const filesByName = summary.files_by_name || {};
    const FILES_PREVIEW = 3;
    const filesCellHtml = files => {
      const list = files.map(esc);
      if (list.length <= FILES_PREVIEW) return list.join(", ");
      return `<span class="files-cell">
                <span class="files-short">${list.slice(0, FILES_PREVIEW).join(", ")}, &hellip; +${list.length - FILES_PREVIEW} more</span>
                <span class="files-full" hidden>${list.join(", ")}</span>
                <button type="button" class="files-toggle" aria-expanded="false">Show more</button>
              </span>`;
    };
    const keys = Object.keys(counts).sort((a, b) => (counts[b] - counts[a]) || a.localeCompare(b));

    let html = "";
    // Cut-off-game warnings can be dismissed individually.
    (data.games || []).filter(g => g.incomplete && g.incomplete_message).forEach(g => {
      html += `<div class="error warn-row"><span>${ic("warn")}${esc(g.incomplete_message)}</span>
               <button type="button" class="ignore-warning btn-danger">Ignore</button></div>`;
    });
    (data.notices || []).forEach(n => { html += `<div class="notice">${ic("info")}${esc(n)}</div>`; });
    if (data.warnings.length) html += `<div class="error is-visible">${data.warnings.map(w => `${ic("warn")}${esc(w)}`).join("<br>")}</div>`;
    const lay = data.layouts && data.layouts.new > 0
      ? ` (${data.layouts.old} old layout, ${data.layouts.new} new layout)` : "";
    const nExtra = (data.extra_games || []).length;
    html += `<p class="small">${data.games.length + nExtra} game(s) detected from ${nImages} screenshot(s)${lay}${nExtra ? ` (${nExtra} with only a Match Stats page)` : ""}.</p>`;
    html += `<h3 class="small">Scan Results (${esc(data.timestamp)})</h3>`;
    html += `<table class="results-table"><thead><tr><th>Name</th><th>Goals</th><th>Files</th>${detect ? "<th></th>" : ""}</tr></thead><tbody>`;
    if (keys.length === 0) {
      html += `<tr><td class="empty-cell" colspan="${detect ? 4 : 3}">No goals found</td></tr>`;
    } else {
      keys.forEach((key, idx) => {
        const who = esc(capitalizeName(key));
        // Goals cell: a stepper. "-" subtracts a goal the user knows doesn't count (e.g. an own goal
        // credited to this player), "+" undoes that. The unit label ("goals") only shows on narrow
        // screens, where the header row is hidden and rows become cards (see styles.css).
        html += `<tr data-idx="${idx}"><td>${who}</td>
                 <td><div class="stepper">
                   <button type="button" class="step-btn step-minus" aria-label="Subtract one goal from ${who}" title="Subtract a goal (e.g. an own goal)">${ICONS.minus}</button>
                   <span class="goal-count" aria-live="polite">${counts[key]}</span><span class="goal-unit">${counts[key] === 1 ? "goal" : "goals"}</span>
                   <button type="button" class="step-btn step-plus" aria-label="Add a goal back for ${who}" title="Undo: add a goal back" disabled>${ICONS.plus}</button>
                 </div></td>
                 <td data-label="Files">${filesCellHtml(filesByName[key] || [])}</td>
                 ${detect ? `<td><button type="button" class="delete-player btn-danger icon-btn" aria-label="Remove ${who} from the results" title="Remove this player (e.g. an own goal) before saving">${ICONS.trash}</button></td>` : ""}</tr>`;
      });
    }
    html += "</tbody></table>";
    resultsDiv.innerHTML = html;

    // Adjustments the user makes before saving (all undoable):
    //   excluded  players removed entirely with the trash button (Detect mode: e.g. non-team players)
    //   reduced   goals subtracted per player with "-" (never below 0, "+" never above what was scanned)
    const excluded = new Set();
    const reduced = {};
    const effective = key => counts[key] - (reduced[key] || 0);
    const refreshRow = row => {
      const key = keys[Number(row.dataset.idx)], removed = excluded.has(key), n = effective(key);
      row.querySelector(".goal-count").textContent = n;
      row.querySelector(".goal-unit").textContent = n === 1 ? "goal" : "goals";
      row.querySelector(".step-minus").disabled = removed || n <= 0;
      row.querySelector(".step-plus").disabled = removed || !reduced[key];
      row.classList.toggle("is-removed", removed);
      row.classList.toggle("is-zero", !removed && n <= 0);
      row.classList.toggle("is-reduced", !removed && n > 0 && !!reduced[key]);
      const trash = row.querySelector(".delete-player");
      if (trash) {
        const who = capitalizeName(key);
        trash.innerHTML = removed ? ICONS.undo : ICONS.trash;
        trash.classList.toggle("is-undo", removed);
        trash.setAttribute("aria-label", removed ? `Undo removing ${who}` : `Remove ${who} from the results`);
        trash.title = removed ? "Undo: put this player back" : "Remove this player (e.g. an own goal) before saving";
      }
      const cb = $("confirmBtn");
      if (cb) cb.disabled = !canConfirm();
    };
    // Nothing to confirm when every goal was removed and the scan has neither match stats nor a game result to keep.
    const hasResults = [...(data.games || []), ...(data.extra_games || [])].some(g => Number.isFinite(g.score?.[0]) && Number.isFinite(g.score?.[1]));
    const canConfirm = () => !(keys.length > 0 && keys.every(k => excluded.has(k) || effective(k) <= 0)) || (data.stat_records || []).length > 0 || hasResults;
    let confirmed = false;
    // Step 1: check the results above, then confirm. Step 2: the stats appear and the spreadsheet can be saved.
    const showConfirmStep = () => {
      confirmed = false;
      previewToken++;
      statsScan.innerHTML = ""; shareCard?.clearScan();
      if (sheetStats) showAllTimeStats(sheetStats, false, sheetScorers); else clearAllTimeStats();      // back to the spreadsheet as it is on disk
      refreshStatsCard();
      confirmContainer.innerHTML = `<button id="confirmBtn" class="primary">${ic("check")}Confirm results</button>
        <div class="hint-text">Check the players and goals above (remove or subtract anything that's wrong), then confirm to see this scan's stats.</div>`;
      $("confirmBtn").addEventListener("click", showSaveStep);
      $("confirmBtn").disabled = !canConfirm();
    };
    const showSaveStep = () => {
      confirmed = true;
      showScanStats(data, excluded, reduced);
      confirmContainer.innerHTML = `<div class="confirm-actions"><button id="saveBtn" class="primary">${ic("save")}Save to spreadsheet</button>
        <button id="editBtn" type="button" class="btn-cancel">${ic("edit")}Edit results</button></div>
        <div class="hint-text">After saving you'll get a downloadable updated file.</div>
        ${communityEnabled() ? `<label class="check community-opt"><input type="checkbox" id="communityOpt"${getOptIn() ? " checked" : ""}> <span>Add this scan to the community totals <span class="opt">(only player names and goal counts are sent, never screenshots or opponents)</span></span></label>` : ""}`;
      $("communityOpt")?.addEventListener("change", e => setOptIn(e.target.checked));
      $("saveBtn").addEventListener("click", e => save(e.target, data, excluded, reduced));
      $("editBtn").addEventListener("click", showConfirmStep);
      previewAllTime(data, excluded, reduced);
    };
    // On the table itself (a fresh element per scan), so listeners from earlier scans can't pile up.
    resultsDiv.querySelector(".results-table").addEventListener("click", ev => {
      const btn = ev.target.closest(".step-minus, .step-plus, .delete-player");
      if (!btn || btn.disabled) return;
      const row = btn.closest("tr"), key = keys[Number(row.dataset.idx)];
      if (btn.classList.contains("step-minus")) reduced[key] = Math.min(counts[key], (reduced[key] || 0) + 1);
      else if (btn.classList.contains("step-plus")) reduced[key] = Math.max(0, (reduced[key] || 0) - 1);
      else if (excluded.has(key)) excluded.delete(key); else excluded.add(key);
      if (confirmed) showConfirmStep();        // changing anything after confirming means confirming again (the stats would be stale)
      refreshRow(row);
    });
    resultsDiv.querySelectorAll(".files-toggle").forEach(btn => btn.addEventListener("click", () => {
      const cell = btn.closest(".files-cell"), full = cell.querySelector(".files-full");
      const open = full.hidden;
      full.hidden = !open;
      cell.querySelector(".files-short").hidden = open;
      cell.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "Show less" : "Show more";
    }));
    resultsDiv.querySelectorAll(".ignore-warning").forEach(btn => btn.addEventListener("click", () => btn.closest(".warn-row").remove()));

    showConfirmStep();
  }

  // "Everything in your spreadsheet" with this scan included: exactly what saving would produce, built in memory
  // (nothing is downloaded). It replaces the panel once confirmed, so the two panels never disagree about the latest scan.
  async function previewAllTime(data, excluded, reduced) {
    const token = ++previewToken;
    try {
      const sheetBytes = sheetMode() === "upload" && sheet ? sheet.bytes : null;
      const known = sheetBytes ? await readKnownGoals(sheetBytes, sheet.name) : [];
      const b = buildSave(data, known, excluded, reduced);
      if (b.problem) return;
      const out = await updateWorkbook({ sheetBytes, filename: sheet?.name || "", counts: b.counts, timestamp: data.timestamp,
                                         normalize, logGoals: b.logGoals, theirGoals: b.theirGoals, statRecords: b.statRecords, gameRecords: b.gameRecords });
      if (token === previewToken) showAllTimeStats(out.stats, true, out.sheet_totals);
    } catch { /* the panel keeps showing the spreadsheet as it is */ }
  }

  // ---- save: record the goals in the user's spreadsheet and hand back the updated file ----
  async function save(button, data, excluded, reduced) {
    clearError();
    const shareToCommunity = !!$("communityOpt")?.checked;     // read before the step's HTML is replaced
    button.disabled = true;
    previewToken++;                                           // a preview still being built must not overwrite the saved result
    try {
      const sheetBytes = sheetMode() === "upload" && sheet ? sheet.bytes : null;
      const known = sheetBytes ? await readKnownGoals(sheetBytes, sheet.name) : [];
      const { counts, logGoals: toRecord, shareGoals, theirGoals, statRecords, gameRecords, skipped, problem } = buildSave(data, known, excluded, reduced);
      if (problem) throw new Error(problem);
      const out = await updateWorkbook({ sheetBytes, filename: sheet?.name || "", counts, timestamp: data.timestamp,
                                         normalize, logGoals: toRecord, theirGoals, statRecords, gameRecords });
      if (!toRecord.length && !out.recorded_stats && !out.recorded_theirs && !out.recorded_games) {
        throw new Error("Nothing new to save: every goal and every match's stats are already in your spreadsheet.");
      }

      const url = URL.createObjectURL(new Blob([out.xlsx], { type: XLSX_MIME }));
      let msg = `<p class="success-note">${ic("check")}Data saved. <a id="openLink" href="${url}" download="${esc(out.filename)}">Open/download updated file</a>. `
              + `Keep it: upload it next time to carry on your totals and skip goals you've already recorded.</p>`;
      if (out.notice) msg += `<div class="notice">${ic("info")}${esc(out.notice)}</div>`;
      if (skipped) msg += `<div class="notice">${ic("info")}${skipped} goal(s) were already recorded and not added again.</div>`;
      if (out.recorded_stats) msg += `<div class="notice">${ic("chart")}Match stats saved for ${out.recorded_stats} game(s).</div>`;
      if (out.skipped_stats) msg += `<div class="notice">${ic("info")}${out.skipped_stats} game(s)' stats were already in your spreadsheet.</div>`;
      let totals = "";
      if (out.sheet_totals.length) {
        totals = `<div class="totals-block"><h4 class="totals-title">Spreadsheet top scorers</h4>
          <table class="results-table"><thead><tr><th>Name</th><th>Total</th></tr></thead><tbody>
          ${(rk => out.sheet_totals.map((r, i) => `<tr><td><span class="rank">${rk[i]}</span>${esc(capitalizeName(r.name))}</td><td data-label="${r.total === 1 ? "goal" : "goals"}">${r.total}</td></tr>`).join(""))(ranks(out.sheet_totals, r => r.total))}
          </tbody></table></div>`;
      }
      confirmContainer.innerHTML = `<div class="saved-msg">${msg}</div><p id="communityNote" class="hint-text" hidden></p>${totals}`;
      showAllTimeStats(out.stats, false, out.sheet_totals);   // averages, hat-tricks and clutch from the saved file
      if (shareToCommunity) addToCommunity(shareGoals, gameRecords);
      $("openLink").click();                                  // start the download
    } catch (err) {
      showError(err.message || "Failed to save to spreadsheet.");
      button.disabled = false;
    }
  }

  // ---- community totals: opt-in, never blocks or fails a save ----
  async function addToCommunity(logGoals, gameRecords) {
    const note = $("communityNote");
    const c = buildContribution(logGoals, gameRecords);
    if (!c) { if (note) { note.hidden = false; note.textContent = "Nothing new to add to the community totals."; } return; }
    const ok = await contribute(c);
    if (note) { note.hidden = false; note.textContent = ok ? "Added to the community totals. Thank you!" : "Couldn't add this scan to the community totals right now."; }
    if (ok) refreshCommunity();
  }
  async function refreshCommunity() {
    const card = $("community-card");
    if (!card || !communityEnabled()) return;
    const t = await loadTotals();
    if (!t) return;
    const strip = $("community-top");
    card.hidden = false; if (strip) strip.hidden = false;      // shown even when empty, so people know it exists
    const none = !t.games && !t.goals && !t.scorers.length;
    const emptyMsg = "Nothing shared yet. Save a scan with the community box ticked to add the first totals.";
    const rk = ranks(t.scorers, r => Number(r.goals));
    if (strip) {
      const top = t.scorers.slice(0, 3);
      $("community-top-body").innerHTML = `<div class="cs-figures">
          <div><strong>${big(t.goals)}</strong><span>Total goals</span></div>
          <div><strong>${big(t.games)}</strong><span>Total games</span></div></div>`
        + (none ? `<p class="cs-empty">${emptyMsg}</p>` : "")
        + (top.length ? `<ol class="cs-top" aria-label="Top scorers">${top.map((r, i) => `<li><span class="rank">${rk[i]}</span><span class="cs-name">${esc(r.name)}</span><b>${Number(r.goals)}</b></li>`).join("")}</ol>` : "");
    }
    const avg = t.games ? (t.goals / t.games).toFixed(2) : "0.00";
    $("community-body").innerHTML = `<div class="community-tiles">
        <div class="community-tile"><strong>${big(t.goals)}</strong><span>Total goals</span></div>
        <div class="community-tile"><strong>${big(t.games)}</strong><span>Games</span></div>
        <div class="community-tile"><strong>${avg}</strong><span>Goals per game</span></div></div>`
      + (t.scorers.length ? `<div class="totals-block"><h4 class="totals-title">Top scorers</h4>
          <table class="results-table"><thead><tr><th>Name</th><th>Goals</th></tr></thead><tbody>
          ${t.scorers.map((r, i) => `<tr><td><span class="rank">${rk[i]}</span>${esc(r.name)}</td><td data-label="${r.goals === 1 ? "goal" : "goals"}">${Number(r.goals)}</td></tr>`).join("")}
          </tbody></table></div>` : "")
      + (none ? `<p class="sub">${emptyMsg}</p>` : "");
  }
  refreshCommunity();

  // ---- offline support ----
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});
