// Port of process_images() from services/ocr_engine.py: scans screenshots, reads the green
// goal rows, groups screenshots of the same game, de-duplicates by (minute, scorer) and flags
// games whose goal list is cut off.
//
// Everything runs in the browser. Injected so it can also run under Node for tests:
//   decodeImage(file) -> {data: RGBA, width, height}
//   ocr: pool from createOcrPool()
import { digitsFrom } from "./ocr.js";
import { analyzeImage, minuteGlyphs, PREP_BY_VERSION, REFERENCE_ASPECT } from "./vision.js";
import { cleanWord, fuzzyMatch, normalize, partialRatio, ratio } from "./text.js";
import { findKnown, oppKey } from "./goal-log.js";
import { readMatchStats } from "./statsread.js";
import { statsKey } from "./matchstats.js";

const OPP_MIN_CONF = 0.5;     // below this the opponent name read is treated as unknown
const SCORE_MIN_CONF = 0.8;   // ignore score reads less confident than this
const NAME_SIM = 80;          // fuzzy % for "same opponent username"
const SCORER_SIM = 70;        // fuzzy % for "same scorer" when checking conflicts

// ------------------------------------------------------------------ parsing
export function parseMinute(text) {
  const nums = String(text ?? "").match(/\d+/g);
  if (!nums) return null;
  return nums.slice(0, 2).map(n => n.replace(/^0+/, "") || "0").join("+");
}

/** A minute is plausible if it is N or N+M with N in 1..120 and M in 1..15. */
export function validMinute(text) {
  const nums = String(text ?? "").match(/\d+/g);
  if (!nums || nums.length > 2) return false;
  const [n, extra] = nums.map(Number);
  return n >= 1 && n <= 120 && (extra === undefined || (extra >= 1 && extra <= 15));
}

export function minuteSortKey(m) {
  if (m == null) return [10000, 0];
  const p = m.split("+");
  return [parseInt(p[0], 10), p.length > 1 ? parseInt(p[1], 10) : 0];
}
const cmpKey = (a, b) => a[0] - b[0] || a[1] - b[1];

export function parseScore(text) {
  const digits = String(text ?? "").replace(/\D/g, "");
  return digits ? parseInt(digits, 10) : null;
}

/** OCR field used for a kind of crop on a given screen layout. */
function fieldFor(version, kind) {
  if (kind === "score_l" || kind === "score_r") return version === "new" ? "score_ring" : "score";
  return kind;     // name, minute, opp
}

/**
 * Confidence of a score read. Old screen: Tesseract's own. New screen: its confidence is 0 for
 * the ring-shaped zero (and sometimes for clean digits), so a read that parsed to a number counts as
 * confident; the new font is large and clean, and a wrong read is caught by the games' score checks.
 */
function scoreConf(analysis, value, result) {
  return analysis.version === "new" ? (value == null ? 0 : 1) : result.conf / 100;
}

/** Score reads may contain O/o/D/Q for the new font's ring-shaped zero. */
function scoreText(text) {
  return String(text ?? "").replace(/[OoDQ]/g, "0");
}

/**
 * The line read sometimes drops a repeated thin digit ("11'" -> "1") or invents one ("12'" -> "127").
 * When the number of digits it returned differs from the number of digit-shaped glyphs in the
 * crop, read those glyphs one by one instead.
 * Only accepted if every glyph gives exactly one digit; otherwise the line read stands.
 * Mutates `minutes` (the recognised results, aligned with `owners`).
 */
