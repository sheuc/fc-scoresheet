// Image analysis for EA FC Mobile post-match screenshots: a port of the colour pass and crop
// preparation in services/ocr_engine.py. Pure JS over RGBA pixel buffers, no DOM, so it runs
// the same in the browser and in Node tests.
//
// Instead of OCR-ing the whole screenshot we exploit the fixed layout of the post-match screen:
//  1. Colour pass: goal-feed rows are found by their coloured "GOAL" text (green = your team,
//     blue = opponent). No OCR involved.
//  2. Tiny crops (player name, minute, score digits, opponent) are cut out and prepared for OCR.

import { detectVersion } from "./versions.js";

// Layout constants of the OLD summary screen, as fractions of image width/height (measured on
// 2079x960 screenshots). The new screen's constants are LN below.
export const L = {
  FEED_Y: [0.24, 0.84],        // vertical extent of the goal feed
  TEXT_X: [0.60, 0.78],        // name + GOAL text (stops before the video button)
  NAME_X0: 0.598,              // where the player name starts
  MINUTE_X: [0.503, 0.556],    // minute column ("44'", "90' +1'")
  ROW_HALF_H: 0.034,           // half-height of a row crop
  SCORE_Y: [0.085, 0.175],
  SCORE_L_X: [0.40, 0.488],    // your score (left of the dash)
  SCORE_R_X: [0.512, 0.60],    // opponent score
  OPP_Y: [0.095, 0.158],       // opponent username line (identifies the game)
  OPP_X: [0.57, 0.778],
};

// OpenCV 8-bit HSV ranges: H 0-179, S/V 0-255
const GREEN = { h: [50, 90], s: [100, 255], v: [140, 255] };
const BLUE = { h: [95, 125], s: [120, 255], v: [140, 255] };

const trunc = Math.trunc;

// ------------------------------------------------------------------ pixel helpers
/** OpenCV BGR2GRAY (fixed-point 0.299 R + 0.587 G + 0.114 B). */
function gray(r, g, b) {
  return (r * 4899 + g * 9617 + b * 1868 + 8192) >> 14;
}

/** OpenCV 8-bit RGB -> HSV (H in 0..179). */
function hsv(r, g, b) {
  const v = Math.max(r, g, b), diff = v - Math.min(r, g, b);
  if (v === 0 || diff === 0) return [0, 0, v];
  const s = Math.round((255 * diff) / v);
  let h = v === r ? g - b : v === g ? b - r + 2 * diff : r - g + 4 * diff;
  h = Math.round((h * 30) / diff);
  if (h < 0) h += 180;
  return [h, s, v];
}

const inRange = (x, [lo, hi]) => x >= lo && x <= hi;

/** Contiguous runs (start,end) where profile[i] is true; gaps up to maxGap are bridged. */
export function runs(profile, minLen, maxGap) {
  const out = [];
  let start = -1, prev = -1;
  for (let i = 0; i < profile.length; i++) {
    if (!profile[i]) continue;
    if (start < 0) { start = prev = i; continue; }
    if (i - prev > maxGap) { out.push([start, prev]); start = i; }
    prev = i;
  }
  if (start >= 0) out.push([start, prev]);
  return out.filter(([a, b]) => b - a + 1 >= minLen);
}

// ------------------------------------------------------------------ colour pass
/** Rows [{cy, goal_x, color}] for every coloured GOAL tag. `img` = {data (RGBA), width, height}. */
export function findGoalRows(img) {
  const { data, width: w, height: h } = img;
  const y0 = trunc(L.FEED_Y[0] * h), y1 = trunc(L.FEED_Y[1] * h);
  const x0 = trunc(L.TEXT_X[0] * w), x1 = trunc(L.TEXT_X[1] * w);
  const rw = x1 - x0, rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return [];

  const green = new Uint8Array(rw * rh), blue = new Uint8Array(rw * rh);
  const rowSum = new Uint16Array(rh);
  for (let y = 0; y < rh; y++) {
    let base = ((y0 + y) * w + x0) * 4;
    for (let x = 0; x < rw; x++, base += 4) {
      const [H, S, V] = hsv(data[base], data[base + 1], data[base + 2]);
      if (V < 140) continue;
      const i = y * rw + x;
      if (inRange(H, GREEN.h) && inRange(S, GREEN.s)) { green[i] = 1; rowSum[y]++; }
      else if (inRange(H, BLUE.h) && inRange(S, BLUE.s)) { blue[i] = 1; rowSum[y]++; }
    }
  }
  const profile = Array.from(rowSum, v => v >= 3);
  const rows = [];
  for (const [ra, rb] of runs(profile, trunc(0.018 * h), trunc(0.006 * h))) {
    let firstCol = -1, g = 0, b = 0;
    for (let x = 0; x < rw && firstCol < 0; x++) {       // first column with >=2 coloured pixels
      let c = 0;
      for (let y = ra; y <= rb; y++) c += green[y * rw + x] | blue[y * rw + x];
      if (c >= 2) firstCol = x;
    }
    if (firstCol < 0) continue;
    for (let y = ra; y <= rb; y++) for (let x = 0; x < rw; x++) { g += green[y * rw + x]; b += blue[y * rw + x]; }
    rows.push({ cy: y0 + ((ra + rb) >> 1), goal_x: x0 + firstCol, color: g >= b ? "green" : "blue" });
  }
  return rows;
}

// ------------------------------------------------------------------ cropping
/** Gray crop of [xa,xb) x [ya,yb) as {data, w, h}, or null if empty. */
function cropGray(img, xa, xb, ya, yb) {
  const { data, width: W, height: H } = img;
  xa = Math.max(0, xa); ya = Math.max(0, ya); xb = Math.min(W, xb); yb = Math.min(H, yb);
  const w = xb - xa, h = yb - ya;
  if (w <= 0 || h <= 0) return null;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let p = ((ya + y) * W + xa) * 4;
    for (let x = 0; x < w; x++, p += 4) out[y * w + x] = gray(data[p], data[p + 1], data[p + 2]);
  }
  return { data: out, w, h };
}

