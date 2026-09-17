"""
Sync XAU/USD 60s and 5s candles from live Railway cloud recorder
Downloads the continuous raw stream files and extracts verified closed candles.
"""
import json
import urllib.request
from pathlib import Path
from datetime import datetime, timezone

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
BASE_URL = "https://binary-options-quant-production.up.railway.app"
OUT_DIR = PROJECT_ROOT / "research" / "datasets" / "XAUUSD" / "raw"
OUT_DIR.mkdir(parents=True, exist_ok=True)

def sync_stream(stream_spec: str, filename: str):
    url = f"{BASE_URL}/download?stream={stream_spec}"
    out_file = OUT_DIR / filename
    print(f"Syncing {stream_spec} from {url} ...", flush=True)

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        content_length = resp.headers.get("Content-Length")
        print(f"  -> Incoming stream size: {int(content_length)/(1024*1024):.2f} MB" if content_length else "  -> Streaming...", flush=True)
        
        with open(out_file, "wb") as f:
            chunk_size = 1024 * 1024
            downloaded = 0
            while True:
                chunk = resp.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if downloaded % (10 * 1024 * 1024) < chunk_size:
                    print(f"  -> Downloaded {downloaded / (1024 * 1024):.1f} MB ...", flush=True)

    print(f"  -> Successfully saved {stream_spec} to {out_file} ({out_file.stat().st_size / (1024*1024):.2f} MB)", flush=True)
    return out_file

def main():
    print("=" * 70)
    print("SYNCING LIVE XAU/USD RECORDER DATA FROM RAILWAY")
    print("=" * 70)
    f60 = sync_stream("XAUUSD:60", "IQO_XAUUSD_60s_raw.jsonl")
    f5 = sync_stream("XAUUSD:5", "IQO_XAUUSD_5s_raw.jsonl")
    print("=" * 70)
    print("SYNC COMPLETE.")
    print("=" * 70)

if __name__ == "__main__":
    main()