async function rereadCollapsedMinutes(ocr, owners, minutes) {
  const jobs = [];       // {i, digits: [glyph images], plusAfter}
  owners.forEach((r, i) => {
    const g = minuteGlyphs(r.minute_crop);
    const read = (minutes[i].text.match(/\d/g) || []).length;
    // Fewer digits than glyphs: the decoder collapsed a repeated thin digit ("11'" -> "1").
    // More digits than glyphs: it invented one, typically from the apostrophe ("12'" -> "127").
    if (!g.merged && g.digits.length > 0 && g.digits.length !== read) jobs.push({ i, ...g });
  });
  if (!jobs.length) return;
  const all = jobs.flatMap(j => j.digits);
  const glyphs = await ocr.recognize("glyph", all);
  // A glyph the digits-only reader sees nothing in (a round "0") is read once more without a whitelist, and the
  // letters it answers for digit shapes are mapped back (the same two-reader idea as the stats cells).
  const blank = glyphs.map((r, i) => (digitsFrom(r.text) === "" ? i : -1)).filter(i => i >= 0);
  if (blank.length) {
    const again = await ocr.recognize("digit1", blank.map(i => all[i]));
    blank.forEach((i, n) => { if (digitsFrom(again[n].text).length === 1) glyphs[i] = again[n]; });
  }
  let k = 0;
  for (const j of jobs) {
    const d = glyphs.slice(k, k + j.digits.length).map(r => digitsFrom(r.text));
    k += j.digits.length;
    if (!d.every(s => s.length === 1)) continue;
    const text = j.plusAfter >= 0
      ? `${d.slice(0, j.plusAfter).join("")}+${d.slice(j.plusAfter).join("")}`
      : d.join("");
    if (validMinute(text)) minutes[j.i] = { ...minutes[j.i], text };
  }
}

/** Names always start with a capital, and "I" and "l" are the same glyph in the game's font. */
function fixName(text) {
  const t = String(text ?? "").trim();
  return t.startsWith("l") ? "I" + t.slice(1) : t;
}

// ------------------------------------------------------------------ grouping screenshots of the same game
function sameText(a, b, thr) { return ratio(a, b) >= thr; }

/** Score conflict between two screenshots (both reads confident and different), or null. */
function scoreConflict(a, b) {
  for (const side of ["l", "r"]) {
    const va = a[`score_${side}_val`], vb = b[`score_${side}_val`];
    const ca = a[`score_${side}_conf`], cb = b[`score_${side}_conf`];
    if (va != null && vb != null && ca >= SCORE_MIN_CONF && cb >= SCORE_MIN_CONF && va !== vb)
      return `score ${side} ${va} != ${vb}`;
  }
  return null;
}

/** All goals a new-layout screenshot shows, with the side that scored. */
function eventsOf(a) {
  return [...a.goals.map(g => ({ side: "o", minute: g.minute, clean: g.clean })),
          ...(a.theirs_goals || []).map(g => ({ side: "t", minute: g.minute, clean: g.clean }))].filter(e => e.minute);
}

/** Every goal on the screen was visible and read: your goals and the opponent's add up to the score. */
function isComplete(a) {
  return a.score_l_val != null && a.score_r_val != null
    && a.score_l_conf >= SCORE_MIN_CONF && a.score_r_conf >= SCORE_MIN_CONF
    && a.goals.length === a.score_l_val && (a.theirs_goals || []).length === a.score_r_val;
}

/**
 * New layout. The club name and username can only *rule games out*: many games are against the same
 * club, and the username banner reads imperfectly. What *proves* two screenshots are the same game is
 * a goal they both show: same minute, same side, same scorer. Without one they stay separate games.
 */
export function incompatibleNew(a, b) {
  const sc = scoreConflict(a, b);
  if (sc) return sc;
  if (a.opp.length >= 3 && b.opp.length >= 3 && a.opp_conf >= 0.6 && b.opp_conf >= 0.6 && !sameText(a.opp, b.opp, NAME_SIM))
    return `club '${a.opp}' != '${b.opp}'`;
  // The banner is pixel-identical across screenshots of one game, so its (noisy) read is too.
  if (a.user.length >= 4 && b.user.length >= 4 && ratio(a.user, b.user) < 70 && partialRatio(a.user, b.user) < 80)
    return `username '${a.user}' != '${b.user}'`;

  const ea = eventsOf(a), eb = eventsOf(b);
  let shared = 0;
  for (const e of eb) {
    const same = ea.filter(x => x.side === e.side && x.minute === e.minute);
    if (!same.length) continue;
    if (same.some(x => sameText(x.clean, e.clean, SCORER_SIM))) shared++;
    else return `minute ${e.minute}: a different player scored`;
  }
  if (!shared) return "no goal in common";
  // Both lists complete means both show the whole game, so they must (almost) agree.
  // One misread minute is tolerated.
  if (isComplete(a) && isComplete(b) && shared < Math.max(1, Math.min(ea.length, eb.length) - 1))
    return "both show every goal, but different ones";
  return null;
}

