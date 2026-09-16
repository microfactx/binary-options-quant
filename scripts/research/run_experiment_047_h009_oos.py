"""
EXP_047: Blind Out-of-Sample Walk-Forward Replay for HYPOTHESIS_009
Dataset: Reconstructed Binance BTCUSDT (2024-07-01 to 2024-08-31, 62 days)
Governance: Blind OOS Execution under CRO Tri-Proof Gate.
"""
import json
import math
import sys
import time
from pathlib import Path
from datetime import datetime, timezone

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = PROJECT_ROOT / "research" / "datasets" / "BTCUSDT" / "reconstructed_5s"
M1_FILE = DATA_DIR / "BTCUSDT_60s_2024-07-01_to_2024-08-31.jsonl"
M5_FILE = DATA_DIR / "BTCUSDT_5s_2024-07-01_to_2024-08-31.jsonl"
REPORTS_DIR = PROJECT_ROOT / "research" / "reports" / "EXP_047"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

def wilson_score_ci(k, n, confidence=0.95):
    if n == 0: return 0.0, 0.0, 0.0
    p = k / n
    z = 1.959963984540054
    z2 = z * z
    denom = 1 + z2 / n
    centre = (p + z2 / (2 * n)) / denom
    spread = z * math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denom
    return p, max(0.0, centre - spread), min(1.0, centre + spread)

def load_jsonl_candles(filepath):
    candles = {}
    print(f"Loading {filepath.name} ...", flush=True)
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip(): continue
            try:
                rec = json.loads(line)
                ts_sec = rec["timestamp_ms"] // 1000
                candles[ts_sec] = {
                    "ts": ts_sec,
                    "open": float(rec["open"]),
                    "high": float(rec["high"]),
                    "low": float(rec["low"]),
                    "close": float(rec["close"]),
                    "volume": float(rec.get("volume", 0)),
                }
            except Exception: pass
    return candles

