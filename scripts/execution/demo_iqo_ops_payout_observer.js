"use strict";

/**
 * scripts/execution/demo_iqo_ops_payout_observer.js
 *
 * Append-only venue payout observer for track DEMO_IQO_OPS.
 *
 * Purpose: record live payout snapshots (rate + source + timestamp) so that
 * paper fills use OBSERVED economics instead of assumed constants. This log is
 * an input to the future H011 venue-discovery receipt — it is NOT evidence.
 *
 * Fail-closed: invalid snapshots are rejected (throw). Absence of a snapshot
 * blocks dispatch upstream (supervisor gate PAYOUT_UNKNOWN).
 */

const fs = require('fs');
const path = require('path');

class DemoIqoPayoutObserver {
  constructor(logPath) {
    if (!logPath || typeof logPath !== 'string') {
      throw new Error('PAYOUT OBSERVER ERROR: logPath must be a non-empty string');
    }
    this.logPath = logPath;
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.latestByKey = new Map(); // `${asset}|${market}` -> snapshot
    this.rebuildFromLog();
  }

  static keyFor(asset, market) {
    return `${asset}|${market}`;
  }

  static validateSnapshot(snap) {
    if (!snap || typeof snap !== 'object') throw new Error('PAYOUT OBSERVER ERROR: snapshot must be an object');
    if (typeof snap.asset !== 'string' || !snap.asset) throw new Error('PAYOUT OBSERVER ERROR: asset required');
    if (typeof snap.market !== 'string' || !snap.market) throw new Error('PAYOUT OBSERVER ERROR: market required');
    if (typeof snap.payoutRate !== 'number' || !Number.isFinite(snap.payoutRate)) {
      throw new Error('PAYOUT OBSERVER ERROR: payoutRate must be a finite number');
    }
    if (snap.payoutRate <= 0 || snap.payoutRate > 1) {
      throw new Error(`PAYOUT OBSERVER ERROR: payoutRate out of (0,1] range (got ${snap.payoutRate})`);
    }
    if (typeof snap.timestamp !== 'number' || !Number.isFinite(snap.timestamp)) {
      throw new Error('PAYOUT OBSERVER ERROR: timestamp (ms) required');
    }
    if (typeof snap.source !== 'string' || !snap.source) {
      throw new Error('PAYOUT OBSERVER ERROR: source required (e.g. VENUE_DISCOVERY, LIVE_SNAPSHOT)');
    }
  }

  recordSnapshot(snap) {
    DemoIqoPayoutObserver.validateSnapshot(snap);
    const payload = Object.freeze({
      asset: snap.asset,
      market: snap.market,
      payoutRate: snap.payoutRate,
      timestamp: snap.timestamp,
      source: snap.source
    });
    fs.appendFileSync(this.logPath, JSON.stringify(payload) + '\n', 'utf-8');
    const key = DemoIqoPayoutObserver.keyFor(payload.asset, payload.market);
    const prev = this.latestByKey.get(key);
    if (!prev || payload.timestamp >= prev.timestamp) this.latestByKey.set(key, payload);
    return payload;
  }

  hasRate(asset, market) {
    return this.latestByKey.has(DemoIqoPayoutObserver.keyFor(asset, market));
  }

  getRate(asset, market) {
    const snap = this.latestByKey.get(DemoIqoPayoutObserver.keyFor(asset, market));
    return snap ? { payoutRate: snap.payoutRate, source: snap.source, snapshotTs: snap.timestamp } : null;
  }

  rebuildFromLog() {
    if (!fs.existsSync(this.logPath)) return 0;
    const content = fs.readFileSync(this.logPath, 'utf-8').trim();
    if (!content) return 0;
    let count = 0;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const snap = JSON.parse(line);
      DemoIqoPayoutObserver.validateSnapshot(snap);
      const key = DemoIqoPayoutObserver.keyFor(snap.asset, snap.market);
      const prev = this.latestByKey.get(key);
      if (!prev || snap.timestamp >= prev.timestamp) this.latestByKey.set(key, snap);
      count++;
    }
    return count;
  }

  readAll() {
    if (!fs.existsSync(this.logPath)) return [];
    const content = fs.readFileSync(this.logPath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
}

module.exports = DemoIqoPayoutObserver;
