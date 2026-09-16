import json
import os
import sys
import time
import traceback
from pathlib import Path
from datetime import datetime, timezone

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent
RECORDER_DIR = Path(__file__).resolve().parent

# Support reading from project root .env or local .env
for env_file in [PROJECT_ROOT / ".env", RECORDER_DIR / ".env"]:
    if env_file.exists():
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    key, val = line.split("=", 1)
                    os.environ.setdefault(key.strip(), val.strip())

ASSET = os.environ.get("IQO_ASSET", "XAU/XAG")
INTERVAL = int(os.environ.get("IQO_INTERVAL", 60))
MAX_CANDLES = int(os.environ.get("IQO_MAX_CANDLES", 0))  # 0 = infinite / continuous, per stream

custom_raw_dir = os.environ.get("RAW_DIR")
if custom_raw_dir:
    RAW_DIR = Path(custom_raw_dir)
else:
    RAW_DIR = PROJECT_ROOT / "research" / "execution" / "data_acquisition" / "raw"
RAW_DIR.mkdir(parents=True, exist_ok=True)


def safe_asset(asset: str) -> str:
    return asset.replace("/", "_").replace("\\", "_")


def stream_file(asset: str, interval: int) -> Path:
    """Canonical per-stream dataset path. Unchanged scheme (backward compatible)."""
    return RAW_DIR / f"IQO_{safe_asset(asset)}_{interval}s_raw.jsonl"


def parse_streams():
    """Parse IQO_STREAMS="ASSET:INTERVAL,..." into [(asset, interval)].

    Default (env absent): single stream from IQO_ASSET/IQO_INTERVAL, i.e.
    byte-identical behavior and file layout to the single-stream recorder.
    Malformed specs raise ValueError (fail closed at startup).
    """
    raw = os.environ.get("IQO_STREAMS", "").strip()
    if not raw:
        return [(ASSET, INTERVAL)]
    streams = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if ":" not in chunk:
            raise ValueError(f"Invalid IQO_STREAMS entry (expected ASSET:INTERVAL): {chunk!r}")
        asset, interval_s = chunk.rsplit(":", 1)
        asset = asset.strip()
        try:
            interval = int(interval_s.strip())
        except ValueError:
            raise ValueError(f"Invalid interval in IQO_STREAMS entry: {chunk!r}")
        if not asset or interval < 1:
            raise ValueError(f"Invalid IQO_STREAMS entry: {chunk!r}")
        if (asset, interval) not in streams:
            streams.append((asset, interval))
    if not streams:
        raise ValueError("IQO_STREAMS is empty after parsing")
    return streams


# Legacy single-stream aliases (backward compatibility for external importers).
SAFE_ASSET = safe_asset(ASSET)
RAW_FILE = stream_file(ASSET, INTERVAL)

# Reconnect parameters
MAX_RECONNECT_ATTEMPTS = 10
RECONNECT_DELAY_BASE = 5   # seconds, exponential backoff
CANDLE_POLL_INTERVAL = 0.5  # seconds
EMPTY_POLL_PATIENCE = 60    # seconds of empty polls before reconnecting
GET_CANDLES_ERROR_PATIENCE = 30  # seconds of continuous errors before reconnecting

# Shared catalog discovery cache
CATALOG_CACHE = {}


def log(msg):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] {msg}", flush=True)


def append_jsonl(path: Path, record: dict):
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, separators=(",", ":"), sort_keys=True))
        f.write("\n")


def create_adapter(email, password):
    """Create and connect an IQOptionAdapter. Returns (adapter, success)."""
    from iqoption_adapter import IQOptionAdapter
    try:
        adapter = IQOptionAdapter(email, password)
        adapter.connect()
        return adapter, True
    except Exception as e:
        log(f"Connection failed: {e}")
        return None, False


def new_stream_state(asset, interval):
    """Per-stream mutable session state (isolated across streams)."""
    return {
        "asset": asset,
        "interval": interval,
        "tag": f"[{asset}:{interval}s]",
        "raw_file": stream_file(asset, interval),
        "recorded_closed": set(),
        "closed_count": 0,
        "reconnect_attempt": 0,
        "last_data_time": time.time(),
        "consecutive_empty": 0,
        "consecutive_errors": 0,
        "last_forming_at": {},
        "done": False,
    }


