// Statistics over everything saved in the user's spreadsheet: pure functions over rows, no I/O.
//
//   averages(statRows)  per-game average shots, shots on target, possession, pass accuracy, fouls, offsides
//   gamesFromLog(rows)  group the goal log into matches
//   hatTricks(games)    players by number of matches with 3+ goals
//   clutch(games)       players by stoppage-time winners and equalizers
//   extremes(games)     biggest win and heaviest defeat
//   comebacks(games)    wins after having trailed
//   shooting(statRows)  shot accuracy (on target / shots) and conversion (goals / shots)
//
// "Stoppage time" here means the second half's added time: a goal at 90'+N. (First-half stoppage time, 45'+N, is not
// "clutch": it decides nothing.)

const METRICS = ["shots", "sot", "possession", "pass", "fouls", "offsides"];

/** "90+3" -> {base: 90, extra: 3}; "45" -> {base: 45, extra: 0}; unreadable -> null. */
export function parseMinuteParts(minute) {
  const m = /^(\d+)(?:\+(\d+))?$/.exec(String(minute ?? "").trim());
  return m ? { base: parseInt(m[1], 10), extra: m[2] ? parseInt(m[2], 10) : 0 } : null;
}
const key = minute => { const p = parseMinuteParts(minute); return p ? p.base * 100 + p.extra : Infinity; };
export const isLateStoppage = minute => { const p = parseMinuteParts(minute); return !!p && p.base >= 90 && p.extra > 0; };

const round1 = v => Math.round(v * 10) / 10;

/**
 * @param rows  stat records: {for: {shots, sot, possession, pass, fouls, offsides}, against: {...}}
 * @returns     {games, for: {metric: average}, against: {metric: average}}, averages rounded to 1 decimal
 */
export function averages(rows) {
  const out = { games: rows.length, for: {}, against: {} };
  for (const side of ["for", "against"]) {
    for (const m of METRICS) {
      const vals = rows.map(r => r[side]?.[m]).filter(v => Number.isFinite(v));
      out[side][m] = vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    }
  }
  return out;
}

/**
 * Results over matches' final scores.
 * @param games  [{score: [goalsFor, goalsAgainst]}]; matches with an unknown score are ignored
 * @returns {played, wins, draws, losses, goalsFor, goalsAgainst, goalDiff, cleanSheets}
 *          (a clean sheet is a match in which the opponent didn't score, 0-0 draws included)
 */
export function results(games) {
  const r = { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDiff: 0, cleanSheets: 0 };
  for (const g of games) {
    const [a, b] = g.score || [];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    r.played++; r.goalsFor += a; r.goalsAgainst += b;
    if (a > b) r.wins++; else if (a < b) r.losses++; else r.draws++;
    if (b === 0) r.cleanSheets++;
  }
  r.goalDiff = r.goalsFor - r.goalsAgainst;
  r.winRate = r.played ? round1((100 * r.wins) / r.played) : null;          // percent of games won (draws are not half-wins)
  return r;
}

/**
 * The biggest win and the heaviest defeat by goal margin.
 * @param games  [{score: [goalsFor, goalsAgainst], opponent}]
 * @returns {biggestWin, heaviestDefeat}, each {score, opponent, margin} or null when there isn't one.
 *          Ties go to the win with more goals scored / the defeat with more goals conceded, then to the opponent's name,
 *          so the answer doesn't depend on the order the games are in.
 */
export function extremes(games) {
  let win = null, loss = null;
  const better = (x, y, goals) => !y || x.margin > y.margin || (x.margin === y.margin && (goals(x) > goals(y)
    || (goals(x) === goals(y) && lower(x.opponent) < lower(y.opponent))));
  for (const g of games) {
    const [a, b] = g.score || [];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
    const e = { score: [a, b], opponent: g.opponent || "", margin: Math.abs(a - b) };
    if (a > b) { if (better(e, win, x => x.score[0])) win = e; }
    else if (better(e, loss, x => x.score[1])) loss = e;
  }
  return { biggestWin: win, heaviestDefeat: loss };
}

/**
 * Shot accuracy (shots on target / shots) and conversion (goals / shots), in percent, for you and the opponent,
 * over the games that have match stats. A game's goals are the goals of its final score.
 * @param rows  stat records: {score: [l, r] or "l-r", for: {shots, sot}, against: {shots, sot}}
 */
