// Port of services/excel_manager.py using ExcelJS. Everything happens in memory in the browser:
// the user's workbook comes in as bytes and the updated workbook goes out as bytes.
//
// Tracker layout:  Name | Total | <one column per scan date> ...
// A hidden "_log" sheet (see goal-log.js) remembers which goals were already recorded.
//
// ExcelJS is a browser global (vendor/exceljs/exceljs.min.js); Node tests set globalThis.ExcelJS.
import { LOG_HEADER, LOG_TITLE, logRow, oppKey, parseLogRows, theirLogRow } from "./goal-log.js";
import { computeStats, gamesFromLog } from "./stats.js";

export const STATS_DATA_TITLE = "_stats";     // hidden: one row per game with match stats
export const GAMES_TITLE = "_games";          // hidden: one row per game with its final score (W/D/L, goals, clean sheets)
export const SUMMARY_TITLE = "Stats";         // visible: averages, results, hat-tricks, clutch
const HELPER_SHEETS = new Set([LOG_TITLE, STATS_DATA_TITLE, GAMES_TITLE, SUMMARY_TITLE]);
const GAMES_HEADER = ["Saved", "Opponent", "Goals for", "Goals against", "Key"];
const STATS_HEADER = ["Saved", "Opponent", "Score", "Shots", "On target", "Possession %", "Pass accuracy %", "Fouls", "Offsides",
                      "Opp shots", "Opp on target", "Opp possession %", "Opp pass accuracy %", "Opp fouls", "Opp offsides", "Key"];

const MAX_NAMES = 1000;                       // how many player names an uploaded sheet can fill in
export const MAX_SHEET_BYTES = 5 * 1024 * 1024;   // a results spreadsheet is tiny; refuse anything big
const BAD_SHEET = "Couldn't read that spreadsheet. Please upload an .xlsx or .csv file.";

const XL = () => {
  if (!globalThis.ExcelJS) throw new Error("ExcelJS is not loaded");
  return globalThis.ExcelJS;
};

// ------------------------------------------------------------------ cell helpers
/** A cell's plain value: formulas give their result, rich text its text. */
export function plain(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("result" in v) return plain(v.result);
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join("");
    if ("text" in v) return plain(v.text);
    if ("error" in v) return null;
  }
  return v;
}
const str = v => { const p = plain(v); return p == null ? "" : String(p); };

