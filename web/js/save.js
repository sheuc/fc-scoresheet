// What a scan turns into when the user confirms: the goal counts, the log rows and the match stats to write.
// Pure (no DOM), so the app and the tests build the save exactly the same way.
import { findKnown, oppKey } from "./goal-log.js";
import { normalize } from "./text.js";

/**
 * @param data      the result of processImages()
 * @param known     goals already in the user's spreadsheet (readKnownGoals), [] for a new one
 * @param excluded  Set of players removed with the trash button
 * @param reduced   {player: n} goals subtracted with "-"
 * @returns {counts, logGoals, theirGoals, statRecords, gameRecords, skipped, gameIds, problem}
 *          `problem` is a message when there is nothing to save, else null
 */
export function buildSave(data, known = [], excluded = new Set(), reduced = {}) {
  const excl = new Set([...excluded].map(normalize));

  // Every match in the scan gets an id, shared by its goals in the log (hat-tricks and winners are worked out per
  // match). A match whose goals are already in the spreadsheet keeps the id it has there.
  const gameIds = (data.games || []).map((g, i) => g.known_game || `${data.scan_id || data.timestamp}#${i + 1}`);

  const logGoals = [];
  let skipped = 0;
  for (const g of data.goals || []) {
    if (!g.matched_name || g.already_recorded || excl.has(normalize(g.matched_name))) continue;
    if (findKnown(g, known)) { skipped++; continue; }       // re-checked in case the sheet changed since the scan
    logGoals.push({ ...g, game_id: gameIds[g.game] });
  }

  // The opponent's goals matter only for matches that have goals of yours in the log (stoppage-time equalizers).
  const withGoals = new Set((data.goals || []).filter(g => g.matched_name && !excl.has(normalize(g.matched_name))).map(g => g.game));
  const theirGoals = (data.theirs || []).filter(t => withGoals.has(t.game)).map(t => ({ ...t, game_id: gameIds[t.game] }));
  const statRecords = data.stat_records || [];

  // Each game's final score (wins, draws, losses, goals, clean sheets are worked out from these). A game with goals in
  // the log is keyed by its match id, so the same game scanned again, or completed by a later screenshot, is one row.
  // A game with no goal of yours in the log (0-0, or a loss where you didn't score) has no id to reuse, so it is keyed
  // by what identifies it: the opponent, the score and the minutes of the opponent's goals.
  const gameRecords = [];
  (data.games || []).forEach((g, i) => {
    const [gf, ga] = g.score || [];
    if (!Number.isFinite(gf) || !Number.isFinite(ga)) return;
    const logged = logGoals.some(x => x.game === i) || !!g.known_game;
    const theirMinutes = (g.theirs_goals || []).map(t => t.minute).filter(Boolean).join(",");
    gameRecords.push({ key: logged ? gameIds[i] : `0|${oppKey(g.opponent)}|${gf}-${ga}|t:${theirMinutes}`, opponent: g.opponent || "", score: [gf, ga] });
  });

  // A game that was scanned only as a Match Stats page (no goal list): its result is saved under the same kind of key
  // as a game with no goals of yours. If the spreadsheet already has that game (same opponent and score in its goal
  // log), it is counted there and not again.
  for (const e of data.extra_games || []) {
    const [gf, ga] = e.score || [];
    if (!Number.isFinite(gf) || !Number.isFinite(ga)) continue;
    const label = oppKey(e.opponent);
    if (label && known.some(k => k.score_l === gf && k.score_r === ga && k.opponent === label)) continue;     // the same label, not a similar one (see statsPageLinked)
    gameRecords.push({ key: `0|${label}|${gf}-${ga}|t:`, opponent: e.opponent || "", score: [gf, ga] });
  }

  // Goals subtracted with "-" are left out of the totals but still go into the hidden log, so scanning the
  // same screenshots again won't bring them back.
  const counts = {};
  for (const g of logGoals) counts[g.matched_name] = (counts[g.matched_name] || 0) + 1;
  for (const [name, n] of Object.entries(reduced)) {
    if (!(name in counts)) continue;
    counts[name] = Math.max(0, counts[name] - n);
    if (counts[name] === 0) delete counts[name];
  }

  let problem = null;
  if (!logGoals.length && !statRecords.length && !theirGoals.length && !gameRecords.length) {
    problem = "Nothing new to save: every goal is already in your spreadsheet or was removed.";
  } else if (!Object.keys(counts).length && !statRecords.length && !gameRecords.length) {
    problem = "Nothing to save: every goal was subtracted or removed.";
  }
  return { counts, logGoals, theirGoals, statRecords, gameRecords, skipped, gameIds, problem };
}
