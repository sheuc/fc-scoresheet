// The shareable summary card ("Wrapped"-style graphic): 1080 x 1350 (4:5) PNG with a title, the top scorers and a
// few stats chosen by the user. Everything is drawn on a Canvas in the browser: nothing is uploaded.
//
//   buildCardModel(input)      pure: what goes on the card (sanitised text, top scorers, the chosen stat tiles)
//   renderCard(ctx, model)     draws it on any 2D context (canvas or offscreen) and returns a layout report
//   statAvailability(stats)    which of the stat choices have data (the picker greys the rest out)
//
// No EA / FC logos, game art or club crests are used (it is an unofficial fan tool), and no opponent names appear.
// The look is the app's own: gradient, soft glows, rounded panels, neon accent. The top scorers are a ranked table with the leader highlighted.
import { capitalizeName } from "./text.js";

export const CARD_W = 1080, CARD_H = 1350;
export const DEFAULT_TITLE = "My FC Mobile Season";
export const TITLE_MAX = 40, NAME_MAX = 24;
const MAX_SCORER_NAME = 60;              // a longer scorer name (from a spreadsheet) could never be shown anyway and made fitting it very slow
export const MIN_STATS = 3, MAX_STATS = 6;
export const MIN_SCORERS = 1, DEFAULT_SCORERS = 5, MAX_SCORERS = 8;          // how many top scorers the card lists (the user's choice)
export const DEFAULT_STATS = ["played", "winRate", "goalsFor", "record"];
export const FONT_FAMILY = 'Inter, "Segoe UI", system-ui, -apple-system, Roboto, sans-serif';

const fmt = v => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const pct = v => `${fmt(v)}%`;
const signed = n => (n > 0 ? `+${n}` : String(n));

/**
 * The stats a user can put on the card. `get(stats)` gives {value, sub?} or null when there is nothing to show;
 * `why` says what is missing in that case. `stats` is the object computeScanStats() / computeStats() returns.
 */
export const STAT_CHOICES = [
  { key: "played", label: "Games played", needs: "games", get: s => ({ value: String(s.results.played) }) },
  { key: "record", label: "Record", needs: "games", get: s => ({ value: `${s.results.wins}-${s.results.draws}-${s.results.losses}`, sub: "W-D-L" }) },
  { key: "winRate", label: "Win rate", needs: "games", get: s => (s.results.winRate == null ? null : { value: pct(s.results.winRate) }) },
  { key: "goalsFor", label: "Goals scored", needs: "games", get: s => ({ value: String(s.results.goalsFor) }) },
  { key: "goalsAgainst", label: "Goals conceded", needs: "games", get: s => ({ value: String(s.results.goalsAgainst) }) },
  { key: "goalDiff", label: "Goal difference", needs: "games", get: s => ({ value: signed(s.results.goalDiff) }) },
  { key: "goalsPerGame", label: "Goals per game", needs: "games", get: s => (s.averages.for.goals == null ? null : { value: fmt(s.averages.for.goals) }) },
  { key: "cleanSheets", label: "Clean sheets", needs: "games", get: s => ({ value: String(s.results.cleanSheets) }) },
  { key: "hatTricks", label: "Hat-tricks", needs: "games", get: s => ({ value: String(s.results.hatTricks ?? 0) }) },
  { key: "comebackWins", label: "Comeback wins", needs: "goals of both teams", get: s => ({ value: String(s.results.comebackWins ?? 0) }) },
  { key: "biggestWin", label: "Biggest win", needs: "a win", get: s => (s.extremes?.biggestWin ? { value: `${s.extremes.biggestWin.score[0]}-${s.extremes.biggestWin.score[1]}` } : null) },
  { key: "possession", label: "Avg possession", needs: "match stats", get: s => (s.averages.for.possession == null ? null : { value: pct(s.averages.for.possession) }) },
  { key: "passAccuracy", label: "Pass accuracy", needs: "match stats", get: s => (s.averages.for.pass == null ? null : { value: pct(s.averages.for.pass) }) },
  { key: "shotsPerGame", label: "Shots per game", needs: "match stats", get: s => (s.averages.for.shots == null ? null : { value: fmt(s.averages.for.shots) }) },
  { key: "shotAccuracy", label: "Shot accuracy", needs: "match stats", get: s => (s.shooting?.for?.accuracy == null ? null : { value: pct(s.shooting.for.accuracy), sub: "on target" }) },
  { key: "conversion", label: "Shot conversion", needs: "match stats", get: s => (s.shooting?.for?.conversion == null ? null : { value: pct(s.shooting.for.conversion), sub: "goals per shot" }) },
  { key: "topHatTrick", label: "Most hat-tricks", needs: "a hat-trick", get: s => (s.hatTricks?.length ? { value: capitalizeName(s.hatTricks[0].name), sub: `${s.hatTricks[0].hatTricks} hat-trick${s.hatTricks[0].hatTricks === 1 ? "" : "s"}` } : null) },
  { key: "topClutch", label: "Most clutch player", needs: "a stoppage-time winner or equalizer", get: s => (s.clutch?.length ? { value: capitalizeName(s.clutch[0].name), sub: `${s.clutch[0].total} late goal${s.clutch[0].total === 1 ? "" : "s"}` } : null) },
];

