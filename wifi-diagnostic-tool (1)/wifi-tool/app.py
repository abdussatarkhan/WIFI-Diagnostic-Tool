"""
WiFi Diagnostic Tool — Flask backend
=====================================
Polls Windows' `netsh wlan show interfaces` for live signal data (your
adapter's link to its connected router), keeps a rolling in-memory history
for the strip chart, and runs speed tests in a background thread so the UI
never blocks.

Presence/motion sensing is driven separately, by a background scan of
*all* nearby routers/access points (`netsh wlan show networks mode=bssid`)
rather than just the one your laptop is connected to — see the
"Router scan" section below.

Run:
    python app.py
Then open http://127.0.0.1:5000
"""

import re
import statistics
import subprocess
import threading
import time
import uuid
from collections import deque
from datetime import datetime

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------

HISTORY_MAXLEN = 180  # ~6 minutes at 2s polling
history = deque(maxlen=HISTORY_MAXLEN)
history_lock = threading.Lock()

speed_jobs = {}
speed_jobs_lock = threading.Lock()

# Windows netsh output uses "Key    : Value" lines. This regex is tolerant of
# the variable-width padding netsh inserts between key and colon.
LINE_RE = re.compile(r"^\s*([A-Za-z0-9 ()/\.\-]+?)\s*:\s*(.*\S)?\s*$")


def _run_netsh():
    """Run `netsh wlan show interfaces` and return raw stdout text."""
    result = subprocess.run(
        ["netsh", "wlan", "show", "interfaces"],
        capture_output=True,
        text=True,
        timeout=5,
    )
    return result.stdout


def _parse_netsh_output(raw):
    """Parse netsh's key/value block into a dict keyed by lowercase field name."""
    fields = {}
    for line in raw.splitlines():
        m = LINE_RE.match(line)
        if not m:
            continue
        key, value = m.group(1).strip(), (m.group(2) or "").strip()
        if key:
            fields[key.lower()] = value
    return fields


def _signal_percent_to_dbm(percent):
    """Approximate RSSI (dBm) from Windows' 0-100% signal quality figure.

    Windows/NDIS does not expose raw RSSI through netsh, only a quality
    percentage. The formula below (percent/2 - 100) is the commonly used
    approximation for translating that quality figure back to a dBm-like
    scale. It's an estimate, not a hardware measurement.
    """
    try:
        return round((percent / 2) - 100, 1)
    except TypeError:
        return None


