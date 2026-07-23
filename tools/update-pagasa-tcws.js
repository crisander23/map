const fs = require("fs");
const path = require("path");

const PAGASA_URL = "https://pagasa.dost.gov.ph/tropical-cyclone/severe-weather-bulletin";
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

const PROVINCE_ALIASES = {
  "Davao de Oro": "Compostela Valley",
  "Davao del Norte": "Davao del Norte",
  "Davao del Sur": "Davao del Sur",
  "Davao Oriental": "Davao Oriental",
  "Metro Manila": "Metropolitan Manila",
  NCR: "Metropolitan Manila",
};

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlText(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeProvince(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/province of\s+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseIssuedAt(value) {
  const match = String(value || "").match(/(\d{1,2}):(\d{2})\s*(am|pm),?\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  if (!match) return "";
  const hour = Number(match[1]) % 12 + (match[3].toLowerCase() === "pm" ? 12 : 0);
  const month = MONTHS[match[5].toLowerCase()];
  if (month === undefined) return "";
  return `${match[6]}-${String(month + 1).padStart(2, "0")}-${String(Number(match[4])).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${match[2]}:00+08:00`;
}

function nextAdvisoryAt(issuedAt, time, dayWord) {
  if (!issuedAt || !time) return "";
  const match = String(time).match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  const issuedDate = String(issuedAt).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match || !issuedDate) return "";
  const hour = Number(match[1]) % 12 + (match[3].toLowerCase() === "pm" ? 12 : 0);
  const target = new Date(Date.UTC(Number(issuedDate[1]), Number(issuedDate[2]) - 1, Number(issuedDate[3]) + (String(dayWord).toLowerCase() === "tomorrow" ? 1 : 0), hour, Number(match[2])));
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(target.getUTCDate()).padStart(2, "0")}T${String(target.getUTCHours()).padStart(2, "0")}:${String(target.getUTCMinutes()).padStart(2, "0")}:00+08:00`;
}

function extractProvinceNames(text, provinces) {
  const found = new Set();
  const candidates = [
    ...provinces.map((name) => ({ name, canonical: name })),
    ...Object.entries(PROVINCE_ALIASES).map(([name, canonical]) => ({ name, canonical })),
  ].sort((a, b) => b.name.length - a.name.length);

  for (const candidate of candidates) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(candidate.name).replace(/\\ /g, "\\s+")}(?=$|[^a-z0-9])`, "i");
    if (pattern.test(text)) found.add(candidate.canonical);
  }
  return found;
}

function parsePsgProvinceList(basePath = process.cwd()) {
  const mapPath = path.resolve(basePath, "coverage-map.json");
  if (!fs.existsSync(mapPath)) return [];
  try {
    const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
    return [...new Set((map.features || []).flatMap((feature) => feature.ps || [feature.p]).filter(Boolean))];
  } catch (error) {
    return [];
  }
}