/** [{key, label, available, why}] for the picker. */
export function statAvailability(stats) {
  return STAT_CHOICES.map(c => {
    let ok = false;
    try { ok = !!stats && (stats.results?.played > 0 || stats.averages?.games > 0) && c.get(stats) != null; } catch { ok = false; }
    return { key: c.key, label: c.label, available: ok, why: ok ? "" : `Needs ${c.needs}, which isn't in this data yet` };
  });
}

const clean = (text, max) => Array.from(String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, max).join("").trim();

/**
 * Everything the card shows, decided and sanitised.
 * @param input.stats     computeScanStats() / computeStats() result
 * @param input.scorers   [{name, goals}] (any order, any length): the top `scorerCount` (1..MAX_SCORERS, default 5) with goals > 0 are used
 * @param input.selected  stat keys in the order wanted (unavailable ones are dropped; at least MIN_STATS if possible)
 * @param input.source    "scan" | "all": the badge on the card
 */
export function buildCardModel({ title, name, stats, scorers = [], scorerCount = DEFAULT_SCORERS, selected = DEFAULT_STATS, source = "scan", theme = "dark", dateText = "" }) {
  const shown = Math.max(MIN_SCORERS, Math.min(MAX_SCORERS, Math.round(Number(scorerCount)) || DEFAULT_SCORERS));
  const avail = new Map(statAvailability(stats).map(a => [a.key, a.available]));
  const picked = [];
  for (const k of selected || []) if (avail.get(k) && !picked.includes(k)) picked.push(k);
  for (const k of [...DEFAULT_STATS, ...STAT_CHOICES.map(c => c.key)]) {          // top up to the minimum from the defaults
    if (picked.length >= MIN_STATS) break;
    if (avail.get(k) && !picked.includes(k)) picked.push(k);
  }
  const tiles = picked.slice(0, MAX_STATS).map(k => {
    const c = STAT_CHOICES.find(x => x.key === k);
    return { key: k, label: c.label, ...c.get(stats) };
  });
  const ranked = scorers.filter(s => s && s.name && s.goals > 0)
    .map(s => ({ name: capitalizeName(Array.from(String(s.name)).slice(0, MAX_SCORER_NAME).join("")), goals: Math.round(s.goals) }))
    .sort((a, b) => (b.goals - a.goals) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return {
    title: clean(title, TITLE_MAX) || DEFAULT_TITLE,
    name: clean(name, NAME_MAX),
    source: source === "all" ? "all" : "scan",
    theme: theme === "light" ? "light" : "dark",
    dateText: clean(dateText, 24),
    games: stats?.results?.played ?? 0,
    scorers: ranked.slice(0, shown),
    totalScorers: ranked.length,
    otherScorers: Math.max(0, ranked.length - shown),
    tiles,
  };
}

// ------------------------------------------------------------------ drawing
// The app's own look: a dark (or light) gradient with soft glows, rounded panels and the neon accent. The top scorers are a
// ranked table whose leader is highlighted; there are no bars and no badge saying where the data came from.
const PALETTES = {
  dark: {
    bg0: "#060b17", bg1: "#101c36", glowA: "rgba(0,255,135,0.22)", glowB: "rgba(70,130,255,0.26)", ring: "rgba(255,255,255,0.045)",
    panel: "rgba(255,255,255,0.065)", panelEdge: "rgba(255,255,255,0.11)", text: "#f3f7ff", muted: "#97a8c6",
    accent: "#00ff87", accent2: "#12d6c0", accentInk: "#04150c",
    gold: ["#ffe27a", "#f2b705"], goldInk: "#1d1500", silver: { tint: "rgba(195,204,217,0.16)", num: "#c3ccd9" }, bronze: { tint: "rgba(224,149,90,0.18)", num: "#e0955a" },
  },
  light: {
    bg0: "#f5f8fd", bg1: "#e3ebf8", glowA: "rgba(0,190,110,0.20)", glowB: "rgba(70,130,255,0.18)", ring: "rgba(15,27,51,0.05)",
    panel: "rgba(255,255,255,0.92)", panelEdge: "rgba(15,27,51,0.10)", text: "#0e1a33", muted: "#5b6d8a",
    accent: "#00995e", accent2: "#00b97d", accentInk: "#ffffff",
    gold: ["#f8d35a", "#e0a100"], goldInk: "#1d1500", silver: { tint: "rgba(107,122,144,0.15)", num: "#5b6b82" }, bronze: { tint: "rgba(162,96,42,0.15)", num: "#94561f" },
  },
};

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

const font = (weight, size) => `${weight} ${Math.round(size)}px ${FONT_FAMILY}`;
const width = (ctx, text, weight, size) => { ctx.font = font(weight, size); return ctx.measureText(text).width; };

/** Largest size in [min, max] at which `text` fits `maxW` (or `min`). */
function fitSize(ctx, text, weight, max, min, maxW) {
  for (let s = max; s > min; s -= 2) if (width(ctx, text, weight, s) <= maxW) return s;
  return min;
}
function ellipsize(ctx, text, weight, size, maxW) {
  if (width(ctx, text, weight, size) <= maxW) return text;
  const cs = Array.from(text);                                   // by character (an emoji is one), and a binary search: each probe measures the whole string
  let lo = 1, hi = cs.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (width(ctx, `${cs.slice(0, mid).join("")}…`, weight, size) <= maxW) lo = mid; else hi = mid - 1; }
  return `${cs.slice(0, lo).join("").trimEnd()}…`;
}
/** Text with letter spacing (canvas letterSpacing isn't everywhere). Returns its width. */
function tracked(ctx, text, x, y, spacing, align = "left") {
  const total = trackedWidth(ctx, text, spacing);
  let cx = align === "right" ? x - total : align === "center" ? x - total / 2 : x;
  const prev = ctx.textAlign; ctx.textAlign = "left";
  for (const ch of text) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + spacing; }
  ctx.textAlign = prev;
  return total;
}
const trackedWidth = (ctx, text, spacing) => [...text].reduce((w, ch) => w + ctx.measureText(ch).width + spacing, -spacing);

