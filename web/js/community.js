// Community totals: an opt-in way to add a scan's goals to everyone's shared totals, and to read those totals back.
// The shared side is a Google Apps Script web app (see <meta name="community-url"> in index.html); without that URL the
// whole feature stays hidden. Only scorer names and goal counts are sent: never screenshots, opponents or spreadsheets.
const SENT_KEY = "fcstat.community.sent.v1";     // goals/games this browser has already added, so nothing is counted twice
const OPT_KEY = "fcstat.community.optin";
const MAX_REMEMBERED = 5000;

// Opening the site with ?resetcommunity forgets which goals this browser has already added (handy after clearing the shared sheet).
try { if (new URLSearchParams(location.search).has("resetcommunity")) localStorage.removeItem(SENT_KEY); } catch { /* fine */ }

const url = () => (document.querySelector('meta[name="community-url"]')?.content || "").trim();
export const communityEnabled = () => !!url();

function readSent() {
  try { return new Set(JSON.parse(localStorage.getItem(SENT_KEY) || "[]")); } catch { return new Set(); }
}
function writeSent(set) {
  try { localStorage.setItem(SENT_KEY, JSON.stringify([...set].slice(-MAX_REMEMBERED))); } catch { /* private mode: fine */ }
}
export function getOptIn() {                    // on unless the user turned it off
  try { return localStorage.getItem(OPT_KEY) !== "0"; } catch { return true; }
}
export function setOptIn(on) {
  try { localStorage.setItem(OPT_KEY, on ? "1" : "0"); } catch { /* fine */ }
}

const goalKey = g => `g|${g.opponent}|${g.score_l}-${g.score_r}|${g.minute}|${g.matched_name}`;
// A game's identity must not depend on the random id given to each scan: use who it was against, the score and its goals.
const gameKey = (r, logGoals) => {
  if (String(r.key).startsWith("0|")) return `m|${r.key}`;         // a stats-only game already has a stable key
  const goals = (logGoals || []).filter(g => g.game_id === r.key).map(g => `${g.minute}:${g.matched_name}`).sort().join(",");
  return `m|${r.opponent}|${(r.score || []).join("-")}|${goals}`;
};

/**
 * What would be added to the community for a save: your goals (per player) and games that this browser has not added
 * before. `logGoals` / `gameRecords` are what buildSave() returns. Returns null when there is nothing new.
 */
export function buildContribution(logGoals, gameRecords) {
  const sent = readSent();
  const newGoals = (logGoals || []).filter(g => g && g.matched_name && !sent.has(goalKey(g)));
  const newGames = (gameRecords || []).filter(r => r && r.key && !sent.has(gameKey(r, logGoals)));
  if (!newGoals.length && !newGames.length) return null;
  const byName = new Map();
  for (const g of newGoals) byName.set(g.matched_name, (byName.get(g.matched_name) || 0) + 1);
  return {
    games: newGames.length,
    scorers: [...byName].map(([name, goals]) => ({ name, goals })),
    keys: [...newGoals.map(goalKey), ...newGames.map(r => gameKey(r, logGoals))],
  };
}

// Sends one contribution. Never throws; resolves true when it was handed to the service.
export async function contribute(c) {
  if (!communityEnabled() || !c) return false;
  const id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    // text/plain keeps this a "simple" request (no CORS preflight), which Apps Script web apps need
    const res = await fetch(url(), { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ id, games: c.games, scorers: c.scorers }) });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) return false;
    const sent = readSent(); c.keys.forEach(k => sent.add(k)); writeSent(sent);
    return true;
  } catch { return false; }
}

// Names come from a sheet anyone can add to: cut absurdly long words (they would widen a phone screen) and the whole name.
const cleanShown = name => String(name ?? "").replace(/\S{21,}/g, m => `${m.slice(0, 20)}\u2026`).slice(0, 60);

// The shared totals, or null if they can't be read right now.
export async function loadTotals() {
  if (!communityEnabled()) return null;
  try {
    const res = await fetch(url(), { cache: "no-store" });
    const d = await res.json();
    if (!res.ok || !d || d.ok !== true) return null;
    return { games: Number(d.games) || 0, goals: Number(d.goals) || 0, scorers: Array.isArray(d.scorers) ? d.scorers.slice(0, 10).map(s => ({ name: cleanShown(s?.name), goals: Number(s?.goals) || 0 })) : [] };
  } catch { return null; }
}