/** Why two screenshots can't be the same game, or null if they can. */
export function incompatibleReason(a, b) {
  if (a.version !== b.version) return "different screen layouts";
  if (a.version === "new") return incompatibleNew(a, b);
  const oppKnown = [a, b].every(x => x.opp.length >= 3 && x.opp_conf >= OPP_MIN_CONF);
  if (oppKnown && !sameText(a.opp, b.opp, NAME_SIM)) return `opponent '${a.opp}' != '${b.opp}'`;
  const sc = scoreConflict(a, b);
  if (sc) return sc;
  const ma = new Map(a.goals.filter(g => g.minute).map(g => [g.minute, g.clean]));
  for (const g of b.goals) {
    if (ma.has(g.minute) && !sameText(ma.get(g.minute), g.clean, SCORER_SIM))
      return `minute ${g.minute}: '${ma.get(g.minute)}' != '${g.clean}'`;
  }
  if (!oppKnown) {
    // Can't tell the games apart by opponent (e.g. a stylised username), so only merge on
    // positive evidence: a goal both screenshots show.
    const shared = b.goals.some(g => g.minute && ma.has(g.minute) && sameText(ma.get(g.minute), g.clean, SCORER_SIM));
    if (!shared) return "opponent unreadable and no overlapping goal";
  }
  return null;
}

export function groupImages(analyzed) {
  const groups = [];
  for (const item of analyzed) {
    const home = groups.find(grp => !grp.some(other => incompatibleReason(item, other)));
    if (home) home.push(item); else groups.push([item]);
  }
  return groups;
}

