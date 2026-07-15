const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { DEFAULT_INTERVAL_MS, updatePagasaTcws } = require("./tools/update-pagasa-tcws");

const root = process.pkg ? __dirname : process.cwd();
const appDirectory = process.pkg ? path.dirname(process.execPath) : process.cwd();
const bundledWeatherPath = path.join(root, "data", "weather-signals.json");
const weatherPath = path.join(appDirectory, "data", "weather-signals.json");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const apiCache = new Map();
let pagasaWeather = readJsonFile(weatherPath) || readJsonFile(bundledWeatherPath) || {};

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

async function refreshPagasaWeather() {
  try {
    pagasaWeather = await updatePagasaTcws({ filePath: weatherPath, fallbackPath: bundledWeatherPath });
    console.log("PAGASA TCWS refreshed at " + pagasaWeather.tcwsFetchedAt);
  } catch (error) {
    console.warn("PAGASA TCWS refresh failed: " + error.message);
  }
}

async function cachedApiResponse(key, ttlMs, loader) {
  const now = Date.now();
  const cached = apiCache.get(key);
  if (cached?.value && now - cached.createdAt < ttlMs) {
    return cached.value;
  }
  if (cached?.promise) {
    return cached.promise;
  }

  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      apiCache.set(key, { value, createdAt: Date.now() });
      return value;
    })
    .finally(() => {
      const current = apiCache.get(key);
      if (current?.promise === promise) {
        apiCache.set(key, { value: current.value, createdAt: current.createdAt });
      }
    });

  apiCache.set(key, { value: cached?.value, createdAt: cached?.createdAt || 0, promise });
  return promise;
}

function sendJson(res, status, payload, cacheControl = "no-store") {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cacheControl, "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(payload));
}

async function earthquakeProxy(res) {
  try {
    const payload = await cachedApiResponse("phivolcs-earthquakes", 60_000, async () => {
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
      return response.json();
    });
    sendJson(res, 200, payload, "public, max-age=30, stale-while-revalidate=60");
  } catch (error) {
    sendJson(res, 502, { success: false, message: error.message, data: [] });
  }
}

async function scadaProxy(res) {
  try {
    const payload = await cachedApiResponse("scada-alarms", 30_000, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const response = await fetch("http://26.8.239.167:3010/api/dashboard/retrieve-scada-alarms", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("SCADA request failed: " + response.status);
        const sourcePayload = await response.json();
        const rows = Array.isArray(sourcePayload) ? sourcePayload : (sourcePayload.data || sourcePayload.records || sourcePayload.results || sourcePayload.alarms || []);
        const latestByEc = new Map();
        rows.forEach((row) => {
          const ec = row?.EC_CODE || row?.ec_code || row?.ecCode || row?.ECCODE;
          if (!ec) return;
          const previous = latestByEc.get(String(ec).toUpperCase());
          const currentTime = new Date(row.RECORD_TIMESTAMP || row.time || 0).getTime();
          const previousTime = new Date(previous?.RECORD_TIMESTAMP || previous?.time || 0).getTime();
          if (!previous || currentTime >= previousTime) latestByEc.set(String(ec).toUpperCase(), row);
        });
        return Array.from(latestByEc.values()).filter((row) => {
          const level = Number(row?.level ?? row?.LEVEL ?? row?.scada_level ?? row?.alarm_level);
          return level === 4 || level === 5;
        });
      } finally {
        clearTimeout(timer);
      }
    });
    sendJson(res, 200, payload, "public, max-age=15, stale-while-revalidate=30");
  } catch (error) {
    sendJson(res, 502, { success: false, message: error.name === "AbortError" ? "SCADA request timed out" : error.message, data: [] });
  }
}

async function outageProxy(res) {
  try {
    const payload = await cachedApiResponse("outages", 60_000, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch("http://26.8.239.167:3010/api/dashboard/retrieve-unscheduled-interruptions", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Outage request failed: " + response.status);
        const sourcePayload = await response.json();
        if (sourcePayload?.success === false) throw new Error(sourcePayload.message || "Outage API returned an error");
        return Array.isArray(sourcePayload)
          ? sourcePayload
          : (sourcePayload?.data || sourcePayload?.records || sourcePayload?.results || sourcePayload?.interruptions || []);
      } finally {
        clearTimeout(timer);
      }
    });
    sendJson(res, 200, payload, "public, max-age=30, stale-while-revalidate=60");
  } catch (error) {
    sendJson(res, 502, { success: false, message: error.name === "AbortError" ? "Outage request timed out" : error.message, data: [] });
  }
}

function pagasaWeatherProxy(res) {
  sendJson(res, 200, pagasaWeather, "public, max-age=30, stale-while-revalidate=60");
}

function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const filePath = path.resolve(root, relative);
  if (!filePath.startsWith(root + path.sep) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end("Not found"); return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  const etag = `"${stat.size}-${stat.mtimeMs}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }
  const cacheControl = requested.endsWith(".html")
    ? "no-store"
    : ext === ".json"
      ? "public, max-age=3600, stale-while-revalidate=86400"
      : [".png", ".jpg", ".svg", ".ico"].includes(ext)
        ? "public, max-age=86400, stale-while-revalidate=604800"
        : "public, max-age=600, stale-while-revalidate=3600";
  res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream", "Cache-Control": cacheControl, ETag: etag, "Last-Modified": stat.mtime.toUTCString() });
  fs.createReadStream(filePath).pipe(res);
}

function openPackagedMap() {
  if (!process.pkg || process.env.NEA_DDCC_NO_OPEN === "1") return;
  const url = `http://127.0.0.1:${port}/`;
  const command = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(command);
}

http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); res.end(); return; }
  if (req.method === "GET" && req.url.split("?")[0] === "/api/phivolcs-earthquakes") { earthquakeProxy(res); return; }
  if (req.method === "GET" && req.url.split("?")[0] === "/api/scada-alarms") { scadaProxy(res); return; }
  if (req.method === "GET" && req.url.split("?")[0] === "/api/outages") { outageProxy(res); return; }
  if (req.method === "GET" && req.url.split("?")[0] === "/api/pagasa-weather") { pagasaWeatherProxy(res); return; }
  serveStatic(req, res);
}).listen(port, host, () => {
  console.log("Map server listening on " + host + ":" + port);
  refreshPagasaWeather();
  const refreshTimer = setInterval(refreshPagasaWeather, DEFAULT_INTERVAL_MS);
  refreshTimer.unref?.();
  openPackagedMap();
});
