import os
import threading
import time
from datetime import datetime, timezone
import iqoptionapi.constants as OP_code
from iqoptionapi.stable_api import IQ_Option

# Pre-populate dynamic Fusion CFDs to avoid WebSocket reverse-lookup failures
OP_code.ACTIVES["XAU/XAG"] = 2071
OP_code.ACTIVES["XAU/XAG-OTC"] = 2086

# Explicit bound for the third-party venue handshake. The iqoptionapi
# connect() call has no effective timeout: a stalled handshake blocks the
# recorder thread forever with zero log output (observed on Railway
# 2026-09-14: attempt 1 hung >25 min). Fail closed on expiry.
CONNECT_TIMEOUT_S = int(os.environ.get("IQO_CONNECT_TIMEOUT", "90"))

# Single source of truth for venue connectivity known to this process.
# Consumed by cloud_entrypoint.py (/health, /metrics, dashboard badge).
CONNECTION_STATE = {
    "connected": False,
    "last_ok_at": None,
    "consecutive_failures": 0,
    "last_error": None,
    "last_error_at": None,
}

class IQOptionAdapter:
    """
    Observation-only adapter for IQ Option market data.
    Strictly read-only; no trade or order execution endpoints are exposed.
    """
    def __init__(self, email: str, password: str):
        if not email or not password:
            raise ValueError("IQ Option credentials are required")
        self.api = IQ_Option(email, password)

    @staticmethod
    def _record_failure(message: str) -> None:
        CONNECTION_STATE["connected"] = False
        CONNECTION_STATE["consecutive_failures"] += 1
        CONNECTION_STATE["last_error"] = message
        CONNECTION_STATE["last_error_at"] = datetime.now(timezone.utc).isoformat()

    def connect(self) -> None:
        outcome = {}

        def _do_connect():
            try:
                outcome["result"] = self.api.connect()
            except Exception as exc:  # capture any handshake failure
                outcome["error"] = exc

        worker = threading.Thread(target=_do_connect, daemon=True)
        worker.start()
        worker.join(timeout=CONNECT_TIMEOUT_S)
        if worker.is_alive():
            # Handshake hung past the explicit bound. The orphaned worker
            # stays blocked on its socket (bounded separately by the
            # process-wide default socket timeout); surface and retry.
            self._record_failure(
                f"IQ Option connect timeout after {CONNECT_TIMEOUT_S}s "
                "(handshake hung, retrying)"
            )
            raise RuntimeError(CONNECTION_STATE["last_error"])
        if "error" in outcome:
            self._record_failure(f"IQ Option connect raised: {outcome['error']}")
            raise RuntimeError(CONNECTION_STATE["last_error"])

        ok, reason = outcome.get("result", (False, "empty connect outcome"))
        if not ok:
            self._record_failure(f"IQ Option connection failed: {reason}")
            raise RuntimeError(CONNECTION_STATE["last_error"])

        # Ensure we are in practice mode for safety
        self.api.change_balance("PRACTICE")
        CONNECTION_STATE["connected"] = True
        CONNECTION_STATE["last_ok_at"] = datetime.now(timezone.utc).isoformat()
        CONNECTION_STATE["consecutive_failures"] = 0

    def server_timestamp(self) -> float:
        ts = self.api.get_server_timestamp()
        if not isinstance(ts, (int, float)):
            raise RuntimeError("Invalid server timestamp")
        return float(ts)

    def start_candles(self, asset: str, interval: int = 60, maxdict: int = 100):
        self.api.start_candles_stream(asset, interval, maxdict)

    def get_candles(self, asset: str, interval: int = 60):
        data = self.api.get_realtime_candles(asset, interval)
        if not isinstance(data, dict):
            raise RuntimeError("Invalid candle payload")
        # Snapshot to avoid iterating a live mutable dictionary.
        return dict(data)

    def stop_candles(self, asset: str, interval: int = 60):
        self.api.stop_candles_stream(asset, interval)