/** Near-white pixels only (text colour), as a 255/0 gray crop. For text over busy coloured art. */
function whiteMaskCrop(img, xa, xb, ya, yb) {
  const { data, width: W, height: H } = img;
  xa = Math.max(0, xa); ya = Math.max(0, ya); xb = Math.min(W, xb); yb = Math.min(H, yb);
  const w = xb - xa, h = yb - ya;
  if (w <= 0 || h <= 0) return null;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let p = ((ya + y) * W + xa) * 4;
    for (let x = 0; x < w; x++, p += 4) out[y * w + x] = Math.min(data[p], data[p + 1], data[p + 2]) > 205 ? 255 : 0;
  }
  return { data: out, w, h };
}

function rowCrop(img, x0, x1, cy, halfH, yMin = 0, yMax = Infinity) {
  const h = img.height;
  return cropGray(img, trunc(x0), trunc(x1), Math.max(trunc(yMin), trunc(cy - halfH * h)), Math.min(trunc(yMax), trunc(cy + halfH * h)));
}

// ------------------------------------------------------------------ match stats cells
// Both layouts show the same five rows (shots(on target), possession, pass accuracy, fouls, offsides):
// your value left of the centre, the opponent's right of it.
const rowsY = list => list.map(v => v / 924);       // measured on a 2000x924 view; fractions carry over
export const STATS_OLD = { ROWS_Y: rowsY([343, 429, 516, 602, 689]), HALF_H: 0.035, LEFT_X: [0.157, 0.205], RIGHT_X: [0.440, 0.50] };
export const STATS_NEW = { ROWS_Y: rowsY([353, 419, 486, 552, 619]), HALF_H: 0.035, LEFT_X: [0.28, 0.34], RIGHT_X: [0.66, 0.72] };

function statCrops(img, g) {
  const { width: w, height: h } = img;
  return g.ROWS_Y.map(cy => ({
    l: cropGray(img, trunc(g.LEFT_X[0] * w), trunc(g.LEFT_X[1] * w), trunc((cy - g.HALF_H) * h), trunc((cy + g.HALF_H) * h)),
    r: cropGray(img, trunc(g.RIGHT_X[0] * w), trunc(g.RIGHT_X[1] * w), trunc((cy - g.HALF_H) * h), trunc((cy + g.HALF_H) * h)),
  }));
}

// ------------------------------------------------------------------ new layout
// The redesigned summary screen has no GOAL tag and no colour coding. Each goal row has an aqua
// video button instead: on the LEFT for your goals, on the RIGHT for the opponent's. Names sit
// right-aligned next to a ball icon, minutes in a centre column.
export const LN = {
  FEED_Y: [0.24, 0.78],
  OURS_X: [0.225, 0.295],       // band holding the video buttons of your goals
  THEIRS_X: [0.675, 0.735],     // ... and of the opponent's goals
  NAME_X: [0.30, 0.438],        // between the video button and the ball icon
  MINUTE_X: [0.472, 0.56],      // left-aligned, starts right of the ball icon
  ROW_HALF_H: 0.034,
  SCORE_Y: [0.125, 0.215],
  SCORE_L_X: [0.40, 0.465],     // your score (left of the centre logo)
  SCORE_R_X: [0.535, 0.60],     // opponent's score
  CLUB_Y: [0.15, 0.21],         // opponent's CLUB name: a clean white-on-dark line
  CLUB_X: [0.728, 0.90],
  USER_Y: [0.006, 0.045],       // opponent's USERNAME (first line of the top-right banner). The banner art
  USER_X: [0.71, 0.822],        // varies, so only near-white pixels are kept (see whiteMaskCrop)
  THEIR_NAME_X: [0.572, 0.704], // opponent scorers: left-aligned between the ball icon and the button
  THEIR_MINUTE_X: [0.472, 0.532], // on the opponent's side the ball icon is RIGHT of the minute (from ~0.538)
  LIST_Y: [0.283, 0.768],       // text area of the goal list; the divider lines just outside it must stay out of crops
  BUTTON_HUE: [75, 100],        // the button outline is aqua-green
  BUTTON_MIN_H: 0.047,          // a full button is ~5.4% of the height; shorter = clipped by the list edge
};

/** Which page of the new screen's carousel this is: "stats" | "goals" | "playstyles" (the active dot is saturated). */
export function newPageType(img) {
  const { data, width: w, height: h } = img;
  const cy = Math.round(0.8128 * h);
  const sat = [0.489, 0.500, 0.511].map(fx => {
    const cx = Math.round(fx * w);
    let best = 0;
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) {
      const p = (y * w + x) * 4;
      best = Math.max(best, Math.max(data[p], data[p + 1], data[p + 2]) - Math.min(data[p], data[p + 1], data[p + 2]));
    }
    return best;
  });
  const top = Math.max(...sat);
  if (top < 100) return "goals";                       // dots not found (other aspect ratio?): assume the goals page
  return ["stats", "goals", "playstyles"][sat.indexOf(top)];
}

/** Rows [{cy}] of FULLY visible video buttons in a vertical band (a button cut off by the list's edge is skipped,
 *  its text is cut off too; the same goal shows up whole in the next, scrolled screenshot). */