/** Detect mode: fold near-identical OCR spellings of a scorer into the most common one. */
export function canonicalNames(names, threshold = 85) {
  const freq = new Map();
  for (const n of names) if (n) freq.set(n, (freq.get(n) || 0) + 1);
  const canon = new Map(), reps = [];
  const order = [...freq.keys()].sort((a, b) => freq.get(b) - freq.get(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const n of order) {
    const rep = reps.find(r => ratio(n, r) >= threshold);
    if (rep) canon.set(n, rep); else { reps.push(n); canon.set(n, n); }
  }
  return canon;
}

/** Most common value; ties go to the smallest (matches iteration order of a Python set of small ints). */
function mode(values) {
  if (!values.length) return null;
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

const pad2 = n => String(n).padStart(2, "0");
export function stamp(d = new Date()) {
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Is a Match Stats page the stats of one of these goal-list games? Same final score and the SAME opponent label. The
 * label is read from a banner that is pixel-identical on every page of a game, so a near match is not good enough:
 * "Juventus FC / Marcus" and "Juventus FC / Marcos" are 83% alike, but are different opponents. A page whose label
 * could not be read is linked only when exactly one game has its score.
 */
export function statsPageLinked(games, score, opponent) {
  const label = oppKey(opponent);
  const sameScore = games.filter(g => g.score[0] === score[0] && g.score[1] === score[1]);
  return label ? sameScore.some(g => oppKey(g.opponent) === label) : sameScore.length === 1;
}

// ------------------------------------------------------------------ main entry point
/**
 * @param files      array of {name, ...} handed to decodeImage
 * @param normNames  normalised names to look for (ignored when detect = true)
 * @param opts       {detect, ocr, decodeImage, progress(stage, pct), knownGoals, signal}
 */
export async function processImages(files, normNames, opts) {
  const { detect = false, ocr, decodeImage, knownGoals = [], signal } = opts;
  const report = opts.progress || (() => {});
  const aborted = () => { if (signal?.aborted) throw new DOMException("Scan cancelled", "AbortError"); };
  const warnings = [];
  const total = files.length;

  // --- 1. decode + colour pass, one screenshot at a time (keeps memory flat on phones) ---
  report(`Reading screenshots (0 of ${total})`, 0);
  const analyzed = [];
  for (let i = 0; i < total; i++) {
    aborted();
    const f = files[i];
    try {
      const a = analyzeImage(f.name, await decodeImage(f));
      if (a.score_l && a.score_r && a.opp_crop) analyzed.push(a);
      else warnings.push(`${f.name}: doesn't look like a post-match screen; skipped.`);
    } catch (e) {
      warnings.push(`${f.name}: couldn't be read as an image; skipped.`);
    }
    report(`Reading screenshots (${i + 1} of ${total})`, Math.round(35 * (i + 1) / total));
    if (i % 4 === 3) await new Promise(r => setTimeout(r, 0));      // let the page repaint
  }

  // --- 2. batched recognition across every image ---
  // Screenshots of the two layouts are prepared (and some fields read) differently, so each
  // batch is split by layout, recognised, and put back in order.
  // Every row to read: yours first, then (new layout) the opponent's, whose minutes and names are only
  // used to tell games apart.
  const owners = [];
  for (const a of analyzed) for (const r of a.rows) { r.version = a.version; owners.push(r); }
  for (const a of analyzed) for (const r of a.theirs_rows || []) { r.version = a.version; owners.push(r); }
  const tick = (lo, hi, label) => (n, m) => report(label, Math.round(lo + (hi - lo) * n / m));

  async function readBatch(kind, items, onItem) {
    const out = new Array(items.length), groups = new Map();
    items.forEach((it, i) => {
      const field = fieldFor(it.version, kind);
      if (!groups.has(field)) groups.set(field, []);
      groups.get(field).push(i);
    });
    let done = 0;
    for (const [field, idx] of groups) {
      const imgs = idx.map(i => PREP_BY_VERSION[items[i].version][kind](items[i].crop));
      const res = await ocr.recognize(field, imgs, onItem && (() => onItem(++done, items.length)));
      idx.forEach((i, k) => { out[i] = res[k]; });
    }
    return out;
  }

  aborted();
  report("Reading player names", 35);
  const names = await readBatch("name", owners.map(r => ({ version: r.version, crop: r.name_crop })), tick(35, 50, "Reading player names"));
  aborted();
  const minutes = await readBatch("minute", owners.map(r => ({ version: r.version, crop: r.minute_crop })), tick(50, 62, "Reading goal minutes"));
  await rereadCollapsedMinutes(ocr, owners, minutes);
  aborted();
  const scoreItems = [
    ...analyzed.map(a => ({ version: a.version, crop: a.score_l })),
    ...analyzed.map(a => ({ version: a.version, crop: a.score_r })),
  ];
  const scores = await readBatch("score_l", scoreItems, tick(62, 68, "Reading scores"));
  // A line read that finds no digit at all often just needs single-character mode (seen on JPEG-recompressed screenshots).
  for (const version of ["old", "new"]) {
    const idx = scores.map((r, i) => (parseScore(scoreText(r.text)) == null && scoreItems[i].version === version ? i : -1)).filter(i => i >= 0);
    if (!idx.length) continue;
    const again = await ocr.recognize(version === "new" ? "score_ring1" : "score1", idx.map(i => PREP_BY_VERSION[version].score_l(scoreItems[i].crop)));
    idx.forEach((i, k) => { if (parseScore(scoreText(again[k].text)) != null) scores[i] = again[k]; });
  }
  aborted();
  const opps = await readBatch("opp", analyzed.map(a => ({ version: a.version, crop: a.opp_crop })), tick(68, 72, "Identifying games"));
  // New layout: the opponent's username (banner) as well as the club.
  const withUser = analyzed.filter(a => a.user_crop);
  const users = await readBatch("opp", withUser.map(a => ({ version: a.version, crop: a.user_crop })), tick(72, 74, "Identifying games"));
  withUser.forEach((a, i) => { a.user_raw = users[i].text.replace(/[^\w .-]/g, "").trim(); });

  // Match stats: the old screen has the panel in every screenshot, the new one on its own "Match Stats" page.
  aborted();
  const withStats = analyzed.filter(a => a.stats_crops);
  if (withStats.length) {
    // Match stats are an extra: whatever goes wrong while reading them must never cost the goals.
    try {
      const read = await readMatchStats(ocr, withStats.map(a => a.stats_crops), f => report("Reading match stats", Math.round(74 + 18 * f)));
      withStats.forEach((a, i) => { a.stats = read[i]; });
    } catch (e) {
      if (e?.name === "AbortError" || signal?.aborted) throw e;
      warnings.push("The match stats couldn't be read from these screenshots, so none were recorded (the goals were not affected).");
      withStats.forEach(a => { a.stats = null; });
    }
  }
  report("Merging screenshots into games", 92);

  owners.forEach((r, i) => {
    r.raw = fixName(names[i].text);
    r.clean = normalize(cleanWord(r.raw.replace(/\bgoal\b/gi, "")));
    r.minute = parseMinute(minutes[i].text);
    // Tesseract's confidence is unreliable on binarised minute crops; judge the read by its shape.
    r.minute_conf = r.minute != null && validMinute(minutes[i].text) ? 1 : 0;
  });
  const n = analyzed.length;
  analyzed.forEach((a, i) => {
    a.score_l_val = parseScore(scoreText(scores[i].text)); a.score_l_conf = scoreConf(a, a.score_l_val, scores[i]);
    a.score_r_val = parseScore(scoreText(scores[n + i].text)); a.score_r_conf = scoreConf(a, a.score_r_val, scores[n + i]);
    a.opp = normalize(opps[i].text).replace(/[^a-z0-9]/g, "");
    a.opp_conf = opps[i].conf / 100;
    a.opp_raw = opps[i].text.trim();
    a.user = normalize(a.user_raw || "").replace(/[^a-z0-9]/g, "");
    // New layout: label the opponent "club / username" so two games against one club stay distinguishable
    if (a.version === "new" && a.user.length >= 3) a.opp_raw = `${a.opp_raw} / ${a.user_raw}`;
    a.goals = a.rows;
    a.theirs_goals = a.theirs_rows || [];
  });

  // --- 3. screenshots that don't look like the expected screen are skipped ---
  const goalsFlat = [], gamesOut = [], counts = new Map(), filesByName = new Map(), allMatches = [];
  const theirsFlat = [], statRecords = [], partialNotes = [];
  let skippedKnown = 0;
  const normal = [];
  const statsPages = [];
  for (const a of analyzed) {
    if (a.version === "new" && a.page === "stats") { statsPages.push(a); continue; }     // used for the match stats only
    if (a.version === "new" && a.page === "playstyles") {
      warnings.push(`${a.filename}: this is the Playstyles page, which has nothing to read; skipped.`);
      continue;
    }
    const looksWrong = a.goals.length === 0 && (a.score_l_val == null || a.score_l_val > 0);
    if (looksWrong) {
      warnings.push(a.version === "new"
        ? `${a.filename}: this is the new match screen but no goal rows were found; skipped.`
        : `${a.filename}: layout not recognised; skipped.`);
    } else normal.push(a);
  }

  // --- 4. merge screenshots of the same game, de-duplicating by (minute, scorer) ---
  const canon = detect ? canonicalNames(normal.flatMap(a => a.goals.map(g => g.clean))) : new Map();
  const bump = (m, k, by = 1) => m.set(k, (m.get(k) || 0) + by);
  let anon = 0;
  for (const grp of groupImages(normal)) {
    const seen = new Map(), goals = [], files = [];
    for (const a of grp) {
      files.push(a.filename);
      for (const g of a.goals) {
        const key = g.minute ? `${g.minute}|${g.clean}` : `anon${anon++}|${g.clean}`;
        if (seen.has(key)) { seen.get(key).files.add(a.filename); continue; }
        const entry = { ...g, filename: a.filename, files: new Set([a.filename]) };
        seen.set(key, entry);
        goals.push(entry);
      }
    }
    goals.sort((x, y) => cmpKey(minuteSortKey(x.minute), minuteSortKey(y.minute)));

    // your final score = most common confident read across the game's screenshots
    const expected = mode(grp.filter(a => a.score_l_val != null && a.score_l_conf >= SCORE_MIN_CONF).map(a => a.score_l_val));
    const scoreR = mode(grp.filter(a => a.score_r_val != null && a.score_r_conf >= SCORE_MIN_CONF).map(a => a.score_r_val));
    const named = grp.filter(a => a.opp.length >= 3 && a.opp_conf >= OPP_MIN_CONF);
    const opponent = named.length ? named.reduce((b, a) => (a.opp_conf > b.opp_conf ? a : b)).opp_raw : "";
    if (expected == null || scoreR == null) {
      warnings.push(`Game with ${files.join(", ")}: couldn't read the final score, so this game isn't counted in your results ` +
                    `(its goals are still counted). Check the screenshot, or scan it again.`);
    }
    const incomplete = expected != null && goals.length < expected;
    const incompleteMsg = incomplete
      ? `Game with ${files.join(", ")}: score shows ${expected} goal(s) but only ${goals.length} found ` +
        `(${expected - goals.length} missing). Add another screenshot of this game scrolled to the missing goals.`
      : null;

    // the opponent's goals (minutes), merged across the game's screenshots: needed for stoppage-time equalizers
    const theirSeen = new Map();
    for (const a of grp) for (const t of a.theirs_goals || []) if (t.minute && !theirSeen.has(t.minute)) theirSeen.set(t.minute, { minute: t.minute, name: cleanWord(t.raw || "") });
    const theirGoals = [...theirSeen.values()].sort((x, y) => cmpKey(minuteSortKey(x.minute), minuteSortKey(y.minute)));
    const gameIndex = gamesOut.length;
    let knownGame = null;

    const gameGoals = [];
    for (const g of goals) {
      const matched = detect ? (canon.get(g.clean) || null)
        : (normNames.includes(g.clean) ? g.clean : fuzzyMatch(g.clean, normNames)[0]);
      if (g.minute == null || g.minute_conf < 0.3) {
        warnings.push(`${g.filename}: couldn't read the minute for '${g.raw.trim()}'; ` +
                      `it may be double-counted if the game spans several screenshots.`);
      }
      const record = { matched_name: matched, raw_name: g.raw.trim(), minute: g.minute, opponent,
                       score_l: expected, score_r: scoreR, filename: g.filename, game: gameIndex };
      const hit = matched ? findKnown(record, knownGoals) : null;
      const already = !!hit;
      if (hit && !knownGame) knownGame = hit.game;                 // this match is already in the spreadsheet under that id
      if (matched) {
        goalsFlat.push({ ...record, already_recorded: already });
        if (already) skippedKnown++;
        else {
          bump(counts, matched);
          if (!filesByName.has(matched)) filesByName.set(matched, new Set());
          g.files.forEach(f => filesByName.get(matched).add(f));
          allMatches.push({ raw_name: g.raw.trim(), matched_name: matched, filename: g.filename, minute: g.minute });
        }
      }
      gameGoals.push({ minute: g.minute, raw_name: g.raw.trim(), matched_name: matched, already_recorded: already });
    }
    // match stats: on the old screen they are part of the same screenshot(s); pick the reading most of them agree on
    const readable = grp.filter(a => a.stats && a.stats.problems.length === 0);
    let gameStats = null;
    if (readable.length) {
      const tally = new Map();
      for (const a of readable) {
        const k = statsKey(oppKey(opponent), [expected, scoreR], a.stats);
        tally.set(k, { n: (tally.get(k)?.n || 0) + 1, stats: a.stats });
      }
      gameStats = [...tally.values()].sort((x, y) => y.n - x.n)[0].stats;
      if (gameStats.missing?.length) partialNotes.push(`${files[0]}: the stats panel hadn't finished loading (no ${gameStats.missing.join(" / ")} row yet), so ${gameStats.missing.join(" / ")} is left blank; the other stats were recorded.`);
    } else if (grp.some(a => a.stats_crops)) {
      warnings.push(`${files[0]}: couldn't read the match stats reliably, so they weren't recorded.`);
    }
    gamesOut.push({ files, expected_goals: expected, found_goals: goals.length, incomplete,
                    incomplete_message: incompleteMsg, opponent, score: [expected, scoreR], goals: gameGoals,
                    theirs_goals: theirGoals, stats: gameStats, known_game: knownGame });
    for (const t of theirGoals) theirsFlat.push({ game: gameIndex, minute: t.minute, name: t.name, opponent, score_l: expected, score_r: scoreR });
    if (gameStats) statRecords.push({ files, opponent, score: [expected, scoreR], stats: gameStats });
  }

  // new layout: each "Match Stats" page is one game's stats. Its game is the goal-list game with the same opponent and
  // score; a page with no such game (its goal list was never screenshotted) is a game of its own: it still decides a
  // win / draw / loss and has stats, it just has no goals.
  const extraGames = [];
  for (const a of statsPages) {
    if (!a.stats || a.stats.problems.length) {
      warnings.push(`${a.filename}: couldn't read the match stats reliably` + (a.stats ? ` (${a.stats.problems[0]})` : "") + "; skipped.");
      continue;
    }
    if (a.stats.missing?.length) partialNotes.push(`${a.filename}: the stats page hadn't finished loading (no ${a.stats.missing.join(" / ")} row yet), so ${a.stats.missing.join(" / ")} is left blank; the other stats were recorded.`);
    const score = [a.score_l_val, a.score_r_val];
    statRecords.push({ files: [a.filename], opponent: a.opp_raw, score, stats: a.stats });
    if (score.some(v => v == null)) continue;
    if (!statsPageLinked(gamesOut, score, a.opp_raw)) extraGames.push({ files: [a.filename], opponent: a.opp_raw, score, stats: a.stats, goals: [], theirs_goals: [] });
  }
  // the same stats read twice (duplicate screenshots, or a game seen on several pages) are one record
  const seenStats = new Set();
  const uniqueStats = statRecords.filter(r => {
    r.key = statsKey(oppKey(r.opponent), r.score, r.stats);
    if (seenStats.has(r.key)) return false;
    seenStats.add(r.key);
    return true;
  });

  // one extra game per distinct stats record (the same page screenshotted twice is one game)
  const extraKeys = new Set(), extras = [];
  for (const e of extraGames) {
    const k = statsKey(oppKey(e.opponent), e.score, e.stats);
    if (extraKeys.has(k)) continue;
    extraKeys.add(k);
    extras.push(e);
  }
  const notices = [...partialNotes];
  const odd = analyzed.filter(a => Math.abs(a.aspect / REFERENCE_ASPECT - 1) > 0.03);
  if (odd.length) {
    notices.push(`${odd.length} screenshot${odd.length === 1 ? " is" : "s are"} from a differently shaped screen (${[...new Set(odd.map(a => a.aspect.toFixed(2)))].join(", ")}:1) than the ones this reader was tuned on ` +
                 `(${REFERENCE_ASPECT.toFixed(2)}:1). They are read after adjusting for that, but have not been tested on your kind of phone: check the results table against your screenshots.`);
  }
  for (const e of extras) {
    notices.push(`${e.files[0]}: only the Match Stats page of this game (${e.opponent || "unknown opponent"}, ${e.score.join("-")}) was scanned, with no goal list. ` +
                 `It counts as a game in your results and its stats are recorded, but no goals are.`);
  }
  if (skippedKnown) notices.push(`${skippedKnown} goal(s) already recorded in your spreadsheet were skipped (same game, minute and scorer).`);
  const fbn = Object.fromEntries([...filesByName].map(([k, v]) => [k, [...v].sort()]));
  const countsObj = Object.fromEntries(counts);
  report("Done", 100);
  return {
    timestamp: stamp(),
    scan_id: `${stamp()}~${Math.random().toString(36).slice(2, 6)}`,   // unique per scan: game ids are built from it, and two scans can share a minute
    matches: allMatches,
    counts: countsObj,
    files_by_name: fbn,
    games: gamesOut,
    extra_games: extras,
    goals: goalsFlat,
    theirs: theirsFlat,
    stat_records: uniqueStats,
    notices,
    layouts: { old: analyzed.filter(a => a.version === "old").length, new: analyzed.filter(a => a.version === "new").length },
    images: analyzed.map(a => ({
      file: a.filename, version: a.version, opponent: a.opp, user: a.user || "", score: [a.score_l_val, a.score_r_val], green_rows: a.goals.length,
      theirs: (a.theirs_goals || []).map(g => ({ minute: g.minute, name: g.raw })),
    })),
    warnings,
    summary: { aggregated_goals: countsObj, files_by_name: fbn },
  };
}
