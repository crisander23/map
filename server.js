const http = require("http");
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(payload));
}

async function earthquakeProxy(res) {
  try {
    const tokenResponse = await fetch("https://hazardhunter.georisk.gov.ph/passport-token", { cache: "no-store" });
    if (!tokenResponse.ok) throw new Error("HazardHunter token request failed: " + tokenResponse.status);
    const token = await tokenResponse.json();
    const today = new Date().toISOString().slice(0, 10);
    const form = new URLSearchParams({ datestart: today, dateend: today, magnitude: "0", depth: "all", month_year: "" });
    const response = await fetch("https://api.georisk.gov.ph/api/v2/earthquake/scraping", {
      method: "POST",
      headers: { Authorization: "Bearer " + token.access_token, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      cache: "no-store",
    });
    if (!response.ok) throw new Error("PHIVOLCS earthquake request failed: " + response.status);
    sendJson(res, 200, await response.json());
  } catch (error) {
    sendJson(res, 502, { success: false, message: error.message, data: [] });
  }
}

async function scadaProxy(res) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const response = await fetch("http://26.8.239.167:3010/api/dashboard/retrieve-scada-alarms", { cache: "no-store", signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error("SCADA request failed: " + response.status);
    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload : (payload.data || payload.records || payload.results || []);
    const latestByEc = new Map();
    rows.forEach((row) => {
      const ec = row?.EC_CODE || row?.ec_code || row?.ecCode || row?.ECCODE;
      if (!ec) return;
      const previous = latestByEc.get(String(ec).toUpperCase());
      const currentTime = new Date(row.RECORD_TIMESTAMP || row.time || 0).getTime();
      const previousTime = new Date(previous?.RECORD_TIMESTAMP || previous?.time || 0).getTime();
      if (!previous || currentTime >= previousTime) latestByEc.set(String(ec).toUpperCase(), row);
    });
    const latestLevel45 = Array.from(latestByEc.values()).filter((row) => {
      const level = Number(row?.level ?? row?.LEVEL ?? row?.scada_level ?? row?.alarm_level);
      return level === 4 || level === 5;
    });
    sendJson(res, 200, latestLevel45);
  } catch (error) {
    sendJson(res, 502, { success: false, message: error.name === "AbortError" ? "SCADA request timed out" : error.message, data: [] });
  }
}
function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const filePath = path.resolve(root, relative);
  if (!filePath.startsWith(root + path.sep) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end("Not found"); return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream", "Cache-Control": requested.endsWith(".html") ? "no-store" : "public, max-age=300" });
  fs.createReadStream(filePath).pipe(res);
}

http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); res.end(); return; }
  if (req.method === "GET" && req.url.split("?")[0] === "/api/phivolcs-earthquakes") { earthquakeProxy(res); return; }
  if (req.method === "GET" && req.url.split("?")[0] === "/api/scada-alarms") { scadaProxy(res); return; }
  serveStatic(req, res);
}).listen(port, "127.0.0.1", () => console.log("Map server listening on http://127.0.0.1:" + port));