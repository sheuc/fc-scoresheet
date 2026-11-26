// Reads the match-stats panel (both layouts) into numbers: {for, against} per screenshot.
//
// Tesseract is unreliable on these small cells in *different* ways depending on its settings (with a digits-only
// whitelist it returns nothing for some clear digits; without one it occasionally drops a digit), so every group of
// digits is read several ways and the readings vote. The one hard constraint available, that the two possession
// values add up to 100, then breaks any remaining tie.
import { cellIsBlank, statParts } from "./vision.js";
import { statsFromNumbers } from "./matchstats.js";
import { digitsFrom } from "./ocr.js";

const ROW_KINDS = ["shots", "percent", "percent", "count", "count"];     // shots(on target), possession, pass accuracy, fouls, offsides

/** Most common candidate; ties go to the one whose length matches the glyph count, then to the earliest. */
function vote(cands, glyphCount) {
  const counts = new Map();
  for (const c of cands) if (c) counts.set(c, (counts.get(c) || 0) + 1);
  if (!counts.size) return null;
  return [...counts].sort((a, b) => b[1] - a[1] || (b[0].length === glyphCount) - (a[0].length === glyphCount))[0][0];
}

/**
 * @param ocr    pool from createOcrPool()
 * @param crops  array (one per screenshot) of the 5 rows [{l, r}] from analyzeImage().stats_crops
 * @param onProgress  optional, called with 0..1 as the reading advances
 * @returns      array aligned with `crops`: {for, against, problems[]} or null if a cell couldn't be read
 */
export async function readMatchStats(ocr, crops, onProgress = () => {}) {
  // 1. cut every cell into digit groups
  const cells = [];                                    // {shot, r, side, parts|null}
  crops.forEach((rows, shot) => rows.forEach((row, r) => ["l", "r"].forEach(side => {
    const blank = cellIsBlank(row[side]);                        // checked first: an empty cell would otherwise "yield" noise glyphs
    let parts = null;
    try { parts = blank ? null : statParts(row[side], ROW_KINDS[r]); } catch { parts = null; }      // a cell that can't be cut is simply unreadable
    cells.push({ shot, r, side, blank, parts });
  })));
  const groups = cells.flatMap(c => (c.parts ? c.parts.groups : []));

  // 2. read every group as a line, with and without a whitelist
  const strips = groups.map(g => g.strip);
  const free = await ocr.recognize("digits", strips, (n, m) => onProgress(0.4 * n / m));
  const strict = await ocr.recognize("digitsWL", strips, (n, m) => onProgress(0.4 + 0.4 * n / m));
  groups.forEach((g, i) => { g.cands = [digitsFrom(free[i].text), digitsFrom(strict[i].text)]; });

  // 3. every group also gets a glyph-by-glyph read. A line read can be wrong in a way both settings share: it drops a
  // repeated digit ("77" -> "7") or reads a 7 next to a thin 1 as another 1 ("71%" -> "11%", IMG_9768). A digit read on
  // its own has no neighbours to be confused by, so these candidates come first and win ties.
  const flat = groups.flatMap(g => g.glyphs);
  const [a, b] = flat.length ? [await ocr.recognize("digit1", flat), await ocr.recognize("digit1WL", flat)] : [[], []];
  onProgress(0.95);
  let k = 0;
  for (const g of groups) {
    const n = g.glyphs.length, lineReads = g.cands;
    g.cands = [];
    for (const res of [a, b]) {
      const t = res.slice(k, k + n).map(r => digitsFrom(r.text));
      if (t.every(d => d.length === 1)) g.cands.push(t.join(""));
    }
    g.cands.push(...lineReads);
    k += n;
  }
  groups.forEach(g => {
    g.all = g.cands;
    g.text = vote(g.cands, g.glyphs.length);
    g.votes = g.text ? g.cands.filter(c => c === g.text).length : 0;      // independent readings that agree
  });

  // 4. numbers; the possession pair must add up to 100
  const num = g => (g && g.text ? parseInt(g.text, 10) : null);
  const cell = (shot, r, side) => cells.find(x => x.shot === shot && x.r === r && x.side === side);
  const alts = g => [...new Set(g.all.filter(Boolean))].map(Number);
  // The game draws the rows one after another, so a screenshot taken a moment early lacks the last ones. Fouls and
  // offsides may be missing then, but only if the row is completely empty on BOTH sides; anything unreadable that
  // is there still rejects the screenshot.
  const rowAbsent = (shot, r) => ["l", "r"].every(side => cell(shot, r, side).blank);
  const team = (shot, side) => {
    const sh = cell(shot, 0, side).parts;
    const [possession, pass, fouls, offsides] = [1, 2, 3, 4].map(r => num(cell(shot, r, side).parts?.groups[0]));
    const vals = { shots: sh && num(sh.groups[0]), sot: sh && num(sh.groups[1]), possession, pass, fouls, offsides };
    if (vals.fouls == null && rowAbsent(shot, 3)) vals.fouls = null; else if (vals.fouls == null) return null;
    if (vals.offsides == null && rowAbsent(shot, 4)) vals.offsides = null; else if (vals.offsides == null) return null;
    return ["shots", "sot", "possession", "pass"].some(k => vals[k] == null) ? null : vals;
  };
  return crops.map((_, shot) => {
    const f = team(shot, "l"), a = team(shot, "r");
    if (!f || !a) return null;
    if (f.possession + a.possession !== 100) {
      const gl = cell(shot, 1, "l").parts.groups[0], gr = cell(shot, 1, "r").parts.groups[0];
      const fix = alts(gl).flatMap(x => alts(gr).map(y => [x, y])).filter(([x, y]) => x + y === 100);
      if (fix.length === 1) [f.possession, a.possession] = fix[0];             // exactly one combination adds up
    }
    const s = statsFromNumbers(f, a);
    s.missing = ["fouls", "offsides"].filter(k => f[k] == null);          // rows the screenshot didn't have yet
    // how many of this screenshot's values rest on a single reading (the others were contradicted or unconfirmed)
    s.unsure = cells.filter(c => c.shot === shot && c.parts).flatMap(c => c.parts.groups).filter(g => g.votes < 2).length;
    return s;
  });
}