export function findButtonRows(img, band) {
  const { data, width: w, height: h } = img;
  const y0 = trunc(LN.FEED_Y[0] * h), y1 = trunc(LN.FEED_Y[1] * h);
  const x0 = trunc(band[0] * w), x1 = trunc(band[1] * w);
  if (y1 <= y0 || x1 <= x0) return [];
  const hit = new Array(y1 - y0).fill(false);
  for (let y = y0; y < y1; y++) {
    let n = 0, p = (y * w + x0) * 4;
    for (let x = x0; x < x1; x++, p += 4) {
      const [H, S, V] = hsv(data[p], data[p + 1], data[p + 2]);
      if (V >= 140 && S >= 120 && H >= LN.BUTTON_HUE[0] && H <= LN.BUTTON_HUE[1]) n++;
    }
    hit[y - y0] = n >= 3;
  }
  return runs(hit, trunc(LN.BUTTON_MIN_H * h), trunc(0.006 * h)).map(([a, b]) => ({ cy: y0 + ((a + b) >> 1) }));
}

function analyzeNewLayout(filename, img, original = img) {
  const { width: w, height: h } = img;
  const page = newPageType(img);
  const rows = [];
  const yMin = LN.LIST_Y[0] * h, yMax = LN.LIST_Y[1] * h;
  for (const { cy } of findButtonRows(img, LN.OURS_X)) {
    const nameCrop = rowCrop(img, LN.NAME_X[0] * w, LN.NAME_X[1] * w, cy, LN.ROW_HALF_H, yMin, yMax);
    const minuteCrop = rowCrop(img, LN.MINUTE_X[0] * w, LN.MINUTE_X[1] * w, cy, LN.ROW_HALF_H, yMin, yMax);
    if (nameCrop && minuteCrop) rows.push({ name_crop: nameCrop, minute_crop: minuteCrop });
  }
  // The opponent's goals are not counted for you, but they (with the minutes) fingerprint the game:
  // two screenshots only belong to the same game if they show some of the same goals.
  const theirsRows = [];
  for (const { cy } of findButtonRows(img, LN.THEIRS_X)) {
    const nameCrop = rowCrop(img, LN.THEIR_NAME_X[0] * w, LN.THEIR_NAME_X[1] * w, cy, LN.ROW_HALF_H, yMin, yMax);
    const minuteCrop = rowCrop(img, LN.THEIR_MINUTE_X[0] * w, LN.THEIR_MINUTE_X[1] * w, cy, LN.ROW_HALF_H, yMin, yMax);
    if (nameCrop && minuteCrop) theirsRows.push({ name_crop: nameCrop, minute_crop: minuteCrop });
  }
  const sy0 = trunc(LN.SCORE_Y[0] * h), sy1 = trunc(LN.SCORE_Y[1] * h);
  return {
    filename, width: w, height: h, rows, page,
    stats_crops: page === "stats" ? statCrops(original, STATS_NEW) : null,
    theirs_rows: theirsRows, theirs: theirsRows.length,
    user_crop: whiteMaskCrop(img, trunc(LN.USER_X[0] * w), trunc(LN.USER_X[1] * w), trunc(LN.USER_Y[0] * h), trunc(LN.USER_Y[1] * h)),
    score_l: cropGray(img, trunc(LN.SCORE_L_X[0] * w), trunc(LN.SCORE_L_X[1] * w), sy0, sy1),
    score_r: cropGray(img, trunc(LN.SCORE_R_X[0] * w), trunc(LN.SCORE_R_X[1] * w), sy0, sy1),
    opp_crop: cropGray(img, trunc(LN.CLUB_X[0] * w), trunc(LN.CLUB_X[1] * w), trunc(LN.CLUB_Y[0] * h), trunc(LN.CLUB_Y[1] * h)),
  };
}

const lanczos = x => { x = Math.abs(x); if (x < 1e-9) return 1; if (x >= 3) return 0; const px = Math.PI * x; return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px); };

/** The height every layout constant and OCR preprocessing rule was tuned at (the samples are 2079x960). */
export const REFERENCE_HEIGHT = 960;

/**
 * Resample a screenshot to the reference height (same aspect ratio) before anything is read from it. The layout
 * constants are ratios, but crop sizes, glyph thresholds and OCR input scale are not: a screenshot from a phone with
 * another resolution read wrong names, minutes and scores until it was brought to the scale everything was tuned at.
 * A Lanczos-3 filter whose support grows when shrinking, so downscaling averages instead of aliasing and edges stay sharp.
 */
export function resampleToReference(img) {
  const scale = REFERENCE_HEIGHT / img.height;
  if (Math.abs(scale - 1) < 0.01) return img;
  const outW = Math.max(1, Math.round(img.width * scale)), outH = REFERENCE_HEIGHT;
  const axis = (inLen, outLen) => {
    const sc = outLen / inLen, support = 3 * Math.max(1, 1 / sc), taps = [];
    for (let o = 0; o < outLen; o++) {
      const centre = (o + 0.5) / sc - 0.5, from = Math.max(0, Math.ceil(centre - support)), to = Math.min(inLen - 1, Math.floor(centre + support));
      const idx = [], wts = []; let sum = 0;
      for (let i = from; i <= to; i++) { const wt = lanczos((i - centre) / Math.max(1, 1 / sc)); if (wt !== 0) { idx.push(i); wts.push(wt); sum += wt; } }
      if (!idx.length) { idx.push(Math.min(inLen - 1, Math.max(0, Math.round(centre)))); wts.push(1); sum = 1; }
      taps.push({ idx, wts: wts.map(v => v / sum) });
    }
    return taps;
  };
  const tx = axis(img.width, outW), ty = axis(img.height, outH);
  const mid = new Float32Array(outW * img.height * 4);                       // horizontal pass
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < outW; x++) {
      const { idx, wts } = tx[x];
      for (let c = 0; c < 4; c++) {
        let v = 0;
        for (let k = 0; k < idx.length; k++) v += img.data[(y * img.width + idx[k]) * 4 + c] * wts[k];
        mid[(y * outW + x) * 4 + c] = v;
      }
    }
  }
  const out = new Uint8ClampedArray(outW * outH * 4);                        // vertical pass
  for (let y = 0; y < outH; y++) {
    const { idx, wts } = ty[y];
    for (let x = 0; x < outW; x++) {
      for (let c = 0; c < 4; c++) {
        let v = 0;
        for (let k = 0; k < idx.length; k++) v += mid[(idx[k] * outW + x) * 4 + c] * wts[k];
        out[(y * outW + x) * 4 + c] = Math.round(v);   // Uint8ClampedArray clamps the filter's overshoot
      }
    }
  }
  return { data: out, width: outW, height: outH };
}