export function shooting(rows) {
  const out = { games: rows.length, for: {}, against: {} };
  const pct = (n, d) => (d > 0 ? round1((100 * n) / d) : null);
  for (const [side, at] of [["for", 0], ["against", 1]]) {
    let shots = 0, sot = 0, goals = 0, scored = 0;
    for (const r of rows) {
      const t = r[side];
      if (!t || !Number.isFinite(t.shots)) continue;
      shots += t.shots;
      if (Number.isFinite(t.sot)) sot += t.sot;
      const sc = Array.isArray(r.score) ? r.score : String(r.score ?? "").split("-").map(x => (x.trim() === "" ? NaN : Number(x)));
      if (Number.isFinite(sc[at])) { goals += sc[at]; scored += t.shots; }       // conversion only over games whose score is known
    }
    out[side] = { shots, sot, goals, accuracy: pct(sot, shots), conversion: pct(goals, scored) };
  }
  return out;
}

/** Goals per game for and against, as extra rows of the averages (over every match with a score). */
function withGoalAverages(avg, res) {
  avg.goalGames = res.played;
  avg.for.goals = res.played ? round1(res.goalsFor / res.played) : null;
  avg.against.goals = res.played ? round1(res.goalsAgainst / res.played) : null;
  return avg;
}

/**
 * Group goal-log entries (from parseLogRows) into matches.
 * @returns [{game, opponent, score: [l, r], ours: [{minute, name}], theirs: [{minute, name}]}]
 */
export function gamesFromLog(entries) {
  const byGame = new Map();
  for (const e of entries) {
    if (!byGame.has(e.game)) byGame.set(e.game, { game: e.game, opponent: e.opponent_label, score: [e.score_l, e.score_r], ours: [], theirs: [] });
    const g = byGame.get(e.game);
    if (g.score[0] == null && e.score_l != null) g.score = [e.score_l, e.score_r];
    (e.side === "them" ? g.theirs : g.ours).push({ minute: e.minute, name: e.scorer_label || e.scorer });
  }
  for (const g of byGame.values()) {
    g.ours.sort((a, b) => key(a.minute) - key(b.minute));
    g.theirs.sort((a, b) => key(a.minute) - key(b.minute));
  }
  return [...byGame.values()];
}

const lower = s => String(s || "").toLowerCase();
const byName = (a, b) => (lower(a.name) < lower(b.name) ? -1 : lower(a.name) > lower(b.name) ? 1 : 0);

/** Players by number of matches in which they scored 3 or more. Returns [{name, hatTricks, mostGoals}] (most first). */
export function hatTricks(games) {
  const per = new Map();                                              // normalised name -> {name, hatTricks, mostGoals}
  for (const g of games) {
    const goals = new Map();
    for (const o of g.ours) goals.set(lower(o.name), { name: o.name, n: (goals.get(lower(o.name))?.n || 0) + 1 });
    for (const [k, { name, n }] of goals) {
      if (n < 3) continue;
      const p = per.get(k) || { name, hatTricks: 0, mostGoals: 0 };
      p.hatTricks++; p.mostGoals = Math.max(p.mostGoals, n);
      per.set(k, p);
    }
  }
  return [...per.values()].sort((a, b) => (b.hatTricks - a.hatTricks) || (b.mostGoals - a.mostGoals) || byName(a, b));
}

/**
 * Players by stoppage-time (90'+N) winners and equalizers. Returns [{name, winners, equalizers, total}] (most first).
 *
 *  winner     the goal that decided a win: with a final score of l-r and l > r, your (r+1)-th goal. Needs all of
 *             your goals for that match (found == l), or the order can't be trusted.
 *  equalizer  your goal that made the score level at that moment. Needs both teams' goals for the match, and
 *             is skipped when a goal of each side shares a minute (the order is unknown).
 */
export function clutch(games) {
  const per = new Map();
  const bump = (name, field) => {
    const k = lower(name), p = per.get(k) || { name, winners: 0, equalizers: 0, total: 0 };
    p[field]++; p.total++; per.set(k, p);
  };
  for (const g of games) {
    const [l, r] = g.score;
    if (l == null || r == null || g.ours.length !== l) continue;       // incomplete record: can't judge
    if (l > r) {
      const decider = g.ours[r];                                       // (r+1)-th goal
      if (decider && isLateStoppage(decider.minute)) bump(decider.name, "winners");
    }
    if (g.theirs.length === r && r > 0) {
      let a = 0, b = 0;
      const events = [...g.ours.map(o => ({ side: "o", ...o })), ...g.theirs.map(t => ({ side: "t", ...t }))]
        .sort((x, y) => key(x.minute) - key(y.minute));
      events.forEach(e => {
        if (e.side === "t") { b++; return; }
        a++;
        const tie = g.theirs.some(t => key(t.minute) === key(e.minute));
        if (a === b && !tie && isLateStoppage(e.minute)) bump(e.name, "equalizers");
      });
    }
  }
  return [...per.values()].sort((a, b) => (b.total - a.total) || (b.winners - a.winners) || byName(a, b));
}

