"""
Cloud Entrypoint & Web Dashboard for IQ Option XAU/XAG Data Recorder
Runs the recorder daemon in a background thread and exposes an HTTP server
for health checks (Railway), live metrics, and one-click JSONL dataset download.
"""
import os
import sys
import time
import json
import socket
import threading
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timezone

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent.parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

from iqoption_adapter import CONNECTION_STATE, CONNECT_TIMEOUT_S

# Configuration
PORT = int(os.environ.get("PORT", 8080))
RAW_DIR_ENV = os.environ.get("RAW_DIR")
if RAW_DIR_ENV:
    RAW_DIR = Path(RAW_DIR_ENV)
else:
    RAW_DIR = PROJECT_ROOT / "research" / "execution" / "data_acquisition" / "raw"
RAW_DIR.mkdir(parents=True, exist_ok=True)

ASSET = os.environ.get("IQO_ASSET", "XAU/XAG")
INTERVAL = int(os.environ.get("IQO_INTERVAL", 60))
SAFE_ASSET = ASSET.replace("/", "_").replace("\\", "_")
RAW_FILE = RAW_DIR / f"IQO_{SAFE_ASSET}_{INTERVAL}s_raw.jsonl"
TARGET_CANDLES = 10000

START_TIME = time.time()
recorder_status = {
    "connected": False,
    "last_error": None,
    "last_heartbeat": None,
    "session_closed_count": 0
}


