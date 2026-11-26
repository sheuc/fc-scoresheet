// Copies the browser builds of Tesseract.js / ExcelJS and the English model into vendor/,
// so the site is fully static (no CDN at runtime; works offline after the first visit).
// Run: npm run vendor
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = (p) => join(root, "node_modules", p);
const out = (p) => join(root, "vendor", p);

// The accuracy validated in the spike was measured with exactly this model file.
const ENG_SHA256 = "5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747";

mkdirSync(out("tesseract/core"), { recursive: true });
mkdirSync(out("tesseract/lang"), { recursive: true });
mkdirSync(out("exceljs"), { recursive: true });

cpSync(nm("tesseract.js/dist/tesseract.min.js"), out("tesseract/tesseract.min.js"));
cpSync(nm("tesseract.js/dist/worker.min.js"), out("tesseract/worker.min.js"));
// Tesseract.js picks the SIMD build when the browser supports it, else the plain one (LSTM-only builds).
for (const f of ["tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"])
  cpSync(nm(`tesseract.js-core/${f}`), out(`tesseract/core/${f}`));

const eng = gunzipSync(readFileSync(nm("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz")));
const sha = createHash("sha256").update(eng).digest("hex");
if (sha !== ENG_SHA256) throw new Error(`eng.traineddata checksum mismatch: ${sha}`);
writeFileSync(out("tesseract/lang/eng.traineddata"), eng);

cpSync(nm("exceljs/dist/exceljs.min.js"), out("exceljs/exceljs.min.js"));
console.log("vendor/ ready");
