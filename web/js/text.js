// Port of utils.py: name normalisation and fuzzy matching.

/** Lower-case, strip accents, trim. */
export function normalize(text) {
  if (!text) return "";
  return String(text).normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().trim();
}

/** Trim non-word characters from both ends and collapse whitespace.
 *  ('_' counts as a word character in regexes, so it is replaced first.) */
export function cleanWord(word) {
  const w = String(word ?? "").replace(/_+/g, " ");
  return w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/\s+/g, " ").trim();
}

/** Same as rapidfuzz.fuzz.ratio: 100 * 2 * LCS / (len(a) + len(b)). */
export function ratio(a, b) {
  const x = Array.from(a ?? ""), y = Array.from(b ?? "");
  const total = x.length + y.length;
  if (total === 0) return 100;
  if (x.length === 0 || y.length === 0) return 0;
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return (100 * 2 * prev[y.length]) / total;
}

/** Like rapidfuzz partial_ratio: how well the shorter string matches the best same-length window of the longer one.
 *  Tolerates stray junk before/after a name ("pat jones" vs "jones"). */
export function partialRatio(a, b) {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (!s.length) return l.length ? 0 : 100;
  if (s.length === l.length) return ratio(s, l);
  let best = 0;
  for (let i = 0; i + s.length <= l.length; i++) best = Math.max(best, ratio(s, l.slice(i, i + s.length)));
  return best;
}

/** Best match of `word` in `names` scoring at least `threshold`: [name|null, score]. */
export function fuzzyMatch(word, names, threshold = 75) {
  if (!word || !names || names.length === 0) return [null, 0];
  let best = null, bestScore = -1;
  for (const n of names) {
    const s = ratio(word, n);
    if (s > bestScore) { best = n; bestScore = s; }   // first best wins on ties
  }
  return bestScore >= threshold ? [best, bestScore] : [null, 0];
}

/** "bernardo silva" -> "Bernardo Silva" (also after - ' ’). */
export function capitalizeName(n) {
  if (!n) return "";
  return String(n).split(" ").map(word =>
    word.split(/(-|'|’)/).map(part =>
      (part === "-" || part === "'" || part === "’") ? part
        : part.length ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part
    ).join("")).join(" ");
}
