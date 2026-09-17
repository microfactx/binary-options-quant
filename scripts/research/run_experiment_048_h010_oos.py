"""
EXP_048: Blind Out-of-Sample Walk-Forward Replay for HYPOTHESIS_010
Title: Macro-Conditioned Order Flow Absorption & Terminal Microstructure Reversion on BTC/USDT
Dataset: Reconstructed Binance BTCUSDT (2024-07-01 to 2024-11-30, 153 days, 2.64M 5s bars)
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
REPORTS_DIR = PROJECT_ROOT / "research" / "reports" / "EXP_048"
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

def load_jsonl_candles(filepaths):
    if not isinstance(filepaths, list):
        filepaths = [filepaths]
    candles = {}
    for fp in filepaths:
        print(f"Loading {fp.name} ...", flush=True)
        with open(fp, "r", encoding="utf-8") as f:
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
                        "taker_buy_vol": float(rec.get("taker_buy_vol", 0)),
                        "taker_sell_vol": float(rec.get("taker_sell_vol", 0)),
                    }
                except Exception: pass
    return candles

def run_replay(payout_rate=0.85):
    m1_files = sorted([f for f in DATA_DIR.glob("BTCUSDT_60s_*.jsonl") if "2024-06" not in f.name])
    m5_files = sorted([f for f in DATA_DIR.glob("BTCUSDT_5s_*.jsonl") if "2024-06" not in f.name])

    if not m1_files or not m5_files:
        print(f"Error: OOS files missing in {DATA_DIR}")
        return None

    first_date = m1_files[0].name.split("_")[2]
    last_date = m1_files[-1].name.split("_")[-1].replace(".jsonl", "")
    replay_period = f"{first_date} to {last_date} (153 days OOS Blind)"

    m1_dict = load_jsonl_candles(m1_files)
    m5_dict = load_jsonl_candles(m5_files)
    print(f"Loaded {len(m1_dict):,} M1 candles and {len(m5_dict):,} 5s candles across {replay_period}.")

    m1_sorted_ts = sorted(m1_dict.keys())
    m1_list = [m1_dict[ts] for ts in m1_sorted_ts]

    # Parameters from frozen HYPOTHESIS_010.json
    atr_period = 14
    stretch_mult = 1.5
    min_wick_ratio = 0.35
    max_timing_sec = 50
    macro_period = 1440
    macro_tolerance_pct = 0.015
    absorption_share_threshold = 0.45

    tr_history = []
    closes_history = []
    current_atr = None
    prev_close = None
    macro_sum = 0
    current_macro_sma = None

    trades = []
    reversed_trades = []
    baseline_trades = []
    monthly_stats = {}

    for i in range(len(m1_list) - 1):
        curr = m1_list[i]
        nxt = m1_list[i + 1]

        dt = datetime.fromtimestamp(curr["ts"], tz=timezone.utc)
        month_key = dt.strftime("%Y-%m")
        if month_key not in monthly_stats:
            monthly_stats[month_key] = {"n": 0, "wins": 0, "losses": 0, "pushes": 0}

        # 1. Prediction on candle i using causal ATR and causal Macro SMA
        if current_atr is not None and current_atr > 0 and current_macro_sma is not None:
            m1_range = curr["high"] - curr["low"]
            m1_body = curr["close"] - curr["open"]
            stretch = m1_range / current_atr

            ts_start = curr["ts"]
            sub_5s = [m5_dict[ts_start + s] for s in range(0, 60, 5) if (ts_start + s) in m5_dict]

            signal = "NO_SIGNAL"

            if stretch >= stretch_mult and abs(m1_body) > 1e-8 and len(sub_5s) >= 11:
                is_bull = m1_body > 0

                # Macro Trend Filter Gate
                macro_ok = False
                if is_bull:
                    # Fading bull to PUT: price must not exceed macro SMA by more than 1.5%
                    macro_ok = curr["close"] <= current_macro_sma * (1 + macro_tolerance_pct)
                else:
                    # Fading bear to CALL: price must not drop below macro SMA by more than 1.5%
                    macro_ok = curr["close"] >= current_macro_sma * (1 - macro_tolerance_pct)

                if macro_ok:
                    # Timing guard
                    extreme_idx = 0
                    if is_bull:
                        max_val = -1e9
                        for s_idx, b in enumerate(sub_5s):
                            if b["high"] > max_val:
                                max_val = b["high"]
                                extreme_idx = s_idx
                    else:
                        min_val = 1e9
                        for s_idx, b in enumerate(sub_5s):
                            if b["low"] < min_val:
                                min_val = b["low"]
                                extreme_idx = s_idx

                    extreme_timing_sec = extreme_idx * 5

                    if extreme_timing_sec < max_timing_sec:
                        # Terminal 5s candle
                        c12 = sub_5s[-1]
                        rng_5s = c12["high"] - c12["low"]
                        if rng_5s > 1e-8:
                            if is_bull:
                                terminal_wick = (c12["high"] - max(c12["open"], c12["close"])) / rng_5s
                                pro_fade_close = c12["close"] < c12["open"]
                            else:
                                terminal_wick = (min(c12["open"], c12["close"]) - c12["low"]) / rng_5s
                                pro_fade_close = c12["close"] > c12["open"]

                            if pro_fade_close and terminal_wick >= min_wick_ratio:
                                # Order Flow Absorption Gate
                                buy_vol = c12.get("taker_buy_vol", 0)
                                sell_vol = c12.get("taker_sell_vol", 0)
                                delta_vol = buy_vol - sell_vol
                                total_vol = buy_vol + sell_vol

                                if is_bull:
                                    absorbed = (delta_vol <= 0) or (total_vol > 0 and (buy_vol / total_vol) <= absorption_share_threshold)
                                else:
                                    absorbed = (delta_vol >= 0) or (total_vol > 0 and (sell_vol / total_vol) <= absorption_share_threshold)

                                if absorbed:
                                    signal = "PUT" if is_bull else "CALL"

            # 2. Record trade outcome
            if signal in ("CALL", "PUT"):
                entry_price = curr["close"]
                exit_price = nxt["close"]

                if signal == "CALL":
                    outcome = "WIN" if exit_price > entry_price else ("LOSS" if exit_price < entry_price else "PUSH")
                    rev_outcome = "LOSS" if exit_price > entry_price else ("WIN" if exit_price < entry_price else "PUSH")
                else:
                    outcome = "WIN" if exit_price < entry_price else ("LOSS" if exit_price > entry_price else "PUSH")
                    rev_outcome = "LOSS" if exit_price < entry_price else ("WIN" if exit_price > entry_price else "PUSH")

                trade_record = {
                    "ts": curr["ts"],
                    "direction": signal,
                    "entry": entry_price,
                    "exit": exit_price,
                    "outcome": outcome,
                    "stretch": stretch,
                    "macroSma": current_macro_sma,
                    "month": month_key
                }
                trades.append(trade_record)
                reversed_trades.append({"outcome": rev_outcome, "direction": "PUT" if signal == "CALL" else "CALL"})

                monthly_stats[month_key]["n"] += 1
                if outcome == "WIN": monthly_stats[month_key]["wins"] += 1
                elif outcome == "LOSS": monthly_stats[month_key]["losses"] += 1
                else: monthly_stats[month_key]["pushes"] += 1

        # 3. Naive Baseline (constant random walk control on each closed candle)
        base_dir = "CALL" if i % 2 == 0 else "PUT"
        e_p = curr["close"]
        x_p = nxt["close"]
        if base_dir == "CALL":
            b_out = "WIN" if x_p > e_p else ("LOSS" if x_p < e_p else "PUSH")
        else:
            b_out = "WIN" if x_p < e_p else ("LOSS" if x_p > e_p else "PUSH")
        baseline_trades.append(b_out)

        # 4. Strict Causal Updates (t-1 updates)
        hl = curr["high"] - curr["low"]
        tr = hl if prev_close is None else max(hl, abs(curr["high"] - prev_close), abs(curr["low"] - prev_close))
        tr_history.append(tr)
        prev_close = curr["close"]

        if len(tr_history) == atr_period:
            current_atr = sum(tr_history[-atr_period:]) / atr_period
        elif len(tr_history) > atr_period:
            current_atr = (current_atr * (atr_period - 1) + tr) / atr_period

        closes_history.append(curr["close"])
        macro_sum += curr["close"]
        if len(closes_history) > macro_period:
            macro_sum -= closes_history.pop(0)
            current_macro_sma = macro_sum / macro_period
        elif len(closes_history) == macro_period:
            current_macro_sma = macro_sum / macro_period

    # Metrics computation
    def compute_stats(t_list):
        n_resolved = sum(1 for t in t_list if t["outcome"] in ("WIN", "LOSS"))
        wins = sum(1 for t in t_list if t["outcome"] == "WIN")
        losses = sum(1 for t in t_list if t["outcome"] == "LOSS")
        pushes = sum(1 for t in t_list if t["outcome"] == "PUSH")
        wr, ci_low, ci_high = wilson_score_ci(wins, n_resolved)
        ev = (wr * payout_rate) - ((1.0 - wr) * 1.0) if n_resolved > 0 else 0.0
        return {
            "n": n_resolved, "wins": wins, "losses": losses, "pushes": pushes,
            "winRate": wr, "ciLower": ci_low, "ciUpper": ci_high, "ev": ev
        }

    h010_stats = compute_stats(trades)
    rev_stats = compute_stats(reversed_trades)

    # Baseline stats
    n_base = sum(1 for b in baseline_trades if b in ("WIN", "LOSS"))
    w_base = sum(1 for b in baseline_trades if b == "WIN")
    l_base = sum(1 for b in baseline_trades if b == "LOSS")
    p_base = sum(1 for b in baseline_trades if b == "PUSH")
    wr_b, ci_l_b, ci_h_b = wilson_score_ci(w_base, n_base)
    base_stats = {
        "n": n_base, "wins": w_base, "losses": l_base, "pushes": p_base,
        "winRate": wr_b, "ciLower": ci_l_b, "ciUpper": ci_h_b,
        "ev": (wr_b * payout_rate) - ((1.0 - wr_b) * 1.0)
    }

    call_trades = [t for t in trades if t["direction"] == "CALL"]
    put_trades = [t for t in trades if t["direction"] == "PUT"]
    call_stats = compute_stats(call_trades)
    put_stats = compute_stats(put_trades)

    p_be = 1 / (1 + payout_rate)

    report = {
        "experimentId": "EXP_048_BTCUSDT_ORDERFLOW_ABSORPTION_001",
        "hypothesisId": "HYPOTHESIS_010",
        "status": "COMPLETED",
        "replayPeriod": replay_period,
        "payoutRate": payout_rate,
        "breakevenHurdle": p_be,
        "h010Model": h010_stats,
        "reversedControl": rev_stats,
        "naiveBaseline": base_stats,
        "directionalBreakdown": {
            "call": call_stats,
            "put": put_stats,
            "directionalImbalance": abs(call_stats.get("winRate", 0) - put_stats.get("winRate", 0))
        },
        "monthlyBreakdown": {
            m: {
                "n": s["n"],
                "wins": s["wins"],
                "losses": s["losses"],
                "pushes": s["pushes"],
                "winRate": (s["wins"] / (s["wins"] + s["losses"])) if (s["wins"] + s["losses"]) > 0 else 0.0
            }
            for m, s in sorted(monthly_stats.items())
        },
        "gatesEvaluation": {
            "minSampleGate": {
                "n": h010_stats["n"],
                "floor": 100,
                "status": "PASS" if h010_stats["n"] >= 100 else "FAIL"
            },
            "statisticalEvidenceGate": {
                "wilsonLowerBound": h010_stats["ciLower"],
                "pBe": p_be,
                "surplusBps": round((h010_stats["ciLower"] - p_be) * 10000, 2),
                "status": "PASS" if h010_stats["ciLower"] > p_be else "FAIL"
            },
            "reversedControlGate": {
                "baseWinRate": h010_stats["winRate"],
                "reversedWinRate": rev_stats["winRate"],
                "alphaOverReversed": round((h010_stats["winRate"] - rev_stats["winRate"]) * 100, 2),
                "status": "PASS" if (h010_stats["winRate"] - rev_stats["winRate"]) >= 0.10 else "FAIL"
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
    print("BLIND OOS REPLAY RESULTS (HYPOTHESIS_010 — BTCUSDT ORDER FLOW ABSORPTION)")
    print(f"Resolved Trades (N):     {h010_stats['n']} (Wins: {h010_stats['wins']}, Losses: {h010_stats['losses']}, Pushes: {h010_stats['pushes']})")
    print(f"OOS Win Rate:            {h010_stats['winRate']*100:.2f}% (95% Wilson CI: [{h010_stats['ciLower']*100:.2f}%, {h010_stats['ciUpper']*100:.2f}%])")
    print(f"Reversed Control:        {rev_stats['winRate']*100:.2f}% (Alpha: +{(h010_stats['winRate'] - rev_stats['winRate'])*100:.2f} pp)")
    print(f"Naive Market Baseline:   {base_stats['winRate']*100:.2f}% (Alpha: +{(h010_stats['winRate'] - base_stats['winRate'])*100:.2f} pp)")
    print(f"CALL Win Rate:           {call_stats['winRate']*100:.2f}% (N={call_stats['n']})")
    print(f"PUT Win Rate:            {put_stats['winRate']*100:.2f}% (N={put_stats['n']})")
    print(f"Break-even Barrier:      {p_be*100:.2f}% (Payout {payout_rate*100:.0f}%)")
    print(f"Expected Value (EV):     {h010_stats['ev']:+.4f}")
    print(f"Wilson Lower vs P_BE:    {'PASSED (+)' if h010_stats['ciLower'] > p_be else 'FAILED (-)'}")
    print("=" * 80)
    print("MONTHLY BREAKDOWN:")
    for m, ms in sorted(report["monthlyBreakdown"].items()):
        print(f"  {m}: N={ms['n']} | W={ms['wins']} | L={ms['losses']} | WR={ms['winRate']*100:.2f}%")
    print("=" * 80)
    print(f"Report saved to: {report_file}")
    return report

if __name__ == "__main__":
    payout = float(sys.argv[1]) if len(sys.argv) > 1 else 0.85
    run_replay(payout)
