"""Multi-stream recorder test battery (stdlib unittest, no network).

Run from the recorder directory:
    python -m unittest discover -s tests -v
Covers: stream spec parsing (incl. fail-closed malformed input), canonical
per-stream file layout incl. legacy default, dedup isolation per stream,
per-stream failure isolation, MAX_CANDLES per-stream finish, record schema
stability, and cloud entrypoint stream wiring.
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

RECORDER_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RECORDER_DIR))


class EnvCase(unittest.TestCase):
    """Real os.environ control (parse_streams reads env lazily at call time)."""

    def set_env(self, extra):
        if not hasattr(self, "_saved_env"):
            self._saved_env = dict(os.environ)
            self.addCleanup(self._restore_env)
        for key in ("IQO_STREAMS", "IQO_ASSET", "IQO_INTERVAL",
                    "IQO_MAX_CANDLES", "RAW_DIR"):
            os.environ.pop(key, None)
        os.environ.update(extra)

    def _restore_env(self):
        os.environ.clear()
        os.environ.update(self._saved_env)

    def fresh(self, *mods):
        for mod in mods or ("recorder", "iqoption_adapter", "cloud_entrypoint"):
            sys.modules.pop(mod, None)
        import recorder
        return recorder


class FakeAdapter:
    """Scripted venue: per-(asset, interval) candle script + failure injection."""

    def __init__(self, script, fail_on=()):
        # script: {(asset, interval): [dict-of-candles per poll]}
        self.script = script
        self.calls = []
        self.fail_on = set(fail_on)
        self.started = []
        self.stopped = []
        self.ts = 10_000_000

    def server_timestamp(self):
        return self.ts

    def start_candles(self, asset, interval, maxdict=100):
        self.started.append((asset, interval))

    def stop_candles(self, asset, interval):
        self.stopped.append((asset, interval))

    def get_candles(self, asset, interval):
        self.calls.append((asset, interval))
        if (asset, interval) in self.fail_on:
            raise RuntimeError("boom")
        script = self.script.get((asset, interval), [])
        return script.pop(0) if script else {}


def candle(ts, close, volume=100, at=None):
    return {"from": ts, "at": ts if at is None else at, "close": close,
            "open": close, "high": close, "low": close, "volume": volume}


class TestParseStreams(EnvCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.set_env({"RAW_DIR": self.tmp.name})

    def test_default_single_stream_legacy(self):
        r = self.fresh()
        self.assertEqual(r.parse_streams(), [("XAU/XAG", 60)])
        self.assertEqual(r.RAW_FILE.name, "IQO_XAU_XAG_60s_raw.jsonl")

    def test_multi_stream_spec(self):
        self.set_env({"RAW_DIR": self.tmp.name,
                      "IQO_STREAMS": "XAU/XAG:60,XAUUSD:60,XAUUSD:5"})
        r = self.fresh()
        self.assertEqual(r.parse_streams(),
                         [("XAU/XAG", 60), ("XAUUSD", 60), ("XAUUSD", 5)])
        self.assertEqual(r.stream_file("XAUUSD", 5).name, "IQO_XAUUSD_5s_raw.jsonl")

    def test_dedupes_and_trims(self):
        self.set_env({"RAW_DIR": self.tmp.name,
                      "IQO_STREAMS": " XAUUSD:5 ,XAUUSD:5,XAU/XAG:60 "})
        r = self.fresh()
        self.assertEqual(r.parse_streams(), [("XAUUSD", 5), ("XAU/XAG", 60)])

    def test_malformed_fail_closed(self):
        for bad in ("XAUUSD", "XAUUSD:abc", "XAUUSD:0", ":5", "XAUUSD:-3"):
            self.set_env({"RAW_DIR": self.tmp.name, "IQO_STREAMS": bad})
            r = self.fresh()
            with self.assertRaises(ValueError, msg=bad):
                r.parse_streams()


class TestMultiStreamRecording(EnvCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.set_env({"RAW_DIR": self.tmp.name,
                      "IQO_STREAMS": "XAU/XAG:60,XAUUSD:5"})
        self.rec = self.fresh()

    def drive(self, adapter, states, max_cycles=10):
        """Drive poll cycles directly (no sleeps, no network)."""
        for state in states:
            adapter.start_candles(state["asset"], state["interval"], maxdict=100)
        for _ in range(max_cycles):
            if all(s["done"] for s in states):
                break
            ts = adapter.server_timestamp()
            for state in states:
                if state["done"]:
                    continue
                action = self.rec.poll_stream(adapter, state, ts)
                if action == "finished":
                    adapter.stop_candles(state["asset"], state["interval"])
        return states

    def test_per_stream_files_and_schema(self):
        script = {
            ("XAU/XAG", 60): [{1000: candle(1000, 68.0)}],
            ("XAUUSD", 5): [{2000: candle(2000, 2700.0)}],
        }
        adapter = FakeAdapter(script)
        streams = [("XAU/XAG", 60), ("XAUUSD", 5)]
        states = [self.rec.new_stream_state(a, i) for a, i in streams]
        self.drive(adapter, states, max_cycles=3)
        for state, (asset, interval) in zip(states, streams):
            lines = state["raw_file"].read_text(encoding="utf-8").strip().splitlines()
            closed = [json.loads(x) for x in lines if json.loads(x)["candle_status"] == "CLOSED"]
            self.assertEqual(len(closed), 1)
            rec = closed[0]
            # Record schema stability (frozen contract with downstream audit).
            self.assertEqual(rec["source"], "IQ_OPTION_STREAM")
            self.assertEqual(rec["asset"], asset)
            self.assertEqual(rec["interval_requested"], interval)
            self.assertIn("server_timestamp_original", rec)
            self.assertIn("raw_payload", rec)
        # Canonical file names.
        names = sorted(p.name for p in Path(self.tmp.name).glob("*.jsonl"))
        self.assertEqual(names, ["IQO_XAUUSD_5s_raw.jsonl", "IQO_XAU_XAG_60s_raw.jsonl"])

    def test_failure_isolation(self):
        script = {("XAU/XAG", 60): [{1000: candle(1000, 68.0)}]}
        adapter = FakeAdapter(script, fail_on={("XAUUSD", 5)})
        states = [self.rec.new_stream_state(a, i) for a, i in
                  [("XAU/XAG", 60), ("XAUUSD", 5)]]
        from unittest.mock import patch
        with patch.object(self.rec, "GET_CANDLES_ERROR_PATIENCE", -1):
            self.drive(adapter, states, max_cycles=2)
        # Healthy stream recorded; failing stream recorded nothing and
        # the failure did not propagate.
        self.assertEqual(states[0]["closed_count"], 1)
        self.assertEqual(states[1]["closed_count"], 0)
        self.assertFalse(states[1]["raw_file"].exists())

    def test_dedup_isolation_across_restart(self):
        script = {("XAU/XAG", 60): [{1000: candle(1000, 68.0)}]}
        adapter = FakeAdapter(script)
        states = [self.rec.new_stream_state("XAU/XAG", 60)]
        self.drive(adapter, states, max_cycles=2)
        self.assertEqual(states[0]["closed_count"], 1)
        # Simulate container restart: fresh state, same file, same candle.
        adapter2 = FakeAdapter({("XAU/XAG", 60): [{1000: candle(1000, 68.0)}]})
        states2 = [self.rec.new_stream_state("XAU/XAG", 60)]
        self.rec.load_dedup(states2[0])
        self.drive(adapter2, states2, max_cycles=2)
        self.assertEqual(states2[0]["closed_count"], 1)  # no duplicate

    def test_max_candles_per_stream_finish(self):
        from unittest.mock import patch
        with patch.object(self.rec, "MAX_CANDLES", 1):
            script = {
                ("XAU/XAG", 60): [{1000: candle(1000, 68.0)}],
                ("XAUUSD", 5): [{2000: candle(2000, 2700.0)}],
            }
            adapter = FakeAdapter(script)
            states = [self.rec.new_stream_state(a, i) for a, i in
                      [("XAU/XAG", 60), ("XAUUSD", 5)]]
            self.drive(adapter, states, max_cycles=5)
            self.assertTrue(all(s["done"] for s in states))


class TestEntrypointWiring(EnvCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.set_env({"RAW_DIR": self.tmp.name,
                      "IQO_STREAMS": "XAU/XAG:60,XAUUSD:60,XAUUSD:5"})

    def load(self):
        for mod in ("recorder", "iqoption_adapter", "cloud_entrypoint"):
            sys.modules.pop(mod, None)
        import cloud_entrypoint
        return cloud_entrypoint

    def test_streams_and_files(self):
        ce = self.load()
        self.assertEqual(ce.STREAMS, [("XAU/XAG", 60), ("XAUUSD", 60), ("XAUUSD", 5)])
        # Legacy aliases preserved (first stream).
        self.assertEqual(ce.RAW_FILE.name, "IQO_XAU_XAG_60s_raw.jsonl")
        self.assertEqual(ce.ASSET, "XAU/XAG")
        self.assertEqual(ce.INTERVAL, 60)

    def test_resolve_stream(self):
        ce = self.load()
        self.assertEqual(ce.resolve_stream(None), ("XAU/XAG", 60))
        self.assertEqual(ce.resolve_stream("XAUUSD:5"), ("XAUUSD", 5))
        self.assertIsNone(ce.resolve_stream("NOPE:60"))

    def test_stream_entry_counts(self):
        ce = self.load()
        f60 = ce.STREAM_FILES[("XAU/XAG", 60)]
        f60.write_text(
            '{"candle_status":"CLOSED","raw_payload":{"from":1,"close":68.0}}\n'
            '{"candle_status":"FORMING","raw_payload":{"from":2,"close":68.1}}\n',
            encoding="utf-8")
        entry = ce.stream_entry("XAU/XAG", 60)
        self.assertEqual(entry["stats"]["closed_candles"], 1)
        self.assertEqual(entry["stats"]["forming_candles"], 1)
        self.assertEqual(entry["progress_percent"], round(1 / 10000 * 100, 2))
        empty = ce.stream_entry("XAUUSD", 5)
        self.assertEqual(empty["stats"]["closed_candles"], 0)

    def test_discovery_response(self):
        ce = self.load()
        import io
        cat_file = Path(self.tmp.name) / "VENUE_CATALOG_DISCOVERY.json"
        cat_file.write_text(json.dumps({
            "XAUUSD": {
                "active_id": 74,
                "name": "front.gold",
                "ticker": "XAUUSD",
                "category": "turbo",
                "precision": 2,
                "payout_rate": 0.85
            }
        }), encoding="utf-8")

        class MockHandler(ce.CloudRequestHandler):
            def __init__(self, path):
                self.path = path
                self.wfile = io.BytesIO()
                self.headers_sent = {}
                self.status_code = None

            def send_response(self, code, message=None):
                self.status_code = code

            def send_header(self, keyword, value):
                self.headers_sent[keyword] = value

            def end_headers(self):
                pass

        # Test querying specific asset
        h1 = MockHandler("/discovery?asset=XAUUSD")
        h1.handle_discovery()
        resp1 = json.loads(h1.wfile.getvalue().decode("utf-8"))
        self.assertEqual(resp1.get("active_id"), 74)
        self.assertEqual(resp1.get("category"), "turbo")

        # Test querying non-existent asset (fail-closed)
        h2 = MockHandler("/discovery?asset=NONEXISTENT")
        h2.handle_discovery()
        resp2 = json.loads(h2.wfile.getvalue().decode("utf-8"))
        self.assertEqual(resp2.get("status"), "UNKNOWN / FAIL-CLOSED")

        # Test querying full catalog
        h3 = MockHandler("/discovery")
        h3.handle_discovery()
        resp3 = json.loads(h3.wfile.getvalue().decode("utf-8"))
        self.assertEqual(resp3.get("status"), "SUCCESS")
        self.assertIn("XAUUSD", resp3.get("discovered_assets", {}))


if __name__ == "__main__":
    unittest.main()
