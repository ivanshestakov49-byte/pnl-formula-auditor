import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./public/", import.meta.url));
let serverConfig = {};
try {
  serverConfig = JSON.parse(await readFile(new URL("./server-config.json", import.meta.url), "utf8"));
} catch {}
const googleSheetsApiKey = process.env.GOOGLE_SHEETS_API_KEY || serverConfig.googleSheetsApiKey;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };

createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("Bad request"); return;
  }
  if (pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok" })); return;
  }
  if (pathname.startsWith("/api/sheets/")) {
    try {
      if (!googleSheetsApiKey) throw new Error("На сервере не настроен ключ Google Sheets API");
      const upstreamPath = pathname.slice("/api/sheets/".length);
      if (!/^[\w-]+(?:\/values\/.+)?$/.test(upstreamPath) || upstreamPath.includes("..")) throw new Error("Некорректный запрос");
      const incoming = new URL(req.url, "http://localhost");
      incoming.searchParams.set("key", googleSheetsApiKey);
      const upstream = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${upstreamPath}?${incoming.searchParams}`);
      const body = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(body); return;
    } catch (error) { res.writeHead(400, {"content-type":"application/json"}).end(JSON.stringify({error:{message:error.message}})); return; }
  }
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(root, relative));
  if (!file.startsWith(root)) { res.writeHead(403).end("Forbidden"); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch { res.writeHead(404).end("Not found"); }
}).listen(port, host, () => console.log(`Проверка формул ПНЛ: http://${host}:${port}`));