/**
 * Decode-independent analysis of one screenshot of either layout: your goal rows with their
 * name/minute crops, the two score crops and the opponent crop (all grayscale), plus `version`.
 */
export function analyzeImage(filename, shot) {
  // A phone with another screen shape than the one the reader was tuned on shows the game either stretched to the
  // width, or with the same-size UI centred between extra (or fewer) side margins. The first case reads as it is;
  // the second only after the sides are cut off (longer screens) or padded (shorter ones). Which one it is can be
  // seen from where the screen's fixed landmarks fall, so both readings are made and the one whose landmarks sit
  // where they do in the reference screenshots wins. Same-shape screenshots are never touched.
  const aspect = shot.width / shot.height;
  let src = shot, aligned = false;
  if (Math.abs(aspect / REFERENCE_ASPECT - 1) > 0.03) {
    const alt = aspect > REFERENCE_ASPECT ? centreCropToAspect(shot, REFERENCE_ASPECT) : padToAspect(shot, REFERENCE_ASPECT);
    if (alignmentEvidence(alt) > alignmentEvidence(shot) + 0.05) { src = alt; aligned = true; }
  }
  const a = analyzeShot(filename, src);
  a.evidence = alignmentEvidence(src);       // how much it looks like a match screen at all (see MIN_LAYOUT_EVIDENCE)
  a.aspect = aspect;
  a.aligned_to_fit = aligned;
  return a;
}

/**
 * A screenshot must show the match screen's fixed landmarks (see alignmentEvidence) before anything is read from it; without
 * this, any image with green-ish rows (another screen, a rotated screenshot) produced "goals". Measured: all 113 real
 * screenshots score >= 0.998, blank / rotated / wrong-screen / random images score <= 0.3.
 */
export const MIN_LAYOUT_EVIDENCE = 0.4;

/** The width:height of the screenshots everything was tuned on. */
export const REFERENCE_ASPECT = 2079 / 960;

/**
 * How well the landmarks of a match screen sit where they do in the reference screenshots (0..1):
 *   new layout  the logo at top centre matches its template (NCC)
 *   old layout  the header bar's thin green strip at its left end and blue strip at its right end
 * Both layouts are laid out symmetrically about the screen's centre, so a centred crop/pad is the only shift to test.
 */
export function alignmentEvidence(img) {
  const v = detectVersion(img);
  return Math.max(v.version === "new" ? v.score : 0, stripEvidence(img));
}
const STRIP = { left: 310.5 / 2079, right: 1769.5 / 2079, y: [0.10, 0.20], reach: 0.012 };
function stripEvidence(img) {
  const { data, width: w, height: h } = img;
  const rows = Array.from({ length: 10 }, (_, i) => trunc((STRIP.y[0] + (STRIP.y[1] - STRIP.y[0]) * (i + 0.5) / 10) * h));
  const side = (cx, isGreen) => {
    let best = 0;
    for (let x = Math.max(0, trunc((cx - STRIP.reach) * w)); x <= Math.min(w - 1, trunc((cx + STRIP.reach) * w)); x++) {
      let n = 0;
      for (const y of rows) {
        const q = (y * w + x) * 4, r = data[q], g = data[q + 1], b = data[q + 2];
        if (isGreen ? (g > 190 && g - r > 90 && g - b > 70) : (b > 200 && b - r > 120 && b - g > 50)) n++;     // bright and clearly green / blue (paler mid-animation: IMG_4499)
      }
      best = Math.max(best, n / rows.length);
    }
    return best;
  };
  return Math.min(side(STRIP.left, true), side(STRIP.right, false));
}

/** The centre of an image cut to `aspect` (width : height), when it is wider than that. */
export function centreCropToAspect(img, aspect) {
  const w2 = Math.round(img.height * aspect);
  if (w2 >= img.width) return img;
  const x0 = Math.floor((img.width - w2) / 2), out = new Uint8ClampedArray(w2 * img.height * 4);
  for (let y = 0; y < img.height; y++) out.set(img.data.subarray((y * img.width + x0) * 4, (y * img.width + x0 + w2) * 4), y * w2 * 4);
  return { data: out, width: w2, height: img.height };
}

/** An image centred in extra side margins (its edge columns repeated) so that it is `aspect` wide, when it is narrower. */
export function padToAspect(img, aspect) {
  const w2 = Math.round(img.height * aspect);
  if (w2 <= img.width) return img;
  const padL = Math.floor((w2 - img.width) / 2), out = new Uint8ClampedArray(w2 * img.height * 4);
  for (let y = 0; y < img.height; y++) {
    const row = y * w2 * 4, src = y * img.width * 4;
    out.set(img.data.subarray(src, src + img.width * 4), row + padL * 4);
    for (let x = 0; x < padL; x++) out.set(img.data.subarray(src, src + 4), row + x * 4);
    for (let x = padL + img.width; x < w2; x++) out.set(img.data.subarray(src + (img.width - 1) * 4, src + img.width * 4), row + x * 4);
  }
  return { data: out, width: w2, height: img.height };
}

