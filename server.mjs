import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./public/", import.meta.url));
let serverConfig = {};
try {
  serverConfig = JSON.parse(await readFile(new URL("./server-config.json", import.meta.url), "utf8"));
} catch {}
const googleSheetsApiKey = process.env.GOOGLE_SHEETS_API_KEY || serverConfig.googleSheetsApiKey;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const historyFile = resolve(process.env.ACTION_LOG_PATH || fileURLToPath(new URL("./data/action-history.json", import.meta.url)));
const historyLimit = Math.max(100, Math.min(50_000, Number(process.env.ACTION_LOG_MAX_ENTRIES) || 5_000));
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };

let history = [];
let historyWrite = Promise.resolve();

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function cleanText(value, field, maxLength, required = true) {
  if (value == null && !required) return "";
  if (typeof value !== "string") throw new Error(`Поле «${field}» должно быть строкой`);
  const cleaned = value.trim().replace(/[\u0000-\u001f\u007f]/g, " ");
  if (required && !cleaned) throw new Error(`Не заполнено поле «${field}»`);
  if (cleaned.length > maxLength) throw new Error(`Поле «${field}» слишком длинное`);
  return cleaned;
}

function cleanCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000) {
    throw new Error(`Некорректное значение поля «${field}»`);
  }
  return value;
}

function cleanSpreadsheet(value) {
  const suppliedId = cleanText(value.spreadsheetId, "spreadsheetId", 100, false);
  const suppliedUrl = cleanText(value.spreadsheetUrl, "spreadsheetUrl", 500, false);
  let idFromUrl = "";
  if (suppliedUrl) {
    let url;
    try { url = new URL(suppliedUrl); } catch { throw new Error("Некорректная ссылка на Google Таблицу"); }
    if (url.protocol !== "https:" || url.hostname !== "docs.google.com") throw new Error("Допустима только ссылка на Google Таблицу");
    const match = url.pathname.match(/^\/spreadsheets\/d\/([\w-]+)(?:\/|$)/);
    if (!match) throw new Error("Некорректная ссылка на Google Таблицу");
    idFromUrl = match[1];
  }
  const spreadsheetId = suppliedId || idFromUrl;
  if (!/^[\w-]{20,100}$/.test(spreadsheetId)) throw new Error("Некорректный идентификатор Google Таблицы");
  if (idFromUrl && suppliedId && idFromUrl !== suppliedId) throw new Error("Ссылка и идентификатор таблицы не совпадают");
  return {
    spreadsheetId,
    spreadsheetName: cleanText(value.spreadsheetName, "spreadsheetName", 200, false) || spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}

function validateHistoryEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ожидался объект журнала");
  const spreadsheet = cleanSpreadsheet(value);
  const mode = value.mode === "year" ? "year" : value.mode === "month" ? "month" : null;
  if (!mode) throw new Error("Поле «mode» должно быть month или year");
  const year = Number(value.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new Error("Некорректный год");
  const month = mode === "month" ? Number(value.month) : null;
  if (mode === "month" && (!Number.isInteger(month) || month < 1 || month > 12)) throw new Error("Некорректный месяц");
  const status = value.status === "success" ? "success" : value.status === "error" ? "error" : null;
  if (!status) throw new Error("Поле «status» должно быть success или error");

  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...spreadsheet,
    sheetName: cleanText(value.sheetName, "sheetName", 200),
    mode,
    year,
    month,
    status,
    checkedArticles: cleanCount(value.checkedArticles ?? 0, "checkedArticles"),
    issueCount: cleanCount(value.issueCount ?? 0, "issueCount"),
    missingFormulaCount: cleanCount(value.missingFormulaCount ?? 0, "missingFormulaCount"),
    incorrectFormulaCount: cleanCount(value.incorrectFormulaCount ?? 0, "incorrectFormulaCount"),
    durationMs: cleanCount(value.durationMs ?? 0, "durationMs"),
    errorMessage: status === "error" ? cleanText(value.errorMessage, "errorMessage", 300, false) : "",
  };
}

async function readJsonBody(req, maxBytes = 16_384) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) throw new Error("Требуется Content-Type: application/json");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Тело запроса слишком большое");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Некорректный JSON"); }
}

async function saveHistory() {
  await mkdir(dirname(historyFile), { recursive: true });
  const temporaryFile = `${historyFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify({ version: 1, entries: history }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryFile, historyFile);
}

async function loadHistory() {
  try {
    const parsed = JSON.parse(await readFile(historyFile, "utf8"));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("неизвестный формат");
    history = parsed.entries.slice(-historyLimit);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error(`Журнал не загружен (${historyFile}): ${error.message}`);
      return;
    }
    await saveHistory();
  }
}

function getHistoryResponse(limit) {
  const items = history.slice(-limit).reverse();
  const fileIds = new Set(history.map((entry) => entry.spreadsheetId));
  return {
    summary: {
      totalRuns: history.length,
      uniqueFiles: fileIds.size,
      successfulRuns: history.filter((entry) => entry.status === "success").length,
      failedRuns: history.filter((entry) => entry.status === "error").length,
      totalIssues: history.reduce((sum, entry) => sum + (Number(entry.issueCount) || 0), 0),
    },
    items,
  };
}

await loadHistory();

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
  if (pathname === "/api/history") {
    if (req.method === "GET") {
      const incoming = new URL(req.url, "http://localhost");
      const requestedLimit = Number(incoming.searchParams.get("limit") || 100);
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(250, requestedLimit)) : 100;
      sendJson(res, 200, getHistoryResponse(limit)); return;
    }
    if (req.method === "POST") {
      try {
        const entry = validateHistoryEntry(await readJsonBody(req));
        history.push(entry);
        if (history.length > historyLimit) history = history.slice(-historyLimit);
        historyWrite = historyWrite.catch((error) => {
          console.error(`Предыдущая запись журнала не сохранена: ${error.message}`);
        }).then(saveHistory);
        await historyWrite;
        sendJson(res, 201, { entry, summary: getHistoryResponse(1).summary });
      } catch (error) {
        sendJson(res, 400, { error: { message: error.message } });
      }
      return;
    }
    res.writeHead(405, { allow: "GET, POST" }).end("Method not allowed"); return;
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
