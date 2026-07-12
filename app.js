const state = {
  data: null,
  weather: null,
  mode: "ec",
  labelsVisible: true,
  outages: {
    records: [],
    byEc: new Map(),
    loadedAt: null,
    error: null,
  },
  canvas: null,
  ctx: null,
  dpr: 1,
  width: 0,
  height: 0,
  bounds: null,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  dragging: false,
  dragStart: null,
  hovered: null,
  selected: null,
  selectionLift: 0,
  selectionPulse: 0,
  viewAnimation: 0,
  weatherSelectionPulse: 0,
  weatherSelectionAnimation: 0,
  weatherLayer: "tcws",
  temperatureByFeature: new Map(),
  temperatureUpdatedAt: "",
  rainfallByFeature: new Map(),
  rainfallUpdatedAt: "",
  filters: {
    search: "",
    province: "",
    ec: "",
  },
  visibleFeatures: [],
  visibleLabels: [],
  raf: null,
  windTimer: null,
  windPhase: 0,
  windy: {
    initialized: false,
    initializing: false,
    api: null,
    map: null,
    layers: new Map(),
    labels: [],
  },
};

const els = {};
const THEME_STORAGE_KEY = "ec-coverage-theme";
const LABELS_STORAGE_KEY = "ec-coverage-labels-visible";
const PET_VISIBILITY_STORAGE_KEY = "ec-coverage-mascot-visible";
const PET_ASSETS = {
  ec: "assets/pet/watt-pixel-ec.png",
  outages: "assets/pet/watt-pixel-outage.png",
  weather: "assets/pet/watt-pixel-weather.png",
  retreat: "assets/pet/watt-pixel-retreat.png",
};
const PET_GUIDES = {
  ec: {
    title: "What is EC mode?",
    text: "Explore electric cooperative coverage, select an EC, and inspect its latest status and service area.",
  },
  weather: {
    title: "What is Weather mode?",
    text: "See weather-related signals and TCWS coverage so you can understand conditions affecting each area.",
  },
  outages: {
    title: "What is Outage mode?",
    text: "Track the latest interruption report per EC. Colors show ongoing, restored, or no recent report.",
  },
};
let petHideTimer = null;
let petUserHidden = false;
let petModeHidden = false;
let splashStartedAt = performance.now();
let splashHideTimer = null;

const palette = [
  "#22c55e",
  "#38bdf8",
  "#a78bfa",
  "#f59e0b",
  "#84cc16",
  "#fb7185",
  "#60a5fa",
  "#facc15",
  "#818cf8",
  "#2dd4bf",
  "#f97316",
  "#4ade80",
];

const signalPalette = {
  0: {
    fill: "#243447",
    stroke: "rgba(148,163,184,0.52)",
    label: "No signal",
  },
  1: {
    fill: "#facc15",
    stroke: "rgba(254,240,138,0.92)",
    label: "Signal 1",
  },
  2: {
    fill: "#f97316",
    stroke: "rgba(253,186,116,0.95)",
    label: "Signal 2",
  },
  3: {
    fill: "#ef4444",
    stroke: "rgba(252,165,165,0.98)",
    label: "Signal 3",
  },
  4: {
    fill: "#c026d3",
    stroke: "rgba(240,171,252,0.98)",
    label: "Signal 4",
  },
  5: {
    fill: "#7c3aed",
    stroke: "rgba(196,181,253,0.98)",
    label: "Signal 5",
  },
};

const outagePalette = {
  ongoing: {
    fill: "#ef4444",
    stroke: "#fecaca",
    label: "Ongoing",
  },
  restored: {
    fill: "#22c55e",
    stroke: "#bbf7d0",
    label: "Restored",
  },
  none: {
    fill: "#64748b",
    stroke: "#cbd5e1",
    label: "No recent report",
  },
};

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function hashString(value) {
  let hash = 0;

  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }

  return Math.abs(hash);
}

function colorForEc(ec) {
  return palette[hashString(ec) % palette.length];
}

function isLightTheme() {
  return document.body.dataset.theme === "light";
}

function setTheme(theme, persist = true) {
  const nextTheme = theme === "light" ? "light" : "dark";
  document.body.dataset.theme = nextTheme;

  if (persist) {
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  }

  if (els.themeToggle) {
    const lightMode = nextTheme === "light";
    const label = lightMode ? "Use dark mode" : "Use light mode";
    els.themeToggle.setAttribute("aria-label", label);
    els.themeToggle.setAttribute("title", label);
    els.themeToggle.setAttribute("aria-pressed", String(lightMode));
  }

  scheduleDraw();
}

function initializeTheme() {
  let savedTheme = "dark";

  try {
    savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY) || "dark";
  } catch (error) {
    savedTheme = "dark";
  }

  setTheme(savedTheme, false);
}

function setLabelsVisible(visible, persist = true) {
  state.labelsVisible = Boolean(visible);

  if (persist) {
    window.localStorage.setItem(
      LABELS_STORAGE_KEY,
      String(state.labelsVisible)
    );
  }

  if (els.labelsToggle) {
    const label = state.labelsVisible
      ? "Hide map labels"
      : "Show map labels";
    els.labelsToggle.classList.toggle(
      "is-off",
      !state.labelsVisible
    );
    els.labelsToggle.setAttribute("aria-label", label);
    els.labelsToggle.setAttribute("title", label);
    els.labelsToggle.setAttribute(
      "aria-pressed",
      String(state.labelsVisible)
    );
  }

  if (state.windy.initialized) {
    addWindyLabels();
  }

  scheduleDraw();
}

function initializeLabels() {
  let savedValue = "true";

  try {
    savedValue = window.localStorage.getItem(LABELS_STORAGE_KEY) || "true";
  } catch (error) {
    savedValue = "true";
  }

  setLabelsVisible(savedValue !== "false", false);
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

function clampSignal(value) {
  const signal = Number(value);

  if (!Number.isFinite(signal)) {
    return 0;
  }

  return Math.max(0, Math.min(5, Math.trunc(signal)));
}

function prepareWeatherSignals() {
  const signals = state.weather?.signals || {};
  const flood = state.weather?.flood || {};
  const temperature = state.weather?.temperature || {};
  const normalized = {};

  Object.entries(signals).forEach(([province, signal]) => {
    normalized[normalizeProvince(province)] = clampSignal(signal);
  });

  state.weather = {
    source: state.weather?.source || "No weather source loaded",
    issuedAt:
      state.weather?.issuedAt || "No TCWS bulletin timestamp loaded",
    tcwsIssuedAt:
      state.weather?.tcwsIssuedAt || state.weather?.issuedAt || "",
    tcwsNextAdvisoryAt: state.weather?.tcwsNextAdvisoryAt || "",
    tcwsUpdateCadence:
      state.weather?.tcwsUpdateCadence ||
      "Every 6 hours; hourly updates when needed",
    signals,
    normalized,
    flood,
    temperature,
    floodIssuedAt: state.weather?.floodIssuedAt || "",
    floodAlerts: state.weather?.floodAlerts || [],
  };

  if (els.weatherStatus) {
    els.weatherStatus.textContent = weatherStatusText();
  }
  if (els.tcwsTimestamp) {
    els.tcwsTimestamp.textContent = "Bulletin issued: " + formatOutageDate(state.weather.tcwsIssuedAt);
  }
  if (els.tcwsCadence) {
    const next = state.weather.tcwsNextAdvisoryAt ? " · Next scheduled: " + formatOutageDate(state.weather.tcwsNextAdvisoryAt) : "";
    els.tcwsCadence.textContent = state.weather.tcwsUpdateCadence + next;
  }
}

function signalForProvince(province) {
  return (
    state.weather?.normalized?.[normalizeProvince(province)] || 0
  );
}

function signalForFeature(feature) {
  return (feature.ps || [feature.p]).reduce(
    (maxSignal, province) => {
      return Math.max(
        maxSignal,
        signalForProvince(province)
      );
    },
    0
  );
}

function signalLabel(signal) {
  return signalPalette[signal]?.label || "No signal";
}

function withAlpha(hex, alpha) {
  const clean = hex.replace("#", "");

  const value = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");

  return `#${clean}${value}`;
}

function initElements() {
  [
    "splashScreen",
    "sidebar",
    "sidebarToggle",
    "sidebarBrandToggle",
    "signalLegend",
    "weatherLegendTitle",
    "tcwsTimestamp",
    "tcwsCadence",
    "outageLegend",
    "mapCanvas",
    "windy",
    "tooltip",
    "visibleCount",
    "searchInput",
    "provinceSelect",
    "ecSelect",
    "modeEc",
    "modeWeather",
    "modeOutages",
    "weatherStatus",
    "weatherLayerSwitch",
    "zoomOutButton",
    "zoomInButton",
    "centerButton",
    "labelsToggle",
    "themeToggle",
    "detailPanel",
    "petOverlay",
    "detailPet",
    "petBubble",
    "petBubbleTitle",
    "petBubbleText",
    "petBubbleClose",
    "petBubbleHide",
    "petRestoreButton",
    "detailClose",
    "detailMode",
    "detailProvince",
    "detailProvinceCount",
    "detailEc",
    "detailStatus",
    "detailStatusTag",
    "detailSignal",
    "detailSignalLabel",
    "detailSignalHint",
    "detailProvinceCountLabel",
    "detailProvinceCountHint",
    "detailProvinceLabel",
    "detailSource",
    "detailUpdated",
    "coordLon",
    "coordLat",
    "zoomReadout",
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });

  state.canvas = els.mapCanvas;
  state.ctx = state.canvas.getContext("2d");
}

