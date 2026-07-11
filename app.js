const state = {
  data: null,
  weather: null,
  mode: "ec",
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
  weatherSelectionPulse: 0,
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
  const normalized = {};

  Object.entries(signals).forEach(([province, signal]) => {
    normalized[normalizeProvince(province)] = clampSignal(signal);
  });

  state.weather = {
    source: state.weather?.source || "No weather source loaded",
    issuedAt:
      state.weather?.issuedAt || "No TCWS bulletin timestamp loaded",
    signals,
    normalized,
  };

  if (els.weatherStatus) {
    els.weatherStatus.textContent = state.weather.issuedAt;
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
    "mapCanvas",
    "windy",
    "tooltip",
    "visibleCount",
    "searchInput",
    "provinceSelect",
    "ecSelect",
    "modeEc",
    "modeWeather",
    "weatherStatus",
    "fitButton",
    "clearButton",
    "detailPanel",
    "detailClose",
    "detailProvince",
    "detailEc",
    "detailStatus",
    "detailSignal",
    "coordLon",
    "coordLat",
    "zoomReadout",
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });

  state.canvas = els.mapCanvas;
  state.ctx = state.canvas.getContext("2d");
}

function resizeCanvas() {
  const rect = state.canvas.getBoundingClientRect();

  state.dpr = window.devicePixelRatio || 1;
  state.width = Math.max(1, rect.width);
  state.height = Math.max(1, rect.height);

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

  scheduleDraw();
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

  const size = worldSize();

  const padding =
    state.width < 700 ? 28 : 58;

  const sx =
    (state.width - padding * 2) /
    size.lon;

  const sy =
    (state.height - padding * 2) /
    size.lat;

  state.scale = Math.max(
    1,
    Math.min(sx, sy)
  );

  state.offsetX =
    (state.width -
      size.lon * state.scale) /
    2;

  state.offsetY =
    (state.height -
      size.lat * state.scale) /
    2;

  updateZoomReadout();

  if (animate) {
    scheduleDraw();
  }
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
      : "EC mode";

  els.visibleCount.textContent = hasActiveFilters()
    ? formatNumber(matchingCount) + " matched of " + formatNumber(state.data.features.length) + " EC polygons - " + modeText
    : formatNumber(state.data.features.length) + " EC polygons visible - " + modeText;

  if (state.windy.initialized) {
    refreshWindyCoverage();
  }

  scheduleDraw();
}

