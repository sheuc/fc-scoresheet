// Browser-only glue: Tesseract.js worker factory and screenshot decoding.
// (The pipeline itself is environment-agnostic; see pipeline.js.)

const BASE = () => new URL("vendor/tesseract/", document.baseURI).href;

/** Factory for createOcrPool(): Tesseract workers served from our own origin (no CDN, works offline). */
export function makeBrowserWorker() {
  if (!globalThis.Tesseract) throw new Error("Text recognition failed to load. Check your connection and reload.");
  const base = BASE();
  return globalThis.Tesseract.createWorker("eng", 1, {
    workerPath: base + "worker.min.js",
    corePath: base + "core/",       // Tesseract.js picks the SIMD build when the browser supports it
    langPath: base + "lang/",
    gzip: false,
  });
}

/** Tesseract.js takes a Blob in the browser. */
export const toInput = bytes => new Blob([bytes], { type: "image/png" });

/** How many OCR workers to run: half the cores (each holds ~tens of MB of WASM heap), 1-4. */
export function workerCount() {
  return Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
}

/** Decode an image File to RGBA pixels. The embedded colour profile is ignored on purpose:
 *  the colour thresholds were tuned on the raw pixel values (phone screenshots are often Display P3). */
export async function decodeImage(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { colorSpaceConversion: "none" });
  } catch {
    bmp = await createImageBitmap(file);      // browsers without the option
  }
  const { width, height } = bmp;
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const { data } = ctx.getImageData(0, 0, width, height);
  canvas.width = canvas.height = 0;           // release the backing store right away (phones)
  return { data, width, height };
}