function analyzeShot(filename, original) {
  const img = resampleToReference(original);
  const { version } = detectVersion(img);
  // The stats panels are cut from the ORIGINAL pixels: their digit splitting depends on the exact edges and read fine at
  // any size (rescaling made them worse), whereas names, minutes and scores need the scale the OCR rules were tuned at.
  const a = version === "new" ? analyzeNewLayout(filename, img, original) : analyzeOldLayout(filename, img, original);
  a.version = version;
  return a;
}

function analyzeOldLayout(filename, img, original = img) {
  const { width: w, height: h } = img;
  const rows = [], theirsRows = [];
  for (const r of findGoalRows(img)) {
    const nameCrop = rowCrop(img, L.NAME_X0 * w, r.goal_x - 0.004 * w, r.cy, L.ROW_HALF_H);
    const minuteCrop = rowCrop(img, L.MINUTE_X[0] * w, L.MINUTE_X[1] * w, r.cy, L.ROW_HALF_H);
    if (!nameCrop || !minuteCrop) continue;
    // green GOAL tag = yours; blue = the opponent's (only used for stoppage-time equalizers)
    (r.color === "green" ? rows : theirsRows).push({ name_crop: nameCrop, minute_crop: minuteCrop });
  }
  const sy0 = trunc(L.SCORE_Y[0] * h), sy1 = trunc(L.SCORE_Y[1] * h);
  return {
    filename, width: w, height: h, rows,
    theirs_rows: theirsRows, theirs: theirsRows.length,
    stats_crops: statCrops(original, STATS_OLD),
    score_l: cropGray(img, trunc(L.SCORE_L_X[0] * w), trunc(L.SCORE_L_X[1] * w), sy0, sy1),
    score_r: cropGray(img, trunc(L.SCORE_R_X[0] * w), trunc(L.SCORE_R_X[1] * w), sy0, sy1),
    opp_crop: cropGray(img, trunc(L.OPP_X[0] * w), trunc(L.OPP_X[1] * w),
                       trunc(L.OPP_Y[0] * h), trunc(L.OPP_Y[1] * h)),
  };
}

// ------------------------------------------------------------------ OCR input preparation
const FLT_EPSILON = 1.1920929e-7;

/** Otsu threshold exactly as cv2.threshold(..., THRESH_OTSU) returns it (pixels > t are "on"). */
export function otsuThreshold(data) {
  const hist = new Float64Array(256), n = data.length;
  for (let i = 0; i < n; i++) hist[data[i]]++;
  const scale = 1 / n;
  let mu = 0;
  for (let i = 0; i < 256; i++) mu += i * hist[i] * scale;
  let mu1 = 0, q1 = 0, maxSigma = 0, maxVal = 0;
  for (let i = 0; i < 256; i++) {
    const p = hist[i] * scale;
    mu1 *= q1; q1 += p;
    const q2 = 1 - q1;
    if (Math.min(q1, q2) < FLT_EPSILON || Math.max(q1, q2) > 1 - FLT_EPSILON) continue;
    mu1 = (mu1 + i * p) / q1;
    const mu2 = (mu - q1 * mu1) / q2;
    const sigma = q1 * q2 * (mu1 - mu2) * (mu1 - mu2);
    if (sigma > maxSigma) { maxSigma = sigma; maxVal = i; }
  }
  return maxVal;
}

/** numpy-style median truncated to int (what int(np.median(x)) does). */
function medianInt(values) {
  const hist = new Uint32Array(256);
  for (const v of values) hist[v]++;
  const n = values.length, kLo = (n - 1) >> 1, kHi = n >> 1;
  let seen = 0, lo = 0, hi = 0;
  for (let v = 0; v < 256; v++) {
    const next = seen + hist[v];
    if (seen <= kLo && kLo < next) lo = v;
    if (seen <= kHi && kHi < next) { hi = v; break; }
    seen = next;
  }
  return trunc((lo + hi) / 2);
}

/** True if a crop holds no ink at all (e.g. a stats row the game hadn't drawn yet when the screenshot was taken). */
export function cellIsBlank(g) {
  const { data } = g;
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const limit = Math.max(otsuThreshold(data), sum / data.length + 20);
  let count = 0;
  for (let i = 0; i < data.length; i++) if (data[i] > limit) count++;
  return count < 8;                                   // same rule tightCrop uses to decide there is nothing to trim to
}

/** Trim a light-on-dark crop to its bright ink. */
export function tightCrop(g, pad = 4) {
  const { data, w, h } = g;
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const limit = Math.max(otsuThreshold(data), sum / data.length + 20);
  let x0 = w, x1 = -1, y0 = h, y1 = -1, count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[y * w + x] > limit) {
      count++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (count < 8) return g;
  return subImage(g, Math.max(0, x0 - pad), Math.min(w, x1 + 1 + pad), Math.max(0, y0 - pad), Math.min(h, y1 + 1 + pad));
}

function subImage(g, xa, xb, ya, yb) {
  const w = xb - xa, h = yb - ya, out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(g.data.subarray((ya + y) * g.w + xa, (ya + y) * g.w + xb), y * w);
  return { data: out, w, h };
}

function pad(g, p, value /* undefined = replicate edge */) {
  const w = g.w + 2 * p, h = g.h + 2 * p, out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = x - p, sy = y - p;
    out[y * w + x] = (sx >= 0 && sx < g.w && sy >= 0 && sy < g.h) ? g.data[sy * g.w + sx]
      : value !== undefined ? value
      : g.data[Math.min(g.h - 1, Math.max(0, sy)) * g.w + Math.min(g.w - 1, Math.max(0, sx))];
  }
  return { data: out, w, h };
}

const invert = g => ({ ...g, data: g.data.map(v => 255 - v) });

/**
 * Names: dark text on light, padded with a CONSTANT background colour. Replicate-padding smears
 * the last letter's stroke into a bar that Tesseract reads as an extra character.
 */
export function prepName(crop) {
  const g = tightCrop(crop);
  return invert(pad(g, 10, medianInt(g.data)));
}

