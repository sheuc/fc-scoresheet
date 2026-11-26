// A small pool of Tesseract.js workers. Environment-agnostic: the caller supplies `makeWorker`
// (browser and Node construct Tesseract.js workers differently) and, optionally, `toInput`
// (browser: bytes -> Blob).
//
// Work is submitted one *field type* at a time (all names, then all minutes, ...). Each worker
// applies that field's recogniser settings once per batch.
import { encodeGrayPng } from "./vision.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -'.";

// psm 7 = single text line, 8 = single word. An empty whitelist means "no restriction".
//   name   ASCII only: avoids accent mojibake, and the game's accents don't matter (names are normalised)
//   minute digits, ' and +
//   score  digits
/** Letters Tesseract answers for digit shapes -> the digit. */
export const LOOKALIKE_MAP = { O: 0, o: 0, D: 0, Q: 0, I: 1, l: 1, "|": 1, Z: 2, z: 2, S: 5, s: 5, G: 6, b: 6, B: 8, g: 9, q: 9 };

export const FIELDS = {
  name:   { psm: "7", whitelist: LETTERS },
  minute: { psm: "7", whitelist: "0123456789'+ " },
  score:  { psm: "8", whitelist: "0123456789" },
  // New screen: its "0" is a perfect ring that Tesseract only sees as a letter, so a digits-only
  // whitelist returns nothing. Let it answer O/o/D/Q and map those back to 0 (pipeline.js).
  score_ring: { psm: "8", whitelist: "0123456789OoDQ" },
  // The same two score readers in single-character mode: the retry when a line read finds no digit at all (a clear "4"
  // came back empty on a JPEG-recompressed screenshot, where PSM 10 reads it).
  score1: { psm: "10", whitelist: "0123456789" },
  score_ring1: { psm: "10", whitelist: "0123456789OoDQ" },
  // One glyph at a time: fallback for minutes whose repeated thin digits ("11'") collapse in a line read.
  glyph:  { psm: "10", whitelist: "0123456789" },
  opp:    { psm: "7", whitelist: "" },
  // Match-stat cells: "6(6)" shots (on target), "65%" possession / pass accuracy, "0" fouls / offsides
  stat:   { psm: "7", whitelist: "0123456789()%" },
  // A group of digits cut out of a stat cell (brackets / % sign removed), or a single one. Deliberately NO whitelist:
  // on these clean crops a digits-only whitelist makes Tesseract return nothing for some perfectly clear digits
  // (a "6" it takes for a "G"), while unconstrained it reads them. Letters it answers for digit shapes are mapped
  // back with digitsFrom(), anything else is dropped.
  digits: { psm: "7", whitelist: "" },
  digit1: { psm: "10", whitelist: "" },
  // ...but the constrained readers get it right where the unconstrained ones fail, so both vote (statsread.js)
  digitsWL: { psm: "7", whitelist: "0123456789" },
  digit1WL: { psm: "10", whitelist: "0123456789" },
};

/** "6O" / "G0" -> "60": keep digits, map look-alike letters, drop everything else. */
export function digitsFrom(text) {
  return Array.from(String(text ?? ""), c => (/\d/.test(c) ? c : c in LOOKALIKE_MAP ? String(LOOKALIKE_MAP[c]) : "")).join("");
}

export async function createOcrPool({ makeWorker, size = 3, toInput = b => b }) {
  const workers = [];
  await Promise.all(Array.from({ length: size }, async () => {
    workers.push({ worker: await makeWorker(), field: null });
  }));

  /** Recognise gray images {data,w,h} with a field's settings. -> [{text, conf}] in input order. */
  async function recognize(field, images, onItem) {
    const cfg = FIELDS[field];
    if (!cfg) throw new Error(`unknown OCR field: ${field}`);
    const results = new Array(images.length);
    let next = 0, done = 0;
    await Promise.all(workers.map(async w => {
      if (w.field !== field) {
        // No adaptive learning: otherwise what a worker read earlier changes what it reads next, and since crops are
        // handed to whichever worker is free, the same screenshot could read differently from one scan to the next.
        await w.worker.setParameters({ tessedit_pageseg_mode: cfg.psm, tessedit_char_whitelist: cfg.whitelist,
                                       classify_enable_learning: "0", classify_enable_adaptive_matcher: "0" });
        w.field = field;
      }
      while (next < images.length) {
        const i = next++;
        const { data } = await w.worker.recognize(toInput(encodeGrayPng(images[i])));
        results[i] = { text: String(data.text || "").replace(/\s+/g, " ").trim(), conf: data.confidence };
        if (onItem) onItem(++done, images.length);
      }
    }));
    return results;
  }

  return {
    recognize,
    size,
    terminate: () => Promise.all(workers.map(w => w.worker.terminate())),
  };
}