def load_dedup(state):
    """Load previously recorded closed timestamps to avoid re-recording."""
    raw_file = state["raw_file"]
    if not raw_file.exists():
        return
    count = 0
    with raw_file.open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
                if rec.get("candle_status") == "CLOSED":
                    payload = rec.get("raw_payload", {})
                    ts = payload.get("from")
                    if ts is not None:
                        state["recorded_closed"].add(ts)
                        count += 1
            except Exception:
                pass
    state["closed_count"] = count
    log(f"{state['tag']} Loaded {count} previously recorded closed candles (dedup)")


def start_stream(adapter, state):
    adapter.start_candles(state["asset"], state["interval"], maxdict=100)
    log(f"{state['tag']} Candle stream started")


def stop_stream(adapter, state):
    try:
        adapter.stop_candles(state["asset"], state["interval"])
    except Exception:
        pass


def poll_stream(adapter, state, server_ts):
    """Run one poll cycle for a single stream.

    Returns "ok" | "reconnect" | "finished".
    Raises KeyboardInterrupt upward; isolates all other failures to this stream.
    """
    asset = state["asset"]
    interval = state["interval"]
    tag = state["tag"]
    try:
        candles = adapter.get_candles(asset, interval)
        state["consecutive_errors"] = 0  # Reset error counter on success
    except RuntimeError as e:
        state["consecutive_errors"] += 1
        if state["consecutive_errors"] == 1:
            log(f"{tag} get_candles error: {e}")
        if state["consecutive_errors"] * CANDLE_POLL_INTERVAL > GET_CANDLES_ERROR_PATIENCE:
            log(f"{tag} Persistent candle errors for {GET_CANDLES_ERROR_PATIENCE}s. Reconnecting stream...")
            return "reconnect"
        return "ok"
    except Exception as e:
        # Unexpected failure: isolate to this stream (never kills siblings).
        log(f"{tag} Unexpected error in candle poll: {e}")
        traceback.print_exc()
        return "reconnect"

    if not candles:
        state["consecutive_empty"] += 1
        elapsed = time.time() - state["last_data_time"]
        if elapsed > EMPTY_POLL_PATIENCE:
            log(f"{tag} No candles for {EMPTY_POLL_PATIENCE}s. Market may be closed. Reconnecting stream...")
            return "reconnect"
        return "ok"

    state["consecutive_empty"] = 0
    state["last_data_time"] = time.time()

    for candle_ts in sorted(candles.keys()):
        candle = candles[candle_ts]

        # Check if candle interval has fully concluded
        is_closed = server_ts >= (candle_ts + interval)

        if is_closed:
            if candle_ts in state["recorded_closed"]:
                continue

            record = {
                "source": "IQ_OPTION_STREAM",
                "asset": asset,
                "interval_requested": interval,
                "candle_status": "CLOSED",
                "local_timestamp": time.time(),
                "server_timestamp_original": server_ts,
                "raw_payload": candle
            }
            append_jsonl(state["raw_file"], record)
            state["recorded_closed"].add(candle_ts)
            state["closed_count"] += 1
            log(f"{tag} CLOSED #{state['closed_count']} | TS: {candle_ts} | Close: {candle.get('close')} | Vol: {candle.get('volume')}")

        else:
            # Forming candle: log snapshot if updated
            current_at = candle.get("at")
            if state["last_forming_at"].get(candle_ts) != current_at:
                state["last_forming_at"][candle_ts] = current_at
                record = {
                    "source": "IQ_OPTION_STREAM",
                    "asset": asset,
                    "interval_requested": interval,
                    "candle_status": "FORMING",
                    "local_timestamp": time.time(),
                    "server_timestamp_original": server_ts,
                    "raw_payload": candle
                }
                append_jsonl(state["raw_file"], record)

    if MAX_CANDLES > 0 and state["closed_count"] >= MAX_CANDLES:
        log(f"{tag} Target of {MAX_CANDLES} closed candles reached. Stopping stream.")
        state["done"] = True
        return "finished"

    return "ok"