/** Bilinear upscale by an integer-ish factor (Tesseract does best on text that is ~30+ px tall). */
export function upscale(g, k) {
  if (k === 1) return g;
  const w = Math.round(g.w * k), h = Math.round(g.h * k), d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(g.h - 1, Math.max(0, (y + 0.5) / k - 0.5)), y0 = Math.floor(sy), y1 = Math.min(g.h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(g.w - 1, Math.max(0, (x + 0.5) / k - 0.5)), x0 = Math.floor(sx), x1 = Math.min(g.w - 1, x0 + 1), fx = sx - x0;
      d[y * w + x] = Math.round((g.data[y0 * g.w + x0] * (1 - fx) + g.data[y0 * g.w + x1] * fx) * (1 - fy)
                              + (g.data[y1 * g.w + x0] * (1 - fx) + g.data[y1 * g.w + x1] * fx) * fy);
    }
  }
  return { data: d, w, h };
}

/** Match-stat cell: like prepPlain, upscaled (the old panel's digits are small). */
export function prepStat(crop, k = 3) {
  return upscale(prepPlain(crop), k);
}

/** Scores / opponent name: tight crop, replicate padding, inverted. */
export function prepPlain(crop) {
  return invert(pad(tightCrop(crop), 6));
}

/**
 * Minutes: binarise, then widen every gap between glyphs to >= 0.5 x height. With tight digit
 * spacing the recogniser collapses repeated glyphs ("11'" -> "1", "71'" -> "7").
 */
export function prepMinute(crop, gapFactor = 0.5) {
  const g = tightCrop(crop);
  const thr = otsuThreshold(g.data);
  const ink = g.data.map(v => (v > thr ? 1 : 0));
  const b = { data: ink.map(v => (v ? 0 : 255)), w: g.w, h: g.h };    // black ink on white
  return pad(respace(b, ink, Math.max(4, trunc(gapFactor * g.h))), 12, 255);
}

/** Column runs [start, end] of a 0/1 ink mask: one per glyph (touching glyphs share a run). */
function columnSegments(ink, w, h) {
  const segs = [];
  let start = -1, prev = -1;
  for (let x = 0; x < w; x++) {
    let any = false;
    for (let y = 0; y < h && !any; y++) any = ink[y * w + x] === 1;
    if (!any) continue;
    if (start < 0) start = prev = x;
    else if (x - prev > 1) { segs.push([start, prev]); start = x; }
    prev = x;
  }
  if (start >= 0) segs.push([start, prev]);
  return segs;
}

/**
 * The digits of a minute crop as separate glyph images, for reading one at a time.
 * Used when the whole-line read comes back with fewer digits than there are digit-shaped glyphs
 * (the decoder collapses repeated thin glyphs such as the two bars of "11'").
 * Digits are the full-height glyphs; the apostrophe is short and high, the "+" is the widest short glyph.
 * Returns {digits: [gray image], plusAfter: number of digits before the "+" (or -1), merged: touching digits}.
 */
export function minuteGlyphs(crop) {
  const g = tightCrop(crop);
  const thr = otsuThreshold(g.data);
  const ink = g.data.map(v => (v > thr ? 1 : 0));
  const segs = columnSegments(ink, g.w, g.h);
  const info = segs.map(([a, z]) => {
    let y0 = g.h, y1 = -1;
    for (let y = 0; y < g.h; y++) for (let x = a; x <= z; x++) if (ink[y * g.w + x]) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return { a, z, w: z - a + 1, h: y1 - y0 + 1 };
  });
  const maxH = Math.max(0, ...info.map(s => s.h));
  // Digits are all (almost) the same height; the "+" is ~70% of it and the apostrophe ~30%.
  const tall = info.filter(s => s.h >= 0.85 * maxH);
  const short = info.filter(s => s.h < 0.85 * maxH);
  const plus = short.reduce((best, s) => (!best || s.w > best.w ? s : best), null);
  const plusSeg = plus && plus.w >= 0.3 * maxH ? plus : null;
  const digits = tall.map(s => {
    const sub = { data: new Uint8Array(s.w * g.h), w: s.w, h: g.h };
    for (let y = 0; y < g.h; y++) for (let x = 0; x < s.w; x++) sub.data[y * s.w + x] = ink[y * g.w + s.a + x] ? 0 : 255;
    return pad(sub, 12, 255);
  });
  // A "digit" much wider than tall is two touching digits: counting glyphs says nothing then.
  const merged = tall.some(s => s.w > 1.1 * s.h);
  return { digits, merged, plusAfter: plusSeg ? tall.filter(s => s.a < plusSeg.a).length : -1 };
}

/**
 * Cut a match-stat cell into its digit groups (the numbers, without brackets / % sign).
 * Line OCR drops the "(" of "6(6)" and leading digits of small "72%"; the glyph shapes themselves are fine.
 *   kind "shots"   A(B): the brackets are found by their tails, which hang below the digits' baseline and sit in
 *                  their own columns even when a bracket touches a digit -> two groups A and B
 *   kind "percent" 72%:  every glyph but the last (the % sign) -> one group
 *   kind "count"   2:    every glyph -> one group
 * Each group is {strip: image of the digits only, glyphs: [one image per digit], merged: touching digits}.
 * Returns {groups: [...]} or null if the cell doesn't look like that.
 */
export function statParts(crop, kind) {
  const g = tightCrop(crop);
  const base = otsuThreshold(g.data);
  let maxV = 0;
  for (let i = 0; i < g.data.length; i++) if (g.data[i] > maxV) maxV = g.data[i];
  // Touching digits ("71": a 7 and a thin 1) are bridged only by anti-aliased edge pixels: a stricter brightness
  // threshold separates them again. Try progressively stricter ones until the cell has the expected structure.
  let fallback = null;
  for (const f of [0, 0.35, 0.6]) {
    const res = statPartsAt(g, base + f * (maxV - base), kind);
    if (res && (kind !== "percent" || res.groups[0].glyphs.length >= 2)) return res;      // a percentage has 2+ digits
    fallback = fallback || res;
  }
  return fallback;
}

