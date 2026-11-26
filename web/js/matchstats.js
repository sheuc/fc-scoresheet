// Match statistics (the panel with shots, possession, pass accuracy, fouls, offsides): parsing the
// OCR'd cells and checking that the numbers make sense. Both teams are read: yours and the opponent's.
//
//   shots        "6(6)"  shots (on target)
//   possession   "65%"
//   pass         "82%"   pass accuracy
//   fouls        "0"
//   offsides     "1"

export const STAT_KEYS = ["shots", "possession", "pass", "fouls", "offsides"];

const int = s => (s == null ? null : parseInt(s, 10));

/** {shots, sot} from "6(6)"; tolerates a missing bracket or a space ("6 (6)", "6(6"). null if unreadable. */
export function parseShots(text) {
  const t = String(text ?? "").replace(/\s+/g, "");
  let m = /^(\d+)\((\d+)\)?$/.exec(t);              // 6(6) or 6(6
  if (!m) m = /^(\d+)\)?\((\d+)\)?$/.exec(t);
  if (m) return { shots: int(m[1]), sot: int(m[2]) };
  return null;
}

/** An integer such as 65 from "65%" (or "65"). null if unreadable. */
export function parsePercentOrCount(text) {
  const m = /^(\d{1,3})%?$/.exec(String(text ?? "").replace(/\s+/g, ""));
  return m ? int(m[1]) : null;
}

/** One team's stats from its five cell texts, or null if any cell can't be parsed. */
function teamStats(texts) {
  const shots = parseShots(texts[0]);
  const possession = parsePercentOrCount(texts[1]), pass = parsePercentOrCount(texts[2]);
  const fouls = parsePercentOrCount(texts[3]), offsides = parsePercentOrCount(texts[4]);
  if (!shots || [possession, pass, fouls, offsides].some(v => v == null)) return null;
  return { shots: shots.shots, sot: shots.sot, possession, pass, fouls, offsides };
}

/** Things that can't be true of a real scoreline. Returns [] when the stats look right. */
export function problems(s) {
  const out = [];
  for (const side of ["for", "against"]) {
    const t = s[side];
    if (t.sot > t.shots) out.push(`${side}: ${t.sot} shots on target but only ${t.shots} shots`);
    if (t.shots > 60) out.push(`${side}: ${t.shots} shots`);
    if (t.possession > 100 || t.pass > 100) out.push(`${side}: a percentage above 100`);
    if (t.fouls > 40 || t.offsides > 40) out.push(`${side}: ${t.fouls} fouls / ${t.offsides} offsides`);
  }
  const total = s.for.possession + s.against.possession;
  if (total < 98 || total > 102) out.push(`possession adds up to ${total}%`);
  return out;
}

/**
 * Stats of one screenshot from the 5 rows x 2 cells of OCR text: {for, against} (yours / the opponent's)
 * with `problems` ([] when consistent), or null if a cell was unreadable.
 */
export function buildStats(leftTexts, rightTexts) {
  const f = teamStats(leftTexts), a = teamStats(rightTexts);
  if (!f || !a) return null;
  const s = { for: f, against: a };
  s.problems = problems(s);
  return s;
}

/** Identity of a stats record: the same screen read twice gives the same key. */
export function statsKey(opponentKey, score, s) {
  const nums = t => [t.shots, t.sot, t.possession, t.pass, t.fouls, t.offsides].join(",");
  return `${opponentKey}|${score[0]}-${score[1]}|${nums(s.for)}|${nums(s.against)}`;
}

/** Stats of one screenshot from numbers read glyph by glyph: {shots, sot, possession, pass, fouls, offsides} x 2. */
export function statsFromNumbers(forNums, againstNums) {
  const s = { for: forNums, against: againstNums };
  s.problems = problems(s);
  return s;
}