def run_sessions(adapter, states):
    """Run recording sessions across all streams on one shared connection.

    Returns (all_finished). A per-stream "reconnect" restarts only that
    stream's candle feed; a server-timestamp failure breaks the whole
    session back to the outer connection backoff (as before).
    """
    for state in states:
        if state["done"]:
            continue
        try:
            start_stream(adapter, state)
        except Exception as e:
            log(f"{state['tag']} Failed to start candle stream: {e}")
            return False

    server_errors = 0
    try:
        while True:
            if all(s["done"] for s in states):
                return True
            try:
                server_ts = adapter.server_timestamp()
                server_errors = 0
            except Exception as e:
                server_errors += 1
                if server_errors == 1:
                    log(f"server_timestamp error: {e}")
                if server_errors * CANDLE_POLL_INTERVAL > GET_CANDLES_ERROR_PATIENCE:
                    log("Persistent server_timestamp errors. Reconnecting session...")
                    return False
                time.sleep(CANDLE_POLL_INTERVAL)
                continue

            for state in states:
                if state["done"]:
                    continue
                try:
                    action = poll_stream(adapter, state, server_ts)
                except KeyboardInterrupt:
                    raise
                except Exception as e:
                    log(f"{state['tag']} Session error: {e}")
                    traceback.print_exc()
                    action = "reconnect"
                if action == "reconnect":
                    stop_stream(adapter, state)
                    state["consecutive_empty"] = 0
                    state["consecutive_errors"] = 0
                    try:
                        start_stream(adapter, state)
                    except Exception as e:
                        log(f"{state['tag']} Failed to restart candle stream: {e}")
                        return False
                elif action == "finished":
                    stop_stream(adapter, state)

            time.sleep(CANDLE_POLL_INTERVAL)

    except KeyboardInterrupt:
        log("Recorder stopped by user.")
        return True
    finally:
        for state in states:
            if not state["done"]:
                stop_stream(adapter, state)


def main():
    email = os.environ.get("IQO_EMAIL")
    password = os.environ.get("IQO_PASSWORD")

    if not email or not password:
        log("ERROR: IQO_EMAIL and IQO_PASSWORD must be set in .env or system.")
        return

    streams = parse_streams()
    states = [new_stream_state(asset, interval) for asset, interval in streams]

    log("=" * 60)
    log("IQ Option Recorder v2.1 — Resilient Daemon Mode (multi-stream)")
    for state in states:
        log(f"Stream: {state['asset']} | Interval: {state['interval']}s | "
            f"Max: {'infinite' if MAX_CANDLES == 0 else MAX_CANDLES} | Output: {state['raw_file']}")
    log("=" * 60)

    for state in states:
        load_dedup(state)

    reconnect_attempt = 0

    while True:
        if all(s["done"] for s in states):
            break
        log(f"Connecting to IQ Option (attempt {reconnect_attempt + 1})...")
        adapter, ok = create_adapter(email, password)

        if not ok:
            reconnect_attempt += 1
            if reconnect_attempt > MAX_RECONNECT_ATTEMPTS:
                log(f"Max reconnect attempts ({MAX_RECONNECT_ATTEMPTS}) exceeded. Waiting 5 minutes...")
                reconnect_attempt = 0
                time.sleep(300)
            else:
                delay = min(RECONNECT_DELAY_BASE * (2 ** (reconnect_attempt - 1)), 120)
                log(f"Retrying in {delay}s...")
                time.sleep(delay)
            continue

        log("Connection successful. Practice mode asserted.")
        reconnect_attempt = 0  # Reset on successful connection

        # Probe catalog for configured streams to avoid unverified assumptions
        stream_assets = list(dict.fromkeys([s["asset"] for s in states] + ["XAU/XAG", "XAUUSD"]))
        try:
            if hasattr(adapter, "get_catalog_metadata"):
                meta = adapter.get_catalog_metadata(stream_assets)
                if isinstance(meta, dict):
                    CATALOG_CACHE.update(meta)
                    cat_file = RAW_DIR / "VENUE_CATALOG_DISCOVERY.json"
                    with cat_file.open("w", encoding="utf-8") as cf:
                        json.dump(CATALOG_CACHE, cf, indent=2)
                    log(f"Venue catalog discovery updated for: {list(CATALOG_CACHE.keys())}")
        except Exception as e:
            log(f"Venue catalog discovery non-fatal warning: {e}")

        all_finished = run_sessions(adapter, states)

        if all_finished and all(s["done"] for s in states):
            break

        # Reconnect with backoff
        reconnect_attempt += 1
        if reconnect_attempt > MAX_RECONNECT_ATTEMPTS:
            log("Max reconnect attempts exceeded. Sleeping 5 minutes before reset...")
            reconnect_attempt = 0
            time.sleep(300)
        else:
            delay = min(RECONNECT_DELAY_BASE * (2 ** (reconnect_attempt - 1)), 120)
            log(f"Reconnecting in {delay}s...")
            time.sleep(delay)

    total = sum(s["closed_count"] for s in states)
    log(f"Recorder finished. Total closed candles: {total}")
    log("Candle stream stopped gracefully.")


if __name__ == "__main__":
    main()
