// Thermal View — frontend logic (v3)
//
// Two independent modes, picked at start time:
//
//  - "camera" mode (original): real webcam feed -> false-color thermal
//    palette (canvas pixel remap) -> on-device person detection
//    (TensorFlow.js + COCO-SSD) draws bracketed boxes over anyone in
//    frame, styled after a FLIR "human motion detector" clip. Needs
//    working light, like any visible-light webcam.
//
//  - "wifi" mode (new): no camera at all. It reuses the exact same
//    multi-router signal-quality-volatility heuristic as Presence Watch
//    (/api/presence) -- a background scan reads every nearby router/AP's
//    signal quality every few seconds, and a person moving through the
//    space tends to add jitter to those readings -- and renders that as
//    an aircraft/ship-radar-style rotating sweep with glowing "contacts",
//    the same way onboard radar shows returns on a PPI scope. Because it
//    never touches a camera or light sensor, it behaves identically in
//    full daylight or total darkness. It is still the same coarse,
//    multi-router signal-quality heuristic described in the README: it
//    can say "something nearby is moving," it cannot fix a real bearing
//    or range the way an actual radar's directional antenna array can.
//    How many contacts appear (0-2) and how they drift is derived only
//    from that single aggregated score -- a styled reconstruction, not a
//    real position fix -- and the canvas says so.
//
// Both modes gate on the live WiFi signal from /api/wifi; everything
// runs locally in the browser, no frames or signal data leave the device.

const WIFI_POLL_MS = 2000;
const PRESENCE_POLL_MS = 2000;
const DETECT_MS = 350;          // how often we run the person-detector (camera mode)
const RANGE_MIN_PERCENT = 10;   // below this (or disconnected) = "out of range"

const LEVEL_COLORS = {
  quiet: "#4FD8C4",
  possible: "#F2B84B",
  active: "#EF5B5B",
  idle: "#334049",
};

const BAND_COLORS = {
  excellent: "#4FD8C4",
  good: "#7FD858",
  fair: "#F2B84B",
  poor: "#EF5B5B",
};

const COVERAGE_BY_BAND = {
  excellent: "~15m (strong)",
  good: "~10m",
  fair: "~6m",
  poor: "~2m (edge of range)",
};

// ---------------------------------------------------------------------
// Clock + connection badge (shared look with the other pages)
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

// ---------------------------------------------------------------------
// Thermal colormap: maps 0..255 luminance -> [r,g,b] via a precomputed LUT
// ---------------------------------------------------------------------

const STOPS = [
  { t: 0.00, c: [7, 12, 40] },
  { t: 0.16, c: [16, 40, 150] },
  { t: 0.34, c: [20, 110, 190] },
  { t: 0.50, c: [40, 190, 140] },
  { t: 0.64, c: [180, 220, 40] },
  { t: 0.78, c: [235, 160, 30] },
  { t: 0.90, c: [225, 45, 40] },
  { t: 1.00, c: [255, 150, 90] },
];

const LUT = new Uint8Array(256 * 3);
(function buildLUT() {
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let color = STOPS[STOPS.length - 1].c;
    for (let s = 0; s < STOPS.length - 1; s++) {
      const a = STOPS[s], b = STOPS[s + 1];
      if (v >= a.t && v <= b.t) {
        const f = (v - a.t) / (b.t - a.t || 1);
        color = [
          a.c[0] + (b.c[0] - a.c[0]) * f,
          a.c[1] + (b.c[1] - a.c[1]) * f,
          a.c[2] + (b.c[2] - a.c[2]) * f,
        ];
        break;
      }
    }
    LUT[i * 3] = color[0];
    LUT[i * 3 + 1] = color[1];
    LUT[i * 3 + 2] = color[2];
  }
})();

// ---------------------------------------------------------------------
// DOM + canvas setup
// ---------------------------------------------------------------------

const video = document.getElementById("cam-video");
const canvas = document.getElementById("thermal-canvas");
const ctx = canvas.getContext("2d");

