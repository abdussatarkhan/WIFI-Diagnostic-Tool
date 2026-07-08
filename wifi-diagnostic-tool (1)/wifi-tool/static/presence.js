// Presence Watch — frontend logic
// Polls /api/presence, which now aggregates signal-quality volatility
// across every currently-visible router/AP (from a background
// `netsh wlan show networks mode=bssid` scan) rather than just your
// laptop's own link to the router it's connected to. Drives the
// motion-score readout, a rolling avg. stdev/jitter chart, and a table of
// the individual routers feeding the score. Classification thresholds are
// recomputed client-side from the sensitivity slider.

const POLL_MS = 2000;

const LEVEL_COLORS = {
  quiet: "#4FD8C4",
  possible: "#F2B84B",
  active: "#EF5B5B",
  idle: "#334049",
};

let sensitivity = 1.0;
let volatilityHistory = []; // [{t, stdev, jitter}]
let lastRouters = []; // most recent per-router breakdown

// ---------------------------------------------------------------------
// Clock + connection badge (shared look with the diagnostics page)
// ---------------------------------------------------------------------

function tickClock() {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString();
}
setInterval(tickClock, 1000);
tickClock();

function setConnBadge(online) {
  const dot = document.getElementById("conn-dot");
  const label = document.getElementById("conn-label");
  dot.classList.toggle("online", online);
  dot.classList.toggle("offline", !online);
  label.textContent = online ? "Live" : "Disconnected";
}

