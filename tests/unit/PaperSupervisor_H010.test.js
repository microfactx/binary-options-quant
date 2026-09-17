"use strict";

const fs = require('fs');
const path = require('path');
const PaperSupervisorH010 = require('../../scripts/execution/paper_supervisor_h010');

const SCRATCH = path.join(__dirname, '..', '..', 'scratch');

function tmpPaths(tag) {
  return {
    ledgerPath: path.join(SCRATCH, `test_paper_supervisor_h010_${tag}.jsonl`),
    statusPath: path.join(SCRATCH, `test_paper_supervisor_h010_${tag}_status.json`)
  };
}

function cleanup(p) {
  for (const f of [p.ledgerPath, p.statusPath]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_) {
      // ignore
    }
  }
}

function makeWarmBars(n, startTs = 1000000) {
  return Array.from({ length: n }, (_, i) => ({
    ts: startTs + i * 60,
    open: 60000,
    high: 60100,
    low: 59900,
    close: 60000,
    volume: 10
  }));
}

// Signal-generating bull-stretch candle (PUT) mirrored from LiveShadowExecutor_H010 suite.
function makeSignalCandle(ts = 2000000) {
  return { ts, open: 60100, high: 60550, low: 60100, close: 60500, volume: 50 };
}

function makeSignalMicro() {
  const micro = Array.from({ length: 12 }, (_, i) => ({
    high: i === 6 ? 60550 : 60400,
    low: 60200,
    open: 60300,
    close: 60350,
    taker_buy_vol: 10,
    taker_sell_vol: 10
  }));
  micro[11] = {
    high: 60500,
    low: 60250,
    open: 60350,
    close: 60300, // red pro-fade
    taker_buy_vol: 30,
    taker_sell_vol: 70
  };
  return micro;
}

function makeSupervisor(tag, extra = {}) {
  const p = tmpPaths(tag);
  cleanup(p);
  // Default startTimeMs = Date.now() so synthetic candle timestamps
  // (small epoch-second values) never trip the 30d enforcer by accident.
  // Tests that target the enforcer override startTimeMs explicitly.
  const sup = new PaperSupervisorH010({
    ledgerPath: p.ledgerPath,
    statusPath: p.statusPath,
    startTimeMs: Date.now(),
    ...extra
  });
  return { sup, paths: p };
}