/** Split a title into at most 2 lines (by words) that each fit `maxW`; null if it can't. */
function wrapTitle(ctx, text, size, maxW) {
  if (width(ctx, text, 800, size) <= maxW) return [text];
  const words = text.split(" ");
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
    if (width(ctx, a, 800, size) <= maxW && width(ctx, b, 800, size) <= maxW) return [a, b];
  }
  return null;
}

/**
 * Draw the card. `ctx` is a 2D context of a CARD_W x CARD_H canvas.
 * Returns a report: {title: {lines, size}, overflow: [strings], bottom, limit} (`overflow` empty = everything fits).
 */
export function renderCard(ctx, model, w = CARD_W, h = CARD_H) {
  const P = PALETTES[model.theme] || PALETTES.dark, M = 60, CW = w - 2 * M;
  const overflow = [];
  ctx.save();
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";

  // --- background: gradient, two soft glows, faint pitch rings
  const bg = ctx.createLinearGradient(0, 0, w * 0.35, h); bg.addColorStop(0, P.bg0); bg.addColorStop(1, P.bg1);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  for (const [cx, cy, r, c] of [[w * 0.08, h * 0.02, 620, P.glowA], [w * 0.98, h * 0.98, 700, P.glowB]]) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r); g.addColorStop(0, c); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
  ctx.strokeStyle = P.ring; ctx.lineWidth = 3;
  for (const r of [260, 380, 500]) { ctx.beginPath(); ctx.arc(w * 0.92, h * 0.9, r, 0, Math.PI * 2); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(0, h * 0.9 - 4); ctx.lineTo(w, h * 0.9 - 4); ctx.stroke();

  // --- title: one line as large as fits (92..64), else two lines (72..54), else shrunk and cut with an ellipsis
  let tSize = 0, lines = null;
  for (let s = 92; s >= 64 && !lines; s -= 2) if (width(ctx, model.title, 800, s) <= CW) { lines = [model.title]; tSize = s; }
  for (let s = 72; s >= 54 && !lines; s -= 2) { const l = wrapTitle(ctx, model.title, s, CW); if (l) { lines = l; tSize = s; } }
  if (!lines) { tSize = 54; lines = [ellipsize(ctx, model.title, 800, tSize, CW)]; overflow.push("title cut with an ellipsis"); }
  let baseline = 84 + tSize * 0.82;
  ctx.fillStyle = P.text;
  for (const l of lines) { ctx.font = font(800, tSize); ctx.fillText(l, M, baseline); baseline += tSize * 1.06; }
  let y = baseline - tSize * 1.06 + tSize * 0.2;                 // just under the last line's descenders

  // --- subtitle: name and number of games on the left, the date on the right
  const games = model.games ? `${model.games} game${model.games === 1 ? "" : "s"}` : "";
  if (model.name || games || model.dateText) {
    y += 10;
    let x = M;
    if (model.name) {
      const s = fitSize(ctx, model.name, 700, 36, 24, CW * 0.55);
      ctx.font = font(700, s); ctx.fillStyle = P.accent; ctx.fillText(model.name, x, y + 30); x += width(ctx, model.name, 700, s);
    }
    if (games) {
      const t = `${model.name ? "  ·  " : ""}${games}`;
      ctx.font = font(500, 30); ctx.fillStyle = P.muted; ctx.fillText(t, x, y + 30); x += width(ctx, t, 500, 30);
    }
    if (model.dateText) {
      ctx.font = font(500, 26); ctx.fillStyle = P.muted; ctx.textAlign = "right"; ctx.fillText(model.dateText, w - M, y + 30); ctx.textAlign = "left";
      if (x > w - M - width(ctx, model.dateText, 500, 26) - 20) overflow.push("subtitle too wide");
    } else if (x > w - M) overflow.push("subtitle too wide");
    y += 46;
  }
  const headBottom = y;

  // --- layout of the two blocks below, compacted if a long title took room
  const n = model.scorers.length, tiles = model.tiles, rows = Math.ceil(tiles.length / 2);
  const limit = h - 112;
  let rowH = 78, tileH = rows <= 1 ? 170 : rows === 2 ? 146 : 126, gap = 34;
  const panelH = () => 70 + Math.max(1, n) * rowH + (model.otherScorers > 0 ? 50 : 22);
  const total = () => panelH() + (rows ? gap + rows * tileH + (rows - 1) * 18 : 0);
  const TILE_MIN = 124;                                                  // below this a tile's value would sit on its label
  while (headBottom + gap + total() > limit && (rowH > 54 || tileH > TILE_MIN || gap > 20)) {
    if (rowH > 54) rowH -= 2; else if (tileH > TILE_MIN) tileH -= 2; else gap -= 2;
  }
  while (rows && limit - (headBottom + gap + total()) > 44 && tileH < 200) tileH += 2;      // a sparse card: let the tiles use the room
  const spare = limit - (headBottom + gap + total());
  if (spare < 0) overflow.push(`content runs ${-spare}px past the footer`);
  if (rows && tileH < TILE_MIN) overflow.push("tiles too short for their contents");
  const extra = Math.max(0, Math.min(40, spare / 2));
  const panelTop = headBottom + gap + extra * 0.5;

  // --- top scorers: a ranked table, the leader(s) highlighted
  roundRect(ctx, M, panelTop, CW, panelH(), 34); ctx.fillStyle = P.panel; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = P.panelEdge; ctx.stroke();
  ctx.font = font(800, 22); ctx.fillStyle = P.muted; tracked(ctx, "TOP SCORERS", M + 36, panelTop + 52, 4);
  tracked(ctx, "GOALS", w - M - 44, panelTop + 52, 4, "right");
  if (!n) { ctx.font = font(500, 30); ctx.fillStyle = P.muted; ctx.fillText("No goals recorded yet", M + 36, panelTop + 70 + rowH * 0.6); }
  const leader = n ? model.scorers[0].goals : 0;
  const fs = Math.max(0.7, Math.min(1, rowH / 72));                                              // text in tight rows scales down with them
  model.scorers.forEach((s, i) => {
    const top = panelTop + 70 + i * rowH, cy = top + rowH / 2;
    const rank = 1 + model.scorers.filter(x => x.goals > s.goals).length;                         // tied scorers share a rank: 1, 1, 3
    const first = rank === 1;                                                                    // every tied leader gets gold
    const medal = rank === 2 ? P.silver : rank === 3 ? P.bronze : null;
    if (first) {
      const g = ctx.createLinearGradient(M + 14, 0, w - M - 14, 0); g.addColorStop(0, P.gold[0]); g.addColorStop(1, P.gold[1]);
      roundRect(ctx, M + 14, top + 4, CW - 28, rowH - 8, 22); ctx.fillStyle = g; ctx.fill();
    } else if (medal) {                                                                          // silver and bronze: a soft tint behind the row
      roundRect(ctx, M + 14, top + 4, CW - 28, rowH - 8, 22); ctx.fillStyle = medal.tint; ctx.fill();
    }
    const ink = first ? P.goldInk : P.text, soft = first ? P.goldInk : medal ? medal.num : P.muted;
    ctx.font = font(800, 34 * fs); ctx.fillStyle = soft; ctx.fillText(String(rank), M + 44, cy + 12 * fs);
    const nameX = M + 44 + 64, nameW = CW - 44 - 64 - 44 - 120;
    const ns = fitSize(ctx, s.name, 700, 38 * fs, 20, nameW);
    const shown = ellipsize(ctx, s.name, 700, ns, nameW);
    if (shown !== s.name) overflow.push(`scorer name "${s.name}" cut`);
    ctx.font = font(700, ns); ctx.fillStyle = ink; ctx.fillText(shown, nameX, cy + 12 * fs);
    const gs = fitSize(ctx, String(s.goals), 800, 46 * fs, 24, 112);                                   // a huge total shrinks instead of running into the name
    ctx.font = font(800, gs); ctx.textAlign = "right"; ctx.fillStyle = ink; ctx.fillText(String(s.goals), w - M - 44, cy + 16 * fs); ctx.textAlign = "left";
    if (width(ctx, String(s.goals), 800, gs) > 112) overflow.push("goals number too wide");
    if (!first && i < n - 1) { ctx.strokeStyle = P.panelEdge; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(M + 36, top + rowH); ctx.lineTo(w - M - 36, top + rowH); ctx.stroke(); }
  });
  if (model.otherScorers > 0) {
    ctx.font = font(500, 22); ctx.fillStyle = P.muted; ctx.textAlign = "center";
    ctx.fillText(`+ ${model.otherScorers} more scorer${model.otherScorers === 1 ? "" : "s"}`, w / 2, panelTop + panelH() - 20); ctx.textAlign = "left";
  }

  // --- stat tiles: two columns, an odd last tile spans the row
  const tilesTop = panelTop + panelH() + gap + extra * 0.5;
  const colGap = 20, colW = (CW - colGap) / 2;
  tiles.forEach((t, i) => {
    const r = Math.floor(i / 2), c = i % 2, alone = i === tiles.length - 1 && tiles.length % 2 === 1;
    const tw = alone ? CW : colW, tx = M + (alone ? 0 : c * (colW + colGap)), ty = tilesTop + r * (tileH + 18);
    roundRect(ctx, tx, ty, tw, tileH, 30); ctx.fillStyle = P.panel; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = P.panelEdge; ctx.stroke();
    // top row: accent dash, label (left) and the optional note (right); the value below
    ctx.fillStyle = P.accent; roundRect(ctx, tx + 30, ty + 24, 34, 6, 3); ctx.fill();
    ctx.font = font(800, 19); ctx.fillStyle = P.muted;
    const labelW = tracked(ctx, t.label.toUpperCase(), tx + 30, ty + 58, 3);
    if (labelW > tw - 60) overflow.push(`tile label "${t.label}" too wide`);
    if (t.sub) {
      ctx.font = font(700, 20);
      const subW = ctx.measureText(t.sub).width;
      if (30 + labelW + 20 + subW <= tw - 30) { ctx.fillStyle = P.accent; ctx.textAlign = "right"; ctx.fillText(t.sub, tx + tw - 30, ty + 58); ctx.textAlign = "left"; }
    }
    const vy = ty + tileH - 26, vs = fitSize(ctx, t.value, 800, Math.min(86, (vy - (ty + 58) - 14) / 0.74), 26, tw - 60);
    ctx.font = font(800, vs); ctx.fillStyle = P.text;
    const shownV = ellipsize(ctx, t.value, 800, vs, tw - 60);
    if (shownV !== t.value) overflow.push(`tile value "${t.value}" cut`);
    ctx.fillText(shownV, tx + 30, vy);
  });
  const bottom = rows ? tilesTop + rows * tileH + (rows - 1) * 18 : panelTop + panelH();

  // --- footer
  ctx.strokeStyle = P.panelEdge; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(M, h - 86); ctx.lineTo(w - M, h - 86); ctx.stroke();
  ctx.font = font(500, 22); ctx.fillStyle = P.muted; ctx.textAlign = "center";
  ctx.fillText("FC Scoresheet  ·  unofficial fan tool", w / 2, h - 44);
  ctx.restore();
  return { title: { lines, size: tSize }, overflow, bottom, limit: h - 86, rowH, tileH, gap };
}

