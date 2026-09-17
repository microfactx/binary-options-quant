"use strict";

/**
 * scripts/execution/live_shadow_executor_h010.js
 *
 * Live Shadow / Forward Test Daemon for MODEL_H010.
 *
 * Architecture:
 * 1. PRE-WARM: Loads the canonical historical M1 bars to pre-warm the ATR(14)
 *    and Macro SMA(1440) lookback windows. No signals are dispatched during warm-up.
 *
 * 2. STREAM / TAIL: Watches for new CLOSED M1 candles and associated 5s micro-bars.
 *    Each new candle is evaluated: Predict BEFORE Update.
 *    Signals (CALL/PUT) are dispatched through PaperExecutionBridge and logged to immutable TradeLedger.
 *
 * 3. SETTLEMENT: Settles pending trades at 1 bar (60s) expiry.
 *
 * Invariants:
 *   - Predict BEFORE Update (causal integrity)
 *   - Zero Logic Inversion
 *   - Latency budget < 250ms (simulated at 50ms)
 *   - Append-only immutable TradeLedger
 */

const fs = require('fs');
const path = require('path');
const TradeLedger = require('../../src/execution/TradeLedger');
const PaperExecutionBridge = require('../../src/execution/PaperExecutionBridge');
const OrderFlowAbsorptionModel = require('../../src/strategy/models/OrderFlowAbsorptionModel');

class LiveShadowExecutorH010 {
  constructor(options = {}) {
    this.model = options.model || new OrderFlowAbsorptionModel(14, 1.5, 0.35, 50, 1440, 0.015, 0.45, 60);
    this.ledgerPath = options.ledgerPath || path.join(__dirname, '..', '..', 'research', 'execution', 'shadow_trades_h010.jsonl');
    this.statusPath = options.statusPath || path.join(__dirname, '..', '..', 'research', 'reports', 'SHADOW_FORWARD_TEST_STATUS_H010.json');

    this.ledger = new TradeLedger(this.ledgerPath);
    this.bridge = new PaperExecutionBridge({
      ledger: this.ledger,
      maxLatencyMs: options.maxLatencyMs || 250,
      payoutRate: options.payoutRate || 0.85,
      defaultStake: options.defaultStake || 1.0
    });

    this.pendingTrades = [];
    this.settledTrades = [];
    this.preWarmCount = 0;
  }

  preWarm(m1Candles = []) {
    for (const c of m1Candles) {
      this.model.update(c);
      this.preWarmCount++;
    }
  }

  processCandle(m1Candle, microCandles = [], arrivalTimeMs = Date.now()) {
    // 1. Settle any pending trade matching this candle's close
    const remainingPending = [];
    for (const pending of this.pendingTrades) {
      // Expiry is 1 bar (60s)
      if (m1Candle.ts >= pending.entryTs + 60) {
        const exitPrice = m1Candle.close;
        const settlement = this.bridge.settlePosition(pending.tradeId, exitPrice, arrivalTimeMs);
        this.settledTrades.push({
          tradeId: pending.tradeId,
          direction: pending.direction,
          entryPrice: pending.entryPrice,
          exitPrice,
          outcome: settlement.outcome,
          pnl: settlement.payoutProfit
        });
      } else {
        remainingPending.push(pending);
      }
    }
    this.pendingTrades = remainingPending;

    // 2. Predict BEFORE Update (causal invariant)
    const signal = this.model.predict(m1Candle, microCandles);

    // 3. Dispatch if active signal
    if (signal.direction === 'CALL' || signal.direction === 'PUT') {
      const observation = {
        timestamp: m1Candle.ts * 1000,
        close: m1Candle.close,
        asset: 'BTCUSDT'
      };
      const dispatch = this.bridge.dispatchOrder(
        { direction: signal.direction, expirySeconds: 60, reason: signal.reason },
        observation,
        arrivalTimeMs + 20 // Simulated 20ms network latency
      );

      if (dispatch.status === 'FILLED') {
        this.pendingTrades.push({
          tradeId: dispatch.tradeId,
          direction: signal.direction,
          entryPrice: m1Candle.close,
          entryTs: m1Candle.ts
        });
      }
    }

    // 4. Update model with closed candle
    this.model.update(m1Candle);
    return signal;
  }

  getMetrics() {
    const total = this.settledTrades.length;
    const wins = this.settledTrades.filter(t => t.outcome === 'WIN').length;
    const losses = this.settledTrades.filter(t => t.outcome === 'LOSS').length;
    const pushes = this.settledTrades.filter(t => t.outcome === 'PUSH').length;
    const resolved = wins + losses;
    const winRate = resolved > 0 ? wins / resolved : 0.0;
    const netPnl = this.settledTrades.reduce((acc, t) => acc + (t.pnl || 0), 0);

    return {
      totalTrades: total,
      wins,
      losses,
      pushes,
      winRate,
      netPnl,
      pendingCount: this.pendingTrades.length,
      preWarmCount: this.preWarmCount
    };
  }

  emitStatusReport() {
    const metrics = this.getMetrics();
    const report = {
      modelId: 'MODEL_H010_BTCUSDT_ORDERFLOW_ABSORPTION',
      status: 'ACTIVE_SHADOW',
      timestamp: new Date().toISOString(),
      metrics
    };
    fs.writeFileSync(this.statusPath, JSON.stringify(report, null, 2));
    return report;
  }
}

module.exports = LiveShadowExecutorH010;
