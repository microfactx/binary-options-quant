"""
Binance aggTrades to 5s and 60s Microstructure Reconstructor
Fetches historical daily aggTrades archives from data.binance.vision (public archive),
streams the trades in-memory, and reconstructs perfectly aligned, causal 5s and 60s
OHLCV candles with order flow metrics (taker buy/sell volume).
"""
import argparse
import csv
import io
import json
import math
import os
import sys
import time
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE_URL = "https://data.binance.vision/data/spot/daily/aggTrades"

def parse_args():
    parser = argparse.ArgumentParser(description="Reconstruct 5s/60s candles from Binance aggTrades")
    parser.add_argument("--symbol", default="BTCUSDT", help="Trading pair symbol (default: BTCUSDT)")
    parser.add_argument("--start", default="2024-06-01", help="Start date YYYY-MM-DD")
    parser.add_argument("--end", default="2024-06-07", help="End date YYYY-MM-DD")
    parser.add_argument("--output-dir", default=None, help="Target directory for reconstructed data")
    return parser.parse_args()

def date_range(start_date: str, end_date: str):
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    curr = start
    while curr <= end:
        yield curr.strftime("%Y-%m-%d")
        curr += timedelta(days=1)

def download_daily_zip(symbol: str, date_str: str) -> bytes:
    url = f"{BASE_URL}/{symbol}/{symbol}-aggTrades-{date_str}.zip"
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] Downloading {url} ...", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
            print(f"  -> Downloaded {len(data) / (1024 * 1024):.2f} MB", flush=True)
            return data
    except Exception as e:
        print(f"  -> ERROR downloading {date_str}: {e}", flush=True)
        return None

def process_trades_for_day(zip_bytes: bytes, date_str: str):
    """
    Decompresses zip and yields aggregated 5s and 60s buckets across the 24-hour day.
    """
    zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    file_list = zf.namelist()
    if not file_list:
        return None, None

    csv_name = file_list[0]
    day_start_dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    day_start_ms = int(day_start_dt.timestamp() * 1000)
    day_end_ms = day_start_ms + 86400 * 1000

    # Number of 5s buckets in 24 hours: 86400 / 5 = 17,280
    total_5s_buckets = 86400 // 5
    # Number of 60s buckets in 24 hours: 86400 / 60 = 1,440
    total_60s_buckets = 86400 // 60

    candles_5s = {}
    candles_60s = {}

    trade_count = 0
    with zf.open(csv_name) as z_file:
        text_stream = io.TextIOWrapper(z_file, encoding="utf-8")
        reader = csv.reader(text_stream)

        for row in reader:
            if not row or len(row) < 8:
                continue
            # Header check
            if row[0] == "agg_trade_id" or not row[0].isdigit():
                continue

            trade_count += 1
            price = float(row[1])
            qty = float(row[2])
            ts = int(row[5])
            is_buyer_maker = (row[6].lower() == "true")

            # 5s Bucket
            b5_idx = (ts - day_start_ms) // 5000
            if 0 <= b5_idx < total_5s_buckets:
                if b5_idx not in candles_5s:
                    candles_5s[b5_idx] = {
                        "ts": day_start_ms + b5_idx * 5000,
                        "open": price, "high": price, "low": price, "close": price,
                        "volume": qty, "trades": 1,
                        "taker_buy_vol": 0.0 if is_buyer_maker else qty,
                        "taker_sell_vol": qty if is_buyer_maker else 0.0
                    }
                else:
                    b = candles_5s[b5_idx]
                    if price > b["high"]: b["high"] = price
                    if price < b["low"]: b["low"] = price
                    b["close"] = price
                    b["volume"] += qty
                    b["trades"] += 1
                    if is_buyer_maker:
                        b["taker_sell_vol"] += qty
                    else:
                        b["taker_buy_vol"] += qty

            # 60s Bucket
            b60_idx = (ts - day_start_ms) // 60000
            if 0 <= b60_idx < total_60s_buckets:
                if b60_idx not in candles_60s:
                    candles_60s[b60_idx] = {
                        "ts": day_start_ms + b60_idx * 60000,
                        "open": price, "high": price, "low": price, "close": price,
                        "volume": qty, "trades": 1,
                        "taker_buy_vol": 0.0 if is_buyer_maker else qty,
                        "taker_sell_vol": qty if is_buyer_maker else 0.0
                    }
                else:
                    b = candles_60s[b60_idx]
                    if price > b["high"]: b["high"] = price
                    if price < b["low"]: b["low"] = price
                    b["close"] = price
                    b["volume"] += qty
                    b["trades"] += 1
                    if is_buyer_maker:
                        b["taker_sell_vol"] += qty
                    else:
                        b["taker_buy_vol"] += qty

    print(f"  -> Aggregated {trade_count:,} trades into {len(candles_5s)} 5s bars and {len(candles_60s)} 60s bars.", flush=True)

    # Monotonic fill-forward for zero-trade gaps (ensuring strictly continuous series)
    filled_5s = []
    last_close = None
    for idx in range(total_5s_buckets):
        bucket_ts = day_start_ms + idx * 5000
        if idx in candles_5s:
            c = candles_5s[idx]
            last_close = c["close"]
            filled_5s.append(c)
        else:
            # Zero volume fill
            p = last_close if last_close is not None else 0.0
            filled_5s.append({
                "ts": bucket_ts, "open": p, "high": p, "low": p, "close": p,
                "volume": 0.0, "trades": 0, "taker_buy_vol": 0.0, "taker_sell_vol": 0.0
            })

    filled_60s = []
    last_close_60 = None
    for idx in range(total_60s_buckets):
        bucket_ts = day_start_ms + idx * 60000
        if idx in candles_60s:
            c = candles_60s[idx]
            last_close_60 = c["close"]
            filled_60s.append(c)
        else:
            p = last_close_60 if last_close_60 is not None else 0.0
            filled_60s.append({
                "ts": bucket_ts, "open": p, "high": p, "low": p, "close": p,
                "volume": 0.0, "trades": 0, "taker_buy_vol": 0.0, "taker_sell_vol": 0.0
            })

    return filled_5s, filled_60s

