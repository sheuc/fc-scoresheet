// Port of services/goal_log.py, extended. The log lives in a hidden "_log" sheet inside the user's own workbook,
// so scanning the same screenshots twice never double-counts. Nothing is stored anywhere else.
//
// Each row is one goal:  Opponent | Score | Minute | Scorer | Saved | Side | Game
//   Side  "us" (your goal) or "them" (the opponent's; kept so stoppage-time equalizers can be worked out)
//   Game  an id shared by all goals of one match, so hat-tricks and winners can be worked out later
// Files written by the original app have only the first five columns: those rows are your goals, and their game is
// inferred from (Saved, Opponent, Score).
import { normalize, ratio } from "./text.js";

export const LOG_TITLE = "_log";
export const LOG_HEADER = ["Opponent", "Score", "Minute", "Scorer", "Saved", "Side", "Game"];
const SIMILARITY = 80;  // fuzzy % for "same scorer" / "same opponent" (absorbs OCR noise)

export function oppKey(text) {
  return normalize(text || "").replace(/[^a-z0-9]/g, "");
}

function scorePair(text) {
  const m = /^\s*(\d+)\s*[-:]\s*(\d+)/.exec(String(text ?? ""));
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [null, null];
}

const isThem = side => String(side ?? "").trim().toLowerCase() === "them";

/** Every goal row of the log as an object (both sides). `rows` are arrays: opponent, score, minute, scorer, saved, side, game. */
export function parseLogRows(rows) {
  const out = [];
  for (const row of rows) {
    if (!row || row.length < 3) continue;
    const them = isThem(row[5]);
    if (!them && !row[3]) continue;                                  // one of your goals needs a scorer
    const [scoreL, scoreR] = scorePair(row[1]);
    const minute = row[2] == null || row[2] === "" ? null : String(row[2]).trim();
    out.push({
      opponent: oppKey(row[0]), opponent_label: row[0] == null ? "" : String(row[0]),
      score_l: scoreL, score_r: scoreR,
      minute,
      scorer: normalize(row[3]), scorer_label: row[3] == null ? "" : String(row[3]),
      saved: row[4] == null ? "" : String(row[4]),
      side: them ? "them" : "us",
      game: row[6] != null && String(row[6]).trim() !== "" ? String(row[6]).trim()
        : `${row[4] ?? ""}|${oppKey(row[0])}|${scoreL}-${scoreR}`,
    });
  }
  return out;
}

/** Your goals only, for duplicate detection. */
export const ownGoals = entries => entries.filter(e => e.side === "us");

/** The already-recorded goal matching `goal` ({matched_name, minute, opponent, score_l, score_r}), or null. */
export function findKnown(goal, known) {
  if (goal.minute == null || !known || known.length === 0) return null;   // no minute: never skip
  const minute = String(goal.minute).trim();
  const scorer = normalize(goal.matched_name || "");
  const opp = oppKey(goal.opponent);
  for (const k of known) {
    if (k.side && k.side !== "us") continue;
    if (k.minute !== minute) continue;
    if (["score_l", "score_r"].some(s => goal[s] != null && k[s] != null && goal[s] !== k[s])) continue;
    if (ratio(scorer, k.scorer) < SIMILARITY) continue;
    if (opp && k.opponent && ratio(opp, k.opponent) < SIMILARITY) continue;
    return k;
  }
  return null;
}

/** True if `goal` is already in `known`. */
export const isKnown = (goal, known) => findKnown(goal, known) !== null;

const titleCase = s => String(s || "").split(/\s+/).filter(Boolean)
  .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");
const scoreText = g => (g.score_l != null && g.score_r != null ? `${g.score_l}-${g.score_r}` : "");

/** The row the log stores for one of your goals. */
export function logRow(g, saved, game = "") {
  return [g.opponent || "", scoreText(g), g.minute == null ? "" : String(g.minute), titleCase(g.matched_name), saved, "us", game];
}

/** The row for an opponent goal: {opponent, score_l, score_r, minute, name}. */
export function theirLogRow(t, saved, game = "") {
  return [t.opponent || "", scoreText(t), t.minute == null ? "" : String(t.minute), titleCase(t.name), saved, "them", game];
}