def get_file_stats():
    """Scans RAW_FILE to get exact closed candle count and size."""
    if not RAW_FILE.exists():
        return {
            "total_lines": 0,
            "closed_candles": 0,
            "forming_candles": 0,
            "size_bytes": 0,
            "last_closed_timestamp": None,
            "last_closed_price": None
        }
    
    size = RAW_FILE.stat().st_size
    closed_count = 0
    forming_count = 0
    total = 0
    last_closed_ts = None
    last_closed_price = None

    try:
        with RAW_FILE.open("r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                total += 1
                try:
                    record = json.loads(line)
                    status = record.get("candle_status")
                    if status == "CLOSED":
                        closed_count += 1
                        payload = record.get("raw_payload", {})
                        last_closed_ts = payload.get("from")
                        last_closed_price = payload.get("close")
                    elif status == "FORMING":
                        forming_count += 1
                except Exception:
                    pass
    except Exception as e:
        recorder_status["last_error"] = str(e)

    return {
        "total_lines": total,
        "closed_candles": closed_count,
        "forming_candles": forming_count,
        "size_bytes": size,
        "last_closed_timestamp": last_closed_ts,
        "last_closed_price": last_closed_price
    }


class CloudRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress noisy HTTP request logs for /health
        if "/health" in self.path:
            return
        super().log_message(format, *args)

    def do_GET(self):
        if self.path == "/health":
            self.handle_health()
        elif self.path == "/metrics":
            self.handle_metrics()
        elif self.path == "/download":
            self.handle_download()
        elif self.path == "/" or self.path == "/index.html":
            self.handle_dashboard()
        else:
            self.send_error(404, "Endpoint not found")

    def handle_health(self):
        stats = get_file_stats()
        data = {
            "status": "healthy",
            "uptime_seconds": int(time.time() - START_TIME),
            "closed_candles": stats["closed_candles"],
            "target_candles": TARGET_CANDLES,
            "file_size_bytes": stats["size_bytes"],
            "recorder_connected": bool(CONNECTION_STATE["connected"]),
            "connect_consecutive_failures": CONNECTION_STATE["consecutive_failures"],
            "connect_last_error": CONNECTION_STATE["last_error"],
            "connect_last_error_at": CONNECTION_STATE["last_error_at"],
            "connect_timeout_s": CONNECT_TIMEOUT_S,
            "last_heartbeat": recorder_status["last_heartbeat"]
        }
        payload = json.dumps(data).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def handle_metrics(self):
        stats = get_file_stats()
        data = {
            "asset": ASSET,
            "interval_seconds": INTERVAL,
            "raw_file_path": str(RAW_FILE),
            "target_candles": TARGET_CANDLES,
            "connect_timeout_s": CONNECT_TIMEOUT_S,
            "connection": dict(CONNECTION_STATE),
            "progress_percent": round((stats["closed_candles"] / TARGET_CANDLES) * 100, 2),
            "stats": stats,
            "recorder_status": recorder_status,
            "uptime_seconds": int(time.time() - START_TIME)
        }
        payload = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def handle_download(self):
        if not RAW_FILE.exists() or RAW_FILE.stat().st_size == 0:
            self.send_error(404, "No recorded data file found yet.")
            return

        size = RAW_FILE.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", "application/x-jsonlines")
        self.send_header("Content-Disposition", f'attachment; filename="{RAW_FILE.name}"')
        self.send_header("Content-Length", str(size))
        self.end_headers()

        # Stream file in chunks to avoid memory pressure
        with RAW_FILE.open("rb") as f:
            while chunk := f.read(64 * 1024):
                self.wfile.write(chunk)

    def handle_dashboard(self):
        stats = get_file_stats()
        closed = stats["closed_candles"]
        pct = min(100.0, round((closed / TARGET_CANDLES) * 100, 2))
        size_mb = round(stats["size_bytes"] / (1024 * 1024), 2)
        uptime_h = round((time.time() - START_TIME) / 3600, 2)
        
        last_ts_str = "N/A"
        if stats["last_closed_timestamp"]:
            last_ts_str = datetime.fromtimestamp(stats["last_closed_timestamp"], tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

        conn_badge = '<span style="color:#22c55e;font-weight:bold;">CONNECTED</span>' if CONNECTION_STATE["connected"] else '<span style="color:#eab308;font-weight:bold;">STANDBY / POLLING</span>'
        connect_err = CONNECTION_STATE["last_error"]
        err_html = ""
        if connect_err:
            err_html = f'<div class="metric" style="margin-bottom: 24px;"><div class="metric-label">Last Connection Error</div><div style="font-size: 13px; margin-top: 4px;">{connect_err}</div></div>'
        
        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IQ Option Data Recorder | Active 2071</title>
  <meta http-equiv="refresh" content="15">
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f3f4f6; margin: 0; padding: 24px; }}
    .card {{ background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 24px; max-width: 720px; margin: 0 auto; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }}
    h1 {{ font-size: 22px; margin-top: 0; color: #38bdf8; display: flex; align-items: center; justify-content: space-between; }}
    .subtitle {{ color: #9ca3af; font-size: 13px; margin-bottom: 24px; }}
    .grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }}
    .metric {{ background: #1f2937; padding: 14px 18px; border-radius: 8px; }}
    .metric-label {{ font-size: 11px; text-transform: uppercase; color: #9ca3af; letter-spacing: 0.05em; }}
    .metric-val {{ font-size: 22px; font-weight: 700; margin-top: 4px; color: #ffffff; }}
    .progress-box {{ margin-bottom: 24px; }}
    .progress-bar-bg {{ background: #1f2937; height: 16px; border-radius: 8px; overflow: hidden; position: relative; }}
    .progress-bar-fill {{ background: linear-gradient(90deg, #38bdf8, #22c55e); height: 100%; border-radius: 8px; transition: width 0.3s; }}
    .progress-labels {{ display: flex; justify-content: space-between; font-size: 12px; color: #9ca3af; margin-top: 6px; }}
    .btn {{ display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 8px; font-weight: 600; font-size: 14px; text-align: center; cursor: pointer; transition: background 0.2s; }}
    .btn:hover {{ background: #1d4ed8; }}
    .btn-secondary {{ background: #374151; margin-left: 10px; }}
    .btn-secondary:hover {{ background: #4b5563; }}
    .footer {{ font-size: 11px; color: #6b7280; text-align: center; margin-top: 24px; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>
      <span>IQ Option Recorder — XAU/XAG</span>
      {conn_badge}
    </h1>
    <div class="subtitle">Continuous M1 Data Acquisition for Level 2 Fidelity Audit | Active 2071 (Ouro/Prata)</div>

    <div class="progress-box">
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" style="width: {pct}%;"></div>
      </div>
      <div class="progress-labels">
        <span>Progress: <strong>{closed} / {TARGET_CANDLES}</strong> candles</span>
        <span><strong>{pct}%</strong> Complete</span>
      </div>
    </div>

    <div class="grid">
      <div class="metric">
        <div class="metric-label">Closed Candles (M1)</div>
        <div class="metric-val">{closed}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Dataset File Size</div>
        <div class="metric-val">{size_mb} MB</div>
      </div>
      <div class="metric">
        <div class="metric-label">Last Recorded Price</div>
        <div class="metric-val">{stats['last_closed_price'] if stats['last_closed_price'] is not None else 'Waiting...'}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Uptime</div>
        <div class="metric-val">{uptime_h} hrs</div>
      </div>
    </div>

      <div class="metric" style="margin-bottom: 24px;">
        <div class="metric-label">Last Closed Timestamp (UTC)</div>
        <div style="font-size: 14px; font-weight: 600; margin-top: 4px;">{last_ts_str}</div>
      </div>

      {err_html}

    <div style="display:flex; justify-content: space-between; align-items: center;">
      <a href="/download" class="btn">📥 Download Dataset (.jsonl)</a>
      <div>
        <a href="/metrics" class="btn btn-secondary" target="_blank">JSON Metrics</a>
        <a href="/health" class="btn btn-secondary" target="_blank">Healthcheck</a>
      </div>
    </div>

    <div class="footer">
      Quantitative Governance: Fail-Closed | Zero Code Modification | Target: N &ge; 10,000 for Phase 4 Fidelity Audit
    </div>
  </div>
</body>
</html>
"""
        payload = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def run_recorder_thread():
    """Runs the recorder loop in background."""
    print(f"[{datetime.now(timezone.utc).isoformat()}] Starting recorder background thread...", flush=True)
    # Process-wide bound for third-party socket calls without an explicit
    # timeout, so a stalled venue handshake eventually fails instead of
    # hanging forever. The dashboard socket is reset to blocking in main().
    socket.setdefaulttimeout(CONNECT_TIMEOUT_S)
    import recorder
    
    # Monkey-patch or hook into recorder to update status
    while True:
        try:
            email = os.environ.get("IQO_EMAIL")
            password = os.environ.get("IQO_PASSWORD")
            if not email or not password:
                recorder_status["last_error"] = "Credentials missing (IQO_EMAIL / IQO_PASSWORD)"
                recorder_status["connected"] = False
                time.sleep(10)
                continue

            recorder_status["last_heartbeat"] = datetime.now(timezone.utc).isoformat()
            # Run recorder main
            recorder.main()
        except Exception as e:
            recorder_status["last_error"] = str(e)
            recorder_status["connected"] = False
            print(f"[RECORDER ERROR] {e}", flush=True)
            time.sleep(5)


def main():
    print(f"================================================================", flush=True)
    print(f"RAILWAY CLOUD RECORDER & DASHBOARD (PORT {PORT})", flush=True)
    print(f"Storage Path: {RAW_FILE}", flush=True)
    print(f"Target: {ASSET} (Interval: {INTERVAL}s, Goal: {TARGET_CANDLES})", flush=True)
    print(f"================================================================\n", flush=True)

    # Start background recorder thread
    t = threading.Thread(target=run_recorder_thread, daemon=True)
    t.start()

    # Start HTTP server
    server = HTTPServer(("0.0.0.0", PORT), CloudRequestHandler)
    # The recorder thread sets a process-wide default socket timeout; the
    # dashboard socket must stay blocking (serve_forever() uses select()).
    server.socket.settimeout(None)
    print(f"HTTP Server listening on 0.0.0.0:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Shutting down...", flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
