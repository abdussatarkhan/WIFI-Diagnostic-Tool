// Signal Room — frontend logic
// Polls the Flask backend for live WiFi data, renders a compass-style dial,
// draws a scrolling strip chart, and drives the speed test workflow.

const POLL_MS = 2000;

const COLORS = {
  excellent: "#4FD8C4",
  good: "#7FD858",
  fair: "#F2B84B",
  poor: "#EF5B5B",
  idle: "#334049",
};

function bandColor(band) {
  return COLORS[band] || COLORS.idle;
}

function bandFromPercent(p) {
  if (p >= 75) return "excellent";
  if (p >= 50) return "good";
  if (p >= 25) return "fair";
  return "poor";
}

// ---------------------------------------------------------------------
// Compass dial (SVG, built once, updated via attribute changes)
// ---------------------------------------------------------------------

const DIAL_CX = 160;
const DIAL_CY = 160;
const DIAL_R = 128;

function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function buildDial() {
  const svg = document.getElementById("dial-svg");
  const ns = "http://www.w3.org/2000/svg";
  const parts = [];

  // Outer ring
  parts.push(
    `<circle cx="${DIAL_CX}" cy="${DIAL_CY}" r="${DIAL_R}" fill="none" stroke="#1E2730" stroke-width="2"/>`
  );
  parts.push(
    `<circle cx="${DIAL_CX}" cy="${DIAL_CY}" r="${DIAL_R - 18}" fill="none" stroke="#161C22" stroke-width="1"/>`
  );

  // Progress arc track (full circle, faint)
  parts.push(
    `<circle cx="${DIAL_CX}" cy="${DIAL_CY}" r="${DIAL_R - 9}" fill="none" stroke="#161C22" stroke-width="8"/>`
  );

  // Progress arc (drawn via stroke-dasharray, id'd for updates)
  const circumference = 2 * Math.PI * (DIAL_R - 9);
  parts.push(
    `<circle id="dial-progress" cx="${DIAL_CX}" cy="${DIAL_CY}" r="${DIAL_R - 9}" fill="none"
      stroke="${COLORS.idle}" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}"
      transform="rotate(-90 ${DIAL_CX} ${DIAL_CY})"/>`
  );

  // Tick marks every 5% (minor) and every 25% (major, labeled like compass points)
  for (let i = 0; i <= 100; i += 5) {
    const deg = (i / 100) * 360;
    const major = i % 25 === 0;
    const rOuter = DIAL_R - 20;
    const rInner = major ? rOuter - 14 : rOuter - 7;
    const p1 = polar(DIAL_CX, DIAL_CY, rOuter, deg);
    const p2 = polar(DIAL_CX, DIAL_CY, rInner, deg);
    parts.push(
      `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}"
        stroke="${major ? "#4A5C68" : "#2A363F"}" stroke-width="${major ? 2 : 1}"/>`
    );
    if (major) {
      const lp = polar(DIAL_CX, DIAL_CY, rOuter - 26, deg);
      parts.push(
        `<text x="${lp.x.toFixed(1)}" y="${lp.y.toFixed(1)}" fill="#7C8A97" font-size="11"
          font-family="IBM Plex Mono, monospace" text-anchor="middle" dominant-baseline="middle">${i}</text>`
      );
    }
  }

  // Needle group (rotated via transform, updated each tick)
  parts.push(`
    <g id="dial-needle" transform="rotate(0 ${DIAL_CX} ${DIAL_CY})">
      <line x1="${DIAL_CX}" y1="${DIAL_CY}" x2="${DIAL_CX}" y2="${DIAL_CY - (DIAL_R - 34)}"
        stroke="${COLORS.idle}" stroke-width="3" stroke-linecap="round" id="dial-needle-line"/>
      <circle cx="${DIAL_CX}" cy="${DIAL_CY - (DIAL_R - 34)}" r="4" fill="${COLORS.idle}" id="dial-needle-tip"/>
    </g>
    <circle cx="${DIAL_CX}" cy="${DIAL_CY}" r="6" fill="#0A0E12" stroke="#4A5C68" stroke-width="2"/>
  `);

  svg.innerHTML = parts.join("\n");
  svg.setAttribute("data-circumference", circumference.toFixed(2));
}