function renderSplashCoverageMap() {
  const group = document.getElementById("splashCoverageShapes");
  if (!group || !state.data?.features?.length || !state.bounds) {
    return;
  }

  const [minLon, minLat, maxLon, maxLat] = state.bounds;
  const width = 220;
  const height = 350;
  const left = 50;
  const top = 24;
  const lonSpan = maxLon - minLon || 1;
  const latSpan = maxLat - minLat || 1;
  const projectSplashPoint = ([lon, lat]) => [
    left + ((lon - minLon) / lonSpan) * width,
    top + ((maxLat - lat) / latSpan) * height,
  ];

  const pathData = (feature) =>
    (feature.g || [])
      .map((polygon) =>
        polygon
          .map((ring) => {
            const commands = ring.map((point, index) => {
              const [x, y] = projectSplashPoint(point);
              return `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
            });
            return commands.length ? `${commands.join(" ")} Z` : "";
          })
          .join(" ")
      )
      .join(" ");

  const svgNamespace = "http://www.w3.org/2000/svg";
  const paths = state.data.features
    .map((feature) => {
      const d = pathData(feature);
      if (!d) {
        return null;
      }
      const path = document.createElementNS(svgNamespace, "path");
      path.setAttribute("d", d);
      path.classList.add("splash-generated-path");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      path.setAttribute("stroke", "rgba(210, 255, 239, 0.62)");
      path.setAttribute("stroke-width", "0.22");
      return path;
    })
    .filter(Boolean);

  group.replaceChildren(...paths);
  const signals = document.getElementById("splashSignals");
  if (signals) {
    signals.hidden = true;
  }
}

function hideSplashScreen() {
  if (!els.splashScreen || els.splashScreen.hidden) {
    return;
  }

  const minimumDuration = 1100;
  const elapsed = performance.now() - splashStartedAt;
  const wait = Math.max(0, minimumDuration - elapsed);

  window.clearTimeout(splashHideTimer);
  splashHideTimer = window.setTimeout(() => {
    els.splashScreen.classList.add("is-leaving");
    window.setTimeout(() => {
      els.splashScreen.hidden = true;
    }, 560);
  }, wait);
}

function resizeCanvas() {
  const rect = state.canvas.getBoundingClientRect();
  const panelRect = state.canvas.parentElement?.getBoundingClientRect();

  state.dpr = window.devicePixelRatio || 1;
  state.width = Math.max(1, rect.width || panelRect?.width || 1);
  state.height = Math.max(1, rect.height || panelRect?.height || 1);

  state.canvas.width = Math.round(
    state.width * state.dpr
  );

  state.canvas.height = Math.round(
    state.height * state.dpr
  );

  state.ctx.setTransform(
    state.dpr,
    0,
    0,
    state.dpr,
    0,
    0
  );

  if (state.data) {
    fitToBounds(false);
  }

  if (state.windy.map) {
    state.windy.map.invalidateSize();
  }

  if (state.selected) {
    positionPetOverlay();
  }

  scheduleDraw();
}

function normalizeOutageEc(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, " ")
    .replace(/\bA\s*(\d+)\b/g, "AREA $1")
    .replace(/\bAREA\s*(\d+)\b/g, "AREA $1")
    .replace(/\s+/g, " ")
    .trim();
}

function outageForFeature(feature) {
  return state.outages.byEc.get(normalizeOutageEc(feature?.e)) || null;
}

function latestOutageForFeature(feature) {
  return outageForFeature(feature)?.latest || null;
}

function outageStatusKey(record) {
  const status = String(record?.status || "")
    .trim()
    .toLowerCase();

  if (status.includes("ongoing") || status.includes("active")) {
    return "ongoing";
  }

  if (status.includes("restored") || status.includes("restore")) {
    return "restored";
  }

  return "none";
}

function outageStyleFor(record) {
  return outagePalette[outageStatusKey(record)] || outagePalette.none;
}

function formatOutageDate(value) {
  if (!value) {
    return "Time unavailable";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function prepareOutages(records) {
  const byEc = new Map();

  (Array.isArray(records) ? records : []).forEach((record) => {
    const key = normalizeOutageEc(record?.EC_CODE);

    if (!key) {
      return;
    }

    const existing = byEc.get(key) || {
      latest: null,
      count: 0,
      records: [],
    };

    existing.count += 1;
    existing.records.push(record);

    const currentTime = new Date(record?.RECORD_TIMESTAMP || 0).getTime();
    const existingTime = new Date(existing.latest?.RECORD_TIMESTAMP || 0).getTime();

    if (!existing.latest || currentTime >= existingTime) {
      existing.latest = record;
    }

    byEc.set(key, existing);
  });

  state.outages.records = Array.isArray(records) ? records : [];
  state.outages.byEc = byEc;
  state.outages.loadedAt = new Date();
  state.outages.error = null;
}

function worldSize() {
  const [minx, miny, maxx, maxy] = state.bounds;

  return {
    lon: maxx - minx,
    lat: maxy - miny,
  };
}

function project(lon, lat) {
  const [minx, miny, , maxy] = state.bounds;

  const size = worldSize();

  return {
    x:
      (lon - minx) * state.scale +
      state.offsetX,

    y:
      (maxy - lat) * state.scale +
      state.offsetY,

    rawX: lon - minx,
    rawY: maxy - lat,
    worldW: size.lon,
    worldH: size.lat,
  };
}

function screenToLonLat(x, y) {
  const [minx, , , maxy] = state.bounds;

  return {
    lon:
      (x - state.offsetX) /
        state.scale +
      minx,

    lat:
      maxy -
      (y - state.offsetY) /
        state.scale,
  };
}

function fitToBounds(animate = true) {
  if (!state.bounds) {
    return;
  }

  const target = getFitToBoundsView();

  state.scale = target.scale;
  state.offsetX = target.offsetX;
  state.offsetY = target.offsetY;

  updateZoomReadout();

  if (animate) {
    scheduleDraw();
  }
}

function getFitToBoundsView() {
  const size = worldSize();
  const padding = state.width < 700 ? 28 : 58;
  const sx = (state.width - padding * 2) / size.lon;
  const sy = (state.height - padding * 2) / size.lat;
  const scale = Math.max(1, Math.min(sx, sy));

  return {
    scale,
    offsetX: (state.width - size.lon * scale) / 2,
    offsetY: (state.height - size.lat * scale) / 2,
  };
}

function animateCanvasToBounds() {
  if (!state.bounds) {
    return;
  }

  const start = {
    scale: state.scale,
    offsetX: state.offsetX,
    offsetY: state.offsetY,
  };
  const target = getFitToBoundsView();
  const startedAt = performance.now();
  const duration = 520;
  const animationId = ++state.viewAnimation;

  function frame(now) {
    if (animationId !== state.viewAnimation) {
      return;
    }

    const progress = Math.min(
      1,
      (now - startedAt) / duration
    );
    const eased = 1 - Math.pow(1 - progress, 3);

    state.scale =
      start.scale +
      (target.scale - start.scale) * eased;
    state.offsetX =
      start.offsetX +
      (target.offsetX - start.offsetX) * eased;
    state.offsetY =
      start.offsetY +
      (target.offsetY - start.offsetY) * eased;

    updateZoomReadout();
    scheduleDraw();

    if (progress < 1) {
      requestAnimationFrame(frame);
    }
  }

  requestAnimationFrame(frame);
}

function populateControls() {
  const { filters } = state.data;

  filters.provinces.forEach(
    (province) => {
      const option =
        document.createElement("option");

      option.value = province;
      option.textContent = province;

      els.provinceSelect.appendChild(
        option
      );
    }
  );

  filters.ecs.forEach((ec) => {
    const option =
      document.createElement("option");

    option.value = ec;
    option.textContent = ec;

    els.ecSelect.appendChild(option);
  });
}

function isSelectableFeature(feature) {
  return Boolean(feature) && feature.e !== "N/A" && feature.e !== "#N/A";
}

function featureMatches(feature) {
  if (
    state.filters.province &&
    !(feature.ps || [feature.p]).includes(
      state.filters.province
    )
  ) {
    return false;
  }

  if (
    state.filters.ec &&
    feature.e !== state.filters.ec
  ) {
    return false;
  }

  if (state.filters.search) {
    const haystack = `
      ${feature.e}
      ${feature.p}
      ${(feature.ps || []).join(" ")}
    `.toLowerCase();

    if (
      !haystack.includes(
        state.filters.search
      )
    ) {
      return false;
    }
  }

  return true;
}

function labelMatches(label) {
  if (
    state.filters.province &&
    !(label.ps || [label.p]).includes(
      state.filters.province
    )
  ) {
    return false;
  }

  if (
    state.filters.ec &&
    label.e !== state.filters.ec
  ) {
    return false;
  }

  if (state.filters.search) {
    const haystack = `
      ${label.e}
      ${label.p}
      ${(label.ps || []).join(" ")}
    `.toLowerCase();

    if (
      !haystack.includes(
        state.filters.search
      )
    ) {
      return false;
    }
  }

  return true;
}

function hasActiveFilters() {
  return Boolean(
    state.filters.search ||
      state.filters.province ||
      state.filters.ec
  );
}

function updateVisible() {
  state.visibleFeatures = state.data.features;
  state.visibleLabels = state.data.labels;

  const matchingCount =
    state.data.features.filter(
      featureMatches
    ).length;

  const modeText =
    state.mode === "weather"
      ? "weather signal mode"
      : state.mode === "outages"
        ? "outage status mode"
      : "EC mode";

  els.visibleCount.textContent = hasActiveFilters()
    ? formatNumber(matchingCount) + " matched of " + formatNumber(state.data.features.length) + " EC polygons - " + modeText
    : formatNumber(state.data.features.length) + " EC polygons visible - " + modeText;

  if (state.windy.initialized) {
    refreshWindyCoverage();
  }

  scheduleDraw();
}

const WEATHER_LAYER_CONFIG = {
  tcws: {
    label: "Typhoon signal",
    legendTitle: "TCWS Legend",
    overlay: "wind",
    status: "PAGASA TCWS signal layer",
  },
  flood: {
    label: "General Flood Advisory",
    legendTitle: "Flood Legend",
    overlay: "rain",
    status: "PAGASA General Flood Advisory layer",
  },
  rainfall: {
    label: "Rainfall",
    legendTitle: "Rainfall Legend",
    overlay: "rain",
    status: "Open-Meteo precipitation layer",
  },
  temperature: {
    label: "Temperature",
    legendTitle: "Temperature Legend",
    overlay: "temp",
    status: "Windy temperature overlay; PAGASA regional forecasts are the reference",
  },
};

function updateWeatherLayerControls() {
  document.querySelectorAll("[data-weather-layer]").forEach((button) => {
    const active = button.dataset.weatherLayer === state.weatherLayer;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const config = WEATHER_LAYER_CONFIG[state.weatherLayer];
  if (els.weatherLegendTitle) {
    els.weatherLegendTitle.textContent = config.legendTitle;
  }
  document.querySelectorAll("[data-weather-legend]").forEach((legend) => {
    const active = legend.dataset.weatherLegend === state.weatherLayer;
    legend.hidden = !active;
    legend.style.display = active ? "contents" : "none";
  });
}

function weatherUpdatedText(feature = null) {
  if (state.weatherLayer === "temperature") {
    const selectedTime = feature && state.temperatureByFeature.get(feature.id)?.time;
    return selectedTime || state.temperatureUpdatedAt || "Open-Meteo time unavailable";
  }

  if (state.weatherLayer === "flood") {
    return state.weather?.floodIssuedAt
      ? formatOutageDate(state.weather.floodIssuedAt)
      : "PAGASA GFA time unavailable";
  }

  if (state.weatherLayer === "rainfall") {
    const selectedTime = feature && state.rainfallByFeature.get(feature.id)?.time;
    return selectedTime || state.rainfallUpdatedAt || "Open-Meteo time unavailable";
  }

  return state.weather?.tcwsIssuedAt || state.weather?.issuedAt || "TCWS timestamp unavailable";
}
function weatherStatusText() {
  const config = WEATHER_LAYER_CONFIG[state.weatherLayer];
  const cadence = state.weatherLayer === "tcws" ? " · " + (state.weather?.tcwsUpdateCadence || "PAGASA updates every 6 hours") : "";
  return config.status + " · Updated " + weatherUpdatedText() + cadence;
}

function setWeatherLayer(layer) {
  if (!WEATHER_LAYER_CONFIG[layer]) {
    return;
  }

  state.weatherLayer = layer;
  updateWeatherLayerControls();

  const config = WEATHER_LAYER_CONFIG[layer];

  if (els.weatherStatus) {
    els.weatherStatus.textContent = weatherStatusText();
  }

  if (state.windy.initialized) {
    refreshWindyCoverage();
  }

  if (layer === "temperature" || layer === "rainfall") {
    loadTemperatureCoverage();
}
}
function setMode(mode) {
  const modeChanged = state.mode !== mode;
  state.mode = mode;
  document.body.dataset.mode = mode;

  if (modeChanged) {
    petModeHidden = true;
    hidePet();
    resetMapSelection();
  }

  if (els.windy) {
    els.windy.hidden = mode !== "weather";
  }

  if (els.weatherLayerSwitch) {
    els.weatherLayerSwitch.hidden = mode !== "weather";
  }

  updateWeatherLayerControls();

  if (els.signalLegend) {
    els.signalLegend.hidden = mode !== "weather";
  }

  if (els.outageLegend) {
    els.outageLegend.hidden = mode !== "outages";
  }

  if (modeChanged) {
    setSidebarCollapsed(true);
  }

  if (mode !== "weather" && state.windTimer) {
    window.clearTimeout(state.windTimer);
    state.windTimer = null;
  }
  if (els.weatherStatus && mode === "outages") {
    els.weatherStatus.textContent = state.outages.error
      ? "Outage feed unavailable - showing no recent reports."
      : `${formatNumber(state.outages.records.length)} reports loaded · latest report per EC shown.`;
  } else if (els.weatherStatus && mode === "weather") {
    els.weatherStatus.textContent = WEATHER_LAYER_CONFIG[state.weatherLayer].status + " · Updated " + weatherUpdatedText();
  }

  if (mode === "weather") {
    initWindyMap();
  }

  els.modeEc?.classList.toggle(
    "is-active",
    mode === "ec"
  );

  els.modeWeather?.classList.toggle(
    "is-active",
    mode === "weather"
  );

  els.modeOutages?.classList.toggle(
    "is-active",
    mode === "outages"
  );

  if (state.selected) {
    setDetails(state.selected);
  } else if (!modeChanged) {
    showPet();
  }

  updateVisible();

}

function setSidebarCollapsed(collapsed) {
  if (!els.sidebar || !els.sidebarToggle) {
    return;
  }

  els.sidebar.classList.toggle(
    "is-collapsed",
    collapsed
  );
  document.body.classList.toggle(
    "sidebar-collapsed",
    collapsed
  );

  els.sidebarToggle.setAttribute(
    "aria-expanded",
    String(!collapsed)
  );
  els.sidebarToggle.setAttribute(
    "aria-label",
    collapsed ? "Expand sidebar" : "Collapse sidebar"
  );
  els.sidebarToggle.setAttribute(
    "title",
    collapsed ? "Expand sidebar" : "Collapse sidebar"
  );

  if (els.sidebarBrandToggle) {
    els.sidebarBrandToggle.disabled = !collapsed;
    els.sidebarBrandToggle.setAttribute(
      "aria-label",
      collapsed ? "Expand sidebar" : "NEA DDCC Map"
    );
    els.sidebarBrandToggle.setAttribute(
      "title",
      collapsed ? "Expand sidebar" : "NEA DDCC Map"
    );
  }

  resizeCanvas();
}

function drawPolygon(
  ctx,
  feature,
  fill,
  stroke,
  lineWidth,
  offsetX = 0,
  offsetY = 0
) {
  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.beginPath();

  feature.g.forEach((polygon) => {
    polygon.forEach((ring) => {
      ring.forEach(
        (point, index) => {
          const p = project(
            point[0],
            point[1]
          );

          if (index === 0) {
            ctx.moveTo(p.x, p.y);
          } else {
            ctx.lineTo(p.x, p.y);
          }
        }
      );
    });
  });

  ctx.fillStyle = fill;
  ctx.fill("evenodd");

  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  ctx.restore();
}

function drawElevatedTile(ctx, feature) {
  const progress = Math.max(0, Math.min(1, state.selectionLift));
  const lift = Math.round(26 * progress);
  const color = state.mode === "outages"
    ? outageStyleFor(latestOutageForFeature(feature)).fill
    : colorForEc(feature.e);
  const center = project(
    (feature.b[0] + feature.b[2]) / 2,
    (feature.b[1] + feature.b[3]) / 2
  );
  const tilt = 0.08 * progress;
  const expand = 1 + 0.024 * progress;

  if (!lift) {
    drawPolygon(
      ctx,
      feature,
      withAlpha(color, 0.76),
      "#e8f1f7",
      2.2
    );
    return;
  }

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.transform(expand, tilt, 0, expand, 0, 0);
  ctx.translate(-center.x, -center.y);
  ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 13;
  drawPolygon(
    ctx,
    feature,
    "rgba(4, 9, 13, 0.92)",
    "rgba(8, 14, 18, 0.92)",
    1.2,
    0,
    lift
  );
  ctx.restore();

  for (let depth = lift - 2; depth > 0; depth -= 2) {
    drawPolygon(
      ctx,
      feature,
      "rgba(38, 50, 58, 0.96)",
      "rgba(62, 77, 85, 0.9)",
      1,
      0,
      depth
    );
  }

  drawPolygon(
    ctx,
    feature,
    withAlpha(color, 0.9),
    "#ffffff",
    2.4,
    0,
    -lift
  );
}

function drawSelectionGlow(ctx, feature) {
  const pulse = Math.max(
    0,
    Math.min(1, state.selectionPulse)
  );
  const color = state.mode === "outages"
    ? outageStyleFor(latestOutageForFeature(feature)).fill
    : colorForEc(feature.e);
  const center = project(
    (feature.b[0] + feature.b[2]) / 2,
    (feature.b[1] + feature.b[3]) / 2
  );
  const ringRadius = Math.max(
    13,
    Math.min(30, 13 + pulse * 12)
  );

  ctx.save();
  ctx.shadowColor = withAlpha(color, 0.85);
  ctx.shadowBlur = 16 + pulse * 12;
  drawPolygon(
    ctx,
    feature,
    "rgba(255, 255, 255, 0.035)",
    withAlpha(color, 0.88),
    2.8
  );
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.2 + pulse * 0.12;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  ctx.arc(
    center.x,
    center.y,
    ringRadius,
    0,
    Math.PI * 2
  );
  ctx.stroke();
  ctx.restore();
}

function drawMapBase(ctx) {
  const weatherMode =
    state.mode === "weather";
  const lightMode = isLightTheme();

  const gradient =
    ctx.createLinearGradient(
      0,
      0,
      0,
      state.height
    );

  /*
    Softer dark blue/charcoal
    instead of solid black.
  */
  gradient.addColorStop(
    0,
    lightMode
      ? weatherMode
        ? "#e9e9e7"
        : "#eef5f7"
      : weatherMode
        ? "#15181d"
        : "#101820"
  );

  gradient.addColorStop(
    0.55,
    lightMode
      ? weatherMode
        ? "#e2e2df"
        : "#e5f0f3"
      : weatherMode
        ? "#11151a"
        : "#0d151d"
  );

  gradient.addColorStop(
    1,
    lightMode
      ? weatherMode
        ? "#d7d8d5"
        : "#dcebee"
      : weatherMode
        ? "#0c1116"
        : "#09121a"
  );

  ctx.fillStyle = gradient;

  ctx.fillRect(
    0,
    0,
    state.width,
    state.height
  );

  /*
    Soft radial glow.
  */
  const ambientGlow =
    ctx.createRadialGradient(
      state.width * 0.55,
      state.height * 0.4,
      10,
      state.width * 0.55,
      state.height * 0.4,
      Math.max(
        state.width,
        state.height
      ) * 0.75
    );

  ambientGlow.addColorStop(
    0,
    lightMode
      ? weatherMode
        ? "rgba(80, 86, 90, 0.06)"
        : "rgba(14, 116, 144, 0.08)"
      : weatherMode
        ? "rgba(115, 125, 135, 0.08)"
        : "rgba(56, 189, 248, 0.09)"
  );

  ambientGlow.addColorStop(
    1,
    "rgba(0, 0, 0, 0)"
  );

  ctx.fillStyle = ambientGlow;

  ctx.fillRect(
    0,
    0,
    state.width,
    state.height
  );

  ctx.save();

  ctx.globalAlpha =
    weatherMode ? 0.2 : 0.24;

  ctx.strokeStyle = lightMode
    ? weatherMode
      ? "#c2c8c8"
      : "#c5d9de"
    : weatherMode
      ? "#35404a"
      : "#263847";

  ctx.lineWidth = 1;

  for (
    let x = 0;
    x < state.width;
    x += 80
  ) {
    ctx.beginPath();

    ctx.moveTo(x, 0);

    ctx.lineTo(
      x,
      state.height
    );

    ctx.stroke();
  }

  for (
    let y = 0;
    y < state.height;
    y += 80
  ) {
    ctx.beginPath();

    ctx.moveTo(0, y);

    ctx.lineTo(
      state.width,
      y
    );

    ctx.stroke();
  }

  ctx.restore();
}

function reducedMotionPreferred() {
  return window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
}

function drawWindOverlay(ctx) {
  if (state.mode !== "weather") {
    return;
  }

  const spacing =
    state.width < 700 ? 54 : 64;
  const phase = state.windPhase;
  const trailLength = 22;

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.lineCap = "round";
  ctx.lineWidth = 0.85;
  ctx.strokeStyle = "rgba(198, 215, 224, 0.24)";

  for (
    let y = spacing * 0.5;
    y < state.height;
    y += spacing
  ) {
    for (
      let x = spacing * 0.5;
      x < state.width;
      x += spacing
    ) {
      const drift =
        Math.sin(x * 0.011 + phase) * 5 +
        Math.cos(y * 0.013 - phase * 0.7) * 4;
      const angle =
        0.24 +
        Math.sin(y * 0.010 + phase) * 0.34 +
        Math.cos(x * 0.009 - phase * 0.6) * 0.18;
      const startX = x + drift;
      const startY =
        y +
        Math.cos(x * 0.017 + phase) * 3;

      ctx.beginPath();
      ctx.moveTo(startX, startY);

      for (let step = 1; step <= 3; step += 1) {
        const progress = step / 3;
        const curve =
          Math.sin(
            phase + y * 0.018 + progress * 2
          ) * 3;
        ctx.lineTo(
          startX +
            Math.cos(angle) *
              trailLength *
              progress,
          startY +
            Math.sin(angle) *
              trailLength *
              progress +
            curve
        );
      }

      ctx.stroke();
    }
  }

  ctx.restore();

  if (!reducedMotionPreferred()) {
    state.windPhase += 0.08;
  }
}

function scheduleWindFrame() {
  if (
    state.mode !== "weather" ||
    reducedMotionPreferred()
  ) {
    return;
  }

  if (state.windTimer) {
    window.clearTimeout(state.windTimer);
  }

  state.windTimer = window.setTimeout(
    () => {
      state.windTimer = null;
      scheduleDraw();
    },
    90
  );
}
function bboxOnScreen(bbox) {
  const a = project(
    bbox[0],
    bbox[1]
  );

  const b = project(
    bbox[2],
    bbox[3]
  );

  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);

  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);

  return (
    maxX >= -40 &&
    minX <= state.width + 40 &&
    maxY >= -40 &&
    minY <= state.height + 40
  );
}

function drawPolygons(ctx) {
  const selectedId = state.selected?.id;
  const hoveredId = state.hovered?.id;
  const filtering = hasActiveFilters();
  const focusActive = state.mode !== "weather" && selectedId !== undefined && selectedId !== null;

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  state.visibleFeatures.forEach((feature) => {
    if (!bboxOnScreen(feature.b)) {
      return;
    }

    const dimmed = filtering && !featureMatches(feature);

    if (state.mode === "weather") {
      const unassigned = !isSelectableFeature(feature);
      const color = unassigned
        ? { fill: "#59636a", stroke: "#9aa5aa" }
        : weatherPaletteForFeature(feature);

      drawPolygon(
        ctx,
        feature,
        dimmed
          ? "rgba(68, 77, 85, 0.40)"
          : withAlpha(color.fill, unassigned ? 0.42 : 0.82),
        dimmed
          ? "rgba(140, 151, 160, 0.34)"
          : color.stroke,
        dimmed ? 0.9 : unassigned ? 1 : 1.35
      );

      return;
    }

    if (state.mode === "outages") {
      const report = outageForFeature(feature);
      const style = outageStyleFor(report?.latest);
      const selected = feature.id === selectedId;
      const focusDimmed = focusActive && !selected;

      ctx.save();
      if (focusDimmed) {
        ctx.filter = "blur(2px)";
        ctx.globalAlpha = 0.58;
      }

      drawPolygon(
        ctx,
        feature,
        focusDimmed
          ? "#87939a"
          : dimmed
          ? "rgba(100, 116, 139, 0.24)"
          : withAlpha(style.fill, selected ? 0.84 : 0.62),
        focusDimmed
          ? "#cbd5e1"
          : dimmed
          ? "rgba(100, 116, 139, 0.32)"
          : style.stroke,
        focusDimmed ? 0.9 : dimmed ? 0.9 : selected ? 2.2 : 1.35
      );
      ctx.restore();
      return;
    }

    const color = isSelectableFeature(feature)
      ? colorForEc(feature.e)
      : "#69757b";
    const lightMode = isLightTheme();
    const selected = feature.id === selectedId;
    const focusDimmed = focusActive && !selected;

    ctx.save();
    if (focusDimmed) {
      ctx.filter = "blur(2px)";
      ctx.globalAlpha = 0.58;
    }

    drawPolygon(
      ctx,
      feature,
      focusDimmed
        ? "#707a80"
        : dimmed
        ? "rgba(75, 84, 91, 0.40)"
        : withAlpha(color, 0.62),
      focusDimmed
        ? "#b7c0c5"
        : dimmed
        ? "rgba(145, 154, 161, 0.34)"
        : lightMode
        ? "rgba(38, 63, 70, 0.72)"
        : "rgba(232,241,247,0.72)",
      focusDimmed ? 0.9 : dimmed ? 0.9 : 1.05
    );
    ctx.restore();
  });

  if (focusActive) {
    ctx.save();
    ctx.fillStyle = "rgba(4, 10, 15, 0.2)";
    ctx.fillRect(0, 0, state.width, state.height);
    ctx.restore();
  }

  const target = state.visibleFeatures.find(
    (feature) =>
      focusActive
        ? feature.id === selectedId
        : feature.id === hoveredId
  );

  if (target) {
    if (state.mode !== "weather" && target.id === selectedId) {
      drawSelectionGlow(ctx, target);
      drawElevatedTile(ctx, target);
    } else {
      drawPolygon(
        ctx,
        target,
        "rgba(125,211,252,0.18)",
        isLightTheme() ? "#123b45" : "#e8f1f7",
        2.2
      );
    }
  }
}

function labelCanDraw(
  rect,
  occupied
) {
  return !occupied.some(
    (other) => {
      return !(
        rect.x2 < other.x1 ||
        rect.x1 > other.x2 ||
        rect.y2 < other.y1 ||
        rect.y1 > other.y2
      );
    }
  );
}

function drawLabels(ctx) {
  if (!state.labelsVisible) {
    return;
  }

  const occupied = [];
  const filtering = hasActiveFilters();
  const selectedId = state.selected?.id;
  const focusActive =
    state.mode !== "weather" &&
    selectedId !== undefined &&
    selectedId !== null;
  const lightMode = isLightTheme();
  const maxLabels =
    state.scale > 95
      ? 260
      : state.scale > 65
      ? 180
      : 120;
  const labels = filtering
    ? [...state.visibleLabels].sort(
        (left, right) =>
          Number(labelMatches(right)) -
          Number(labelMatches(left))
      )
    : state.visibleLabels;
  let drawn = 0;

  ctx.font = "700 11px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";

  for (const label of labels) {
    if (drawn >= maxLabels) {
      break;
    }

    if (
      state.scale < 55 &&
      label.n < 18 &&
      !filtering
    ) {
      continue;
    }

    const p = project(label.x, label.y);

    if (
      p.x < -80 ||
      p.x > state.width + 80 ||
      p.y < -30 ||
      p.y > state.height + 30
    ) {
      continue;
    }

    const text = label.e;
    const labelFeature = featureForLabel(label);
    const labelOutage = latestOutageForFeature(labelFeature);
    const focusDimmed =
      focusActive && labelFeature?.id !== selectedId;
    const dimmed =
      focusDimmed ||
      (filtering && !labelMatches(label));
    const labelSignal =
      state.mode === "weather"
        ? (label.ps || [label.p]).reduce(
            (maxSignal, province) =>
              Math.max(
                maxSignal,
                signalForProvince(province)
              ),
            0
          )
        : 0;
    const signalColor =
      state.mode === "weather"
        ? labelSignal === 0
          ? "#6f7d88"
          : (
              signalPalette[labelSignal] ||
              signalPalette[0]
            ).fill
        : state.mode === "outages"
        ? outageStyleFor(labelOutage).fill
        : lightMode
        ? "#0f766e"
        : "#9bdcff";
    const markerColor = dimmed
      ? "#6f7981"
      : signalColor;
    const textColor = dimmed
      ? "#a7afb5"
      : state.mode === "weather"
        ? "#e9e5df"
        : state.mode === "outages"
        ? lightMode
          ? "#7f1d1d"
          : outageStyleFor(labelOutage).stroke
        : lightMode
        ? "#0f4c5c"
        : "#9bdcff";
    const width = Math.min(
      150,
      ctx.measureText(text).width + 22
    );
    const rect = {
      x1: p.x + 8,
      y1: p.y - 12,
      x2: p.x + 8 + width,
      y2: p.y + 12,
    };

    if (!labelCanDraw(rect, occupied)) {
      continue;
    }

    occupied.push(rect);
    ctx.save();
    ctx.globalAlpha = focusDimmed
      ? 0.34
      : dimmed
      ? 0.58
      : 1;
    if (focusDimmed) {
      ctx.filter = "blur(1.2px)";
    }
    ctx.fillStyle = markerColor;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = dimmed
      ? lightMode
        ? "rgba(242, 248, 248, 0.92)"
        : "rgba(25, 31, 35, 0.82)"
      : lightMode
        ? "rgba(255, 255, 255, 0.88)"
        : "rgba(8,17,29,0.88)";
    roundedRect(ctx, rect.x1, rect.y1, width, 24, 5);
    ctx.fill();

    ctx.strokeStyle = dimmed
      ? "rgba(138, 149, 157, 0.48)"
      : state.mode === "weather"
        ? withAlpha(signalColor, 0.82)
        : state.mode === "outages"
        ? withAlpha(outageStyleFor(labelOutage).fill, 0.5)
        : lightMode
        ? "rgba(15,118,110,0.38)"
        : "rgba(125,211,252,0.3)";
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.fillText(
      text.length > 18
        ? text.slice(0, 17) + "..."
        : text,
      rect.x1 + 9,
      p.y
    );
    ctx.restore();
    drawn += 1;
  }
}

function roundedRect(
  ctx,
  x,
  y,
  width,
  height,
  radius
) {
  ctx.beginPath();

  ctx.moveTo(
    x + radius,
    y
  );

  ctx.arcTo(
    x + width,
    y,
    x + width,
    y + height,
    radius
  );

  ctx.arcTo(
    x + width,
    y + height,
    x,
    y + height,
    radius
  );

  ctx.arcTo(
    x,
    y + height,
    x,
    y,
    radius
  );

  ctx.arcTo(
    x,
    y,
    x + width,
    y,
    radius
  );

  ctx.closePath();
}

function draw() {
  state.raf = null;

  if (state.mode === "weather") {
    return;
  }

  const { ctx } = state;

  drawMapBase(ctx);

  if (!state.data) {
    return;
  }

  drawPolygons(ctx);
  drawLabels(ctx);
}

function scheduleDraw() {
  if (!state.raf) {
    state.raf =
      requestAnimationFrame(
        draw
      );
  }
}

function pointInRing(
  point,
  ring
) {
  let inside = false;

  const x = point.lon;
  const y = point.lat;

  for (
    let i = 0,
      j = ring.length - 1;

    i < ring.length;

    j = i,
      i += 1
  ) {
    const xi =
      ring[i][0];

    const yi =
      ring[i][1];

    const xj =
      ring[j][0];

    const yj =
      ring[j][1];

    const intersect =
      yi > y !== yj > y &&
      x <
        ((xj - xi) *
          (y - yi)) /
          (yj - yi) +
          xi;

    if (intersect) {
      inside = !inside;
    }
  }

  return inside;
}

function pointInFeature(
  point,
  feature
) {
  if (
    point.lon <
      feature.b[0] ||
    point.lon >
      feature.b[2] ||
    point.lat <
      feature.b[1] ||
    point.lat >
      feature.b[3]
  ) {
    return false;
  }

  return feature.g.some(
    (polygon) => {
      if (
        !polygon[0] ||
        !pointInRing(
          point,
          polygon[0]
        )
      ) {
        return false;
      }

      for (
        let i = 1;
        i < polygon.length;
        i += 1
      ) {
        if (
          pointInRing(
            point,
            polygon[i]
          )
        ) {
          return false;
        }
      }

      return true;
    }
  );
}

function findFeatureAt(
  clientX,
  clientY
) {
  const rect =
    state.canvas
      .getBoundingClientRect();

  const x =
    clientX - rect.left;

  const y =
    clientY - rect.top;

  const point =
    screenToLonLat(
      x,
      y
    );

  for (
    let i =
      state.visibleFeatures
        .length - 1;

    i >= 0;

    i -= 1
  ) {
    const feature =
      state.visibleFeatures[i];

    if (!isSelectableFeature(feature)) {
      continue;
    }

    if (
      pointInFeature(
        point,
        feature
      )
    ) {
      return feature;
    }
  }

  return null;
}

function positionDetailPanel(feature) {
  if (!feature || !els.detailPanel || !state.bounds) {
    return;
  }

  const corners = [
    project(feature.b[0], feature.b[1]),
    project(feature.b[0], feature.b[3]),
    project(feature.b[2], feature.b[1]),
    project(feature.b[2], feature.b[3]),
  ];
  const featureRect = {
    left: Math.min(...corners.map((point) => point.x)),
    right: Math.max(...corners.map((point) => point.x)),
    top: Math.min(...corners.map((point) => point.y)),
    bottom: Math.max(...corners.map((point) => point.y)),
  };
  const anchors = [
    "top-right",
    "top-left",
    "bottom-right",
    "bottom-left",
  ];
  let bestAnchor = anchors[0];
  let smallestOverlap = Number.POSITIVE_INFINITY;

  anchors.forEach((anchor) => {
    els.detailPanel.dataset.anchor = anchor;
    const panel = els.detailPanel.getBoundingClientRect();
    const overlapWidth = Math.max(
      0,
      Math.min(panel.right, featureRect.right) -
        Math.max(panel.left, featureRect.left)
    );
    const overlapHeight = Math.max(
      0,
      Math.min(panel.bottom, featureRect.bottom) -
        Math.max(panel.top, featureRect.top)
    );
    const overlap = overlapWidth * overlapHeight;

    if (overlap < smallestOverlap) {
      smallestOverlap = overlap;
      bestAnchor = anchor;
    }
  });

  els.detailPanel.dataset.anchor = bestAnchor;
}

function positionPetOverlay() {
  if (!els.petOverlay || !els.mapCanvas) {
    return;
  }

  const mapRect = els.mapCanvas.parentElement?.getBoundingClientRect();
  const petWidth = els.petOverlay.offsetWidth || 90;
  const petHeight = els.petOverlay.offsetHeight || 142;

  if (!mapRect || !mapRect.width) {
    return;
  }

  const compact = window.innerWidth <= 620;
  const rightInset = compact ? 12 : 22;
  const bottomInset = compact ? 66 : 78;
  let left = mapRect.width - petWidth - rightInset;
  let top = mapRect.height - petHeight - bottomInset;

  // The lower-right companion faces back into the map instead of toward the card.
  els.petOverlay.dataset.side = "right";

  left = Math.max(8, Math.min(mapRect.width - petWidth - 8, left));
  top = Math.max(8, Math.min(mapRect.height - petHeight - 8, top));

  els.petOverlay.style.left = `${left}px`;
  els.petOverlay.style.top = `${top}px`;
}

function showPet() {
  if (
    !els.petOverlay ||
    !els.detailPet ||
    petUserHidden ||
    petModeHidden ||
    state.selected
  ) {
    return;
  }

  window.clearTimeout(petHideTimer);
  els.petOverlay.hidden = false;
  els.detailPet.src = PET_ASSETS[state.mode] || PET_ASSETS.ec;
  els.petOverlay.dataset.pose = state.mode;
  els.petOverlay.classList.remove("is-retreating");
  els.petRestoreButton && (els.petRestoreButton.hidden = true);
  updatePetGuide();
  positionPetOverlay();
  void els.petOverlay.offsetWidth;
  els.petOverlay.classList.add("is-visible");
}

function updatePetGuide() {
  const guide = PET_GUIDES[state.mode] || PET_GUIDES.ec;

  if (els.petBubbleTitle) {
    els.petBubbleTitle.textContent = guide.title;
  }
  if (els.petBubbleText) {
    els.petBubbleText.textContent = guide.text;
  }
  if (els.petOverlay) {
    els.petOverlay.setAttribute("aria-label", `Open guide: ${guide.title}`);
  }
}

function togglePetBubble(forceOpen) {
  if (!els.petBubble) {
    return;
  }

  const shouldOpen =
    typeof forceOpen === "boolean"
      ? forceOpen
      : els.petBubble.hidden;

  updatePetGuide();
  els.petBubble.hidden = !shouldOpen;
  els.petOverlay?.classList.toggle("is-talking", shouldOpen);
}

function setPetUserHidden(hidden) {
  petUserHidden = hidden;
  petModeHidden = false;
  try {
    window.localStorage.setItem(
      PET_VISIBILITY_STORAGE_KEY,
      hidden ? "hidden" : "visible"
    );
  } catch {
    // Storage may be unavailable in private or embedded browser contexts.
  }

  if (hidden) {
    hidePet();
  } else if (!state.selected) {
    showPet();
  }

  if (els.petRestoreButton) {
    els.petRestoreButton.hidden = !hidden;
  }
}

function initializePetVisibility() {
  try {
    petUserHidden =
      window.localStorage.getItem(PET_VISIBILITY_STORAGE_KEY) === "hidden";
  } catch {
    petUserHidden = false;
  }
}

function hidePet() {
  if (!els.petOverlay) {
    return;
  }

  window.clearTimeout(petHideTimer);
  togglePetBubble(false);
  if (els.petRestoreButton) {
    els.petRestoreButton.hidden = !(petUserHidden || petModeHidden);
  }
  els.petOverlay.classList.remove("is-visible");
  els.petOverlay.classList.add("is-retreating");
  petHideTimer = window.setTimeout(() => {
    els.petOverlay.hidden = true;
    els.petOverlay.classList.remove("is-retreating");
  }, 340);
}

function setDetails(
  feature
) {
  if (!feature) {
    petModeHidden = false;
    showPet();
    document.body.classList.remove("detail-dock-open");
    els.detailPanel.hidden =
      true;

    els.detailPanel.classList.remove(
      "is-open"
    );

    els.detailProvince.textContent =
      "--";

    els.detailEc.textContent =
      "--";

    els.detailStatus.textContent =
      "--";

    els.detailSignal.textContent =
      "--";

    els.detailSignalLabel.textContent =
      "TCWS signal";

    els.detailMode.textContent =
      "EC coverage area";

    els.detailProvinceCount.textContent =
      "--";

    els.detailProvinceCountLabel.textContent =
      "Service area";
    els.detailProvinceCountHint.textContent =
      "province(s)";
    els.detailProvinceLabel.textContent =
      "Service province(s)";

    els.detailStatusTag.textContent =
      "ONLINE";
    els.detailStatusTag.classList.remove(
      "is-alert"
    );

    els.detailSignalHint.textContent =
      "Weather signal status";

    els.detailSource.textContent =
      "--";

    els.detailUpdated.textContent =
      "--";

    resizeCanvas();

    return;
  }

  document.body.classList.add("detail-dock-open");
  els.detailPanel.hidden =
    false;

  resizeCanvas();
  positionDetailPanel(feature);
  hidePet();

  const signal = signalForFeature(feature);
  const provinces = [
    ...new Set(
      (feature.ps || [feature.p]).filter(Boolean)
    ),
  ];
  const isWeather = state.mode === "weather";
  const isOutages = state.mode === "outages";
  const outageReport = outageForFeature(feature);
  const outage = outageReport?.latest;
  const outageDetailStyle = outageStyleFor(outage);
  const temperature = state.temperatureByFeature.get(feature.id);
  const rainfall = state.rainfallByFeature.get(feature.id);
  const status = isOutages
    ? outage?.status || "No recent report"
    : isWeather
      ? state.weatherLayer === "temperature"
        ? "Current conditions"
        : state.weatherLayer === "rainfall"
          ? "Current precipitation"
          : state.weatherLayer === "flood"
          ? weatherMetricForFeature(feature) > 0
            ? "Flood advisory area"
            : "No active flood advisory"
          : signal > 0
            ? "Active TCWS signal"
            : "No active TCWS signal"
      : feature.s && feature.s !== "Blank"
        ? feature.s
        : "Coverage available";
  const accent =
    isWeather
      ? (signalPalette[signal] || signalPalette[0]).fill
      : isOutages
        ? outageDetailStyle.fill
      : colorForEc(feature.e);

  els.detailPanel.style.setProperty(
    "--selected-color",
    accent
  );
  els.detailPanel.classList.remove(
    "is-open"
  );
  void els.detailPanel.offsetWidth;
  els.detailPanel.classList.add(
    "is-open"
  );

  if (isOutages) {
    els.detailProvince.textContent = [
      outage?.areas,
      outage?.feeder ? `Feeder ${outage.feeder}` : "",
      outage?.cause ? `Cause ${outage.cause}` : "",
      outage?.remarks,
    ]
      .filter(Boolean)
      .join(" · ") || "No recent interruption report";
  } else {
  els.detailProvince.textContent =
    provinces.length
      ? provinces.join(" · ")
      : "--";

  }

  els.detailProvinceCount.textContent = isOutages
    ? String(outageReport?.count || 0)
    : String(provinces.length || 0);

  els.detailProvinceCountLabel.textContent = isOutages
    ? "Interruption reports"
    : "Service area";
  els.detailProvinceCountHint.textContent = isOutages
    ? "latest report shown"
    : "province(s)";
  els.detailProvinceLabel.textContent = isOutages
    ? "Latest interruption details"
    : "Service province(s)";

  els.detailEc.textContent =
    feature.e || "--";

  els.detailStatus.textContent =
    status;

  els.detailMode.textContent =
    isWeather
      ? "Weather coverage area"
      : isOutages
        ? "Latest unscheduled interruption"
        : "EC coverage area";

  els.detailStatusTag.textContent =
    isWeather
      ? state.weatherLayer === "temperature"
        ? "LIVE"
        : state.weatherLayer === "rainfall"
          ? "LIVE"
          : state.weatherLayer === "flood"
          ? weatherMetricForFeature(feature) > 0 ? "ALERT" : "CLEAR"
          : signal > 0 ? "ALERT" : "CLEAR"
      : isOutages
        ? outage
          ? outageStatusKey(outage).toUpperCase()
          : "NO REPORT"
        : "ONLINE";
  els.detailStatusTag.classList.toggle(
    "is-alert",
    (isWeather && (state.weatherLayer === "temperature" || state.weatherLayer === "rainfall" || signal > 0 || weatherMetricForFeature(feature) > 0)) ||
      (isOutages && outageStatusKey(outage) === "ongoing")
  );

  els.detailSignalLabel.textContent = isOutages
    ? "Latest status"
    : isWeather && state.weatherLayer === "temperature"
      ? "Current temperature"
      : isWeather && state.weatherLayer === "rainfall"
        ? "Current rainfall"
      : isWeather && state.weatherLayer === "flood"
        ? "Flood advisory"
        : "TCWS signal";
  els.detailSignal.textContent =
    isOutages
      ? outageDetailStyle.label
      : isWeather && state.weatherLayer === "temperature"
        ? temperature?.temperature === undefined || Number.isNaN(temperature?.temperature)
          ? "Loading..."
          : `${temperature.temperature.toFixed(1)} °C`
        : isWeather && state.weatherLayer === "rainfall"
          ? rainfall?.precipitation === undefined || Number.isNaN(rainfall?.precipitation) ? "Loading..." : rainfall.precipitation.toFixed(1) + " mm"
        : isWeather && state.weatherLayer === "flood"
          ? weatherMetricForFeature(feature) > 0 ? "Advisory" : "No advisory"
          : signalLabel(signal);

  els.detailSignalHint.textContent =
    isWeather && state.weatherLayer === "temperature"
      ? temperature?.humidity !== undefined && !Number.isNaN(temperature.humidity)
        ? `Open-Meteo current conditions · ${temperature.humidity}% humidity`
        : "Open-Meteo current conditions"
      : isWeather && state.weatherLayer === "rainfall"
        ? "Open-Meteo current precipitation"
      : isWeather && state.weatherLayer === "flood"
        ? "PAGASA General Flood Advisory status"
        : isWeather
          ? signal > 0
            ? "Active TCWS signal"
            : "No active TCWS signal"
      : isOutages
        ? outage
          ? `${outageReport.count} report(s) · ${formatOutageDate(outage.RECORD_TIMESTAMP)}`
          : "No recent report for this EC"
        : "TCWS data available in Weather mode";

  els.detailSource.textContent =
    isWeather
      ? state.weather?.source || "PAGASA TCWS bulletin"
      : isOutages
        ? outage?.DATA_SOURCE || "Unscheduled interruptions API"
        : "NEA DDCC · EC coverage dataset";

  els.detailUpdated.textContent =
    isWeather
      ? weatherUpdatedText(feature)
      : isOutages
        ? outage
          ? `Report ${formatOutageDate(outage.RECORD_TIMESTAMP)}`
          : "No outage report loaded"
        : "Local boundary data";

  /* legacy province count assignment replaced above */
  /*
  els.detailProvinceCount.textContent =
    String(provinces.length || 0);

  els.detailEc.textContent =
    feature.e || "--";

  els.detailStatus.textContent =
    status;

  els.detailMode.textContent =
    isWeather
      ? "Weather coverage area"
      : "EC coverage area";

  els.detailStatusTag.textContent =
    isWeather
      ? signal > 0
        ? "ALERT"
        : "CLEAR"
      : "ONLINE";
  els.detailStatusTag.classList.toggle(
    "is-alert",
    isWeather && signal > 0
  );

  els.detailSignal.textContent =
    signalLabel(signal);

  els.detailSignalHint.textContent =
    isWeather && state.weatherLayer === "temperature"
      ? temperature?.humidity !== undefined && !Number.isNaN(temperature.humidity)
        ? `Open-Meteo current conditions · ${temperature.humidity}% humidity`
        : "Open-Meteo current conditions"
      : isWeather && state.weatherLayer === "rainfall"
        ? "Open-Meteo current precipitation"
      : isWeather && state.weatherLayer === "flood"
        ? "PAGASA General Flood Advisory status"
        : isWeather
          ? signal > 0
            ? "Active TCWS signal"
            : "No active TCWS signal"
      : "TCWS data available in Weather mode";

  els.detailSource.textContent =
    isWeather
      ? state.weather?.source || "PAGASA TCWS bulletin"
      : "NEA DDCC · EC coverage dataset";

  els.detailUpdated.textContent =
    isWeather
      ? weatherUpdatedText(feature)
      : "Local boundary data";


}

  */
}

function weatherMetricForFeature(feature) {
  if (state.weatherLayer === "temperature") {
    const temperature = state.temperatureByFeature.get(feature.id)?.temperature;
    return Number.isFinite(temperature) ? temperature : null;
  }

  if (state.weatherLayer === "rainfall") {
    const precipitation = state.rainfallByFeature.get(feature.id)?.precipitation;
    return Number.isFinite(precipitation) ? precipitation : null;
  }

  const provinces = feature.ps || [feature.p];
  const source = state.weather?.[state.weatherLayer] || {};
  const values = provinces
    .map((province) => source[normalizeProvince(province)] ?? source[province])
    .filter((value) => value !== undefined && value !== null && value !== "");

  if (!values.length) {
    return null;
  }

  if (state.weatherLayer === "flood") {
    const levels = values.map((value) => {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
      return /active|advisory|flood|watch/i.test(String(value)) ? 1 : 0;
    });
    return Math.max(...levels);
  }

  const numeric = values.map(Number).filter(Number.isFinite);
  return numeric.length ? Math.max(...numeric) : null;
}

function weatherPaletteForFeature(feature) {
  if (state.weatherLayer === "tcws") {
    const signal = signalForFeature(feature);
    return signalPalette[signal] || signalPalette[0];
  }

  const metric = weatherMetricForFeature(feature);

  if (state.weatherLayer === "rainfall") {
    if (metric === null) {
      return { fill: "#59636a", stroke: "#9aa5aa" };
    }

    if (metric <= 0) {
      return { fill: "#334155", stroke: "#94a3b8" };
    }

    if (metric <= 1) {
      return { fill: "#7dd3fc", stroke: "#e0f2fe" };
    }

    if (metric <= 5) {
      return { fill: "#38bdf8", stroke: "#bae6fd" };
    }

    if (metric <= 15) {
      return { fill: "#2563eb", stroke: "#93c5fd" };
    }

    return { fill: "#7c3aed", stroke: "#c4b5fd" };
  }
  if (state.weatherLayer === "flood") {
    if (metric >= 3) {
      return { fill: "#ef4444", stroke: "#fecaca" };
    }

    if (metric === 2) {
      return { fill: "#f97316", stroke: "#fed7aa" };
    }

    return metric === 1
      ? { fill: "#facc15", stroke: "#fef08a" }
      : { fill: "#59636a", stroke: "#9aa5aa" };
  }

  if (metric === null) {
    return { fill: "#59636a", stroke: "#9aa5aa" };
  }

  if (metric <= 24) {
    return { fill: "#60a5fa", stroke: "#bfdbfe" };
  }

  if (metric <= 29) {
    return { fill: "#2dd4bf", stroke: "#99f6e4" };
  }

  if (metric <= 33) {
    return { fill: "#fb923c", stroke: "#fed7aa" };
  }

  return { fill: "#fb7185", stroke: "#fecdd3" };
}
function weatherFeatureStyle(feature) {
  const selected = state.selected?.id === feature.id;
  const focusActive =
    state.mode === "weather" &&
    state.selected?.id !== undefined &&
    state.selected?.id !== null;
  const focusDimmed = focusActive && !selected;
  const dimmed =
    hasActiveFilters() &&
    !featureMatches(feature);
  const signal = signalForFeature(feature);
  const signalStyle = weatherPaletteForFeature(feature);

  return {
    color: selected
      ? "#ffffff"
      : focusDimmed
        ? "#b7c0c5"
        : dimmed
          ? "rgba(165, 176, 184, 0.54)"
          : signalStyle.stroke,
    weight: selected ? 3.6 : focusDimmed ? 1.15 : dimmed ? 1 : 1.65,
    fillColor: focusDimmed
      ? "#707a80"
      : dimmed
        ? "#4a555d"
        : signalStyle.fill,
    fillOpacity: selected
      ? 0.88
      : focusDimmed
        ? 0.56
        : dimmed
          ? 0.24
        : state.weatherLayer === "tcws" && signal === 0
          ? 0.35
          : 0.6,
  };
}

function signalColorForLabel(label) {
  const signal = (label.ps || [label.p]).reduce(
    (maxSignal, province) =>
      Math.max(maxSignal, signalForProvince(province)),
    0
  );

  return signal === 0
    ? "#6f7d88"
    : (signalPalette[signal] || signalPalette[0]).fill;
}

function escapeLabelText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function featureForLabel(label) {
  return state.data.features.find(
    (feature) => feature.e === label.e
  );
}

function windyLabelLimit() {
  const zoom = state.windy.map?.getZoom() || 5;

  if (zoom < 5.5) {
    return 8;
  }

  if (zoom < 6.5) {
    return 16;
  }

  if (zoom < 7.5) {
    return 28;
  }

  if (zoom < 8.5) {
    return 44;
  }

  if (zoom < 9.5) {
    return 68;
  }

  return Number.POSITIVE_INFINITY;
}

function addWindyLabels() {
  if (!state.windy.map || !window.L) {
    return;
  }

  state.windy.labels.forEach((marker) => marker.remove());
  state.windy.labels = [];

  if (!state.labelsVisible) {
    return;
  }

  const filtering = hasActiveFilters();
  const rankedLabels = [...state.data.labels].sort(
    (left, right) => {
      const matchDifference =
        Number(labelMatches(right)) -
        Number(labelMatches(left));

      return matchDifference || Number(right.n || 0) - Number(left.n || 0);
    }
  );
  const labels = filtering
    ? rankedLabels
    : rankedLabels.slice(0, windyLabelLimit());

  if (state.selected) {
    const selectedLabel = rankedLabels.find(
      (label) => label.e === state.selected.e
    );

    if (selectedLabel && !labels.includes(selectedLabel)) {
      labels.push(selectedLabel);
    }
  }

  labels.forEach((label) => {
    const feature = featureForLabel(label);

    if (!feature) {
      return;
    }

    const selected = state.selected?.id === feature.id;
    const focusActive = state.mode === "weather" && Boolean(state.selected);
    const dimmed =
      (focusActive && !selected) ||
      (filtering && !labelMatches(label));
    const classes =
      "ec-weather-label" +
      (dimmed ? " is-dimmed" : "") +
      (selected ? " is-selected" : "");
    const html =
      '<span class="' +
      classes +
      '" style="--signal-color:' +
      signalColorForLabel(label) +
      '">' +
      escapeLabelText(label.e) +
      "</span>";
    const marker = L.marker(
      [label.y, label.x],
      {
        interactive: true,
        keyboard: false,
        icon: L.divIcon({
          className: "ec-weather-marker",
          html,
          iconSize: null,
          iconAnchor: [0, 11],
        }),
      }
    );

    marker.on("click", (event) => {
      L.DomEvent.stopPropagation(event.originalEvent);
      selectWeatherFeature(feature);
    });

    marker.addTo(state.windy.map);
    state.windy.labels.push(marker);
  });
}

function setWeatherSelectionClass(feature, selected) {
  const layer = state.windy.layers.get(feature.id);

  if (!layer) {
    return;
  }

  layer.eachLayer((path) => {
    const element = path.getElement?.() || path._path;

    if (!element) {
      return;
    }

    if (selected) {
      element.classList.remove("weather-selected-path");
      void element.getBoundingClientRect();
      setWeatherSelectionLift(feature, state.weatherSelectionPulse);
    } else {
      element.style.removeProperty("--weather-lift-y");
      element.style.removeProperty("--weather-scale");
      element.style.removeProperty("--weather-skew");
    }

    element.classList.toggle("weather-selected-path", selected);
  });
}

function setWeatherSelectionLift(feature, progress) {
  const layer = state.windy.layers.get(feature.id);

  if (!layer) {
    return;
  }

  const eased = Math.max(0, Math.min(1, progress));
  layer.eachLayer((path) => {
    const element = path.getElement?.() || path._path;

    if (!element) {
      return;
    }

    element.style.setProperty(
      "--weather-lift-y",
      `${(-7 - 9 * eased).toFixed(2)}px`
    );
    element.style.setProperty(
      "--weather-scale",
      (1.004 + 0.014 * eased).toFixed(4)
    );
    element.style.setProperty(
      "--weather-skew",
      `${(-0.35 - 0.8 * eased).toFixed(2)}deg`
    );
  });
}

function animateWeatherSelection(feature) {
  const animationId = ++state.weatherSelectionAnimation;
  const startedAt = performance.now();
  const duration = 820;

  function frame(now) {
    if (
      animationId !== state.weatherSelectionAnimation ||
      state.selected?.id !== feature.id
    ) {
      return;
    }

    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    state.weatherSelectionPulse = eased;
    setWeatherSelectionLift(feature, eased);

    if (progress < 1) {
      requestAnimationFrame(frame);
    }
  }

  requestAnimationFrame(frame);
}
function refreshWindyCoverage() {
  if (!state.windy.initialized) {
    return;
  }

  state.data.features.forEach((feature) => {
    const layer = state.windy.layers.get(feature.id);

    if (!layer) {
      return;
    }

    const selected = state.selected?.id === feature.id;
    layer.setStyle(weatherFeatureStyle(feature));
    setWeatherSelectionClass(feature, selected);

    if (selected) {
      layer.bringToFront();
    }
  });

  addWindyLabels();
}

async function loadTemperatureCoverage() {
  const features = state.data?.features?.filter(isSelectableFeature) || [];
  if (!features.length) {
    return;
  }

  const latitudes = features.map((feature) => ((feature.b[1] + feature.b[3]) / 2).toFixed(5)).join(",");
  const longitudes = features.map((feature) => ((feature.b[0] + feature.b[2]) / 2).toFixed(5)).join(",");
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${latitudes}&longitude=${longitudes}` +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation" +
    "&temperature_unit=celsius&timezone=auto";

  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Open-Meteo coverage request failed: ${response.status}`);
    }

    const payload = await response.json();
    const results = Array.isArray(payload) ? payload : [payload];
    results.forEach((item, index) => {
      const current = item.current || {};
      state.temperatureByFeature.set(features[index].id, {
        temperature: Number(current.temperature_2m),
        apparent: Number(current.apparent_temperature),
        humidity: Number(current.relative_humidity_2m),
        precipitation: Number(current.precipitation),
        time: current.time || "",
      });
      state.rainfallByFeature.set(features[index].id, {
        precipitation: Number(current.precipitation),
        time: current.time || "",
      });
    });

    state.temperatureUpdatedAt = results.find((item) => item.current?.time)?.current?.time || "";
    state.rainfallUpdatedAt = state.temperatureUpdatedAt;
    refreshWindyCoverage();
    scheduleDraw();
    if (state.selected) {
      setDetails(state.selected);
    }
  } catch (error) {
    console.warn("Could not load EC temperature coverage", error);
  }
}
async function loadFeatureTemperature(feature) {
  if ((state.weatherLayer !== "temperature" && state.weatherLayer !== "rainfall") || !feature) {
    return;
  }

  const cached = state.weatherLayer === "rainfall" ? state.rainfallByFeature.get(feature.id) : state.temperatureByFeature.get(feature.id);
  if (cached !== undefined) {
    if (state.selected?.id === feature.id) {
      setDetails(feature);
    }
    return;
  }

  const [minLon, minLat, maxLon, maxLat] = feature.b;
  const latitude = ((minLat + maxLat) / 2).toFixed(5);
  const longitude = ((minLon + maxLon) / 2).toFixed(5);
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${latitude}&longitude=${longitude}` +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation" +
    "&temperature_unit=celsius&timezone=auto";

  if (state.weatherLayer === "rainfall") { state.rainfallByFeature.set(feature.id, null); } else { state.temperatureByFeature.set(feature.id, null); }
  if (state.selected?.id === feature.id) {
    setDetails(feature);
  }

  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Open-Meteo request failed: ${response.status}`);
    }

    const payload = await response.json();
    const current = payload.current || {};
    state.temperatureByFeature.set(feature.id, {
      temperature: Number(current.temperature_2m),
      apparent: Number(current.apparent_temperature),
      humidity: Number(current.relative_humidity_2m),
      time: current.time || "",
    });
    state.rainfallByFeature.set(feature.id, { precipitation: Number(current.precipitation), time: current.time || "" });
  } catch (error) {
    state.temperatureByFeature.delete(feature.id);
    state.rainfallByFeature.delete(feature.id);
    console.warn("Could not load selected EC temperature", error);
  }

  if (state.selected?.id === feature.id) {
    setDetails(feature);
  }
}
function selectWeatherFeature(feature) {
  if (!isSelectableFeature(feature) || !state.windy.map) {
    return;
  }

  if (state.selected?.id === feature.id) {
    resetMapSelection();
    return;
  }

  state.selected = feature;
  state.weatherSelectionPulse = 0;
  state.hovered = null;
  els.tooltip.hidden = true;
  setDetails(feature);
  refreshWindyCoverage();
  animateWeatherSelection(feature);
  loadFeatureTemperature(feature);

  const bbox = feature.b;
  state.windy.map.flyToBounds(
    [
      [bbox[1], bbox[0]],
      [bbox[3], bbox[2]],
    ],
    {
      animate: true,
      duration: 0.8,
      padding: [72, 72],
      maxZoom: 9,
    }
  );
}


function fitWindyMap(animate = true) {
  if (!state.windy.map || !state.bounds) {
    return;
  }

  state.windy.map.fitBounds(
    [
      [state.bounds[1], state.bounds[0]],
      [state.bounds[3], state.bounds[2]],
    ],
    {
      animate,
      duration: 0.65,
      padding: [38, 38],
      maxZoom: 6,
    }
  );
}

function updateWindyTelemetry(latlng) {
  if (!latlng) {
    return;
  }

  els.coordLon.textContent = latlng.lng.toFixed(4);
  els.coordLat.textContent = latlng.lat.toFixed(4);
}

function initWindyMap() {
  if (
    state.windy.initialized ||
    state.windy.initializing
  ) {
    if (state.windy.map) {
      window.setTimeout(
        () => state.windy.map.invalidateSize(),
        80
      );
    }

    return;
  }

  if (
    !window.windyInit ||
    !window.L ||
    !window.WINDY_API_KEY
  ) {
    els.weatherStatus.textContent =
      "Windy forecast could not start.";
    return;
  }

  state.windy.initializing = true;

  windyInit(
    {
      key: window.WINDY_API_KEY,
      lat: 12.8,
      lon: 121.7,
      zoom: 5,
      overlay: "wind",
      level: "surface",
    },
    (windyAPI) => {
      state.windy.api = windyAPI;
      state.windy.map = windyAPI.map;
      state.windy.initialized = true;
      state.windy.initializing = false;

      windyAPI.store.set("overlay", WEATHER_LAYER_CONFIG[state.weatherLayer].overlay);

      state.data.features.forEach((feature) => {
        const layer = L.geoJSON(
          {
            type: "Feature",
            properties: feature,
            geometry: {
              type: "MultiPolygon",
              coordinates: feature.g,
            },
          },
          {
            interactive: isSelectableFeature(feature),
            style: () => weatherFeatureStyle(feature),
          }
        );

        layer.eachLayer((path) => {
          if (!isSelectableFeature(feature)) {
            return;
          }

          path.on("click", (event) => {
            L.DomEvent.stopPropagation(event.originalEvent);
            selectWeatherFeature(feature);
          });

          path.on("mouseover", () => {
            if (state.selected?.id !== feature.id) {
              path.setStyle({
                color: "#ffffff",
                weight: 2.5,
                fillOpacity: 0.72,
              });
            }
          });

          path.on("mouseout", () => {
            path.setStyle(weatherFeatureStyle(feature));
          });
        });

        layer.addTo(state.windy.map);
        state.windy.layers.set(feature.id, layer);
      });

      state.windy.map.on("click", (event) => {
        if (event.originalEvent?.target?.closest?.(".leaflet-interactive")) {
          return;
        }

        resetMapSelection();
      });

      state.windy.map.on("mousemove", (event) => {
        updateWindyTelemetry(event.latlng);
      });

      state.windy.map.on("zoomend", () => {
        els.zoomReadout.textContent =
          "Z" + state.windy.map.getZoom();
        addWindyLabels();
      });

      refreshWindyCoverage();
      fitWindyMap(false);
      els.weatherStatus.textContent =
        "Windy forecast active - TCWS layer retained.";
      window.setTimeout(
        () => state.windy.map.invalidateSize(),
        100
      );
    }
  );
}

function clearCanvasFocus() {
  if (state.mode === "weather" || !state.selected) {
    return;
  }

  state.selected = null;
  state.selectionLift = 0;
  state.selectionPulse = 0;
  state.hovered = null;
  state.viewAnimation += 1;
  setDetails(null);
  scheduleDraw();
}

function resetMapSelection() {
  els.searchInput.value = "";
  els.provinceSelect.value = "";
  els.ecSelect.value = "";

  state.filters = {
    search: "",
    province: "",
    ec: "",
  };
  state.selected = null;
  state.weatherSelectionAnimation += 1;
  state.weatherSelectionPulse = 0;
  state.selectionLift = 0;
  state.selectionPulse = 0;
  state.hovered = null;
  state.viewAnimation += 1;

  setDetails(null);
  updateVisible();

  if (state.windy.initialized) {
    refreshWindyCoverage();
  }

  if (state.mode === "weather") {
    fitWindyMap(true);
  } else {
    animateCanvasToBounds();
  }
}

function focusCanvasFeature(feature) {
  const bbox = feature.b;
  const padding = state.width < 700 ? 34 : 74;
  const targetScale = Math.max(
    35,
    Math.min(
      600,
      Math.min(
        (state.width - padding * 2) / (bbox[2] - bbox[0]),
        (state.height - padding * 2) / (bbox[3] - bbox[1])
      )
    )
  );
  const start = {
    scale: state.scale,
    offsetX: state.offsetX,
    offsetY: state.offsetY,
  };
  const target = {
    scale: targetScale,
    offsetX:
      state.width / 2 -
      ((bbox[0] + bbox[2]) / 2 - state.bounds[0]) *
        targetScale,
    offsetY:
      state.height / 2 -
      (state.bounds[3] - (bbox[1] + bbox[3]) / 2) *
        targetScale,
  };
  const startedAt = performance.now();
  const duration = 820;
  const animationId = ++state.viewAnimation;

  function frame(now) {
    if (animationId !== state.viewAnimation) {
      return;
    }

    const progress = Math.min(
      1,
      (now - startedAt) / duration
    );
    const liftPhase = Math.min(
      1,
      progress / 0.82
    );
    const liftEase =
      1 - Math.pow(1 - liftPhase, 3);
    const settlePhase =
      progress <= 0.72
        ? 0
        : (progress - 0.72) / 0.28;
    const settleEase =
      1 - Math.pow(1 - settlePhase, 3);
    const eased =
      1 - Math.pow(1 - progress, 3);

    state.scale =
      start.scale +
      (target.scale - start.scale) * eased;
    state.offsetX =
      start.offsetX +
      (target.offsetX - start.offsetX) * eased;
    state.offsetY =
      start.offsetY +
      (target.offsetY - start.offsetY) * eased;
    state.selectionLift =
      progress < 0.72
        ? liftEase
        : 1 +
          Math.sin(settlePhase * Math.PI) *
            0.08 *
            (1 - settleEase);
    state.selectionPulse = Math.min(
      1,
      progress / 0.62
    );

    updateZoomReadout();
    scheduleDraw();

    if (progress < 1) {
      requestAnimationFrame(frame);
    } else {
      positionDetailPanel(feature);
    }
  }

  requestAnimationFrame(frame);
}

function selectCanvasFeature(feature) {
  if (!feature) {
    resetMapSelection();
    return;
  }

  if (!isSelectableFeature(feature)) {
    return;
  }

  if (state.selected?.id === feature.id) {
    resetMapSelection();
    return;
  }

  state.selected = feature;
  state.selectionLift = 0;
  state.selectionPulse = 0;
  els.tooltip.hidden = true;
  setDetails(feature);
  focusCanvasFeature(feature);
  scheduleDraw();
}

function zoomCanvasBy(factor) {
  if (state.mode === "weather" || !state.bounds) {
    return;
  }

  const x = state.width / 2;
  const y = state.height / 2;
  const before = screenToLonLat(x, y);

  state.scale = Math.max(
    35,
    Math.min(600, state.scale * factor)
  );

  const after = project(before.lon, before.lat);
  state.offsetX += x - after.x;
  state.offsetY += y - after.y;

  if (factor < 1) {
    clearCanvasFocus();
  }

  updateZoomReadout();
  scheduleDraw();
}

function updateZoomReadout() {
  if (!els.zoomReadout) {
    return;
  }

  els.zoomReadout.textContent =
    `${Math.round(
      state.scale
    )}%`;
}

function updateCoordReadout(
  clientX,
  clientY
) {
  if (
    !els.coordLon ||
    !state.bounds
  ) {
    return;
  }

  const rect =
    state.canvas
      .getBoundingClientRect();

  const point =
    screenToLonLat(
      clientX -
        rect.left,

      clientY -
        rect.top
    );

  els.coordLon.textContent =
    point.lon.toFixed(4);

  els.coordLat.textContent =
    point.lat.toFixed(4);
}

function showTooltip(
  feature,
  clientX,
  clientY
) {
  if (!feature) {
    els.tooltip.hidden =
      true;

    return;
  }

  const panelRect =
    document
      .querySelector(
        ".map-panel"
      )
      .getBoundingClientRect();

  const signal = signalForFeature(feature);
  const signalLine =
    state.mode === "weather"
      ? signalLabel(signal)
      : "EC coverage";

  els.tooltip.innerHTML =
    `<strong>${escapeLabelText(feature.e)}</strong>` +
    `<span>${escapeLabelText(feature.p || "Unknown province")}</span>` +
    `<span>${escapeLabelText(feature.s || "Blank")} · ${escapeLabelText(signalLine)}</span>`;

  els.tooltip.style.left =
    `${
      clientX -
      panelRect.left +
      14
    }px`;

  els.tooltip.style.top =
    `${
      clientY -
      panelRect.top +
      14
    }px`;

  els.tooltip.hidden =
    false;
}

function bindEvents() {
  window.addEventListener(
    "resize",
    resizeCanvas
  );

  els.modeEc?.addEventListener(
    "click",
    () => setMode("ec")
  );

  els.modeWeather?.addEventListener(
    "click",
    () =>
      setMode("weather")
  );

  els.modeOutages?.addEventListener(
    "click",
    () => setMode("outages")
  );

  document.querySelectorAll("[data-weather-layer]").forEach((button) => {
    button.addEventListener("click", () => setWeatherLayer(button.dataset.weatherLayer));
  });

  els.sidebarToggle?.addEventListener(
    "click",
    () => {
      setSidebarCollapsed(
        !els.sidebar.classList.contains("is-collapsed")
      );
    }
  );

  els.sidebarBrandToggle?.addEventListener(
    "click",
    () => {
      if (els.sidebar.classList.contains("is-collapsed")) {
        setSidebarCollapsed(false);
      }
    }
  );

  els.themeToggle?.addEventListener(
    "click",
    () => setTheme(isLightTheme() ? "dark" : "light")
  );

  els.labelsToggle?.addEventListener(
    "click",
    () => setLabelsVisible(!state.labelsVisible)
  );

  els.zoomOutButton.addEventListener(
    "click",
    () => zoomCanvasBy(0.82)
  );

  els.zoomInButton.addEventListener(
    "click",
    () => zoomCanvasBy(1.22)
  );

  els.centerButton.addEventListener(
    "click",
    () => {
      if (state.mode === "weather") {
        fitWindyMap(true);
      } else {
        fitToBounds(true);
      }
    }
  );

  els.detailClose.addEventListener(
    "click",
    () => {
      resetMapSelection();
    }
  );

  els.petOverlay?.addEventListener(
    "click",
    () => togglePetBubble()
  );

  els.petBubbleClose?.addEventListener(
    "click",
    () => togglePetBubble(false)
  );

  els.petBubbleHide?.addEventListener(
    "click",
    () => setPetUserHidden(true)
  );

  els.petRestoreButton?.addEventListener(
    "click",
    () => setPetUserHidden(false)
  );

  els.searchInput.addEventListener(
    "input",
    () => {
      state.filters.search =
        els.searchInput.value
          .trim()
          .toLowerCase();

      updateVisible();
    }
  );

  els.provinceSelect.addEventListener(
    "change",
    () => {
      state.filters.province =
        els.provinceSelect.value;

      updateVisible();
    }
  );

  els.ecSelect.addEventListener(
    "change",
    () => {
      state.filters.ec =
        els.ecSelect.value;

      updateVisible();
    }
  );

  state.canvas.addEventListener(
    "mousedown",
    (event) => {
      state.dragging =
        true;

      state.canvas.classList.add(
        "dragging"
      );

      state.dragStart = {
        x: event.clientX,
        y: event.clientY,
        offsetX:
          state.offsetX,
        offsetY:
          state.offsetY,
      };
    }
  );

  window.addEventListener(
    "mouseup",
    () => {
      state.dragging =
        false;

      state.canvas.classList.remove(
        "dragging"
      );
    }
  );

  window.addEventListener(
    "mousemove",
    (event) => {
      updateCoordReadout(
        event.clientX,
        event.clientY
      );

      if (
        state.dragging &&
        state.dragStart
      ) {
        state.offsetX =
          state.dragStart
            .offsetX +
          event.clientX -
          state.dragStart.x;

        state.offsetY =
          state.dragStart
            .offsetY +
          event.clientY -
          state.dragStart.y;

        scheduleDraw();

        return;
      }

      if (!state.data) {
        return;
      }

      const feature =
        findFeatureAt(
          event.clientX,
          event.clientY
        );

      if (
        feature?.id !==
        state.hovered?.id
      ) {
        state.hovered =
          feature;

        scheduleDraw();
      }

      showTooltip(
        feature,
        event.clientX,
        event.clientY
      );
    }
  );

  state.canvas.addEventListener(
    "mouseleave",
    () => {
      state.hovered =
        null;

      els.tooltip.hidden =
        true;

      if (els.coordLon) {
        els.coordLon.textContent =
          "--";

        els.coordLat.textContent =
          "--";
      }

      scheduleDraw();
    }
  );

  state.canvas.addEventListener(
    "wheel",

    (event) => {
      event.preventDefault();

      const featureUnderCursor =
        state.mode === "weather"
          ? null
          : findFeatureAt(
              event.clientX,
              event.clientY
            );

      if (
        event.deltaY < 0 &&
        featureUnderCursor &&
        state.selected?.id !== featureUnderCursor.id
      ) {
        selectCanvasFeature(featureUnderCursor);
        return;
      }

      const rect =
        state.canvas
          .getBoundingClientRect();

      const x =
        event.clientX -
        rect.left;

      const y =
        event.clientY -
        rect.top;

      const before =
        screenToLonLat(
          x,
          y
        );

      const zoom =
        event.deltaY < 0
          ? 1.18
          : 0.84;

      state.scale =
        Math.max(
          35,

          Math.min(
            600,

            state.scale *
              zoom
          )
        );

      const afterPoint =
        project(
          before.lon,
          before.lat
        );

      state.offsetX +=
        x -
        afterPoint.x;

      state.offsetY +=
        y -
        afterPoint.y;

      if (event.deltaY > 0) {
        clearCanvasFocus();
      }

      updateZoomReadout();

      updateCoordReadout(
        event.clientX,
        event.clientY
      );

      scheduleDraw();
    },

    {
      passive: false,
    }
  );

  state.canvas.addEventListener(
    "click",
    (event) => {
      const feature = findFeatureAt(
        event.clientX,
        event.clientY
      );

      selectCanvasFeature(feature);
    }
  );
}

async function loadWeatherSignals() {
  try {
    const response =
      await fetch(
        "data/weather-signals.json"
      );

    if (!response.ok) {
      throw new Error(
        `Could not load weather data: ${response.status}`
      );
    }

    state.weather =
      await response.json();
  } catch (error) {
    state.weather = {
      source:
        "No weather source loaded",

      issuedAt:
        "Weather signal file not loaded",

      signals: {},
    };

    console.warn(error);
  }

  prepareWeatherSignals();
}

async function loadOutages() {
  try {
    const response = await fetch(
      "http://26.8.239.167:3010/api/dashboard/retrieve-unscheduled-interruptions",
      { cache: "no-store" }
    );

    if (!response.ok) {
      throw new Error(
        `Could not load outage data: ${response.status}`
      );
    }

    prepareOutages(await response.json());
  } catch (error) {
    state.outages.records = [];
    state.outages.byEc = new Map();
    state.outages.loadedAt = null;
    state.outages.error = error;
    console.warn(error);
  }
}

async function loadData() {
  const response =
    await fetch(
      "data/coverage-map.json"
    );

  if (!response.ok) {
    throw new Error(
      `Could not load map data: ${response.status}`
    );
  }

  state.data =
    await response.json();

  state.bounds =
    state.data.bbox;

  renderSplashCoverageMap();

  await loadWeatherSignals();
  await loadOutages();

  populateControls();

  updateVisible();

  fitToBounds(false);
}

async function main() {
  initElements();
  splashStartedAt = performance.now();
  window.setTimeout(hideSplashScreen, 4200);
  initializeTheme();
  initializeLabels();
  initializePetVisibility();

  bindEvents();

  resizeCanvas();
  showPet();

  try {
    await loadData();

    scheduleDraw();
    hideSplashScreen();
  } catch (error) {
    els.visibleCount.textContent =
      "Map data failed to load";

    console.error(error);
    hideSplashScreen();
  }
}

main();