function parseBulletin(html, provinces) {
  const activeTab = html.match(/<li[^>]*class=["'][^"']*active[^"']*["'][^>]*>\s*<a[^>]*data-header=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
  const stormHeading = html.match(/<h3\b[^>]*>\s*([\s\S]*?)\s*<\/h3>/i);
  const issuedMatch = html.match(/Issued at\s+(\d{1,2}:\d{2}\s*(?:am|pm)),?\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
  const nextMatch = html.match(/next advisory to be issued at\s+(\d{1,2}:\d{2}\s*(?:am|pm))\s+(today|tomorrow)/i);
  const issuedAt = parseIssuedAt(issuedMatch ? `${issuedMatch[1]}, ${issuedMatch[2]}` : "");
  const signals = {};
  const panelPattern = /<div class=["'][^"']*panel-heading[^"']*["']>\s*Wind Signal\s*<\/div>\s*<div class=["'][^"']*panel-body[^"']*["']>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let panel;
  let panelCount = 0;

  while ((panel = panelPattern.exec(html))) {
    const body = panel[1];
    const signalMatch = body.match(/(?:Tropical Cyclone\s+)?Wind Signal\s*(?:No\.?|number)\s*([1-5])/i);
    if (!signalMatch) continue;
    panelCount += 1;
    const signal = Number(signalMatch[1]);
    const listItems = [...body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => htmlText(match[1]));
    const sourceText = listItems.length ? listItems.join(" ") : htmlText(body);
    for (const province of extractProvinceNames(sourceText, provinces)) {
      signals[province] = Math.max(Number(signals[province] || 0), signal);
    }
  }

  // PAGASA now renders each TCWS section as a table headed by
  // <th class="signalno1">...</th>, rather than the older panel markup.
  // Slice each heading to the next one so we only read its Affected Areas cell.
  if (!panelCount) {
    const signalHeadings = [...html.matchAll(/<th\b[^>]*class=["'][^"']*\bsignalno([1-5])\b[^"']*["'][^>]*>[\s\S]*?<\/th>/gi)];
    signalHeadings.forEach((heading, index) => {
      const sectionStart = heading.index + heading[0].length;
      const sectionEnd = signalHeadings[index + 1]?.index ?? html.length;
      const section = html.slice(sectionStart, sectionEnd);
      const affectedAreas = section.match(/<td\b[^>]*>\s*<strong>\s*Affected Areas\s*<\/strong>\s*<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>/i);
      if (!affectedAreas) return;

      panelCount += 1;
      const signal = Number(heading[1]);
      for (const province of extractProvinceNames(htmlText(affectedAreas[1]), provinces)) {
        signals[province] = Math.max(Number(signals[province] || 0), signal);
      }
    });
  }

  if (!activeTab && !stormHeading) throw new Error("PAGASA active bulletin was not found");
  if (!issuedAt) throw new Error("PAGASA bulletin issue time was not found");
  if (!panelCount) throw new Error("PAGASA Wind Signal panel was not found");

  return {
    bulletin: htmlText(activeTab?.[1] || ""),
    storm: htmlText(activeTab?.[2] || stormHeading?.[1] || ""),
    issuedAt,
    nextAdvisoryAt: nextAdvisoryAt(issuedAt, nextMatch?.[1], nextMatch?.[2]),
    signals,
  };
}

async function fetchPagasaHtml() {
  const response = await fetch(PAGASA_URL, {
    cache: "no-store",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "NEA-DDCC-Map/1.0 (PAGASA TCWS updater)",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`PAGASA bulletin request failed: ${response.status}`);
  return response.text();
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return {};
  }
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.renameSync(tempPath, filePath);
}

function pruneExpiredFlood(current) {
  if (!Array.isArray(current?.floodAlerts)) return current;
  const activeAlerts = current.floodAlerts.filter((alert) => {
    if (!alert?.validUntil) return true;
    const validUntil = new Date(alert.validUntil).getTime();
    return !Number.isFinite(validUntil) || validUntil > Date.now();
  });
  const flood = {};
  activeAlerts.forEach((alert) => {
    const severity = Number(alert?.severity);
    if (!Number.isFinite(severity)) return;
    (alert.areas || []).forEach((province) => {
      const key = normalizeProvince(province);
      if (key) flood[key] = Math.max(Number(flood[key] || 0), severity);
    });
  });
  return { ...current, flood, floodAlerts: activeAlerts };
}

async function updatePagasaTcws({ filePath, fallbackPath } = {}) {
  const outputPath = filePath || path.resolve(process.cwd(), "data", "weather-signals.json");
  const current = pruneExpiredFlood(readJson(fs.existsSync(outputPath) ? outputPath : fallbackPath || outputPath));
  const mapDirectory = fallbackPath ? path.dirname(fallbackPath) : path.join(path.dirname(outputPath), "data");
  const parsed = parseBulletin(await fetchPagasaHtml(), parsePsgProvinceList(mapDirectory));
  const next = {
    ...current,
    source: current.source || "PAGASA TCWS bulletin + PANaHON CAP General Flood Advisory",
    issuedAt: parsed.issuedAt,
    tcwsIssuedAt: parsed.issuedAt,
    tcwsNextAdvisoryAt: parsed.nextAdvisoryAt,
    tcwsUpdateCadence: "Checked every 5 minutes; PAGASA bulletin cadence varies by hazard",
    tcwsBulletin: parsed.bulletin,
    tcwsStorm: parsed.storm,
    tcwsFetchedAt: new Date().toISOString(),
    signals: parsed.signals,
  };
  writeJsonAtomic(outputPath, next);
  return next;
}

async function main() {
  const outputPath = process.env.NEA_DDCC_WEATHER_FILE || path.resolve(process.cwd(), "data", "weather-signals.json");
  const payload = await updatePagasaTcws({ filePath: outputPath });
  console.log(`Updated ${outputPath}: ${Object.keys(payload.signals || {}).length} provinces with active TCWS`);
}

module.exports = { DEFAULT_INTERVAL_MS, PAGASA_URL, updatePagasaTcws };

if (require.main === module) {
  main().catch((error) => {
    console.error(`PAGASA TCWS update failed: ${error.message}`);
    process.exitCode = 1;
  });
}
