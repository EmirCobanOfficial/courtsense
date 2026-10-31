// Step 3: the local page for hand-marking the players' feet. Listens on 127.0.0.1 only and answers only requests
// addressed to it, so the frames and marks never leave this machine. Marks are saved on every change; a copy is kept
// at every start and before any save that has fewer marks, and a page opened before the last save cannot overwrite it.
// usage (from the repo root): node validate/annotate/pick.ts, then node validate/annotate/server.ts [--port 3461]
import fs from "node:fs";
import http from "node:http";
import { DIR, JOB, LABELS, type Labels, type Manifest } from "./system.ts";

const portArg = process.argv.indexOf("--port");
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 3461;
const HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
const page = fs.readFileSync(new URL("./index.html", import.meta.url));
if (!fs.existsSync(`${DIR}/frames.json`)) throw new Error("no frames yet: run node validate/annotate/pick.ts first");
const manifest = JSON.parse(fs.readFileSync(`${DIR}/frames.json`, "utf8")) as Manifest;
const ids = new Set(manifest.frames.map((x) => x.id));
const files = new Set(manifest.frames.map((x) => x.file));

const BACKUPS = "data/validation/annotate/backups";
type Saved = { updatedAt?: string; labels: Labels };
const read = (): Saved | null => (fs.existsSync(LABELS) ? JSON.parse(fs.readFileSync(LABELS, "utf8")) : null);
const count = (l: Labels) => Object.values(l).reduce((n, m) => n + Object.keys(m).length, 0);
function backup(why: string) {
  fs.mkdirSync(BACKUPS, { recursive: true });
  fs.copyFileSync(LABELS, `${BACKUPS}/annotations-${new Date().toISOString().replace(/[:.]/g, "-")}-${why}.json`);
}
const atStart = read();
if (atStart && count(atStart.labels)) backup("start");

const okMark = (v: unknown) => v === "hidden" || (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n)) && v[0] >= 0 && v[0] <= manifest.width && v[1] >= 0 && v[1] <= manifest.height);
const okLabels = (l: unknown): l is Labels => !!l && typeof l === "object" && Object.entries(l).every(([id, m]) =>
  ids.has(id) && !!m && typeof m === "object" && Object.entries(m).every(([p, v]) => (p === "A" || p === "B") && okMark(v)));

http.createServer((req, res) => {
  const send = (code: number, body: string | Buffer, type = "application/json") => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  };
  // another site pointing its name at 127.0.0.1 (DNS rebinding) must not read the footage
  if (!HOSTS.includes(req.headers.host ?? "")) return send(403, '{"error":"wrong host"}');
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/") return send(200, page, "text/html; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/api/frames") return send(200, JSON.stringify(manifest));
  if (req.method === "GET" && url.pathname.startsWith("/frames/") && files.has(url.pathname.slice(8))) return send(200, fs.readFileSync(`${DIR}/${url.pathname.slice(8)}`), "image/jpeg");
  if (req.method === "GET" && url.pathname === "/api/labels") return send(200, fs.existsSync(LABELS) ? fs.readFileSync(LABELS) : '{"labels":{}}');
  if (req.method === "PUT" && url.pathname === "/api/labels") {
    if (req.headers.origin && !HOSTS.some((h) => req.headers.origin === `http://${h}`)) return send(403, '{"error":"wrong origin"}');
    if (!String(req.headers["content-type"]).startsWith("application/json")) return send(415, '{"error":"send JSON"}');
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      let d: { labels?: unknown; base?: string | null };
      try {
        d = JSON.parse(body);
      } catch {
        return send(400, '{"error":"bad JSON"}');
      }
      const labels = d.labels;
      if (!okLabels(labels)) return send(400, '{"error":"bad marks"}');
      const current = read();
      // base: the version the page last loaded or saved; another tab may have saved newer marks since
      if (d.base !== undefined && (current?.updatedAt ?? null) !== d.base) return send(409, '{"error":"newer marks were saved from another tab: reload this page"}');
      if (current && count(labels) < count(current.labels)) backup("before-removal");
      const updatedAt = new Date().toISOString();
      fs.writeFileSync(`${LABELS}.tmp`, JSON.stringify({ job: JOB, updatedAt, labels }, null, 1) + "\n");
      fs.renameSync(`${LABELS}.tmp`, LABELS); // a crash mid-write cannot leave half a file
      send(200, JSON.stringify({ saved: count(labels), version: updatedAt }));
    });
    return;
  }
  send(404, '{"error":"not found"}');
}).listen(PORT, "127.0.0.1", () => console.log(`open http://127.0.0.1:${PORT}  (marks are saved to ${LABELS})`));