def get_wifi_snapshot():
    """Return a normalized snapshot of the current WiFi connection.

    Always returns a dict with an "ok" boolean. On any failure (not on
    Windows, no adapter, adapter off, etc.) ok=False and "error" explains why,
    while still returning a well-formed shape the frontend can render.
    """
    timestamp = datetime.now().isoformat(timespec="seconds")

    try:
        raw = _run_netsh()
    except FileNotFoundError:
        return {
            "ok": False,
            "error": "netsh not found. This tool reads Windows WiFi data via "
            "'netsh wlan show interfaces' and must run on Windows.",
            "timestamp": timestamp,
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Timed out calling netsh.", "timestamp": timestamp}
    except Exception as exc:  # pragma: no cover - defensive
        return {"ok": False, "error": f"Unexpected error: {exc}", "timestamp": timestamp}

    fields = _parse_netsh_output(raw)

    if not fields or "there is no wireless interface on the system" in raw.lower():
        return {
            "ok": False,
            "error": "No wireless interface detected.",
            "timestamp": timestamp,
        }

    state = fields.get("state", "unknown")
    if state.lower() != "connected":
        return {
            "ok": False,
            "error": f"Adapter state: {state or 'unknown'} (not connected to a network).",
            "timestamp": timestamp,
        }

    signal_raw = fields.get("signal", "0%").replace("%", "").strip()
    try:
        signal_percent = int(signal_raw)
    except ValueError:
        signal_percent = 0

    def _int_or_none(v):
        try:
            return int(re.sub(r"[^\d]", "", v))
        except (ValueError, TypeError):
            return None

    snapshot = {
        "ok": True,
        "timestamp": timestamp,
        "ssid": fields.get("ssid", "—"),
        "bssid": fields.get("bssid", "—"),
        "state": state,
        "radio_type": fields.get("radio type", "—"),
        "authentication": fields.get("authentication", "—"),
        "cipher": fields.get("cipher", "—"),
        "channel": _int_or_none(fields.get("channel", "")),
        "receive_rate_mbps": _int_or_none(fields.get("receive rate (mbps)", "")),
        "transmit_rate_mbps": _int_or_none(fields.get("transmit rate (mbps)", "")),
        "signal_percent": signal_percent,
        "signal_dbm_estimate": _signal_percent_to_dbm(signal_percent),
        "profile": fields.get("profile", "—"),
    }
    return snapshot


def _quality_band(percent):
    if percent >= 75:
        return "excellent"
    if percent >= 50:
        return "good"
    if percent >= 25:
        return "fair"
    return "poor"


# ---------------------------------------------------------------------------
# Router scan (multi-AP sensing)
# ---------------------------------------------------------------------------
# Presence/motion sensing intentionally does NOT use `netsh wlan show
# interfaces` (the signal quality of your laptop's own link to the one
# router it's associated with). Instead, a background thread periodically
# runs `netsh wlan show networks mode=bssid`, a WiFi *scan* that reports a
# live signal-quality reading for every router/access point currently
# broadcasting in range — your own router plus any visible neighbors.
# Motion sensing watches how THOSE readings jitter over time instead.
#
# This is still an RSSI/quality heuristic, not raw channel-state
# information (CSI) — real WiFi-CSI sensing hardware needs dedicated
# antennas and driver-level access this tool doesn't have. But because it
# now draws on however many routers are visible instead of a single link,
# a person walking between you and any of those routers can register,
# which is closer in spirit to real multi-AP WiFi sensing setups.

ROUTER_SCAN_INTERVAL = 3.0     # seconds between scans (a scan takes a moment; don't hammer it)
ROUTER_HISTORY_MAXLEN = 40     # ~2 minutes of scan samples per router
ROUTER_WINDOW = 12             # how many recent scans feed the motion score

router_lock = threading.Lock()
router_latest = []             # [{ssid, bssid, signal_percent, channel}], most recent scan
router_history = {}            # bssid -> deque of signal_percent values (recent scans, oldest first)
router_scan_error = None       # last scan error message, if any
router_scan_started = False

SSID_LINE_RE = re.compile(r"^\s*SSID\s+\d+\s*:\s*(.*\S)?\s*$")
BSSID_LINE_RE = re.compile(r"^\s*BSSID\s+\d+\s*:\s*([0-9A-Fa-f:]{17})\s*$")
SIGNAL_LINE_RE = re.compile(r"^\s*Signal\s*:\s*(\d+)%\s*$")
CHANNEL_LINE_RE = re.compile(r"^\s*Channel\s*:\s*(\d+)\s*$")


def _run_netsh_bssid_scan():
    """Run `netsh wlan show networks mode=bssid` and return raw stdout text."""
    result = subprocess.run(
        ["netsh", "wlan", "show", "networks", "mode=bssid"],
        capture_output=True,
        text=True,
        timeout=8,
    )
    return result.stdout


def _parse_bssid_scan(raw):
    """Parse `netsh wlan show networks mode=bssid` output into a flat list
    of {ssid, bssid, signal_percent, channel} — one entry per visible router
    radio (a router broadcasting on 2.4GHz + 5GHz shows up as two BSSIDs).
    """
    networks = []
    current_ssid = None
    current_bssid = None
    current_channel = None

    for line in raw.splitlines():
        m_ssid = SSID_LINE_RE.match(line)
        if m_ssid:
            current_ssid = (m_ssid.group(1) or "").strip() or "(hidden network)"
            current_bssid = None
            continue

        m_bssid = BSSID_LINE_RE.match(line)
        if m_bssid:
            current_bssid = m_bssid.group(1).lower()
            current_channel = None
            continue

        m_chan = CHANNEL_LINE_RE.match(line)
        if m_chan and current_bssid:
            current_channel = int(m_chan.group(1))
            continue

        m_sig = SIGNAL_LINE_RE.match(line)
        if m_sig and current_bssid:
            networks.append(
                {
                    "ssid": current_ssid,
                    "bssid": current_bssid,
                    "signal_percent": int(m_sig.group(1)),
                    "channel": current_channel,
                }
            )

    return networks


def _router_scan_loop():
    """Background loop: scan visible routers every ROUTER_SCAN_INTERVAL
    seconds and append each one's signal reading to its own rolling history.
    Runs forever in a daemon thread so /api/presence and /api/routers just
    read the latest cached state instead of triggering a scan per request
    (a scan can take a second or two).
    """
    global router_latest, router_scan_error
    while True:
        try:
            raw = _run_netsh_bssid_scan()
            networks = _parse_bssid_scan(raw)
            with router_lock:
                router_latest = networks
                router_scan_error = None
                for n in networks:
                    router_history.setdefault(
                        n["bssid"], deque(maxlen=ROUTER_HISTORY_MAXLEN)
                    ).append(n["signal_percent"])
        except FileNotFoundError:
            with router_lock:
                router_scan_error = (
                    "netsh not found. Router scanning needs Windows' "
                    "'netsh wlan show networks mode=bssid'."
                )
                router_latest = []
        except subprocess.TimeoutExpired:
            with router_lock:
                router_scan_error = "Router scan timed out."
        except Exception as exc:  # pragma: no cover - defensive
            with router_lock:
                router_scan_error = f"Router scan error: {exc}"
        time.sleep(ROUTER_SCAN_INTERVAL)


def _start_router_scan_thread():
    global router_scan_started
    if router_scan_started:
        return
    router_scan_started = True
    thread = threading.Thread(target=_router_scan_loop, daemon=True)
    thread.start()


def _multi_router_motion():
    """Aggregate per-router signal volatility across every currently-tracked
    BSSID into a single 0-100 motion score.

    For each router with enough samples, compute its own stdev + jitter
    (same math as the original single-AP heuristic), then average those
    per-router scores. A person moving through the space tends to disturb
    the radio path to more than one nearby router at once, so averaging
    across routers is a bit more robust than watching only one link — but
    it's still a coarse signal-quality heuristic, not real RF imaging.
    """
    with router_lock:
        snapshot = {bssid: list(vals)[-ROUTER_WINDOW:] for bssid, vals in router_history.items()}
        latest = list(router_latest)
        scan_error = router_scan_error

    per_router = []
    for bssid, values in snapshot.items():
        if len(values) < 5:
            continue
        stdev = statistics.pstdev(values) if len(values) > 1 else 0.0
        diffs = [abs(values[i] - values[i - 1]) for i in range(1, len(values))]
        jitter = statistics.mean(diffs) if diffs else 0.0
        score = min(100.0, stdev * 4 + jitter * 5)
        info = next((n for n in latest if n["bssid"] == bssid), None)
        per_router.append(
            {
                "bssid": bssid,
                "ssid": info["ssid"] if info else None,
                "signal_percent": info["signal_percent"] if info else None,
                "stdev": round(stdev, 2),
                "jitter": round(jitter, 2),
                "score": round(score, 1),
            }
        )

    per_router.sort(key=lambda r: r["score"], reverse=True)
    return per_router, scan_error, snapshot


def _classify_presence(motion_score):
    """Turn an aggregated 0-100 motion score into a label + level."""
    if motion_score < 12:
        return "Quiet — likely unoccupied", "quiet"
    if motion_score < 40:
        return "Possible movement nearby", "possible"
    return "Movement detected", "active"


def _router_trend(snapshot):
    """Same idea as the old single-AP trend check, but run per-router and
    averaged: is the *average* router's volatility rising, falling, or flat
    between the first and second half of its recent window?
    """
    diffs = []
    for values in snapshot.values():
        if len(values) < 6:
            continue
        mid = len(values) // 2
        first_half, second_half = values[:mid], values[mid:]
        vol_first = statistics.pstdev(first_half) if len(first_half) > 1 else 0.0
        vol_second = statistics.pstdev(second_half) if len(second_half) > 1 else 0.0
        diffs.append(vol_second - vol_first)
    if not diffs:
        return "steady"
    avg_diff = statistics.mean(diffs)
    if avg_diff > 2:
        return "intensifying"
    if avg_diff < -2:
        return "settling"
    return "steady"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


def poll_and_record():
    """Take one WiFi snapshot and append it to the shared history buffer.

    Used by /api/wifi and /api/history for the Diagnostics strip chart and
    connection status — presence/motion sensing now lives in the router
    scan above, not here.
    """
    snapshot = get_wifi_snapshot()
    if snapshot.get("ok"):
        snapshot["quality_band"] = _quality_band(snapshot["signal_percent"])
        with history_lock:
            history.append(
                {"t": snapshot["timestamp"], "signal_percent": snapshot["signal_percent"]}
            )
    return snapshot


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/presence")
def presence():
    return render_template("presence.html")


@app.route("/thermal")
def thermal():
    return render_template("thermal.html")


@app.route("/api/wifi")
def api_wifi():
    return jsonify(poll_and_record())


@app.route("/api/history")
def api_history():
    with history_lock:
        return jsonify(list(history))


@app.route("/api/routers")
def api_routers():
    """Current snapshot of every visible router/AP from the background scan."""
    _start_router_scan_thread()
    with router_lock:
        latest = list(router_latest)
        scan_error = router_scan_error
    if scan_error and not latest:
        return jsonify({"ok": False, "error": scan_error, "routers": []})
    return jsonify({"ok": True, "count": len(latest), "routers": latest})


@app.route("/api/presence")
def api_presence():
    _start_router_scan_thread()
    per_router, scan_error, snapshot = _multi_router_motion()

    if scan_error and not per_router:
        return jsonify(
            {
                "ok": False,
                "error": scan_error,
                "timestamp": datetime.now().isoformat(timespec="seconds"),
            }
        )

    if not per_router:
        return jsonify(
            {
                "ok": False,
                "error": "Scanning for nearby routers… keep this page open a few seconds.",
                "timestamp": datetime.now().isoformat(timespec="seconds"),
                "router_count": len(router_history),
            }
        )

    motion_score = round(statistics.mean(r["score"] for r in per_router), 1)
    label, level = _classify_presence(motion_score)
    trend = _router_trend(snapshot)

    return jsonify(
        {
            "ok": True,
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "router_count": len(per_router),
            "motion_score": motion_score,
            "label": label,
            "level": level,
            "trend": trend,
            "routers": per_router,
        }
    )


@app.route("/api/speedtest/start", methods=["POST"])
def api_speedtest_start():
    job_id = uuid.uuid4().hex
    with speed_jobs_lock:
        speed_jobs[job_id] = {"status": "running", "stage": "Finding best server…"}

    thread = threading.Thread(target=_run_speedtest_job, args=(job_id,), daemon=True)
    thread.start()
    return jsonify({"job_id": job_id})


@app.route("/api/speedtest/status/<job_id>")
def api_speedtest_status(job_id):
    with speed_jobs_lock:
        job = speed_jobs.get(job_id)
    if job is None:
        return jsonify({"status": "error", "error": "Unknown job id."}), 404
    return jsonify(job)


def _run_speedtest_job(job_id):
    def set_stage(stage):
        with speed_jobs_lock:
            speed_jobs[job_id]["stage"] = stage

    try:
        import speedtest  # imported lazily; heavy + network-touching on import path

        set_stage("Finding best server…")
        st = speedtest.Speedtest()
        st.get_best_server()

        set_stage("Testing download speed…")
        download_bps = st.download()

        set_stage("Testing upload speed…")
        upload_bps = st.upload()

        results = st.results.dict()

        with speed_jobs_lock:
            speed_jobs[job_id] = {
                "status": "done",
                "download_mbps": round(download_bps / 1_000_000, 2),
                "upload_mbps": round(upload_bps / 1_000_000, 2),
                "ping_ms": round(results.get("ping", 0), 1),
                "server": {
                    "name": results.get("server", {}).get("name"),
                    "sponsor": results.get("server", {}).get("sponsor"),
                    "country": results.get("server", {}).get("country"),
                },
                "isp": results.get("client", {}).get("isp"),
            }
    except ImportError:
        with speed_jobs_lock:
            speed_jobs[job_id] = {
                "status": "error",
                "error": "The 'speedtest-cli' package isn't installed. "
                "Run: pip install speedtest-cli",
            }
    except Exception as exc:
        with speed_jobs_lock:
            speed_jobs[job_id] = {"status": "error", "error": str(exc)}


if __name__ == "__main__":
    _start_router_scan_thread()
    app.run(debug=True, port=5000)
