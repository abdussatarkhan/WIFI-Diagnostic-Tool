# Signal Room — WiFi Diagnostic Tool

A Flask backend paired with a live browser dashboard for monitoring WiFi
signal strength on Windows: a compass-style signal dial, a live strip chart,
a link-detail panel, an integrated speed test, a "Presence Watch" page that
estimates nearby movement from signal volatility, and a "Thermal View" page
with a camera-based person detector and a camera-free WiFi radar mode.

![status](https://img.shields.io/badge/platform-Windows-blue) ![status](https://img.shields.io/badge/backend-Flask-black)

---

## Screenshots

<!--
Drop your own screenshots in a folder (e.g. /docs/screenshots/) and swap
the placeholder paths below to point at them, one per page/mode.
-->

### Diagnostics

<img width="2478" height="1539" alt="Signal Room — WiFi Diagnostic Tool (127 0 0 1_5000) - wifi-tool - Visual Studio Code 7_8_2026 7_16_03 AM" src="https://github.com/user-attachments/assets/ccf17bd5-ae4a-439e-9d05-f39c6ab4b920" />


### Presence Watch

<img width="2478" height="1539" alt="Signal Room — WiFi Diagnostic Tool (127 0 0 1_5000) - wifi-tool - Visual Studio Code 7_8_2026 7_16_19 AM" src="https://github.com/user-attachments/assets/0c1d2dba-9d48-419a-8931-cf3c2da5d6ed" />


### Thermal View 

<img width="2478" height="1539" alt="Signal Room — WiFi Diagnostic Tool (127 0 0 1_5000) - wifi-tool - Visual Studio Code 7_8_2026 7_17_11 AM" src="https://github.com/user-attachments/assets/708b0178-ae7c-4b6a-9889-8255e562d71c" />


## How it works

- The backend calls Windows' built-in `netsh wlan show interfaces` command
  every time the dashboard polls `/api/wifi` (every 2 seconds), and parses
  the SSID, BSSID, radio type, channel, link rates, and signal quality (%)
  out of its text output.
- Windows doesn't expose raw RSSI (dBm) through `netsh`, only a 0–100%
  quality figure, so the backend estimates dBm using the common
  `dBm ≈ (percent / 2) − 100` approximation. This is clearly labeled as an
  estimate in the UI, not a hardware measurement.
- A rolling in-memory history (last ~6 minutes of samples) feeds the strip
  chart, so refreshing the page doesn't lose your recent trend.
- Speed tests run in a background thread via `speedtest-cli` and are polled
  from the frontend as a job (start → poll status → done), so the UI never
  blocks or times out on a slow connection.
- **Presence Watch** (`/presence`) does *not* use `/api/wifi`'s data (your
  laptop's own link quality to the router it's connected to). Instead a
  background thread runs `netsh wlan show networks mode=bssid` — a WiFi
  *scan* — every ~3 seconds, reading a live signal-quality figure for
  *every* router/access point currently broadcasting nearby (yours plus
  any visible neighbors), and keeps a short rolling history per router. For
  each router it computes standard deviation + average sample-to-sample
  jitter over its recent readings, turns that into a 0–100 sub-score, then
  averages across all visible routers into one 0–100 "motion score" — the
  idea being that a person moving through the space adds volatility to
  multiple nearby routers' signal at once that a static, empty room
  doesn't. This is a heuristic built on a coarse 0–100% quality figure per
  router, not a calibrated sensor (see *Notes & limitations*).
- **Thermal View** (`/thermal`) offers two selectable detector modes:
  - *Camera mode* uses your device's camera plus an on-device
    TensorFlow.js/COCO-SSD model to detect people and draw bracketed
    boxes over them, with the whole feed remapped through a false-color
    thermal palette. The detection overlay only "arms" while `/api/wifi`
    reports a usable signal — drop below that threshold (or disconnect)
    and it disarms and dims, standing in for "outside the WiFi coverage
    area." All video processing happens locally in the browser; no
    frames are uploaded anywhere. Like any visible-light camera, it
    needs enough ambient light to see by.
  - *WiFi Radar mode* uses **no camera at all**. It reuses the exact
    same multi-router signal-quality-volatility heuristic as Presence
    Watch (`/api/presence`) and renders it as a rotating radar sweep
    (like an aircraft/ship PPI scope) with glowing "contacts" that light
    up as the beam passes, instead of numbered bounding boxes. Because it
    never touches a camera or light sensor, it reads identically in full
    daylight or total darkness. It is still the same coarse, multi-router
    heuristic described above — it can indicate "movement likely nearby,"
    not fix a real bearing/range or count, identify, or locate people the
    way a camera or a real directional-antenna radar/WiFi-CSI setup can.