function updateDial(percent, band) {
  const svg = document.getElementById("dial-svg");
  const circumference = parseFloat(svg.getAttribute("data-circumference"));
  const color = bandColor(band);

  const progress = svg.querySelector("#dial-progress");
  const offset = circumference - (percent / 100) * circumference;
  progress.setAttribute("stroke-dashoffset", offset.toFixed(2));
  progress.setAttribute("stroke", color);

  const needle = svg.querySelector("#dial-needle");
  const deg = (percent / 100) * 360;
  needle.setAttribute("transform", `rotate(${deg} ${DIAL_CX} ${DIAL_CY})`);
  svg.querySelector("#dial-needle-line").setAttribute("stroke", color);
  svg.querySelector("#dial-needle-tip").setAttribute("fill", color);
}

// ---------------------------------------------------------------------
// Strip chart (canvas)
// ---------------------------------------------------------------------

const chartCanvas = document.getElementById("strip-chart");
const chartCtx = chartCanvas.getContext("2d");
let chartData = []; // [{t, signal_percent}]

function resizeCanvas() {
  const rect = chartCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  chartCanvas.width = rect.width * dpr;
  chartCanvas.height = rect.height * dpr;
  chartCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawChart();
}

function drawChart() {
  const rect = chartCanvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  chartCtx.clearRect(0, 0, w, h);

  // Grid lines at 0/25/50/75/100
  chartCtx.strokeStyle = "#1E2730";
  chartCtx.lineWidth = 1;
  chartCtx.font = "10px IBM Plex Mono, monospace";
  chartCtx.fillStyle = "#7C8A97";
  [0, 25, 50, 75, 100].forEach((v) => {
    const y = h - (v / 100) * (h - 20) - 10;
    chartCtx.beginPath();
    chartCtx.moveTo(0, y);
    chartCtx.lineTo(w, y);
    chartCtx.stroke();
    chartCtx.fillText(`${v}`, 4, y - 3);
  });

  if (chartData.length < 2) return;

  const n = chartData.length;
  const stepX = w / Math.max(n - 1, 1);

  // Line path
  chartCtx.beginPath();
  chartData.forEach((pt, i) => {
    const x = i * stepX;
    const y = h - (pt.signal_percent / 100) * (h - 20) - 10;
    if (i === 0) chartCtx.moveTo(x, y);
    else chartCtx.lineTo(x, y);
  });
  chartCtx.strokeStyle = "#4FD8C4";
  chartCtx.lineWidth = 2;
  chartCtx.stroke();

  // Fill under line
  chartCtx.lineTo((n - 1) * stepX, h);
  chartCtx.lineTo(0, h);
  chartCtx.closePath();
  const gradient = chartCtx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, "rgba(79, 216, 196, 0.25)");
  gradient.addColorStop(1, "rgba(79, 216, 196, 0.0)");
  chartCtx.fillStyle = gradient;
  chartCtx.fill();

  // Points colored by band
  chartData.forEach((pt, i) => {
    const x = i * stepX;
    const y = h - (pt.signal_percent / 100) * (h - 20) - 10;
    chartCtx.beginPath();
    chartCtx.arc(x, y, i === n - 1 ? 3.5 : 1.6, 0, Math.PI * 2);
    chartCtx.fillStyle = bandColor(bandFromPercent(pt.signal_percent));
    chartCtx.fill();
  });
}

window.addEventListener("resize", resizeCanvas);

// ---------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------

function tickClock() {
  const el = document.getElementById("clock");
  el.textContent = new Date().toLocaleTimeString();
}
setInterval(tickClock, 1000);
tickClock();

// ---------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------

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