function statPartsAt(g, thr, kind) {
  const ink = g.data.map(v => (v > thr ? 1 : 0));
  if (!ink.some(Boolean)) return null;
  const allSegs = columnSegments(ink, g.w, g.h);
  const strokes = y => { let n = 0; for (let x = 0; x < g.w; x++) if (ink[y * g.w + x] && !(x > 0 && ink[y * g.w + x - 1])) n++; return n; };
  const rowHasInk = y => { for (let x = 0; x < g.w; x++) if (ink[y * g.w + x]) return true; return false; };

  // Height of the digits (NOT of the padded crop). In a shots cell the brackets hang below them, and below the digits'
  // baseline only the two bracket tails exist: the baseline is the last row crossing 3+ separate strokes.
  let top = 0, baseline = g.h - 1;
  while (top < g.h - 1 && !rowHasInk(top)) top++;
  while (baseline > top && !rowHasInk(baseline)) baseline--;
  if (kind === "shots") {
    while (baseline > 0 && strokes(baseline) < 3) baseline--;
    top = 0;
    while (top < baseline && strokes(top) < 3) top++;
  }
  const digitH = Math.max(1, baseline - top + 1);

  const colInk = x => { let n = 0; for (let y = 0; y < g.h; y++) n += ink[y * g.w + x]; return n; };
  /** Two or more digits whose strokes touch form one column run; cut it at the thinnest columns. */
  const splitWide = sg => {
    const n = Math.round(sg.w / (0.6 * digitH));
    if (n < 2 || n > 8) return [sg];                    // more than 8 digits in a run is not a stat cell: don't try to split it
    const cuts = [];
    for (let k = 1; k < n; k++) {
      const target = Math.round(sg.a + (sg.w * k) / n), reach = Math.max(1, Math.round(0.15 * sg.w));
      let best = target;
      for (let x = Math.max(sg.a + 1, target - reach); x <= Math.min(sg.z - 1, target + reach); x++) if (colInk(x) < colInk(best)) best = x;
      cuts.push(best);
    }
    const bounds = [sg.a, ...cuts.flatMap(c => [c - 1, c]), sg.z];
    return Array.from({ length: n }, (_, k) => ({ a: bounds[2 * k], z: bounds[2 * k + 1], w: bounds[2 * k + 1] - bounds[2 * k] + 1, h: sg.h }));
  };

  // the digit groups inside columns [x0, x1]: digit-sized column runs only (drops stray bracket / % edges)
  const part = (x0, x1) => {
    const sub = new Uint8Array(g.w * g.h);
    for (let y = 0; y < g.h; y++) for (let x = x0; x <= x1; x++) sub[y * g.w + x] = ink[y * g.w + x];
    const keep = columnSegments(sub, g.w, g.h).map(([a, z]) => {
      let y0 = g.h, y1 = -1;
      for (let y = 0; y < g.h; y++) for (let x = a; x <= z; x++) if (sub[y * g.w + x]) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
      return { a, z, w: z - a + 1, h: y1 - y0 + 1 };
    }).filter(sg => sg.h >= 0.6 * digitH);
    if (!keep.length) return null;
    const render = cols => {                    // black digits on white, only the chosen column runs
      const a = cols[0].a, z = cols[cols.length - 1].z, w = Math.max(1, z - a + 1), im = { data: new Uint8Array(w * g.h).fill(255), w, h: g.h };
      for (const c of cols) for (let y = 0; y < g.h; y++) for (let x = c.a; x <= c.z; x++) if (ink[y * g.w + x]) im.data[y * w + (x - a)] = 0;
      return upscale(pad(im, 12, 255), 2);
    };
    const glyphSegs = keep.flatMap(splitWide).filter(c => c.w > 0);
    if (!glyphSegs.length) return null;
    return { strip: render(keep), glyphs: glyphSegs.map(c => render([c])), merged: false };
  };

  if (kind === "count") { const p = part(0, g.w - 1); return p ? { groups: [p] } : null; }
  if (kind === "percent") {
    // The % sign is ~0.88 of the digit height wide, a digit ~0.59. Usually the sign is its own column run; when it
    // touches the last digit the run is wider than a sign, so cut a sign's width off its right end.
    const last = allSegs[allSegs.length - 1], lastW = last[1] - last[0] + 1;
    const cut = lastW <= 1.0 * digitH ? last[0] - 1 : last[1] - Math.round(0.88 * digitH);
    if (cut < 0) return null;
    const p = part(0, cut);
    return p ? { groups: [p] } : null;
  }
  if (kind === "shots") {
    const hang = new Uint8Array(g.w);                                    // columns with ink below the baseline
    for (let y = baseline + 1; y < g.h; y++) for (let x = 0; x < g.w; x++) if (ink[y * g.w + x]) hang[x] = 1;
    const tails = columnSegments(hang, g.w, 1);
    if (tails.length !== 2) return null;                                 // exactly "(" and ")"
    const segOf = x => allSegs.find(([a, z]) => x >= a && x <= z);
    const [so, sc] = [segOf(tails[0][0]), segOf(tails[1][0])];
    const bracket = sg => sg && sg[1] - sg[0] + 1 <= 0.7 * digitH;       // a whole bracket glyph; wider = it touches a digit
    const m = Math.round(0.25 * digitH);
    const aEnd = bracket(so) ? so[0] - 1 : tails[0][0] - m;              // the "(" bulges left of its tail by ~25% of the digit height
    const bStart = bracket(so) ? so[1] + 1 : tails[0][1] + 1;
    const bEnd = bracket(sc) ? sc[0] - 1 : tails[1][0] - 2;
    if (aEnd < 0 || bEnd < bStart) return null;
    const A = part(0, aEnd), B = part(bStart, bEnd);
    return A && B ? { groups: [A, B] } : null;
  }
  return null;
}