function showError(msg) {
  const el = document.getElementById("error-banner");
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

// ---------------------------------------------------------------------
// Classification (mirrors the server's heuristic, but slider-adjustable)
// ---------------------------------------------------------------------

function classify(stdev, jitter) {
  const rawScore = Math.min(100, stdev * 4 + jitter * 5);
  const score = Math.min(100, rawScore * sensitivity);
  if (score < 12) return { score, level: "quiet", label: "Quiet — likely unoccupied" };
  if (score < 40) return { score, level: "possible", label: "Possible movement nearby" };
  return { score, level: "active", label: "Movement detected" };
}

function updateMotionUI(score, level, label) {
  const color = LEVEL_COLORS[level] || LEVEL_COLORS.idle;
  document.getElementById("motion-score-value").textContent = score.toFixed(1);
  document.getElementById("motion-score-value").parentElement.style.color = color;
  document.getElementById("motion-label").textContent = label;
  document.getElementById("motion-label").className = `motion-label level-${level}`;
  document.getElementById("motion-tag").textContent = level.toUpperCase();
  document.getElementById("motion-tag").style.color = color;
  document.getElementById("motion-tag").style.borderColor = color;

  const fill = document.getElementById("motion-bar-fill");
  fill.style.width = `${Math.max(2, score)}%`;
  fill.style.background = color;
}

// ---------------------------------------------------------------------
// Volatility chart (stdev + jitter over time)
// ---------------------------------------------------------------------

const volCanvas = document.getElementById("volatility-chart");
const volCtx = volCanvas.getContext("2d");

function resizeVolCanvas() {
  const rect = volCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  volCanvas.width = rect.width * dpr;
  volCanvas.height = rect.height * dpr;
  volCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawVolChart();
}

function drawVolChart() {
  const rect = volCanvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  volCtx.clearRect(0, 0, w, h);

  volCtx.strokeStyle = "#1E2730";
  volCtx.lineWidth = 1;
  volCtx.font = "10px IBM Plex Mono, monospace";
  volCtx.fillStyle = "#7C8A97";

  const maxVal = Math.max(10, ...volatilityHistory.map((p) => Math.max(p.stdev, p.jitter)));
  [0, 0.5, 1].forEach((frac) => {
    const v = (maxVal * frac).toFixed(1);
    const y = h - frac * (h - 20) - 10;
    volCtx.beginPath();
    volCtx.moveTo(0, y);
    volCtx.lineTo(w, y);
    volCtx.stroke();
    volCtx.fillText(v, 4, y - 3);
  });

  if (volatilityHistory.length < 2) return;

  const n = volatilityHistory.length;
  const stepX = w / Math.max(n - 1, 1);

  function drawSeries(key, color) {
    volCtx.beginPath();
    volatilityHistory.forEach((pt, i) => {
      const x = i * stepX;
      const y = h - (pt[key] / maxVal) * (h - 20) - 10;
      if (i === 0) volCtx.moveTo(x, y);
      else volCtx.lineTo(x, y);
    });
    volCtx.strokeStyle = color;
    volCtx.lineWidth = 2;
    volCtx.stroke();
  }

  drawSeries("stdev", "#6FA8FF");
  drawSeries("jitter", "#C58BFF");
}

window.addEventListener("resize", resizeVolCanvas);

// ---------------------------------------------------------------------
// Sensitivity slider
// ---------------------------------------------------------------------

const slider = document.getElementById("sensitivity-slider");
slider.addEventListener("input", () => {
  sensitivity = parseFloat(slider.value);
  document.getElementById("sensitivity-value").textContent = `${sensitivity.toFixed(1)}×`;
});

// ---------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------

function renderRouterTable(routers) {
  const tbody = document.getElementById("router-table-body");
  const countTag = document.getElementById("router-count-tag");
  countTag.textContent = `${routers.length} found`;

  if (!routers.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="router-table-empty">No routers visible yet…</td></tr>';
    return;
  }

  tbody.innerHTML = routers
    .map((r) => {
      const shortBssid = r.bssid ? r.bssid.toUpperCase() : "—";
      const ssid = r.ssid || "(hidden network)";
      const sig = r.signal_percent != null ? `${r.signal_percent}%` : "--";
      return `<tr>
        <td>${ssid}</td>
        <td class="mono-cell">${shortBssid}</td>
        <td>${sig}</td>
        <td>${r.score.toFixed(0)}</td>
      </tr>`;
    })
    .join("");
}

async function pollPresence() {
  try {
    const res = await fetch("/api/presence");
    const data = await res.json();

    if (!data.ok) {
      setConnBadge(false);
      showError(data.error || "Unable to read presence data.");
      const gathering = data.error && (data.error.includes("Scanning") || data.error.includes("Gathering"));
      updateMotionUI(0, "idle", gathering ? "Scanning for nearby routers…" : "Unavailable");
      renderRouterTable([]);
      return;
    }

    setConnBadge(true);
    showError(null);
    lastRouters = data.routers || [];

    const avgStdev = lastRouters.length
      ? lastRouters.reduce((s, r) => s + r.stdev, 0) / lastRouters.length
      : 0;
    const avgJitter = lastRouters.length
      ? lastRouters.reduce((s, r) => s + r.jitter, 0) / lastRouters.length
      : 0;
    const avgSignal = lastRouters.length
      ? Math.round(lastRouters.reduce((s, r) => s + (r.signal_percent || 0), 0) / lastRouters.length)
      : 0;

    const { score, level, label } = classify(avgStdev, avgJitter);
    updateMotionUI(score, level, `${label}${data.trend && data.trend !== "steady" ? " (" + data.trend + ")" : ""}`);

    document.getElementById("motion-samples").textContent = data.router_count;
    document.getElementById("motion-mean").textContent = avgSignal;
    document.getElementById("motion-trend").textContent = data.trend || "steady";

    renderRouterTable(lastRouters);

    volatilityHistory.push({ t: data.timestamp, stdev: avgStdev, jitter: avgJitter });
    if (volatilityHistory.length > 90) volatilityHistory.shift();
    drawVolChart();
  } catch (err) {
    setConnBadge(false);
    showError("Could not reach the backend. Is app.py running?");
  }
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

resizeVolCanvas();
pollPresence();
setInterval(pollPresence, POLL_MS);