async function pollWifi() {
  try {
    const res = await fetch("/api/wifi");
    const data = await res.json();

    if (!data.ok) {
      setConnBadge(false);
      showError(data.error || "Unable to read WiFi state.");
      document.getElementById("dial-ssid").textContent = "Not connected";
      updateDial(0, "idle");
      document.getElementById("dial-percent-value").textContent = "--";
      document.getElementById("dial-dbm").textContent = "-- dBm est.";
      document.getElementById("quality-tag").textContent = "OFFLINE";
      return;
    }

    setConnBadge(true);
    showError(null);

    updateDial(data.signal_percent, data.quality_band);
    document.getElementById("dial-percent-value").textContent = data.signal_percent;
    document.getElementById("dial-dbm").textContent = `${data.signal_dbm_estimate} dBm est.`;
    document.getElementById("dial-ssid").textContent = data.ssid;
    document.getElementById("quality-tag").textContent = data.quality_band.toUpperCase();
    document.getElementById("quality-tag").style.color = bandColor(data.quality_band);

    document.getElementById("d-ssid").textContent = data.ssid;
    document.getElementById("d-bssid").textContent = data.bssid;
    document.getElementById("d-radio").textContent = data.radio_type;
    document.getElementById("d-channel").textContent = data.channel ?? "—";
    document.getElementById("d-auth").textContent = data.authentication;
    document.getElementById("d-cipher").textContent = data.cipher;
    document.getElementById("d-rx").textContent = data.receive_rate_mbps
      ? `${data.receive_rate_mbps} Mbps`
      : "—";
    document.getElementById("d-tx").textContent = data.transmit_rate_mbps
      ? `${data.transmit_rate_mbps} Mbps`
      : "—";

    chartData.push({ t: data.timestamp, signal_percent: data.signal_percent });
    if (chartData.length > 180) chartData.shift();
    drawChart();
  } catch (err) {
    setConnBadge(false);
    showError("Could not reach the backend. Is app.py running?");
  }
}

async function loadHistory() {
  try {
    const res = await fetch("/api/history");
    const data = await res.json();
    chartData = data;
    drawChart();
  } catch (err) {
    // Non-fatal; live polling will populate the chart regardless.
  }
}

// ---------------------------------------------------------------------
// Speed test
// ---------------------------------------------------------------------

let speedPollTimer = null;

function setSpeedRunning(running) {
  const btn = document.getElementById("speed-btn");
  btn.disabled = running;
  btn.textContent = running ? "Testing…" : "Run speed test";
}

async function startSpeedTest() {
  setSpeedRunning(true);
  document.getElementById("speed-status").textContent = "Starting test…";
  document.getElementById("speed-meta").textContent = "";
  document.getElementById("speed-download").textContent = "--";
  document.getElementById("speed-upload").textContent = "--";
  document.getElementById("speed-ping").textContent = "--";

  try {
    const res = await fetch("/api/speedtest/start", { method: "POST" });
    const { job_id } = await res.json();
    speedPollTimer = setInterval(() => pollSpeedTest(job_id), 1200);
  } catch (err) {
    document.getElementById("speed-status").textContent =
      "Couldn't start the speed test. Is the backend running?";
    setSpeedRunning(false);
  }
}

async function pollSpeedTest(jobId) {
  try {
    const res = await fetch(`/api/speedtest/status/${jobId}`);
    const data = await res.json();

    if (data.status === "running") {
      document.getElementById("speed-status").textContent = data.stage || "Running…";
      return;
    }

    clearInterval(speedPollTimer);
    setSpeedRunning(false);

    if (data.status === "error") {
      document.getElementById("speed-status").textContent = `Error: ${data.error}`;
      return;
    }

    document.getElementById("speed-download").textContent = data.download_mbps;
    document.getElementById("speed-upload").textContent = data.upload_mbps;
    document.getElementById("speed-ping").textContent = data.ping_ms;
    document.getElementById("speed-status").textContent = "Test complete.";
    const server = data.server || {};
    document.getElementById("speed-meta").textContent = server.sponsor
      ? `Server: ${server.sponsor} (${server.name}, ${server.country}) · ISP: ${data.isp || "—"}`
      : "";
  } catch (err) {
    clearInterval(speedPollTimer);
    setSpeedRunning(false);
    document.getElementById("speed-status").textContent = "Lost connection to backend during test.";
  }
}

document.getElementById("speed-btn").addEventListener("click", startSpeedTest);

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

buildDial();
resizeCanvas();
loadHistory().then(pollWifi);
setInterval(pollWifi, POLL_MS);
