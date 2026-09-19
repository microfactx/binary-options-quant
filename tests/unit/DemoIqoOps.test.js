"use strict";

/**
 * tests/unit/DemoIqoOps.test.js
 *
 * Fence tests for track DEMO_IQO_OPS v1.0.0 (IQ Option practice/demo rails).
 *
 * These tests verify containment, not economics: outputs of this track carry
 * zero statistical power by construction (EXPLORATORY-UNVALIDATED-QUARANTINED).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const DemoIqoOpsSupervisor = require('../../scripts/execution/demo_iqo_ops_supervisor');
const DemoIqoPayoutObserver = require('../../scripts/execution/demo_iqo_ops_payout_observer');

let dirSeq = 0;
function freshPaths() {
  dirSeq += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `demo-iqo-ops-${process.pid}-${dirSeq}-`));
  return {
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    statusPath: path.join(dir, 'status.json'),
    payoutLogPath: path.join(dir, 'payout.jsonl')
  };
}

const BASE_MS = Date.UTC(2026, 8, 19, 12, 0, 0);
const BASE_TS = Math.floor(BASE_MS / 1000);

function obsAt(tsSec, close, extra = {}) {
  return { asset: 'BTC/USD', market: 'regular', ts: tsSec, close, ...extra };
}

function snapshot(sup, rate = 0.85, atMs = BASE_MS) {
  return sup.payoutObserver.recordSnapshot({
    asset: 'BTC/USD',
    market: 'regular',
    payoutRate: rate,
    timestamp: atMs,
    source: 'UNIT_TEST'
  });
}

describe('DEMO_IQO_OPS fences v1.0.0', () => {
  test('constructor rejects live, wrong account, stake, expiry, venue, signalMode', () => {
    const p = freshPaths();
    expect(() => new DemoIqoOpsSupervisor({ ...p, liveTrading: true })).toThrow(/Live BLOCKED/);
    expect(() => new DemoIqoOpsSupervisor({ ...p, account: 'real' })).toThrow(/must be 'practice'/);
    expect(() => new DemoIqoOpsSupervisor({ ...p, defaultStake: 2.0 })).toThrow(/Martingale\/Kelly prohibited/);
    expect(() => new DemoIqoOpsSupervisor({ ...p, expirySeconds: 300 })).toThrow(/expirySeconds must be 60/);
    expect(() => new DemoIqoOpsSupervisor({ ...p, venue: 'BINANCE_SPOT' })).toThrow(/venue must be IQ_OPTION/);
    expect(() => new DemoIqoOpsSupervisor({ ...p, signalMode: 'ENABLED' })).toThrow(/New version \+ hash required/);
  });

  test('default provider trades nothing (zero dispatch out of the box)', () => {
    const p = freshPaths();
    const sup = new DemoIqoOpsSupervisor(p);
    snapshot(sup);
    for (let i = 0; i < 5; i++) {
      const r = sup.processObservation(obsAt(BASE_TS + i * 60, 50000 + i), BASE_MS + i * 60000);
      expect(r.direction).toBe('NO_SIGNAL');
    }
    expect(sup.counters.dispatched).toBe(0);
    expect(sup.getMetrics().totalTrades).toBe(0);
  });

  test('directional provider output is blocked while DISABLED (counted, never dispatched)', () => {
    const p = freshPaths();
    const sup = new DemoIqoOpsSupervisor({
      ...p,
      signalProvider: () => ({ direction: 'PUT', stake: 100, reason: 'ROGUE' })
    });
    snapshot(sup);
    const r = sup.processObservation(obsAt(BASE_TS, 50000), BASE_MS);
    expect(r.direction).toBe('NO_SIGNAL');
    expect(r.reason).toBe('SIGNAL_MODE_DISABLED_BLOCKED');
    expect(r.providerDirection).toBe('PUT');
    expect(sup.counters.blockedSignalDisabled).toBe(1);
    expect(sup.counters.tamperStakeAttempts).toBe(1);
    expect(sup.counters.dispatched).toBe(0);
  });

  test('dispatch blocked while venue payout unknown (never assume)', () => {
    const p = freshPaths();
    const sup = new DemoIqoOpsSupervisor({
      ...p,
      signalProvider: () => ({ direction: 'CALL', reason: 'X' })
    });
    const r = sup.processObservation(obsAt(BASE_TS, 50000), BASE_MS);
    expect(r.reason).toBe('PAYOUT_UNKNOWN_NO_DISPATCH');
    expect(sup.counters.blockedPayoutUnknown).toBe(1);
  });

  test('OTC market and wrong asset rejected (never merged)', () => {
    const p = freshPaths();
    const sup = new DemoIqoOpsSupervisor(p);
    snapshot(sup);
    const rOtc = sup.processObservation(obsAt(BASE_TS, 50000, { market: 'otc' }), BASE_MS);
    expect(rOtc.reason).toBe('NON_REGULAR_MARKET_REJECTED');
    const rAsset = sup.processObservation(
      obsAt(BASE_TS + 60, 50000, { asset: 'XAUUSD' }),
      BASE_MS + 60000
    );
    expect(rAsset.reason).toBe('WRONG_ASSET_REJECTED');
    expect(sup.counters.blockedOtc).toBe(1);
    expect(sup.counters.blockedWrongAsset).toBe(1);
  });

  test('daily stop at -10U blocks rest of UTC day; ledger rebuild is restart-safe; next day resumes', () => {
    const p = freshPaths();
    const sup = new DemoIqoOpsSupervisor(p);
    snapshot(sup);
    // 10x PUT losses of 1.0U (rising closes): dispatch at T, settle at T+60.
    for (let i = 0; i < 10; i++) {
      const t = BASE_TS + i * 120;
      const d = sup.dispatchDirectional(
        { direction: 'PUT', reason: 'UNIT' },
        obsAt(t, 50000 + i),
        t * 1000,
        { payoutRate: 0.85, source: 'UNIT_TEST', snapshotTs: BASE_MS }
      );
      expect(d.status).toBe('FILLED');
      sup.processObservation(obsAt(t + 60, 50000 + i + 5), (t + 60) * 1000);
    }
    expect(sup.getDayPnl(BASE_MS)).toBeCloseTo(-10, 8);
    const blocked = sup.processObservation(obsAt(BASE_TS + 10 * 120, 50000), (BASE_TS + 10 * 120) * 1000);
    expect(blocked.reason).toBe('DAILY_STOP_10U_REACHED');
    expect(sup.counters.blockedDailyStop).toBe(1);

    // Restart on same ledger paths: stop state survives via ledger rebuild.
    const sup2 = new DemoIqoOpsSupervisor(p);
    expect(sup2.getDayPnl(BASE_MS)).toBeCloseTo(-10, 8);

    // Next UTC day resumes (fresh wall-clock, no gap trip).
    const nextDayMs = BASE_MS + 86400000;
    const rNext = sup2.processObservation(obsAt(BASE_TS + 86400, 50000), nextDayMs);
    expect(rNext.reason).not.toBe('DAILY_STOP_10U_REACHED');
  });

  test('disconnect freeze is sticky (no auto-restart)', () => {
    const p = freshPaths();
    const sup = new DemoIqoOpsSupervisor(p);
    snapshot(sup);
    sup.setConnectionStatus(false, BASE_MS);
    expect(sup.isFrozen()).toBe(true);
    sup.setConnectionStatus(true, BASE_MS + 1000);
    expect(sup.isFrozen()).toBe(true);
    const r = sup.processObservation(obsAt(BASE_TS, 50000), BASE_MS + 2000);
    expect(r.status).toBe('FROZEN');
    expect(sup.counters.blockedFrozen).toBe(1);
  });

  test('feed gap >300s freezes supervision', () => {
    const p = freshPaths();
    const sup = new DemoIqoOpsSupervisor(p);
    snapshot(sup);
    sup.processObservation(obsAt(BASE_TS, 50000), BASE_MS);
    const r = sup.processObservation(obsAt(BASE_TS + 301, 50000), BASE_MS + 301000);
    expect(r.status).toBe('FROZEN');
    expect(sup.isFrozen()).toBe(true);
  });

  test('applied payout comes from observer snapshot and is logged per trade', () => {
    const p = freshPaths();
    const sup = new DemoIqoOpsSupervisor(p);
    snapshot(sup, 0.77);
    const d = sup.dispatchDirectional(
      { direction: 'CALL', reason: 'UNIT' },
      obsAt(BASE_TS, 50000),
      BASE_MS,
      sup.payoutObserver.getRate('BTC/USD', 'regular')
    );
    expect(d.status).toBe('FILLED');
    expect(d.order.payoutRate).toBe(0.77);
    expect(d.order.stake).toBe(1.0);
    const applied = sup.ledger.readAllEvents().filter((e) => e.eventType === 'PAYOUT_APPLIED');
    expect(applied.length).toBe(1);
    expect(applied[0].payoutRate).toBe(0.77);
    expect(applied[0].payoutSource).toBe('UNIT_TEST');
  });

  test('payout observer rejects invalid snapshots; latest snapshot wins; rebuild works', () => {
    const p = freshPaths();
    const ob = new DemoIqoPayoutObserver(p.payoutLogPath);
    expect(() =>
      ob.recordSnapshot({ asset: 'BTC/USD', market: 'regular', payoutRate: 0, timestamp: 1, source: 'T' })
    ).toThrow(/out of \(0,1]/);
    expect(() =>
      ob.recordSnapshot({ asset: 'BTC/USD', market: 'regular', payoutRate: 1.5, timestamp: 1, source: 'T' })
    ).toThrow(/out of \(0,1]/);
    expect(() =>
      ob.recordSnapshot({ asset: 'BTC/USD', market: 'regular', payoutRate: NaN, timestamp: 1, source: 'T' })
    ).toThrow(/finite/);
    ob.recordSnapshot({ asset: 'BTC/USD', market: 'regular', payoutRate: 0.8, timestamp: 1000, source: 'A' });
    ob.recordSnapshot({ asset: 'BTC/USD', market: 'regular', payoutRate: 0.85, timestamp: 2000, source: 'B' });
    expect(ob.getRate('BTC/USD', 'regular').payoutRate).toBe(0.85);
    const ob2 = new DemoIqoPayoutObserver(p.payoutLogPath);
    expect(ob2.getRate('BTC/USD', 'regular').source).toBe('B');
    expect(ob.hasRate('BTC/USD', 'otc')).toBe(false);
  });

  test('governance: no frozen-model imports; status carries quarantine + fences', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'execution', 'demo_iqo_ops_supervisor.js'),
      'utf-8'
    );
    expect(src).not.toMatch(/OrderFlowAbsorptionModel|BTCUSDTMicrostructureModel|HYPOTHESIS|MODEL_H/);
    const p = freshPaths();
    const sup = new DemoIqoOpsSupervisor(p);
    const rep = sup.emitStatusReport(BASE_MS);
    expect(rep.evidenceStatus).toMatch(/QUARANTINED/);
    expect(rep.quarantineNotice).toMatch(/NOT statistical evidence/);
    expect(rep.fences.liveTrading).toBe(false);
    expect(rep.fences.fixedStake).toBe(1.0);
    expect(rep.account).toBe('practice');
  });
});