/**
 * Wins in which you trailed at some point. Needs both teams' goals for the match (yours found == l, theirs == r), so a
 * match without the opponent's goals (saved by the original app) can't be judged and isn't counted. When a goal of
 * each side shares a minute their order is unknown: the game counts only if you trailed even with your goal first.
 * @returns {count, games: [{opponent, score, deficit}]} (deficit = the most goals you were behind by, in that order)
 */
export function comebacks(games) {
  const found = [];
  for (const g of games) {
    const [l, r] = g.score || [];
    if (!Number.isFinite(l) || !Number.isFinite(r) || l <= r || r === 0) continue;
    if (g.ours.length !== l || g.theirs.length !== r) continue;
    const minutes = [...new Set([...g.ours, ...g.theirs].map(e => key(e.minute)))].sort((x, y) => x - y);
    if (minutes.includes(Infinity)) continue;                                  // a minute that wasn't read: the order is unknown
    let a = 0, b = 0, deficit = 0;
    for (const m of minutes) {
      a += g.ours.filter(e => key(e.minute) === m).length;                     // your goals of that minute first: the best case
      b += g.theirs.filter(e => key(e.minute) === m).length;
      deficit = Math.max(deficit, b - a);
    }
    if (deficit > 0) found.push({ opponent: g.opponent || "", score: [l, r], deficit });
  }
  return { count: found.length, games: found };
}

/**
 * The matches of a scan (the result of processImages), in the shape the leaderboards work on.
 * Every goal is kept (named or not) so a match counts as complete; names are the normalised ones.
 */
export function gamesFromScan(data) {
  const listed = (data.games || []).map((g, i) => ({
    game: String(i), opponent: g.opponent || "", score: [g.score?.[0] ?? null, g.score?.[1] ?? null],
    ours: g.goals.map(x => ({ minute: x.minute, name: x.matched_name || "" })),
    theirs: (g.theirs_goals || []).map(t => ({ minute: t.minute, name: t.name || "" })),
  }));
  // games that exist only as a Match Stats page: a result, but no goals
  const statsOnly = (data.extra_games || []).map((g, i) => ({
    game: `S${i}`, opponent: g.opponent || "", score: [g.score?.[0] ?? null, g.score?.[1] ?? null], ours: [], theirs: [],
  }));
  return [...listed, ...statsOnly];
}

/**
 * Hat-tricks and clutch for what was just scanned, before anything is saved.
 * @param excluded  players removed with the trash button (normalised names): left out of the boards,
 *                  though their goals still count towards a match being complete
 * Goals not matched to a player (name-list mode) are in the matches but never in the boards.
 */
export function computeScanStats(data, excluded = new Set()) {
  const games = gamesFromScan(data);
  const keep = p => p.name && !excluded.has(lower(p.name));
  const hat = hatTricks(games).filter(keep);
  const res = results(games);
  res.hatTricks = hat.reduce((n, h) => n + h.hatTricks, 0);
  res.comebackWins = comebacks(games).count;
  const statRows = (data.stat_records || []).map(r => ({ ...r.stats, score: r.score }));
  return {
    averages: withGoalAverages(averages(statRows), res),
    extremes: extremes(games),
    shooting: shooting(statRows),
    results: res,
    hatTricks: hat,
    clutch: clutch(games).filter(keep),
    games: games.filter(g => g.ours.length || g.theirs.length).length,
  };
}

/**
 * Everything at once. `gameRows` are the saved final scores ({key, score}); matches that are only in the goal log
 * (saved before final scores were stored) are counted too, by their match id, so history isn't lost.
 */
export function computeStats(logEntries, statRows, gameRows = []) {
  const games = gamesFromLog(logEntries);
  const byKey = new Map(games.map(g => [g.game, { score: g.score, opponent: g.opponent }]));
  for (const r of gameRows) byKey.set(r.key, { score: r.score, opponent: r.opponent });
  const res = results([...byKey.values()]);
  const hat = hatTricks(games);
  res.hatTricks = hat.reduce((n, h) => n + h.hatTricks, 0);
  res.comebackWins = comebacks(games).count;
  return {
    averages: withGoalAverages(averages(statRows), res),
    extremes: extremes([...byKey.values()]),
    shooting: shooting(statRows),
    results: res,
    hatTricks: hat,
    clutch: clutch(games),
    games: byKey.size,
  };
}