let activeMode = null; // "camera" | "wifi" | null (idle, showing start overlay)

const FIELD_W = 220;
let FIELD_H = 140;
const field = document.createElement("canvas");
const fctx = field.getContext("2d", { willReadFrequently: true });

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// ---------------------------------------------------------------------
// WiFi range gating -- reuses the same /api/wifi snapshot as the other
// pages. Determines whether the detector is "armed" and drives the
// readout panel.
// ---------------------------------------------------------------------

let inRange = false;
let signalPercent = 0;
let qualityBand = null;
let wifiOk = false;

// Presence/wifi-mode state (populated by pollPresence, used only in "wifi" mode)
let presenceOk = false;
let presenceScore = 0;
let presenceLevel = "idle";
let presenceLabel = "Gathering samples…";
let presenceTrend = "steady";

function updateWifiUI() {
  const tag = document.getElementById("thermal-tag");
  const label = document.getElementById("thermal-label");
  const bar = document.getElementById("thermal-bar-fill");
  const scoreEl = document.getElementById("thermal-score");
  const meanEl = document.getElementById("thermal-mean");
  const samplesEl = document.getElementById("thermal-samples");
  const banner = document.getElementById("thermal-range-banner");
  const countEl = document.getElementById("thermal-temp-value");
  const countUnitEl = document.getElementById("thermal-temp-unit");

  const color = qualityBand ? (BAND_COLORS[qualityBand] || LEVEL_COLORS.idle) : LEVEL_COLORS.idle;

  scoreEl.textContent = wifiOk ? signalPercent : "--";
  meanEl.textContent = wifiOk ? qualityBand : "--";
  samplesEl.textContent = wifiOk ? (COVERAGE_BY_BAND[qualityBand] || "--") : "out of range";

  bar.style.width = `${Math.max(2, wifiOk ? signalPercent : 0)}%`;
  bar.style.background = color;

  if (activeMode === "camera") {
    countUnitEl.textContent = "humans in frame";
    countEl.textContent = cameraRunning ? detectedCount : "--";
  } else if (activeMode === "wifi") {
    countUnitEl.textContent = "motion score / 100";
    countEl.textContent = presenceOk ? presenceScore.toFixed(0) : "--";
  }

  if (activeMode === null) {
    tag.textContent = "IDLE";
    tag.style.color = LEVEL_COLORS.idle;
    tag.style.borderColor = LEVEL_COLORS.idle;
    banner.style.display = "none";
    label.textContent = "Detector off";
    label.className = "motion-label";
    return;
  }

  if (activeMode === "camera") {
    if (!cameraRunning) return;
    if (inRange) {
      tag.textContent = "ARMED";
      tag.style.color = "#4FD8C4";
      tag.style.borderColor = "#4FD8C4";
      banner.style.display = "none";
      label.textContent = detectedCount > 0
        ? `${detectedCount} ${detectedCount === 1 ? "person" : "people"} detected`
        : "Armed -- no one in frame";
      label.className = "motion-label level-quiet";
    } else {
      tag.textContent = "DISARMED";
      tag.style.color = LEVEL_COLORS.active;
      tag.style.borderColor = LEVEL_COLORS.active;
      banner.style.display = "block";
      banner.textContent = wifiOk
        ? "OUT OF WIFI RANGE -- signal too weak, detection paused"
        : "OUT OF WIFI RANGE -- no connection, detection paused";
      label.textContent = "Detection paused";
      label.className = "motion-label level-active";
    }
    return;
  }

  if (activeMode === "wifi") {
    if (!wifiOk) {
      tag.textContent = "NO SIGNAL";
      tag.style.color = LEVEL_COLORS.active;
      tag.style.borderColor = LEVEL_COLORS.active;
      banner.style.display = "block";
      banner.textContent = "NO WIFI CONNECTION -- sensing paused";
      label.textContent = "Sensing paused";
      label.className = "motion-label level-active";
      return;
    }
    banner.style.display = "none";
    tag.textContent = presenceLevel.toUpperCase();
    const c = LEVEL_COLORS[presenceLevel] || LEVEL_COLORS.idle;
    tag.style.color = c;
    tag.style.borderColor = c;
    label.textContent = presenceOk
      ? `${presenceLabel}${presenceTrend !== "steady" ? " (" + presenceTrend + ")" : ""}`
      : presenceLabel;
    label.className = `motion-label level-${presenceLevel === "idle" ? "quiet" : presenceLevel}`;
  }
}

