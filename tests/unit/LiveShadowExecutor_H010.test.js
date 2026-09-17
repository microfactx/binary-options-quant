"use strict";

const path = require('path');
const fs = require('fs');
const LiveShadowExecutorH010 = require('../../scripts/execution/live_shadow_executor_h010');

describe('Live Shadow Executor: MODEL_H010 Architecture & Lifecycle', () => {
  const tmpLedger = path.join(__dirname, '..', '..', 'research', 'execution', '_test_shadow_h010.jsonl');
  const tmpStatus = path.join(__dirname, '..', '..', 'research', 'reports', '_test_status_h010.json');

  beforeEach(() => {
    if (fs.existsSync(tmpLedger)) fs.unlinkSync(tmpLedger);
    if (fs.existsSync(tmpStatus)) fs.unlinkSync(tmpStatus);
  });

  afterEach(() => {
    if (fs.existsSync(tmpLedger)) fs.unlinkSync(tmpLedger);
    if (fs.existsSync(tmpStatus)) fs.unlinkSync(tmpStatus);
  });

  test('Pre-warms model with historical bars and verifies capacity', () => {
    const executor = new LiveShadowExecutorH010({
      ledgerPath: tmpLedger,
      statusPath: tmpStatus
    });

    const warmBars = Array.from({ length: 1500 }, (_, i) => ({
      ts: 1000000 + i * 60,
      open: 60000,
      high: 60100,
      low: 59900,
      close: 60000,
      volume: 10
    }));

    executor.preWarm(warmBars);
    expect(executor.preWarmCount).toBe(1500);
    expect(executor.model.currentAtr).toBeGreaterThan(0);
    expect(executor.model.currentMacroSma).toBeCloseTo(60000, 1);
  });

  test('Executes full Predict -> Dispatch -> Settle lifecycle', () => {
    const executor = new LiveShadowExecutorH010({
      ledgerPath: tmpLedger,
      statusPath: tmpStatus,
      defaultStake: 10.0,
      payoutRate: 0.85
    });

    // 1. Pre-warm
    const warmBars = Array.from({ length: 1450 }, (_, i) => ({
      ts: 1000000 + i * 60,
      open: 60000,
      high: 60100,
      low: 59900,
      close: 60000,
      volume: 10
    }));
    executor.preWarm(warmBars);

    // 2. Generate a valid Bull stretch triggering PUT
    // ATR ~ 200. Range = 60550 - 60100 = 450 (stretch 2.25x)
    const m1Candle = {
      ts: 2000000,
      open: 60100,
      high: 60550,
      low: 60100,
      close: 60500,
      volume: 50
    };

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
      close: 60300, // Red pro-fade
      taker_buy_vol: 30, // Absorbed
      taker_sell_vol: 70
    };

    const signal = executor.processCandle(m1Candle, micro, 2000000 * 1000);
    expect(signal.direction).toBe('PUT');
    expect(executor.pendingTrades.length).toBe(1);

    // 3. Next candle arrives at ts = 2000060 (60s later) with lower close -> WIN for PUT
    const nxtCandle = {
      ts: 2000060,
      open: 60500,
      high: 60520,
      low: 60400,
      close: 60450, // Exit lower than 60500
      volume: 40
    };

    executor.processCandle(nxtCandle, [], 2000060 * 1000);

    expect(executor.pendingTrades.length).toBe(0);
    expect(executor.settledTrades.length).toBe(1);
    expect(executor.settledTrades[0].outcome).toBe('WIN');
    expect(executor.settledTrades[0].pnl).toBeCloseTo(8.50, 2);

    const metrics = executor.getMetrics();
    expect(metrics.totalTrades).toBe(1);
    expect(metrics.wins).toBe(1);
    expect(metrics.losses).toBe(0);
    expect(metrics.winRate).toBe(1.0);
    expect(metrics.netPnl).toBeCloseTo(8.50, 2);

    const report = executor.emitStatusReport();
    expect(fs.existsSync(tmpStatus)).toBe(true);
    expect(report.metrics.wins).toBe(1);
  });
});
