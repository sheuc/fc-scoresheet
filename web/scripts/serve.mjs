// Tiny static file server for local testing: node scripts/serve.mjs [port]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.SERVE_DIR ? join(process.cwd(), process.env.SERVE_DIR) : join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".traineddata": "application/octet-stream", ".wasm": "application/wasm" };

export function startServer(port = 8080) {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (p.endsWith("/")) p += "index.html";
      const file = normalize(join(root, p));
      if (!file.startsWith(root + sep) || /[\/](node_modules|tests|scripts)[\/]/.test(file)) { res.writeHead(403).end("forbidden"); return; }
      if (!(await stat(file)).isFile()) throw new Error("not a file");
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
      let body = await readFile(file);
      // Running locally must never talk to the live services (bug-report form, community totals): blank their keys
      // in the page unless explicitly asked to use them (ALLOW_LIVE_SERVICES=1).
      if (extname(file) === ".html" && !process.env.ALLOW_LIVE_SERVICES)
        body = body.toString("utf8").replace(/(<meta name="(?:report-key|community-url)" content=")[^"]*"/g, '$1"');
      res.end(body);
    } catch { res.writeHead(404).end("not found"); }
  });
  return new Promise(resolve => server.listen(port, process.env.HOST || "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2]) || 8080;
  await startServer(port);
  console.log(`http://localhost:${port}/`);
}