async function pollWifi() {
  try {
    const res = await fetch("/api/wifi");
    const data = await res.json();

    if (!data.ok) {
      setConnBadge(false);
      wifiOk = false;
      qualityBand = null;
      inRange = false;
      updateWifiUI();
      return;
    }

    setConnBadge(true);
    wifiOk = true;
    signalPercent = data.signal_percent;
    qualityBand = data.quality_band
      || (signalPercent >= 75 ? "excellent" : signalPercent >= 50 ? "good" : signalPercent >= 25 ? "fair" : "poor");
    inRange = signalPercent >= RANGE_MIN_PERCENT;
    updateWifiUI();
  } catch (err) {
    setConnBadge(false);
    wifiOk = false;
    inRange = false;
    updateWifiUI();
  }
}

// ---------------------------------------------------------------------
// WiFi motion mode -- reuses the same heuristic as Presence Watch
// (/api/presence: rolling stdev + jitter of signal quality -> 0-100
// motion score). No camera, no light sensor, so it reads identically
// day or night. Only polled while activeMode === "wifi".
// ---------------------------------------------------------------------

async function pollPresence() {
  if (activeMode !== "wifi") return;
  try {
    const res = await fetch("/api/presence");
    const data = await res.json();

    if (!data.ok) {
      presenceOk = false;
      presenceScore = 0;
      presenceLevel = "idle";
      presenceLabel = data.error || "Unavailable";
      updateWifiUI();
      return;
    }

    presenceOk = true;
    presenceScore = data.motion_score;
    presenceLevel = data.level;
    presenceLabel = data.label;
    presenceTrend = data.trend || "steady";
    updateWifiUI();
  } catch (err) {
    presenceOk = false;
    presenceLabel = "Could not reach the backend.";
    updateWifiUI();
  }
}

// ---------------------------------------------------------------------
// Camera + model lifecycle
// ---------------------------------------------------------------------

let cameraRunning = false;
let model = null;
let modelLoading = false;
let latestBoxes = [];     // [{x,y,w,h,score}] in video-native pixel coords
let detectedCount = 0;
let videoW = 0, videoH = 0;

async function startCamera() {
  const overlay = document.getElementById("thermal-start-overlay");
  const btn = document.getElementById("thermal-start-btn");
  btn.disabled = true;
  btn.textContent = "Requesting camera...";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    videoW = video.videoWidth || 640;
    videoH = video.videoHeight || 400;
    FIELD_H = Math.round(FIELD_W * (videoH / videoW));
    field.width = FIELD_W;
    field.height = FIELD_H;

    activeMode = "camera";
    cameraRunning = true;
    overlay.style.display = "none";
    document.getElementById("thermal-panel-title").textContent = "Human Detector — Camera Feed";
    updateWifiUI();

    loadModel();
    requestAnimationFrame(render);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Start camera feed";
    const p = overlay.querySelector("p");
    p.textContent = "Couldn't access the camera (" + (err.message || err.name) + "). Check your browser's camera permission for this page and try again.";
  }
}

async function loadModel() {
  if (model || modelLoading) return;
  modelLoading = true;
  try {
    model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
    detectLoop();
  } catch (err) {
    console.error("Model load failed:", err);
  } finally {
    modelLoading = false;
  }
}