def run_replay(payout_rate=0.85):
    if not M1_FILE.exists() or not M5_FILE.exists():
        print(f"Error: OOS files missing. M1: {M1_FILE.exists()} | M5: {M5_FILE.exists()}")
        return None

    m1_dict = load_jsonl_candles(M1_FILE)
    m5_dict = load_jsonl_candles(M5_FILE)
    print(f"Loaded {len(m1_dict):,} M1 candles and {len(m5_dict):,} 5s candles.")

    m1_sorted_ts = sorted(m1_dict.keys())
    m1_list = [m1_dict[ts] for ts in m1_sorted_ts]

    # Model parameters from frozen HYPOTHESIS_009.json
    atr_period = 14
    stretch_mult = 1.5
    min_wick_ratio = 0.35
    max_timing_sec = 50

    # ATR History (causal)
    tr_history = []
    current_atr = None
    prev_close = None

    trades = []
    reversed_trades = []
    baseline_trades = []

    for i in range(len(m1_list) - 1):
        curr = m1_list[i]
        nxt = m1_list[i + 1]

        # 1. Prediction on candle i using current causal ATR
        if current_atr is not None and current_atr > 0:
            m1_range = curr["high"] - curr["low"]
            m1_body = curr["close"] - curr["open"]
            stretch = m1_range / current_atr

            # Micro 5s collection strictly in [T, T+60)
            ts_start = curr["ts"]
            sub_5s = [m5_dict[ts_start + s] for s in range(0, 60, 5) if (ts_start + s) in m5_dict]

            signal = "NO_SIGNAL"
            signal_reason = "NO_SETUP"

            if stretch >= stretch_mult and abs(m1_body) > 1e-8 and len(sub_5s) >= 11:
                is_bull = m1_body > 0

                # Timing guard
                extreme_idx = 0
                if is_bull:
                    max_val = -1e9
                    for idx, c5 in enumerate(sub_5s):
                        if c5["high"] > max_val: max_val = c5["high"]; extreme_idx = idx
                else:
                    min_val = 1e9
                    for idx, c5 in enumerate(sub_5s):
                        if c5["low"] < min_val: min_val = c5["low"]; extreme_idx = idx

                extreme_sec = extreme_idx * 5
                if extreme_sec < max_timing_sec:
                    terminal_5s = sub_5s[-1]
                    rng_5s = terminal_5s["high"] - terminal_5s["low"]
                    if rng_5s > 0:
                        if is_bull:
                            wick = (terminal_5s["high"] - max(terminal_5s["open"], terminal_5s["close"])) / rng_5s
                            pro_fade = terminal_5s["close"] < terminal_5s["open"]
                            if pro_fade and wick >= min_wick_ratio:
                                signal = "PUT"
                        else:
                            wick = (min(terminal_5s["open"], terminal_5s["close"]) - terminal_5s["low"]) / rng_5s
                            pro_fade = terminal_5s["close"] > terminal_5s["open"]
                            if pro_fade and wick >= min_wick_ratio:
                                signal = "CALL"

            # Execute Model Trade
            if signal in ("CALL", "PUT"):
                # Expiry price is close of nxt
                entry_price = curr["close"]
                expiry_price = nxt["close"]
                if signal == "CALL":
                    outcome = "WIN" if expiry_price > entry_price else ("LOSS" if expiry_price < entry_price else "PUSH")
                else:
                    outcome = "WIN" if expiry_price < entry_price else ("LOSS" if expiry_price > entry_price else "PUSH")

                trades.append({
                    "ts": curr["ts"],
                    "direction": signal,
                    "entryPrice": entry_price,
                    "expiryPrice": expiry_price,
                    "outcome": outcome,
                    "stretch": stretch,
                })

                # Reversed Control executes opposite direction
                rev_dir = "PUT" if signal == "CALL" else "CALL"
                if rev_dir == "CALL":
                    rev_outcome = "WIN" if expiry_price > entry_price else ("LOSS" if expiry_price < entry_price else "PUSH")
                else:
                    rev_outcome = "WIN" if expiry_price < entry_price else ("LOSS" if expiry_price > entry_price else "PUSH")
                reversed_trades.append({"outcome": rev_outcome})

            # Naive Baseline: Fade every M1 candle
            if abs(m1_body) > 1e-8:
                base_dir = "PUT" if m1_body > 0 else "CALL"
                if base_dir == "CALL":
                    base_out = "WIN" if nxt["close"] > curr["close"] else ("LOSS" if nxt["close"] < curr["close"] else "PUSH")
                else:
                    base_out = "WIN" if nxt["close"] < curr["close"] else ("LOSS" if nxt["close"] > curr["close"] else "PUSH")
                baseline_trades.append({"outcome": base_out})

        # 2. Causal ATR update using candle i
        hl = curr["high"] - curr["low"]
        tr = hl
        if prev_close is not None:
            tr = max(hl, abs(curr["high"] - prev_close), abs(curr["low"] - prev_close))
        prev_close = curr["close"]
        tr_history.append(tr)

        if len(tr_history) == atr_period:
            current_atr = sum(tr_history) / atr_period
        elif len(tr_history) > atr_period:
            current_atr = (current_atr * (atr_period - 1) + tr) / atr_period

    # Compute Statistics
    def stats(trades_list):
        valid = [t for t in trades_list if t["outcome"] in ("WIN", "LOSS")]
        n = len(valid)
        pushes = len([t for t in trades_list if t["outcome"] == "PUSH"])
        if n == 0: return {"n": 0, "winRate": 0, "ci": [0, 0], "ev": 0, "pushes": pushes}
        wins = sum(1 for t in valid if t["outcome"] == "WIN")
        losses = sum(1 for t in valid if t["outcome"] == "LOSS")
        wr, low, high = wilson_score_ci(wins, n)
        ev = wr * payout_rate - (1 - wr) * 1.0
        return {
            "n": n, "wins": wins, "losses": losses, "pushes": pushes,
            "winRate": wr, "ciLower": low, "ciUpper": high, "ev": ev
        }

    h009_stats = stats(trades)
    rev_stats = stats(reversed_trades)
    base_stats = stats(baseline_trades)

    call_trades = [t for t in trades if t["direction"] == "CALL"]
    put_trades = [t for t in trades if t["direction"] == "PUT"]
    call_stats = stats(call_trades)
    put_stats = stats(put_trades)

    p_be = 1 / (1 + payout_rate)

    report = {
        "experimentId": "EXP_047_BTCUSDT_MICROSTRUCTURE_001",
        "hypothesisId": "HYPOTHESIS_009",
        "status": "COMPLETED",
        "replayPeriod": "2024-07-01 to 2024-08-31 (62 days)",
        "payoutRate": payout_rate,
        "breakevenHurdle": p_be,
        "h009Model": h009_stats,
        "reversedControl": rev_stats,
        "naiveBaseline": base_stats,
        "directionalBreakdown": {
            "call": call_stats,
            "put": put_stats,
            "directionalImbalance": abs(call_stats.get("winRate", 0) - put_stats.get("winRate", 0))
        },
        "gatesEvaluation": {
            "minSampleGate": {
                "n": h009_stats["n"],
                "floor": 100,
                "status": "PASS" if h009_stats["n"] >= 100 else "FAIL"
            },
            "statisticalEvidenceGate": {
                "wilsonLowerBound": h009_stats["ciLower"],
                "pBe": p_be,
                "surplusBps": round((h009_stats["ciLower"] - p_be) * 10000, 2),
                "status": "PASS" if h009_stats["ciLower"] > p_be else "FAIL"
            },
            "reversedControlGate": {
                "baseWinRate": h009_stats["winRate"],
                "reversedWinRate": rev_stats["winRate"],
                "status": "PASS" if h009_stats["winRate"] > rev_stats["winRate"] else "FAIL"
            },
            "directionalSymmetryGate": {
                "delta": round(abs(call_stats.get("winRate", 0) - put_stats.get("winRate", 0)) * 100, 2),
                "threshold": 8.0,
                "status": "PASS" if abs(call_stats.get("winRate", 0) - put_stats.get("winRate", 0)) <= 0.08 else "FAIL"
            }
        },
        "executedAt": datetime.now(timezone.utc).isoformat()
    }

    report_file = REPORTS_DIR / "OOS_VALIDATION_REPORT.json"
    with open(report_file, "w", encoding="utf-8") as rf:
        json.dump(report, rf, indent=2)

    print("\n" + "=" * 80)
    print("BLIND OOS REPLAY RESULTS (HYPOTHESIS_009 — BTCUSDT)")
    print(f"Resolved Trades (N):     {h009_stats['n']} (Wins: {h009_stats['wins']}, Losses: {h009_stats['losses']}, Pushes: {h009_stats['pushes']})")
    print(f"OOS Win Rate:            {h009_stats['winRate']*100:.2f}% (95% Wilson CI: [{h009_stats['ciLower']*100:.2f}%, {h009_stats['ciUpper']*100:.2f}%])")
    print(f"Reversed Control:        {rev_stats['winRate']*100:.2f}%")
    print(f"Naive Market Baseline:   {base_stats['winRate']*100:.2f}%")
    print(f"CALL Win Rate:           {call_stats['winRate']*100:.2f}% (N={call_stats['n']})")
    print(f"PUT Win Rate:            {put_stats['winRate']*100:.2f}% (N={put_stats['n']})")
    print(f"Break-even Barrier:      {p_be*100:.2f}% (Payout {payout_rate*100:.0f}%)")
    print(f"Expected Value (EV):     {h009_stats['ev']:+.4f}")
    print(f"Wilson Lower vs P_BE:    {'PASSED (+)' if h009_stats['ciLower'] > p_be else 'FAILED (-)'}")
    print("=" * 80)
    print(f"Report saved to: {report_file}")
    return report

if __name__ == "__main__":
    payout = float(sys.argv[1]) if len(sys.argv) > 1 else 0.85
    run_replay(payout)
