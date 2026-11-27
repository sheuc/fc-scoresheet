// Produces dist/: exactly the static files the site needs (no tests, no node_modules).
// Deploy dist/ to GitHub Pages, Netlify, Vercel, Cloudflare Pages, ... (any static host).
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
if (!existsSync(join(root, "vendor", "tesseract", "lang", "eng.traineddata"))) {
  throw new Error("vendor/ is missing. Run: npm install && npm run vendor");
}
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const f of ["index.html", "styles.css", "sw.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "js", "vendor", "fonts"]) {
  cpSync(join(root, f), join(dist, f), { recursive: true });
}
console.log("dist/ ready");