function setMode(mode) {
  state.mode = mode;

  if (mode !== "weather" && state.windTimer) {
    window.clearTimeout(state.windTimer);
    state.windTimer = null;
  }
  document.body.dataset.mode = mode;

  if (els.windy) {
    els.windy.hidden = mode !== "weather";
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

  if (state.selected) {
    setDetails(state.selected);
  }

  updateVisible();
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
  const lift = Math.round(18 * progress);
  const color = colorForEc(feature.e);
  const center = project(
    (feature.b[0] + feature.b[2]) / 2,
    (feature.b[1] + feature.b[3]) / 2
  );
  const tilt = 0.055 * progress;
  const expand = 1 + 0.018 * progress;

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
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 10;
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
  ctx.restore();
}

function drawMapBase(ctx) {
  const weatherMode =
    state.mode === "weather";

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
    weatherMode
      ? "#15181d"
      : "#101820"
  );

  gradient.addColorStop(
    0.55,
    weatherMode
      ? "#11151a"
      : "#0d151d"
  );

  gradient.addColorStop(
    1,
    weatherMode
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
    weatherMode
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

  ctx.strokeStyle =
    weatherMode
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
  const focusActive = state.mode === "ec" && selectedId !== undefined && selectedId !== null;

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  state.visibleFeatures.forEach((feature) => {
    if (!bboxOnScreen(feature.b)) {
      return;
    }

    const dimmed = filtering && !featureMatches(feature);

    if (state.mode === "weather") {
      const signal = signalForFeature(feature);
      const color = signalPalette[signal] || signalPalette[0];

      drawPolygon(
        ctx,
        feature,
        dimmed
          ? "rgba(68, 77, 85, 0.40)"
          : withAlpha(color.fill, signal === 0 ? 0.42 : 0.82),
        dimmed
          ? "rgba(140, 151, 160, 0.34)"
          : color.stroke,
        dimmed ? 0.9 : signal === 0 ? 1 : 1.35
      );

      return;
    }

    const color = colorForEc(feature.e);
    const selected = feature.id === selectedId;
    const focusDimmed = focusActive && !selected;

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
        : "rgba(232,241,247,0.72)",
      focusDimmed ? 0.9 : dimmed ? 0.9 : 1.05
    );
  });

  const target = state.visibleFeatures.find(
    (feature) =>
      focusActive
        ? feature.id === selectedId
        : feature.id === hoveredId
  );

  if (target) {
    if (state.mode === "ec" && target.id === selectedId) {
      drawElevatedTile(ctx, target);
    } else {
      drawPolygon(
        ctx,
        target,
        "rgba(125,211,252,0.18)",
        "#e8f1f7",
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
  const occupied = [];
  const filtering = hasActiveFilters();
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
    const dimmed = filtering && !labelMatches(label);
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
        : "#9bdcff";
    const markerColor = dimmed
      ? "#6f7981"
      : signalColor;
    const textColor = dimmed
      ? "#a7afb5"
      : state.mode === "weather"
        ? "#e9e5df"
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
    ctx.globalAlpha = dimmed ? 0.58 : 1;
    ctx.fillStyle = markerColor;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = dimmed
      ? "rgba(25, 31, 35, 0.82)"
      : "rgba(8,17,29,0.88)";
    roundedRect(ctx, rect.x1, rect.y1, width, 24, 5);
    ctx.fill();

    ctx.strokeStyle = dimmed
      ? "rgba(138, 149, 157, 0.48)"
      : state.mode === "weather"
        ? withAlpha(signalColor, 0.82)
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

  if (state.mode !== "ec") {
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

function setDetails(
  feature
) {
  if (!feature) {
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


    return;
  }

  els.detailPanel.hidden =
    false;

  const signal = signalForFeature(feature);
  const accent =
    state.mode === "weather"
      ? (signalPalette[signal] || signalPalette[0]).fill
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

  els.detailProvince.textContent =
    feature.p || "--";

  els.detailEc.textContent =
    feature.e || "--";

  els.detailStatus.textContent =
    feature.s || "Blank";

  els.detailSignal.textContent =
    signalLabel(signal);


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
  const signalStyle =
    signalPalette[signal] ||
    signalPalette[0];

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
        : signal === 0
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
    }

    element.classList.toggle("weather-selected-path", selected);
  });
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

function selectWeatherFeature(feature) {
  if (!feature || !state.windy.map) {
    return;
  }

  state.selected = feature;
  state.hovered = null;
  els.tooltip.hidden = true;
  setDetails(feature);
  refreshWindyCoverage();

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

      windyAPI.store.set("overlay", "wind");

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
            style: () => weatherFeatureStyle(feature),
          }
        );

        layer.eachLayer((path) => {
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
  state.selectionLift = 0;
  state.hovered = null;

  setDetails(null);
  updateVisible();

  if (state.mode === "ec") {
    scheduleDraw();
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
  const duration = 420;

  function frame(now) {
    const progress = Math.min(
      1,
      (now - startedAt) / duration
    );
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
    state.selectionLift = eased;

    updateZoomReadout();
    scheduleDraw();

    if (progress < 1) {
      requestAnimationFrame(frame);
    }
  }

  requestAnimationFrame(frame);
}

function selectCanvasFeature(feature) {
  if (!feature) {
    resetMapSelection();
    return;
  }

  state.selected = feature;
  state.selectionLift = 0;
  els.tooltip.hidden = true;
  setDetails(feature);
  focusCanvasFeature(feature);
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

  els.fitButton.addEventListener(
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
      state.selected = null;

      setDetails(null);

      if (state.windy.initialized) {
        refreshWindyCoverage();
      }

      scheduleDraw();
    }
  );

  els.clearButton.addEventListener(
    "click",
    () => {
      resetMapSelection();

      if (state.mode === "weather") {
        fitWindyMap(true);
      } else {
        fitToBounds(true);
      }
    }
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

  await loadWeatherSignals();

  populateControls();

  updateVisible();

  fitToBounds(false);
}

async function main() {
  initElements();

  bindEvents();

  resizeCanvas();

  try {
    await loadData();

    scheduleDraw();
  } catch (error) {
    els.visibleCount.textContent =
      "Map data failed to load";

    console.error(error);
  }
}

main();