function respace(b, ink, gapMin) {
  const { w, h } = b;
  const segs = columnSegments(ink, w, h);
  if (!segs.length) return b;
  const edge = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < Math.min(2, w); x++) edge.push(b.data[y * w + x]);
  const bg = medianInt(edge);
  const gaps = segs.slice(1).map(([a], i) => Math.max(gapMin, a - segs[i][1] - 1));
  const outW = segs.reduce((s, [a, z]) => s + (z - a + 1), 0) + gaps.reduce((s, v) => s + v, 0);
  const out = new Uint8Array(outW * h).fill(bg);
  let ox = 0;
  segs.forEach(([a, z], i) => {
    for (let y = 0; y < h; y++) for (let x = a; x <= z; x++) out[y * outW + ox + (x - a)] = b.data[y * w + x];
    ox += z - a + 1 + (gaps[i] ?? 0);
  });
  return { data: out, w: outW, h };
}

/**
 * Erase accent marks (and umlaut dots, tildes, haceks) from a light-on-dark name crop.
 * Tesseract's English model has no accented glyphs and reads "á" as "d"; names are compared
 * without accents anyway. A small blob counts as a diacritic when it sits above a *wide, round*
 * letter body (a, e, o, u, n, s, capitals ...). Dots of "i" and "j" sit above thin stems and stay.
 */
export function removeDiacritics(crop) {
  const { data, w, h } = crop;
  let sum = 0, maxV = 0;
  for (let i = 0; i < data.length; i++) { sum += data[i]; if (data[i] > maxV) maxV = data[i]; }
  const base = Math.max(otsuThreshold(data), sum / data.length + 20);
  const out = new Uint8Array(data), bg = medianInt(data);

  // At a low brightness limit the anti-aliased edges can bridge an accent and its letter into one
  // component; at a higher one they separate. Where that happens depends on the exact pixels, so
  // try several levels and erase whatever any of them identifies as a mark.
  for (const f of [0.5, 0.65, 0.8]) {
    const limit = base + f * (maxV - base);
    const label = new Int32Array(w * h), comps = [];
    for (let s = 0; s < w * h; s++) {
      if (label[s] || data[s] <= limit) continue;
      const id = comps.length + 1, c = { x0: w, x1: -1, y0: h, y1: -1, px: [] }, stack = [s];
      label[s] = id;
      while (stack.length) {
        const p = stack.pop(), x = p % w, y = (p - x) / w;
        c.px.push(p);
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (!label[q] && data[q] > limit) { label[q] = id; stack.push(q); }
        }
      }
      comps.push(c);
    }
    if (comps.length < 2) continue;
    const H = Math.max(...comps.map(c => c.y1)) - Math.min(...comps.map(c => c.y0)) + 1;

    for (const a of comps) {
      const aw = a.x1 - a.x0 + 1, ah = a.y1 - a.y0 + 1;
      if (ah > 0.35 * H || aw > 0.6 * H) continue;                       // not a small mark
      // The letter under the mark: the nearest component below whose bounding box spans the mark's
      // centre. (Bounding box, not ink: a "u" is open at the top, so there is no ink right under its accent.)
      const cx = (a.x0 + a.x1) / 2;
      let b = null;
      for (const c of comps) {
        if (c === a || c.y0 <= a.y1 || c.y0 - a.y1 > Math.ceil(0.4 * H) || c.x0 > cx || c.x1 < cx) continue;
        if (!b || c.y0 < b.y0) b = c;
      }
      if (!b) continue;
      const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
      if (bh / bw > 2.2) continue;                                        // thin stem below: an "i" / "j" dot
      for (const p of a.px) {                                              // erase it and its anti-aliased halo
        const x = p % w, y = (p - x) / w;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && (label[ny * w + nx] === 0 || label[ny * w + nx] === label[p])) out[ny * w + nx] = bg;
        }
      }
    }
  }
  return { data: out, w, h };
}

/** New-layout names: accents removed first. */
export const prepNameNew = crop => prepName(removeDiacritics(crop));

export const PREP = { name: prepName, minute: prepMinute, score_l: prepPlain, score_r: prepPlain, opp: prepPlain, stat: c => prepStat(c, Number(globalThis.process?.env?.STAT_K || 3)) };
/** Preparation per screen layout (see versions.js). */
export const PREP_BY_VERSION = { old: PREP, new: { ...PREP, name: prepNameNew } };

// ------------------------------------------------------------------ tiny PNG encoder
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

/** Encode a gray image as an 8-bit grayscale PNG (uncompressed deflate: tiny crops, no zlib needed). */
export function encodeGrayPng({ data, w, h }) {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(data.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78; z[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const chunk = raw.subarray(i * 65535, Math.min(raw.length, (i + 1) * 65535)), n = chunk.length;
    z[o++] = i === blocks - 1 ? 1 : 0;
    z[o++] = n & 255; z[o++] = n >> 8; z[o++] = ~n & 255; z[o++] = (~n >> 8) & 255;
    z.set(chunk, o); o += n;
  }
  const ad = adler32(raw);
  z[o++] = ad >>> 24; z[o++] = (ad >>> 16) & 255; z[o++] = (ad >>> 8) & 255; z[o++] = ad & 255;

  const chunk = (type, body) => {
    const out = new Uint8Array(12 + body.length), dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 0;   // 8-bit grayscale
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk("IHDR", ihdr), chunk("IDAT", z.subarray(0, o)), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let p = 0;
  for (const part of parts) { png.set(part, p); p += part.length; }
  return png;
}