function num(v) {
  const p = plain(v);
  const n = parseFloat(String(p ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

const capitalizeWord = w => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w);

// ------------------------------------------------------------------ names / CSV
/** 0-based index of the probable name column of a header row, or null. */
export function guessNameColumn(headers) {
  if (!headers || headers.length === 0) return null;
  const candidates = ["name", "player", "player name", "playername", "full name"];
  for (let i = 0; i < headers.length; i++) {
    if (!headers[i]) continue;
    const h = String(headers[i]).toLowerCase().trim();
    if (candidates.some(c => c === h || h.includes(c))) return i;
  }
  return /[a-z]/i.test(String(headers[0] || "")) ? 0 : null;
}

/** Comma, semicolon (Excel in many European locales) or tab: whichever the header line uses most. */
function detectDelimiter(text) {
  const line = String(text).replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
  let best = ",", most = 0;
  for (const d of [",", ";", "\t"]) { const n = line.split(d).length - 1; if (n > most) { best = d; most = n; } }
  return best;
}

/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF, BOM). */
export function parseCsv(text, delim = detectDelimiter(text)) {
  const rows = [];
  let row = [], field = "", quoted = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = ""; rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const toBytes = data => (data instanceof Uint8Array ? data : new Uint8Array(data));

/** Open an uploaded .xlsx/.csv (bytes) as a workbook. Throws Error(BAD_SHEET) if unreadable. */
export async function loadWorkbook(data, filename = "") {
  const bytes = toBytes(data);
  if (bytes.length > MAX_SHEET_BYTES) throw new Error("That spreadsheet is too large (limit 5 MB).");
  try {
    const wb = new (XL().Workbook)();
    if (String(filename).toLowerCase().endsWith(".csv")) {
      const ws = wb.addWorksheet("Sheet1");
      for (const row of parseCsv(new TextDecoder("utf-8").decode(bytes))) ws.addRow(row);
    } else {
      await wb.xlsx.load(bytes);
    }
    return wb;
  } catch {
    throw new Error(BAD_SHEET);
  }
}

function sheetRows(ws, limit) {
  const rows = [];
  const last = Math.min(ws.rowCount, limit);
  for (let r = 1; r <= last; r++) {
    const row = [];
    for (let c = 1; c <= ws.columnCount; c++) row.push(str(ws.getRow(r).getCell(c).value));
    rows.push(row);
  }
  return rows;
}

function namesFromRows(rows) {
  if (!rows.length) return [];
  const col0 = guessNameColumn(rows[0]);
  const start = col0 != null ? 1 : 0, col = col0 ?? 0;
  return rows.slice(start).filter(r => col < r.length && String(r[col]).trim()).map(r => String(r[col]).trim());
}

/** Player names out of an uploaded sheet (first visible non-log sheet, or CSV). */
export async function readNamesFromSheet(data, filename) {
  const isCsv = String(filename).toLowerCase().endsWith(".csv");
  const wb = await loadWorkbook(data, filename);
  const plainSheet = w => !HELPER_SHEETS.has(w.name);
  const ws = wb.worksheets.find(w => plainSheet(w) && w.state === "visible") || wb.worksheets.find(plainSheet) || wb.worksheets[0];   // the sheet a save would update
  const rows = ws ? sheetRows(ws, MAX_NAMES + 1) : [];
  if (!rows.length) throw new Error("File is empty");
  return { names: namesFromRows(rows).slice(0, MAX_NAMES), orig_name: filename, is_csv: isCsv };
}

/** Goals already recorded in the workbook's hidden log (as comparable dicts). */
export function readLog(wb) {
  const ws = wb.getWorksheet(LOG_TITLE);
  if (!ws) return [];
  const rows = [];
  ws.eachRow((row, n) => {
    if (n < 2) return;
    rows.push([1, 2, 3, 4, 5, 6, 7].map(c => plain(row.getCell(c).value)));
  });
  return parseLogRows(rows);
}

/** Per-game match stats saved in the workbook, as {for, against, opponent, score, key}. */
export function readStatRows(wb) {
  const ws = wb.getWorksheet(STATS_DATA_TITLE);
  if (!ws) return [];
  const out = [];
  ws.eachRow((row, n) => {
    if (n < 2) return;
    const v = c => { const x = plain(row.getCell(c).value); return x === "" || x == null ? null : Number(x); };
    out.push({
      saved: String(plain(row.getCell(1).value) ?? ""), opponent: String(plain(row.getCell(2).value) ?? ""),
      score: String(plain(row.getCell(3).value) ?? ""), key: String(plain(row.getCell(16).value) ?? ""),
      for: { shots: v(4), sot: v(5), possession: v(6), pass: v(7), fouls: v(8), offsides: v(9) },
      against: { shots: v(10), sot: v(11), possession: v(12), pass: v(13), fouls: v(14), offsides: v(15) },
    });
  });
  return out;
}

/** Final scores saved in the workbook, as {key, opponent, score: [goalsFor, goalsAgainst]}. */
export function readGameRows(wb) {
  const ws = wb.getWorksheet(GAMES_TITLE);
  if (!ws) return [];
  const out = [];
  ws.eachRow((row, n) => {
    if (n < 2) return;
    const a = plain(row.getCell(3).value), b = plain(row.getCell(4).value);
    if (a === "" || a == null || b === "" || b == null) return;
    out.push({ key: String(plain(row.getCell(5).value) ?? ""), opponent: String(plain(row.getCell(2).value) ?? ""), score: [Number(a), Number(b)] });
  });
  return out;
}

/** Averages, results, hat-tricks and clutch for everything saved in a workbook. */
export function workbookStats(wb) {
  return computeStats(readLog(wb), readStatRows(wb), readGameRows(wb));
}

/** The same, from a spreadsheet file's bytes (for showing the stats as soon as it is uploaded). */
export async function readWorkbookStats(data, filename) {
  return workbookStats(await loadWorkbook(data, filename));
}

/** The per-player totals of an uploaded tracker spreadsheet ([{name, total}], most goals first), [] if it isn't one. */
export async function readWorkbookTotals(data, filename) {
  const ws = mainSheet(await loadWorkbook(data, filename));
  return isTrackerSheet(ws) ? sheetTotals(ws) : [];
}

export async function readKnownGoals(data, filename) {
  return readLog(await loadWorkbook(data, filename));
}

// ------------------------------------------------------------------ tracker sheet
function mainSheet(wb) {
  return wb.worksheets.find(ws => !HELPER_SHEETS.has(ws.name) && ws.state === "visible") || null;
}

function isTrackerSheet(ws) {
  return !!ws && str(ws.getCell("A1").value).trim().toLowerCase() === "name"
              && str(ws.getCell("B1").value).trim().toLowerCase() === "total";
}

const colLetter = n => { let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** Write `counts` into tracker sheet `ws` (new date column), sort players by total goals, rebuild
 *  the Total formulas and styling. Returns the sheet totals. */
function applyCounts(ws, counts, timestamp, normalize) {
  const tsHeader = timestamp.replace(/ /g, "\n");
  let maxCol = Math.max(ws.columnCount, 2);
  const header = Array.from({ length: maxCol }, (_, i) => str(ws.getCell(1, i + 1).value));
  let tsCol = header.indexOf(tsHeader) + 1;
  if (!tsCol) { tsCol = maxCol + 1; ws.getCell(1, tsCol).value = tsHeader; maxCol = tsCol; }

  let lastRow = Math.max(ws.rowCount, 1);
  const rowOf = new Map();
  for (let r = 2; r <= lastRow; r++) rowOf.set(normalize(str(ws.getCell(r, 1).value)), r);
  for (const name of Object.keys(counts)) {
    const key = normalize(name);
    if (!rowOf.has(key)) {
      lastRow++;
      ws.getCell(lastRow, 1).value = name.split(/\s+/).filter(Boolean).map(capitalizeWord).join(" ");
      rowOf.set(key, lastRow);
    }
  }
  // Two saves in the same minute share a column (its header is the time to the minute): add to what is there,
  // never replace it, or the first save's goals would vanish from the totals.
  for (const [name, cnt] of Object.entries(counts)) {
    const cell = ws.getCell(rowOf.get(normalize(name)), tsCol);
    cell.value = num(cell.value) + cnt;
  }

  // Sort players by total goals (most first, ties alphabetical).
  const data = [];
  for (let r = 2; r <= lastRow; r++) {
    const vals = [];
    for (let c = 3; c <= maxCol; c++) vals.push(ws.getCell(r, c).value);
    data.push({ name: ws.getCell(r, 1).value, vals, sum: vals.reduce((s, v) => s + num(v), 0) });
  }
  data.sort((a, b) => (b.sum - a.sum) || (str(a.name).toLowerCase() < str(b.name).toLowerCase() ? -1
                                        : str(a.name).toLowerCase() > str(b.name).toLowerCase() ? 1 : 0));
  data.forEach((d, i) => {
    const r = i + 2;
    ws.getCell(r, 1).value = d.name ?? null;
    d.vals.forEach((v, j) => { ws.getCell(r, j + 3).value = v ?? null; });
  });

  const totals = [];
  for (let r = 2; r <= lastRow; r++) {
    let total = 0;
    for (let c = 3; c <= maxCol; c++) total += num(ws.getCell(r, c).value);
    ws.getCell(r, 2).value = maxCol >= 3
      ? { formula: `SUM(C${r}:${colLetter(maxCol)}${r})`, result: total } : 0;
    const shown = Math.abs(total - Math.round(total)) < 1e-9 ? Math.round(total) : Math.round(total * 100) / 100;
    totals.push({ name: str(ws.getCell(r, 1).value), total: shown });
  }

  for (let c = 1; c <= maxCol; c++) {
    const cell = ws.getCell(1, c);
    cell.alignment = c >= 3 ? { horizontal: "center", vertical: "bottom", textRotation: 45 } : { horizontal: "center" };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4F81BD" } };
  }
  ws.getRow(1).height = 60;
  ws.views = [{ state: "frozen", xSplit: 2, ySplit: 1, topLeftCell: "C2", activeCell: "A1" }];
  return totals.sort((a, b) => b.total - a.total);
}

/** Current per-player totals of a tracker sheet, without changing it. */
function sheetTotals(ws) {
  const totals = [];
  const maxCol = Math.max(ws.columnCount, 2), last = Math.max(ws.rowCount, 1);
  for (let r = 2; r <= last; r++) {
    const name = str(ws.getCell(r, 1).value);
    if (!name) continue;
    let total = 0;
    for (let c = 3; c <= maxCol; c++) total += num(ws.getCell(r, c).value);
    const shown = Math.abs(total - Math.round(total)) < 1e-9 ? Math.round(total) : Math.round(total * 100) / 100;
    totals.push({ name, total: shown });
  }
  return totals.sort((a, b) => b.total - a.total);
}

function logSheet(wb) {
  let ws = wb.getWorksheet(LOG_TITLE);
  if (!ws) { ws = wb.addWorksheet(LOG_TITLE, { state: "hidden" }); ws.addRow(LOG_HEADER); }
  else if (ws.getRow(1).cellCount < LOG_HEADER.length) {            // written by the original app: add the new column titles
    LOG_HEADER.forEach((h, i) => { ws.getCell(1, i + 1).value = h; });
  }
  return ws;
}

/** Your goals (with their match id) and the opponent's goals (skipping ones already logged for that match). */
function appendLog(wb, goals, theirGoals, saved) {
  if (!goals.length && !theirGoals.length) return { theirs: 0 };
  const ws = logSheet(wb);
  const have = new Set();
  ws.eachRow((row, n) => {
    if (n > 1 && String(plain(row.getCell(6).value) ?? "").toLowerCase() === "them") have.add(`${plain(row.getCell(7).value)}|${plain(row.getCell(3).value)}`);
  });
  for (const g of goals) ws.addRow(logRow(g, saved, g.game_id));
  let theirs = 0;
  for (const t of theirGoals) {
    const k = `${t.game_id}|${t.minute}`;
    if (have.has(k)) continue;
    have.add(k);
    ws.addRow(theirLogRow(t, saved, t.game_id));
    theirs++;
  }
  return { theirs };
}

/** One row per game's match stats; a game whose stats are already saved (same key) is skipped. */
function appendStats(wb, records, saved) {
  if (!records.length) return { added: 0, skipped: 0 };
  let ws = wb.getWorksheet(STATS_DATA_TITLE);
  if (!ws) { ws = wb.addWorksheet(STATS_DATA_TITLE, { state: "hidden" }); ws.addRow(STATS_HEADER); }
  const have = new Set();
  ws.eachRow((row, n) => { if (n > 1) have.add(String(plain(row.getCell(16).value) ?? "")); });
  let added = 0, skipped = 0;
  for (const r of records) {
    if (have.has(r.key)) { skipped++; continue; }
    have.add(r.key);
    const f = r.stats.for, a = r.stats.against;
    ws.addRow([saved, r.opponent, `${r.score[0] ?? ""}-${r.score[1] ?? ""}`, f.shots, f.sot, f.possession, f.pass, f.fouls, f.offsides,
               a.shots, a.sot, a.possession, a.pass, a.fouls, a.offsides, r.key]);
    added++;
  }
  return { added, skipped };
}

/**
 * One row per game's final score; a game already saved (same key) is skipped. Games that are only in the goal log
 * (saved before this sheet existed) are copied in first, so the sheet is complete and its formulas are right.
 * Returns {added}: the games of `records` that are new.
 */
function appendGames(wb, records, saved) {
  let ws = wb.getWorksheet(GAMES_TITLE);
  if (!ws) { ws = wb.addWorksheet(GAMES_TITLE, { state: "hidden" }); ws.addRow(GAMES_HEADER); }
  const have = new Set();
  ws.eachRow((row, n) => { if (n > 1) have.add(String(plain(row.getCell(5).value) ?? "")); });
  const fresh = new Set(records.map(r => r.key));
  let added = 0, stubRow = 0;
  const add = (r, when) => {
    if (have.has(r.key) || r.score[0] == null || r.score[1] == null) return;
    // A game saved earlier from its Match Stats page alone (key "0|opponent|score|t:") is this very game, now that
    // its goal list is saved: replace that row instead of counting the game twice.
    if (!r.key.startsWith("0|")) {
      const stub = `0|${oppKey(r.opponent)}|${r.score[0]}-${r.score[1]}|t:`;
      if (have.has(stub)) {
        ws.eachRow((row, n) => { if (n > 1 && String(plain(row.getCell(5).value) ?? "") === stub) stubRow = n; });
        if (stubRow) { ws.spliceRows(stubRow, 1); have.delete(stub); stubRow = 0; }
      }
    }
    have.add(r.key);
    ws.addRow([when, r.opponent, r.score[0], r.score[1], r.key]);
    if (fresh.has(r.key)) added++;
  };
  for (const g of gamesFromLog(readLog(wb))) add({ key: g.game, opponent: g.opponent, score: g.score }, "(earlier)");
  for (const r of records) add(r, saved);
  return { added };
}

const HEAD_STYLE = (cell) => {
  cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4F81BD" } };
  cell.alignment = { horizontal: "center" };
};

/** The visible "Stats" sheet: live averages (formulas over _stats) plus the hat-trick and clutch tables. */
function writeSummarySheet(wb, stats) {
  const old = wb.getWorksheet(SUMMARY_TITLE);
  if (old) wb.removeWorksheet(old.id);
  const ws = wb.addWorksheet(SUMMARY_TITLE);
  ws.getColumn(1).width = 30; [2, 3, 4].forEach(c => { ws.getColumn(c).width = 18; });
  const n = stats.averages.games, res = stats.results;
  const G = (col) => `${GAMES_TITLE}!${col}2:${col}5000`;
  ws.getCell("A1").value = `Average per game (goals: ${res.played} game${res.played === 1 ? "" : "s"}; the rest: ${n} game${n === 1 ? "" : "s"} with match stats)`;
  ws.getCell("A1").font = { bold: true, size: 13 };
  ["Stat", "You", "Opponent"].forEach((h, i) => { const c = ws.getCell(3, i + 1); c.value = h; HEAD_STYLE(c); });
  const avgF = (sheet, col) => `IFERROR(ROUND(AVERAGE(${sheet}!${col}2:${col}5000),1),"")`;
  const metrics = [["Goals", "goals", GAMES_TITLE, "C", "D"], ["Shots", "shots", STATS_DATA_TITLE, "D", "J"], ["Shots on target", "sot", STATS_DATA_TITLE, "E", "K"],
                   ["Possession %", "possession", STATS_DATA_TITLE, "F", "L"], ["Pass accuracy %", "pass", STATS_DATA_TITLE, "G", "M"],
                   ["Fouls", "fouls", STATS_DATA_TITLE, "H", "N"], ["Offsides", "offsides", STATS_DATA_TITLE, "I", "O"]];
  metrics.forEach(([label, key, sheet, you, opp], i) => {
    const r = 4 + i;
    ws.getCell(r, 1).value = label;
    ws.getCell(r, 2).value = { formula: avgF(sheet, you), result: stats.averages.for[key] ?? "" };
    ws.getCell(r, 3).value = { formula: avgF(sheet, opp), result: stats.averages.against[key] ?? "" };
    ws.getCell(r, 2).alignment = ws.getCell(r, 3).alignment = { horizontal: "center" };
  });

  let r = 4 + metrics.length + 1;
  // Team record: live formulas over the hidden _games sheet (hat-tricks and comebacks need the goal log: values)
  ws.getCell(r, 1).value = "Team record"; ws.getCell(r, 1).font = { bold: true, size: 13 }; r++;
  ["Stat", "Total"].forEach((h, i) => { const c = ws.getCell(r, i + 1); c.value = h; HEAD_STYLE(c); });
  r++;
  const at = {};                                                       // row of each line, for the formulas that refer to others
  const rows = [
    ["played", "Games played", `COUNT(${G("C")})`, res.played],
    ["wins", "Wins", `SUMPRODUCT(--(${G("C")}>${G("D")}))`, res.wins],
    ["draws", "Draws", `SUMPRODUCT((${G("C")}<>"")*(${G("C")}=${G("D")}))`, res.draws],
    ["losses", "Losses", `SUMPRODUCT(--(${G("C")}<${G("D")}))`, res.losses],
    ["rate", "Win rate %", () => `IFERROR(ROUND(100*B${at.wins}/B${at.played},1),"")`, res.winRate ?? ""],
    ["gf", "Goals for", `SUM(${G("C")})`, res.goalsFor],
    ["ga", "Goals against", `SUM(${G("D")})`, res.goalsAgainst],
    ["gd", "Goal difference", () => `B${at.gf}-B${at.ga}`, res.goalDiff],
    ["clean", "Clean sheets", `COUNTIFS(${G("D")},0,${G("C")},">=0")`, res.cleanSheets],
    ["comeback", "Comeback wins", null, res.comebackWins ?? 0],
    ["hat", "Hat-tricks", null, res.hatTricks],
  ];
  rows.forEach(([k], i) => { at[k] = r + i; });
  for (const [, label, formula, value] of rows) {
    ws.getCell(r, 1).value = label;
    const f = typeof formula === "function" ? formula() : formula;
    ws.getCell(r, 2).value = f ? { formula: f, result: value } : value;
    ws.getCell(r, 2).alignment = { horizontal: "center" };
    r++;
  }
  r++;

  // Shooting: accuracy is a live formula over _stats; conversion needs each game's goals, so it is a value
  const sh = stats.shooting;
  ws.getCell(r, 1).value = `Shooting (${sh.games} game${sh.games === 1 ? "" : "s"} with match stats)`; ws.getCell(r, 1).font = { bold: true, size: 13 }; r++;
  ["Stat", "You", "Opponent"].forEach((h, i) => { const c = ws.getCell(r, i + 1); c.value = h; HEAD_STYLE(c); });
  r++;
  const S = col => `${STATS_DATA_TITLE}!${col}2:${col}5000`;
  const acc = (sot, shots, v) => ({ formula: `IFERROR(ROUND(100*SUM(${S(sot)})/SUM(${S(shots)}),1),"")`, result: v ?? "" });
  ws.getCell(r, 1).value = "Shot accuracy % (on target / shots)";
  ws.getCell(r, 2).value = acc("E", "D", sh.for.accuracy); ws.getCell(r, 3).value = acc("K", "J", sh.against.accuracy); r++;
  ws.getCell(r, 1).value = "Conversion % (goals / shots)";
  ws.getCell(r, 2).value = sh.for.conversion ?? ""; ws.getCell(r, 3).value = sh.against.conversion ?? ""; r++;
  for (let k = 2; k >= 1; k--) [2, 3].forEach(c => { ws.getCell(r - k, c).alignment = { horizontal: "center" }; });
  r++;

  // Biggest win / heaviest defeat (values: they name the opponent)
  ws.getCell(r, 1).value = "Best and worst results"; ws.getCell(r, 1).font = { bold: true, size: 13 }; r++;
  ["Result", "Score", "Opponent"].forEach((h, i) => { const c = ws.getCell(r, i + 1); c.value = h; HEAD_STYLE(c); });
  r++;
  for (const [label, e] of [["Biggest win", stats.extremes.biggestWin], ["Heaviest defeat", stats.extremes.heaviestDefeat]]) {
    ws.getCell(r, 1).value = label;
    ws.getCell(r, 2).value = e ? `${e.score[0]}-${e.score[1]}` : "-"; ws.getCell(r, 2).alignment = { horizontal: "center" };
    ws.getCell(r, 3).value = e ? e.opponent : "";
    r++;
  }
  r++;

  const section = (title, headers, list, empty) => {
    ws.getCell(r, 1).value = title; ws.getCell(r, 1).font = { bold: true, size: 13 }; r++;
    if (!list.length) { ws.getCell(r, 1).value = empty; ws.getCell(r, 1).font = { italic: true, color: { argb: "FF808080" } }; r += 2; return; }
    headers.forEach((h, i) => { const c = ws.getCell(r, i + 1); c.value = h; HEAD_STYLE(c); });
    r++;
    for (const row of list) { row.forEach((v, i) => { const c = ws.getCell(r, i + 1); c.value = v; if (i) c.alignment = { horizontal: "center" }; }); r++; }
    r++;
  };
  section("Hat-tricks (3+ goals in a match)", ["Player", "Hat-tricks", "Most goals in a match"],
          stats.hatTricks.map(h => [h.name, h.hatTricks, h.mostGoals]), "No hat-tricks yet.");
  section("Most clutch players: stoppage-time (90'+N) winners and equalizers", ["Player", "Winners", "Equalizers", "Total"],
          stats.clutch.map(c => [c.name, c.winners, c.equalizers, c.total]), "No stoppage-time winners or equalizers yet.");
  const note = ws.getCell(r, 1);
  note.value = "Winners need all of your goals for the match; equalizers need both teams goals (recorded from the first scan with this version).";
  note.font = { italic: true, color: { argb: "FF808080" } };
}

/**
 * Apply `counts` (+ log rows for the goals behind them, the opponent's goals and the matches' stats) to the user's
 * spreadsheet. `sheetBytes` is the user's current spreadsheet, or null to start a new one. A spreadsheet that isn't in
 * tracker format (Name | Total | dates...) is never modified: a fresh tracker is created, seeded with the names it listed.
 *
 *   logGoals    your goals to log, each with `game_id` (the match they belong to)
 *   theirGoals  the opponent's goals: {game_id, minute, name, opponent, score_l, score_r}
 *   statRecords one per game: {opponent, score, stats: {for, against}, key}
 *   gameRecords one per game: {opponent, score: [goalsFor, goalsAgainst], key}: the final scores behind the results
 *
 * Returns {xlsx: Uint8Array, filename, sheet_totals, notice, stats, recorded_stats, skipped_stats}.
 */
export async function updateWorkbook({ sheetBytes, filename = "", counts, timestamp, normalize, logGoals = [], theirGoals = [], statRecords = [], gameRecords = [] }) {
  let notice = null, roster = [];
  let wb = sheetBytes ? await loadWorkbook(sheetBytes, filename) : null;
  let ws = null;

  if (wb) {
    ws = mainSheet(wb);
    if (!isTrackerSheet(ws)) {
      roster = ws ? namesFromRows(sheetRows(ws, 500)) : [];
      wb = null;
      notice = "Your spreadsheet isn't in the tracker format (Name | Total | one column per scan), so it was " +
               "left untouched and a new tracker spreadsheet was created" +
               (roster.length ? ` with your ${roster.length} name(s).` : ".");
    }
  }
  if (!wb) {
    wb = new (XL().Workbook)();
    ws = wb.addWorksheet("Results");
    ws.addRow(["Name", "Total"]);
    for (const n of roster) ws.addRow([n]);
  }

  // a save that only adds match stats leaves the goal columns alone
  const totals = Object.keys(counts).length ? applyCounts(ws, counts, timestamp, normalize) : sheetTotals(ws);
  const lg = appendLog(wb, logGoals, theirGoals, timestamp);
  const st = appendStats(wb, statRecords, timestamp);
  const gm = appendGames(wb, gameRecords, timestamp);
  const stats = workbookStats(wb);
  writeSummarySheet(wb, stats);
  const idx = wb.worksheets.indexOf(ws);
  wb.views = [{ x: 0, y: 0, width: 10000, height: 20000, firstSheet: 0, activeTab: idx, visibility: "visible" }];
  wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };   // recalculate every formula when the file is opened

  const out = new Uint8Array(await wb.xlsx.writeBuffer());
  const name = String(filename || "");
  return {
    xlsx: out,
    filename: name.toLowerCase().endsWith(".xlsx") && !notice ? name : "results.xlsx",
    sheet_totals: totals,
    notice,
    stats,
    recorded_stats: st.added,
    skipped_stats: st.skipped,
    recorded_theirs: lg.theirs,
    recorded_games: gm.added,
  };
}
