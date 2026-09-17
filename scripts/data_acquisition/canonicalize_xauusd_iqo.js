"use strict";

/**
 * scripts/data_acquisition/canonicalize_xauusd_iqo.js
 * Canonical Dataset Ingestion for XAU/USD - IQ Option Live Stream
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const RAW_DIR = path.join(ROOT, 'research', 'datasets', 'XAUUSD', 'raw');
const CANON_DIR = path.join(ROOT, 'research', 'datasets', 'XAUUSD', 'canonical');
const MANIFEST_OUT = path.join(ROOT, 'research', 'datasets', 'DATASET_XAUUSD_002_MANIFEST.json');

const INPUTS = {
  '60s': { rawFile: path.join(RAW_DIR, 'IQO_XAUUSD_60s_raw.jsonl'), canonFile: path.join(CANON_DIR, 'IQO_XAUUSD_60s_canonical.jsonl'), intervalSec: 60 },
  '5s':  { rawFile: path.join(RAW_DIR, 'IQO_XAUUSD_5s_raw.jsonl'),  canonFile: path.join(CANON_DIR, 'IQO_XAUUSD_5s_canonical.jsonl'),  intervalSec: 5  }
};

function sha256File(fp) {
  return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}

function semanticHash(rows) {
  const h = crypto.createHash('sha256');
  for (const r of rows) h.update(r.ts + ',' + r.open + ',' + r.high + ',' + r.low + ',' + r.close + ',' + r.volume + '|');
  return h.digest('hex');
}

async function readLines(fp) {
  const rl = readline.createInterface({ input: fs.createReadStream(fp, { encoding: 'utf8' }), crlfDelay: Infinity });
  const lines = [];
  for await (const l of rl) { if (l.trim()) lines.push(l); }
  return lines;
}

async function processStream(label, cfg) {
  console.log('\n' + '='.repeat(64));
  console.log('STREAM: ' + label + ' => ' + cfg.rawFile);
  if (!fs.existsSync(cfg.rawFile)) throw new Error('Raw not found: ' + cfg.rawFile);
  const lines = await readLines(cfg.rawFile);
  console.log('  [READ] ' + lines.length + ' raw lines');

  const closedRecords = [];
  for (const l of lines) {
    try {
      const obj = JSON.parse(l);
      if (obj.candle_status !== 'CLOSED') continue;
      const p = obj.raw_payload;
      if (!p || p.from === undefined) continue;
      closedRecords.push({
        ts: p.from,
        open: Number(p.open),
        high: Number(p.max !== undefined ? p.max : p.high),
        low: Number(p.min !== undefined ? p.min : p.low),
        close: Number(p.close),
        volume: Number(p.volume || 0),
        local_ts: obj.local_timestamp || 0
      });
    } catch (e) {}
  }
  console.log('  [FILTER] Filtered ' + closedRecords.length + ' CLOSED records from ' + lines.length + ' raw lines');

  // Sort by ts ascending, then local_ts ascending (latest emission last)
  closedRecords.sort(function(a, b) {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return a.local_ts - b.local_ts;
  });

  const dedupMap = new Map();
  for (const r of closedRecords) {
    dedupMap.set(r.ts, {
      ts: r.ts,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume
    });
  }
  const deduped = Array.from(dedupMap.values());
  const dupCount = closedRecords.length - deduped.length;
  console.log('  [DEDUP] ' + closedRecords.length + ' -> ' + deduped.length + ' (removed ' + dupCount + ' duplicate closed bars)');

  let badOhlc = 0, gapCount = 0;
  for (let i = 0; i < deduped.length; i++) {
    const r = deduped[i];
    if (!isFinite(r.open) || !isFinite(r.high) || !isFinite(r.low) || !isFinite(r.close)) {
      throw new Error('Non-finite OHLC at ts=' + r.ts);
    }
    if (r.high < r.low || r.open < r.low || r.open > r.high || r.close < r.low || r.close > r.high) {
      badOhlc++;
      console.warn('  [WARN] Bad OHLC ts=' + r.ts + ' O=' + r.open + ' H=' + r.high + ' L=' + r.low + ' C=' + r.close);
    }
    if (i > 0) {
      const delta = r.ts - deduped[i - 1].ts;
      if (delta > cfg.intervalSec * 2) gapCount++;
    }
  }
  if (badOhlc > 0) throw new Error(badOhlc + ' candles with invalid OHLC geometry');

  const monthBreakdown = {};
  for (const r of deduped) {
    const k = new Date(r.ts * 1000).toISOString().slice(0, 7);
    monthBreakdown[k] = (monthBreakdown[k] || 0) + 1;
  }
  console.log('  [GAPS] ' + gapCount + ' gaps detected');
  console.log('  [MONTHS] ' + JSON.stringify(monthBreakdown));

  if (!fs.existsSync(CANON_DIR)) fs.mkdirSync(CANON_DIR, { recursive: true });
  fs.writeFileSync(cfg.canonFile, deduped.map(function(r) { return JSON.stringify(r); }).join('\n') + '\n', 'utf8');
  console.log('  [WRITE] Canonical: ' + cfg.canonFile);

  const fh = sha256File(cfg.canonFile);
  const sh = semanticHash(deduped);
  console.log('  [HASH] File SHA-256: ' + fh);
  console.log('  [HASH] Semantic:     ' + sh);

  return {
    label: label,
    intervalSec: cfg.intervalSec,
    rawLinesRead: lines.length,
    canonicalCount: deduped.length,
    duplicatesRemoved: dupCount,
    gapsDetected: gapCount,
    firstTimestamp: deduped[0].ts,
    lastTimestamp: deduped[deduped.length - 1].ts,
    firstDate: new Date(deduped[0].ts * 1000).toISOString(),
    lastDate: new Date(deduped[deduped.length - 1].ts * 1000).toISOString(),
    monthBreakdown: monthBreakdown,
    canonicalFile: path.relative(ROOT, cfg.canonFile).replace(/\\/g, '/'),
    hashes: { canonicalFileSha256: fh, semanticContentHash: sh, algorithm: 'SHA-256' }
  };
}

async function main() {
  console.log('================================================================');
  console.log('CANONICAL DATASET INGESTION - IQ Option XAU/USD Live Stream');
  console.log('================================================================');
  const results = {};
  for (const label of Object.keys(INPUTS)) {
    results[label] = await processStream(label, INPUTS[label]);
  }
  const manifest = {
    datasetId: 'DATASET_XAUUSD_002',
    asset: 'XAUUSD',
    source: 'IQ_OPTION_LIVE_STREAM',
    sourceType: 'LIVE_BROKER_STREAM_IQO',
    description: 'IQ Option live-streamed XAU/USD candles (60s + 5s) from Railway cloud recorder. Sort+dedup+OHLC-validated.',
    governance: {
      dataTier: 'LEVEL_1_RESEARCH_GRADE',
      status: 'VERIFIED_CANONICAL',
      promotionRequirement: 'Level 2 Fidelity Audit (rho>=0.98 vs reference, DAR>=94%, BSIR<=2%) required before live execution.',
      commercialUsePermitted: false,
      frozenAt: new Date().toISOString()
    },
    streams: results,
    constitutionalInvariants: {
      causality: 'ts = candle open-time (from field). No close-time lookahead.',
      monotonicity: 'Verified: strictly ascending after sort+dedup.',
      syntheticProhibition: 'COMPLIED: sourceType=LIVE_BROKER_STREAM_IQO (empirical live data).',
      targetLeakage: 'N/A: raw stream dataset, no labels computed at canonicalization.'
    }
  };
  fs.writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('\n================================================================');
  console.log('SUCCESS: DATASET_XAUUSD_002 MANIFEST WRITTEN');
  console.log('  60s: ' + results['60s'].canonicalCount + ' bars | ' + results['60s'].firstDate + ' -> ' + results['60s'].lastDate);
  console.log('  5s:  ' + results['5s'].canonicalCount  + ' bars | ' + results['5s'].firstDate  + ' -> ' + results['5s'].lastDate);
  console.log('================================================================');
}

main().catch(function(err) { console.error('[FATAL]', err.message); process.exit(1); });
