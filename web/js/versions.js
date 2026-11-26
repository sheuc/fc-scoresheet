// Which FC Mobile match-summary layout is this screenshot?
//
//   "new"  the redesigned summary screen: "EA SPORTS FC MOBILE" logo at top centre, goals as two
//          columns of rows with a video button on the left (your goals) or right (opponent's)
//   "old"  the earlier screen: stats panel on the left, goal feed on the right with coloured GOAL tags
//
// The logo only exists on the new screen and never changes, so a 32x32 template match against
// its position separates the two cleanly (on the test samples: new >= 0.998, old <= 0.115).
// Anything that isn't the new screen is treated as the old one; if it then has no goal rows the
// pipeline reports it as "layout not recognised", exactly as before.
import { LOGO_TEMPLATE_B64 } from "./logo-template.js";

export const LOGO = { x: [0.456, 0.490], y: [0.0125, 0.086], size: 32 };
export const NEW_LAYOUT_THRESHOLD = 0.6;

/** 32x32 grayscale box-average of the logo region of an RGBA image. */
export function logoSignature(img) {
  const { data, width: W, height: H } = img, N = LOGO.size;
  const xa = Math.trunc(LOGO.x[0] * W), xb = Math.trunc(LOGO.x[1] * W);
  const ya = Math.trunc(LOGO.y[0] * H), yb = Math.trunc(LOGO.y[1] * H);
  const out = new Float64Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x0 = xa + Math.floor(i * (xb - xa) / N), y0 = ya + Math.floor(j * (yb - ya) / N);
    const x1 = Math.max(xa + Math.floor((i + 1) * (xb - xa) / N), x0 + 1);
    const y1 = Math.max(ya + Math.floor((j + 1) * (yb - ya) / N), y0 + 1);
    let s = 0, c = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const q = (y * W + x) * 4;
      s += (data[q] * 4899 + data[q + 1] * 9617 + data[q + 2] * 1868 + 8192) >> 14;
      c++;
    }
    out[j * N + i] = s / c;
  }
  return out;
}

/** Zero-mean normalised cross-correlation, -1..1. */
function ncc(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / (Math.sqrt(da * db) || 1);
}

let template = null;
function getTemplate() {
  if (!template) {
    const bin = atob(LOGO_TEMPLATE_B64);
    template = Float64Array.from(bin, c => c.charCodeAt(0));
  }
  return template;
}

/** {version: "new" | "old", score}. */
export function detectVersion(img) {
  const score = ncc(getTemplate(), logoSignature(img));
  return { version: score >= NEW_LAYOUT_THRESHOLD ? "new" : "old", score };
}