async function detectLoop() {
  if (!cameraRunning) return;
  if (model && inRange) {
    try {
      const predictions = await model.detect(video);
      latestBoxes = predictions
        .filter((p) => p.class === "person" && p.score > 0.5)
        .map((p) => ({
          x: p.bbox[0], y: p.bbox[1], w: p.bbox[2], h: p.bbox[3], score: p.score,
        }));
      detectedCount = latestBoxes.length;
      updateWifiUI();
    } catch (err) {
      // model.detect can throw if the video isn't ready yet -- ignore and retry
    }
  } else if (!inRange) {
    latestBoxes = [];
    detectedCount = 0;
  }
  setTimeout(detectLoop, DETECT_MS);
}

// ---------------------------------------------------------------------
// Render loop: paint the false-color feed, then overlay detection boxes.
// ---------------------------------------------------------------------

function render() {
  if (!cameraRunning) return;

  fctx.drawImage(video, 0, 0, FIELD_W, FIELD_H);
  const frame = fctx.getImageData(0, 0, FIELD_W, FIELD_H);
  const data = frame.data;

  let lumSum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    lumSum += lum;
    data[i] = LUT[lum * 3];
    data[i + 1] = LUT[lum * 3 + 1];
    data[i + 2] = LUT[lum * 3 + 2];
  }
  fctx.putImageData(frame, 0, 0);

  const avgLum = lumSum / (FIELD_W * FIELD_H) / 255;
  const ambientTemp = 18 + avgLum * 9;
  document.getElementById("thermal-ambient").textContent = `${ambientTemp.toFixed(1)}°C*`;

  const w = canvas.width, h = canvas.height;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, w, h);
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(field, 0, 0, w, h);
  ctx.restore();

  const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.95);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  if (!inRange) {
    ctx.fillStyle = "rgba(5,9,20,0.55)";
    ctx.fillRect(0, 0, w, h);
  } else {
    const sx = w / videoW, sy = h / videoH;
    latestBoxes.forEach((b) => {
      const bx = w - (b.x + b.w) * sx; // mirror x to match mirrored video
      const by = b.y * sy;
      const bw = b.w * sx;
      const bh = b.h * sy;
      drawPersonBox(bx, by, bw, bh, b.score, h);
    });
  }

  requestAnimationFrame(render);
}