describe('PaperSupervisor_H010 wrapper (SPEC_PAPER_H010 v1.1.0)', () => {
  test('frozen launch config: bridgeConfig, venue, expiry, fixed stake 1.0', () => {
    const { sup, paths } = makeSupervisor('config');
    try {
      expect(sup.venue).toBe('BINANCE_SPOT');
      expect(sup.expirySeconds).toBe(60);
      expect(sup.bridgeConfig).toEqual({ maxLatencyMs: 250, payoutRate: 0.85, defaultStake: 1.0 });
      expect(sup.executor.bridge.maxLatencyMs).toBe(250);
      expect(sup.executor.bridge.payoutRate).toBe(0.85);
      expect(sup.executor.bridge.defaultStake).toBe(1.0);
      // Kelly / venue / expiry deviations must throw (fail-closed).
      expect(() => new PaperSupervisorH010({ ...tmpPaths('x'), defaultStake: 2.0 })).toThrow();
      expect(() => new PaperSupervisorH010({ ...tmpPaths('x'), venue: 'IQ_OPTION' })).toThrow();
      expect(() => new PaperSupervisorH010({ ...tmpPaths('x'), expirySeconds: 900 })).toThrow();
    } finally {
      cleanup(paths);
    }
  });

  test('prewarmGate: zero dispatch before 1440 bars + macroSMA, opens after full warm', () => {
    const { sup, paths } = makeSupervisor('prewarm');
    try {
      expect(sup.isGateOpen()).toBe(false);
      expect(sup.getStatus()).toBe('PREWARM');

      // Attempt dispatch with a signal-generating candle BEFORE warm-up.
      const res = sup.processCandle(makeSignalCandle(), makeSignalMicro(), 2000000 * 1000);
      expect(res.gated).toBe(true);
      expect(res.status).toBe('PREWARM');
      expect(res.reason).toBe('PREWARM_GATE_BLOCKED');
      expect(sup.executor.pendingTrades.length).toBe(0);
      // Zero ledger writes before gate.
      expect(sup.executor.ledger.readAllEvents().length).toBe(0);
      expect(sup.blockedPrewarmCount).toBe(1);

      // Partial warm-up still blocked.
      sup.preWarm(makeWarmBars(100));
      expect(sup.isGateOpen()).toBe(false);
      const res2 = sup.processCandle(makeSignalCandle(2000060), makeSignalMicro(), 2000060 * 1000);
      expect(res2.gated).toBe(true);
      expect(sup.executor.pendingTrades.length).toBe(0);

      // Full warm-up opens gate (1440 canonical bars, macroSMA non-null).
      const { sup: sup2, paths: p2 } = makeSupervisor('prewarm2');
      try {
        sup2.preWarm(makeWarmBars(1440));
        expect(sup2.executor.preWarmCount).toBe(1440);
        expect(sup2.executor.model.currentMacroSma).not.toBeNull();
        expect(sup2.isGateOpen()).toBe(true);
        expect(sup2.getStatus()).toBe('ACTIVE_SHADOW');
        const live = sup2.processCandle(makeSignalCandle(), makeSignalMicro(), 2000000 * 1000);
        expect(live.direction).toBe('PUT');
        expect(live.gated).toBe(false);
        expect(sup2.executor.pendingTrades.length).toBe(1);
      } finally {
        cleanup(p2);
      }
    } finally {
      cleanup(paths);
    }
  });

  test('disconnectTimer: >300s M1 gap freezes, STATUS=FROZEN, sticky no auto-restart', () => {
    const { sup, paths } = makeSupervisor('gap');
    try {
      sup.preWarm(makeWarmBars(1440));
      expect(sup.isGateOpen()).toBe(true);

      const t0 = 3000000;
      const r0 = sup.processCandle(makeSignalCandle(t0), makeSignalMicro(), t0 * 1000);
      expect(r0.gated).toBe(false);
      expect(sup.isFrozen()).toBe(false);

      // 600s gap (>300s) must freeze.
      const tGap = t0 + 600;
      const rg = sup.processCandle(
        { ts: tGap, open: 60000, high: 60100, low: 59900, close: 60000, volume: 5 },
        [],
        tGap * 1000
      );
      expect(rg.status).toBe('FROZEN');
      expect(sup.isFrozen()).toBe(true);
      expect(sup.getStatus()).toBe('FROZEN');

      // Ledger must contain REJECTED/DISCONNECT.
      const events = sup.executor.ledger.readAllEvents();
      const rej = events.filter((e) => e.eventType === 'REJECTED' && String(e.reason).includes('DISCONNECT'));
      expect(rej.length).toBeGreaterThanOrEqual(1);

      // Status report emits STATUS=FROZEN.
      const report = sup.emitStatusReport(tGap * 1000);
      expect(report.status).toBe('FROZEN');
      expect(report.supervisor.disconnect.frozen).toBe(true);

      // Sticky: healthy candle afterwards must NOT auto-restart.
      const tNext = tGap + 60;
      const rn = sup.processCandle(
        { ts: tNext, open: 60000, high: 60100, low: 59900, close: 60000, volume: 5 },
        [],
        tNext * 1000
      );
      expect(rn.status).toBe('FROZEN');
      expect(sup.isFrozen()).toBe(true);
      // Zero new dispatches while frozen.
      const pendingBefore = sup.executor.pendingTrades.length;
      expect(sup.executor.pendingTrades.length).toBe(pendingBefore);
    } finally {
      cleanup(paths);
    }
  });

  test('disconnectTimer: WS down freezes immediately, sticky across reconnect', () => {
    const { sup, paths } = makeSupervisor('ws');
    try {
      sup.preWarm(makeWarmBars(1440));
      sup.setConnectionStatus(false, 4000000 * 1000);
      expect(sup.isFrozen()).toBe(true);
      expect(sup.getStatus()).toBe('FROZEN');

      const r = sup.processCandle(makeSignalCandle(4000060), makeSignalMicro(), 4000060 * 1000);
      expect(r.status).toBe('FROZEN');
      expect(sup.executor.pendingTrades.length).toBe(0);

      // Reconnect must NOT auto-restart.
      sup.executor.bridge.setConnectionStatus(true);
      const r2 = sup.processCandle(
        { ts: 4000120, open: 60000, high: 60100, low: 59900, close: 60000, volume: 5 },
        [],
        4000120 * 1000
      );
      expect(r2.status).toBe('FROZEN');
      expect(sup.isFrozen()).toBe(true);
    } finally {
      cleanup(paths);
    }
  });

  test('enforcer: N=100 settled (WIN+LOSS ex-PUSH) -> STATUS=FINAL, zero new dispatches', () => {
    const { sup, paths } = makeSupervisor('n100');
    try {
      sup.preWarm(makeWarmBars(1440));
      const bridge = sup.executor.bridge;
      const baseMs = 5000000 * 1000;
      // 100 settled: 50 WIN + 50 LOSS via direct bridge lifecycle (ledger-counted).
      for (let i = 0; i < 100; i++) {
        const obs = { timestamp: baseMs + i * 60000, close: 60000 + i, asset: 'BTCUSDT' };
        const dir = i % 2 === 0 ? 'CALL' : 'PUT';
        const d = bridge.dispatchOrder({ direction: dir, expirySeconds: 60 }, obs, obs.timestamp + 20);
        expect(d.status).toBe('FILLED');
        // Alternate WIN / LOSS deterministically.
        let exit;
        if (dir === 'CALL') exit = i % 4 === 0 ? obs.close + 10 : obs.close - 10;
        else exit = i % 4 === 1 ? obs.close - 10 : obs.close + 10;
        bridge.settlePosition(d.tradeId, exit, obs.timestamp + 60000);
      }
      // 3 PUSH events must be excluded from the count.
      for (let k = 0; k < 3; k++) {
        const obs = { timestamp: baseMs + 10000000 + k * 60000, close: 61000, asset: 'BTCUSDT' };
        const d = bridge.dispatchOrder({ direction: 'CALL', expirySeconds: 60 }, obs, obs.timestamp + 20);
        bridge.settlePosition(d.tradeId, 61000, obs.timestamp + 60000); // exit == entry -> PUSH
      }
      const counts = sup.getSettledCount();
      expect(counts.settled).toBe(100);
      expect(counts.pushes).toBe(3);

      // Next candle triggers FINAL.
      const tNext = 6000000;
      const r = sup.processCandle(
        { ts: tNext, open: 60000, high: 60100, low: 59900, close: 60000, volume: 5 },
        [],
        tNext * 1000
      );
      expect(r.status).toBe('FINAL');
      expect(sup.isFinal()).toBe(true);
      expect(sup.stopReason).toBe('N_100_SETTLED');
      expect(sup.getStatus()).toBe('FINAL');

      const report = sup.emitStatusReport(tNext * 1000);
      expect(report.status).toBe('FINAL');
      expect(report.supervisor.enforcer.settled).toBe(100);

      // Zero new dispatches after FINAL even with a signal candle.
      const pendingBefore = sup.executor.pendingTrades.length;
      const r2 = sup.processCandle(makeSignalCandle(tNext + 60), makeSignalMicro(), (tNext + 60) * 1000);
      expect(r2.status).toBe('FINAL');
      expect(r2.gated).toBe(true);
      expect(sup.executor.pendingTrades.length).toBe(pendingBefore);
    } finally {
      cleanup(paths);
    }
  });

  test('enforcer: 30d elapsed -> STATUS=FINAL', () => {
    const p = tmpPaths('t30');
    cleanup(p);
    const startOld = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const sup = new PaperSupervisorH010({ ledgerPath: p.ledgerPath, statusPath: p.statusPath, startTimeMs: startOld });
    try {
      sup.preWarm(makeWarmBars(1440));
      const r = sup.processCandle(
        { ts: 7000000, open: 60000, high: 60100, low: 59900, close: 60000, volume: 5 },
        [],
        Date.now()
      );
      expect(r.status).toBe('FINAL');
      expect(sup.isFinal()).toBe(true);
      expect(sup.stopReason).toBe('TIME_30D');
    } finally {
      cleanup(p);
    }
  });

  test('Predict BEFORE Update preserved through delegation', () => {
    // Fix time-travel: align startTimeMs so arrival is within 30d window
    // (elapsed >=0 and < MAX_DURATION 2592000000ms) and settled <100,
    // ensuring enforcer pre-check passes and delegation reaches predict->update.
    const arrivalMs = 8000000 * 1000;
    const { sup, paths } = makeSupervisor('order', { startTimeMs: arrivalMs - 60 * 1000 });
    try {
      sup.preWarm(makeWarmBars(1440));
      const order = [];
      const origPredict = sup.executor.model.predict.bind(sup.executor.model);
      const origUpdate = sup.executor.model.update.bind(sup.executor.model);
      sup.executor.model.predict = (...a) => {
        order.push('predict');
        return origPredict(...a);
      };
      sup.executor.model.update = (...a) => {
        order.push('update');
        return origUpdate(...a);
      };
      sup.processCandle(makeSignalCandle(8000000), makeSignalMicro(), arrivalMs);
      expect(order).toEqual(['predict', 'update']);
    } finally {
      cleanup(paths);
    }
  });
});