/**
 * Build the model and draw it, listing fewer scorers if the number asked for doesn't fit (a long title takes two lines,
 * six stats take three rows): squashing the tiles or letting text run into the footer would be worse.
 * @returns {model, report, asked, shown, trimmed}  `trimmed` = fewer scorers than asked for (and than there are) were drawn
 */
export function drawFitted(ctx, input, w = CARD_W, h = CARD_H) {
  const asked = Math.max(MIN_SCORERS, Math.min(MAX_SCORERS, Math.round(Number(input.scorerCount)) || DEFAULT_SCORERS));
  let n = asked, model, report;
  for (;;) {
    model = buildCardModel({ ...input, scorerCount: n });
    report = renderCard(ctx, model, w, h);
    if (!report.overflow.some(o => /past the footer|tiles too short/.test(o)) || n <= MIN_SCORERS) break;
    n--;
  }
  return { model, report, asked, shown: model.scorers.length, trimmed: model.scorers.length < Math.min(asked, model.totalScorers) };
}

// ------------------------------------------------------------------ browser helpers
let fontsPromise = null;
/** Load the card's font (Inter, bundled) once; resolves true if it loaded, false if the system fallback will be used. */
export function loadCardFonts() {
  if (!fontsPromise) {
    fontsPromise = (async () => {
      try {
        for (const wgt of [500, 700, 800]) {
          const face = new FontFace("Inter", `url(${new URL(`../fonts/inter-latin-${wgt}.woff2`, import.meta.url).href})`, { weight: String(wgt) });
          document.fonts.add(await face.load());
        }
        await document.fonts.load(font(800, 40));
        return true;
      } catch { return false; }
    })();
  }
  return fontsPromise;
}

/** A canvas with the card drawn on it (and the layout report). */
export function drawCard(model) {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W; canvas.height = CARD_H;
  const report = renderCard(canvas.getContext("2d"), model);
  return { canvas, report };
}

export const canvasToBlob = canvas => new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error("Couldn't make the image"))), "image/png"));