function drawPersonBox(x, y, w, h, score, canvasH) {
  ctx.save();

  ctx.strokeStyle = "rgba(255, 176, 59, 0.55)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvasH);
  ctx.moveTo(x + w, 0);
  ctx.lineTo(x + w, canvasH);
  ctx.stroke();
  ctx.setLineDash([]);

  const r = 6;
  ctx.strokeStyle = "#FFB03B";
  ctx.lineWidth = 2;
  ctx.shadowColor = "rgba(255,176,59,0.6)";
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.moveTo(x, y + r);
  ctx.lineTo(x, y + h - r);
  ctx.moveTo(x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.moveTo(x + r, y + h);
  ctx.lineTo(x + w - r, y + h);
  ctx.stroke();
  ctx.shadowBlur = 0;

  const label = `HUMAN ${Math.round(score * 100)}%`;
  ctx.font = "600 12px 'IBM Plex Mono', monospace";
  const textW = ctx.measureText(label).width;
  const tagY = Math.max(14, y - 8);
  ctx.fillStyle = "rgba(10,14,26,0.85)";
  ctx.fillRect(x, tagY - 14, textW + 12, 18);
  ctx.fillStyle = "#FFD79A";
  ctx.fillText(label, x + 6, tagY - 2);

  ctx.restore();
}

// ---------------------------------------------------------------------
// WiFi motion mode: render loop
//
// Styled like an aircraft/ship radar scope (PPI display): a rotating
// sweep line illuminates "contacts" that glow as the beam passes and
// fade until the next rotation -- the classic radar look. There is no
// video and no directional antenna array here, so this is a STYLED
// reconstruction, not a real bearing/range fix: how many contacts show
// up (0-2) and how bright they glow is derived only from the single
// aggregated 0-100 WiFi motion score from /api/presence, and each
// contact's angle/range is a smooth pseudo-random drift -- not a real
// measured position. A small on-canvas caption says so.
// ---------------------------------------------------------------------

let wifiRunning = false;
let wifiWanderT = Math.random() * 1000;
let radarAngle = 0; // current sweep angle, radians

function angularDistanceForward(from, to) {
  // How far the sweep has traveled past `to`, moving forward from `from`,
  // wrapped into [0, 2*PI). Used to fade a contact's afterglow.
  let d = (from - to) % (Math.PI * 2);
  if (d < 0) d += Math.PI * 2;
  return d;
}

function drawRadarScope(cx, cy, maxR) {
  // Range rings.
  ctx.save();
  ctx.strokeStyle = "rgba(79, 216, 196, 0.25)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath();
    ctx.arc(cx, cy, (maxR * i) / 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Degree spokes every 30deg.
  for (let deg = 0; deg < 360; deg += 30) {
    const rad = (deg * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(rad) * maxR, cy + Math.sin(rad) * maxR);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSweep(cx, cy, maxR, angle) {
  // Trailing wedge of afterglow behind the sweep line, then the bright
  // leading edge itself -- the classic rotating-radar look.
  const trailWidth = 0.9; // radians
  const grad = ctx.createConicGradient
    ? ctx.createConicGradient(angle - trailWidth, cx, cy)
    : null;

  ctx.save();
  if (grad) {
    grad.addColorStop(0, "rgba(79, 216, 196, 0.28)");
    grad.addColorStop(1, "rgba(79, 216, 196, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, maxR, angle - trailWidth, angle);
    ctx.closePath();
    ctx.fill();
  } else {
    // Fallback for browsers without conic gradients: a few translucent wedges.
    const steps = 12;
    for (let i = 0; i < steps; i++) {
      const a0 = angle - trailWidth + (trailWidth * i) / steps;
      const a1 = angle - trailWidth + (trailWidth * (i + 1)) / steps;
      ctx.fillStyle = `rgba(79, 216, 196, ${0.03 + 0.22 * (i / steps)})`;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, maxR, a0, a1);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.strokeStyle = "#B9F3E8";
  ctx.lineWidth = 2;
  ctx.shadowColor = "rgba(185, 243, 232, 0.8)";
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(angle) * maxR, cy + Math.sin(angle) * maxR);
  ctx.stroke();
  ctx.restore();
}

function drawContact(cx, cy, angle, range, freshness, label) {
  const x = cx + Math.cos(angle) * range;
  const y = cy + Math.sin(angle) * range;
  const alpha = 0.15 + freshness * 0.85;
  const r = 4 + freshness * 4;

  ctx.save();
  ctx.globalAlpha = alpha;

  const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
  glow.addColorStop(0, "rgba(255, 176, 59, 0.9)");
  glow.addColorStop(1, "rgba(255, 176, 59, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, r * 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#FFD79A";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  if (freshness > 0.55) {
    ctx.globalAlpha = Math.min(1, alpha + 0.1);
    ctx.font = "600 11px 'IBM Plex Mono', monospace";
    ctx.fillStyle = "#FFD79A";
    ctx.fillText(label, x + r + 6, y - r - 4);
  }
  ctx.restore();
}

function renderWifiFrame() {
  if (!wifiRunning) return;

  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Dark radar-scope background.
  const base = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
  base.addColorStop(0, "rgb(10,20,22)");
  base.addColorStop(1, "rgb(4,8,10)");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2, cy = h / 2;
  const maxR = Math.min(w, h) * 0.42;
  drawRadarScope(cx, cy, maxR);

  const score01 = wifiOk && presenceOk ? Math.min(1, presenceScore / 100) : 0;
  const sweepSpeed = 0.012 + score01 * 0.01; // busier readings sweep a bit faster
  radarAngle = (radarAngle + sweepSpeed) % (Math.PI * 2);
  wifiWanderT += 0.004;

  drawSweep(cx, cy, maxR, radarAngle);

  if (wifiOk && presenceOk && score01 > 0.04) {
    // Never more than 2 contacts, and the second only once the score is
    // well into "active" -- coarse and capped on purpose, not a headcount.
    const contactCount = score01 > 0.62 ? 2 : 1;

    for (let i = 0; i < contactCount; i++) {
      const phaseOffset = i * 2.6 + 1.1;
      const targetAngle = (wifiWanderT * 0.35 + phaseOffset) % (Math.PI * 2);
      const targetRange = maxR * (0.32 + 0.5 * (0.5 + 0.5 * Math.sin(wifiWanderT * 0.5 + phaseOffset)));

      const dist = angularDistanceForward(radarAngle, targetAngle);
      const decayWindow = 1.1; // radians of trailing afterglow
      const freshness = dist < decayWindow ? (1 - dist / decayWindow) * (0.4 + score01 * 0.6) : 0;

      if (freshness > 0.02) {
        drawContact(cx, cy, targetAngle, targetRange, freshness, "CONTACT");
      }
    }
  }

  // Center hub.
  ctx.save();
  ctx.fillStyle = "#4FD8C4";
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.95);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  if (!wifiOk) {
    ctx.fillStyle = "rgba(5,9,20,0.6)";
    ctx.fillRect(0, 0, w, h);
  }

  // Persistent honesty caption -- contacts react to one aggregated WiFi
  // motion score, not a real measured bearing/range.
  ctx.save();
  ctx.font = "500 10px 'IBM Plex Mono', monospace";
  ctx.fillStyle = "rgba(180, 200, 210, 0.55)";
  ctx.fillText("ILLUSTRATIVE — WiFi signal only, not a real bearing/range fix", 12, h - 12);
  ctx.restore();

  document.getElementById("thermal-ambient").textContent = wifiOk
    ? (presenceOk ? `score ${presenceScore.toFixed(0)}` : "sampling…")
    : "--.-";

  requestAnimationFrame(renderWifiFrame);
}

function startWifiMode() {
  const overlay = document.getElementById("thermal-start-overlay");
  activeMode = "wifi";
  wifiRunning = true;
  presenceOk = false;
  presenceLabel = "Gathering samples…";
  overlay.style.display = "none";
  document.getElementById("thermal-panel-title").textContent = "Human Detector — WiFi Radar (no camera)";
  updateWifiUI();
  pollPresence();
  requestAnimationFrame(renderWifiFrame);
}

function stopDetector() {
  // Return to the start overlay so the user can pick a mode again.
  const overlay = document.getElementById("thermal-start-overlay");
  const btn = document.getElementById("thermal-start-btn");

  if (cameraRunning && video.srcObject) {
    video.srcObject.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
  cameraRunning = false;
  wifiRunning = false;
  activeMode = null;
  latestBoxes = [];
  detectedCount = 0;

  btn.disabled = false;
  btn.textContent = "Start camera feed";
  overlay.querySelector("p").innerHTML =
    "Choose a detector mode. Camera mode uses your device camera and an on-device AI model. " +
    "WiFi Radar mode uses no camera at all -- it re-purposes live WiFi signal volatility into a rotating " +
    "radar-style sweep, so it reads the same in full daylight or total darkness.";
  overlay.style.display = "flex";
  document.getElementById("thermal-panel-title").textContent = "Human Detector";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  updateWifiUI();
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

document.getElementById("thermal-start-btn").addEventListener("click", startCamera);
document.getElementById("thermal-wifi-btn").addEventListener("click", startWifiMode);
document.getElementById("thermal-stop-btn").addEventListener("click", stopDetector);

updateWifiUI();
pollWifi();
setInterval(pollWifi, WIFI_POLL_MS);
setInterval(pollPresence, PRESENCE_POLL_MS);