def main():
    args = parse_args()
    symbol = args.symbol.upper()
    start_date = args.start
    end_date = args.end

    project_root = Path(__file__).resolve().parent.parent.parent
    if args.output_dir:
        out_dir = Path(args.output_dir)
    else:
        out_dir = project_root / "research" / "datasets" / symbol / "reconstructed_5s"
    out_dir.mkdir(parents=True, exist_ok=True)

    file_5s = out_dir / f"{symbol}_5s_{start_date}_to_{end_date}.jsonl"
    file_60s = out_dir / f"{symbol}_60s_{start_date}_to_{end_date}.jsonl"

    print("=" * 70)
    print(f"BINANCE MICROSTRUCTURE RECONSTRUCTOR (5s & 60s)")
    print(f"Symbol: {symbol} | Span: {start_date} to {end_date}")
    print(f"Output 5s:  {file_5s}")
    print(f"Output 60s: {file_60s}")
    print("=" * 70)

    total_days = 0
    total_5s_count = 0
    total_60s_count = 0

    with open(file_5s, "w", encoding="utf-8") as f5, open(file_60s, "w", encoding="utf-8") as f60:
        for d in date_range(start_date, end_date):
            zip_bytes = download_daily_zip(symbol, d)
            if not zip_bytes:
                print(f"Skipping {d} due to download error.")
                continue

            candles_5s, candles_60s = process_trades_for_day(zip_bytes, d)
            if not candles_5s or not candles_60s:
                continue

            for c in candles_5s:
                rec = {
                    "source": "BINANCE_AGGTRADES_RECONSTRUCTED",
                    "symbol": symbol,
                    "interval": "5s",
                    "interval_ms": 5000,
                    "timestamp_ms": c["ts"],
                    "timestamp_utc": datetime.fromtimestamp(c["ts"] / 1000, tz=timezone.utc).isoformat(),
                    "open": round(c["open"], 2),
                    "high": round(c["high"], 2),
                    "low": round(c["low"], 2),
                    "close": round(c["close"], 2),
                    "volume": round(c["volume"], 6),
                    "trades": c["trades"],
                    "taker_buy_vol": round(c["taker_buy_vol"], 6),
                    "taker_sell_vol": round(c["taker_sell_vol"], 6)
                }
                f5.write(json.dumps(rec, separators=(",", ":")) + "\n")
                total_5s_count += 1

            for c in candles_60s:
                rec = {
                    "source": "BINANCE_AGGTRADES_RECONSTRUCTED",
                    "symbol": symbol,
                    "interval": "60s",
                    "interval_ms": 60000,
                    "timestamp_ms": c["ts"],
                    "timestamp_utc": datetime.fromtimestamp(c["ts"] / 1000, tz=timezone.utc).isoformat(),
                    "open": round(c["open"], 2),
                    "high": round(c["high"], 2),
                    "low": round(c["low"], 2),
                    "close": round(c["close"], 2),
                    "volume": round(c["volume"], 6),
                    "trades": c["trades"],
                    "taker_buy_vol": round(c["taker_buy_vol"], 6),
                    "taker_sell_vol": round(c["taker_sell_vol"], 6)
                }
                f60.write(json.dumps(rec, separators=(",", ":")) + "\n")
                total_60s_count += 1

            total_days += 1

    print("\n" + "=" * 70)
    print(f"RECONSTRUCTION COMPLETE")
    print(f"Days Processed: {total_days}")
    print(f"Total 5s Candles:  {total_5s_count:,}")
    print(f"Total 60s Candles: {total_60s_count:,}")
    print(f"Files written to: {out_dir}")
    print("=" * 70)

if __name__ == "__main__":
    main()