---

## Requirements

- **Windows** (the WiFi data source is `netsh`, a Windows-only command).
- Python 3.9+
- An active WiFi connection to see live data.

## Setup

```bash
cd wifi-diagnostic-tool
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

## Run

```bash
python app.py
```

Then open **http://127.0.0.1:5000** in your browser.

---

## Project structure

```
wifi-diagnostic-tool/
├── app.py                 # Flask backend: netsh parsing, history, speed test jobs, presence heuristic
├── requirements.txt
├── templates/
│   ├── index.html         # Diagnostics dashboard markup
│   └── presence.html      # Presence Watch page markup
└── static/
    ├── style.css           # "Signal Room" console theme (shared by both pages)
    ├── app.js               # Dial rendering, strip chart, polling, speed test UI
    └── presence.js          # Motion-score gauge, volatility chart, sensitivity slider
```

---

## API reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/wifi` | GET | Current WiFi snapshot (SSID, signal %, estimated dBm, link rates, etc.) — your laptop's own link |
| `/api/history` | GET | Recent signal-percent history for the strip chart (from `/api/wifi`) |
| `/api/routers` | GET | Latest scan snapshot of every visible router/AP (SSID, BSSID, signal %, channel) |
| `/api/presence` | GET | Multi-router aggregated stdev/jitter of signal quality plus a heuristic motion score, label, trend, and per-router breakdown |
| `/api/speedtest/start` | POST | Kicks off a background speed test, returns a `job_id` |
| `/api/speedtest/status/<job_id>` | GET | Poll for speed test progress/result |

---

## Notes & limitations

- If you run this on macOS/Linux, `/api/wifi` will return
  `{"ok": false, "error": "netsh not found..."}` and the dashboard will show
  a clear "not connected" state rather than crashing — but you'll need
  Windows to see live signal data. `/api/routers` and `/api/presence`
  behave the same way if the router scan can't run.
- The dBm figure is an estimate derived from the quality percentage, not a
  raw radio measurement — Windows doesn't expose true RSSI through `netsh`.
- Speed tests use whatever server `speedtest-cli` selects as "best" for your
  connection; results can vary run to run like any speed test.
- **Presence Watch is a heuristic, not a sensor.** It reads the coarse
  0–100% signal-quality figure `netsh` reports for each visible router —
  not raw channel state information (CSI), which is what dedicated
  WiFi-sensing hardware uses for real device-free detection. Other WiFi
  traffic, moving devices besides people, microwave ovens, and even
  weather can shift the score. Averaging across however many routers
  happen to be visible makes the reading a bit more robust than watching a
  single link, but it's still an experiment for learning about RF sensing,
  not something to rely on for security, safety, or unattended monitoring
  decisions.
- **Thermal View's "range" is a signal-quality gate, not a distance
  measurement.** Camera mode reuses `signal_percent` from `/api/wifi` to
  decide whether the overlay is "in range," and displays an illustrative
  coverage-radius estimate — it does not calculate real physical distance
  and isn't a hardware IR sensor. Person detection quality depends on your
  webcam, lighting, and the COCO-SSD model, like any browser-based CV demo.
- **WiFi Radar mode is the same heuristic as Presence Watch, wearing a
  different skin.** It has no camera and no light dependency, which is
  exactly why it works "day or night" — but it's built on the same coarse
  0–100% signal-quality figure per router, not raw channel state
  information (CSI) and not a phased/directional antenna array like a real
  radar uses to fix bearing and range. It can't localize a person, count
  how many are present, or tell people apart from pets, fans, or other
  moving objects disturbing the radio path to nearby routers. Treat it the
  same way as Presence Watch: an experiment for learning about RF sensing,
  not something to rely on for security, safety, or unattended monitoring.

---

## Customizing

- Polling interval: change `POLL_MS` in `static/app.js` or `static/presence.js`.
- History length: change `HISTORY_MAXLEN` in `app.py`.
- Router scan interval / how many scans feed the motion score:
  `ROUTER_SCAN_INTERVAL` and `ROUTER_WINDOW` in `app.py`.
- Signal quality bands (excellent/good/fair/poor thresholds): `_quality_band()`
  in `app.py` and the mirrored `bandFromPercent()` in `static/app.js`.
- Presence window size: `PRESENCE_WINDOW` in `app.py`.
- Motion-score formula and quiet/possible/active thresholds: `_classify_presence()`
  in `app.py`, mirrored in `classify()` in `static/presence.js`. The in-page
  sensitivity slider scales the score without needing a server round trip.
