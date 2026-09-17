"use strict";

/**
 * scripts/execution/paper_supervisor_h010.js
 *
 * Paper Supervisor wrapper for MODEL_H010 forward (paper) test.
 *
 * FROZEN SPEC: research/governance/SPEC_PAPER_H010_v1.1.0.json (state FROZEN,
 *   fixed stake 1.0, Kelly prohibited).
 *
 * This file is a SEPARATE wrapper around the frozen
 * scripts/execution/live_shadow_executor_h010.js. It MUST NOT edit, subclass-mutate,
 * or monkey-patch the frozen executor / model / bridge / ledger modules.
 * Frozen Mutation veto applies to:
 *   - scripts/execution/live_shadow_executor_h010.js
 *   - src/strategy/models/OrderFlowAbsorptionModel.js
 *   - src/execution/PaperExecutionBridge.js
 *   - src/execution/TradeLedger.js
 *
 * Supervisor responsibilities (fail-closed):
 *   (a) prewarmGate: block processCandle/dispatch until
 *       executor.preWarmCount >= 1440 AND executor.model.currentMacroSma !== null.
 *       Counts canonical prewarm bars. Zero dispatch before gate.
 *   (b) disconnectTimer: track last M1 closed timestamp + WS status.
 *       If >300s gap without M1 close OR !isConnected -> freeze:
 *       stop dispatch, record REJECTED/DISCONNECT if possible, emit STATUS=FROZEN,
 *       no auto-restart (sticky until new provenance / manual reset).
 *   (c) enforcer: track start timestamp + settled WIN+LOSS ex-PUSH via ledger/status.
 *       At 30 calendar days OR 100 settled -> graceful stop, STATUS=FINAL,
 *       zero new dispatches.
 *   (d) launch config: explicit bridgeConfig { maxLatencyMs:250, payoutRate:0.85,
 *       defaultStake:1.0 }, venue BINANCE_SPOT, expiry 60s,
 *       Predict BEFORE Update preserved (delegation to frozen executor).
 *
 * No live start on require. No daemon run. Instantiation only.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const LiveShadowExecutorH010 = require('./live_shadow_executor_h010');

const SPEC_ID = 'SPEC_PAPER_H010';
const SPEC_VERSION = '1.1.0';
const VENUE = 'BINANCE_SPOT';
const ASSET = 'BTCUSDT';
const EXPIRY_SECONDS = 60;

const BRIDGE_CONFIG = Object.freeze({
  maxLatencyMs: 250,
  payoutRate: 0.85,
  defaultStake: 1.0
});

const PREWARM_MIN_BARS = 1440;
const DISCONNECT_GAP_SECONDS = 300;
const DISCONNECT_GAP_MS = 300 * 1000;
const MAX_SETTLED_TRADES = 100;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 calendar days

class PaperSupervisorH010 {
  constructor(options = {}) {
    // ---- Frozen launch-config enforcement (fail-closed) ----
    const venue = options.venue || VENUE;
    if (venue !== VENUE) {
      throw new Error(
        `SUPERVISOR ERROR: venue must be ${VENUE} (got ${venue}). Venue switch prohibited (Replication Laundering).`
      );
    }
    const expirySeconds = options.expirySeconds !== undefined ? options.expirySeconds : EXPIRY_SECONDS;
    if (expirySeconds !== EXPIRY_SECONDS) {
      throw new Error(`SUPERVISOR ERROR: expirySeconds must be ${EXPIRY_SECONDS} (got ${expirySeconds}).`);
    }
    const maxLatencyMs = options.maxLatencyMs !== undefined ? options.maxLatencyMs : BRIDGE_CONFIG.maxLatencyMs;
    const payoutRate = options.payoutRate !== undefined ? options.payoutRate : BRIDGE_CONFIG.payoutRate;
    const defaultStake = options.defaultStake !== undefined ? options.defaultStake : BRIDGE_CONFIG.defaultStake;
    if (maxLatencyMs !== BRIDGE_CONFIG.maxLatencyMs) {
      throw new Error(`SUPERVISOR ERROR: maxLatencyMs must be ${BRIDGE_CONFIG.maxLatencyMs} (got ${maxLatencyMs}).`);
    }
    if (payoutRate !== BRIDGE_CONFIG.payoutRate) {
      throw new Error(`SUPERVISOR ERROR: payoutRate must be ${BRIDGE_CONFIG.payoutRate} (got ${payoutRate}).`);
    }
    // Fixed stake 1.0 — Kelly / Martingale prohibited.
    if (defaultStake !== BRIDGE_CONFIG.defaultStake) {
      throw new Error(
        `SUPERVISOR ERROR: defaultStake must be ${BRIDGE_CONFIG.defaultStake} fixed (got ${defaultStake}). Kelly prohibited.`
      );
    }

    this.venue = VENUE;
    this.asset = ASSET;
    this.expirySeconds = EXPIRY_SECONDS;
    this.bridgeConfig = {
      maxLatencyMs: BRIDGE_CONFIG.maxLatencyMs,
      payoutRate: BRIDGE_CONFIG.payoutRate,
      defaultStake: BRIDGE_CONFIG.defaultStake
    };

    this.ledgerPath =
      options.ledgerPath || path.join(__dirname, '..', '..', 'research', 'execution', 'shadow_trades_h010.jsonl');
    this.statusPath =
      options.statusPath ||
      path.join(__dirname, '..', '..', 'research', 'reports', 'SHADOW_FORWARD_TEST_STATUS_H010.json');

    // Composition over frozen executor — no mutation of frozen modules.
    this.executor =
      options.executor ||
      new LiveShadowExecutorH010({
        ledgerPath: this.ledgerPath,
        statusPath: this.statusPath,
        maxLatencyMs: this.bridgeConfig.maxLatencyMs,
        payoutRate: this.bridgeConfig.payoutRate,
        defaultStake: this.bridgeConfig.defaultStake
      });

    this.startTimeMs = options.startTimeMs !== undefined ? options.startTimeMs : Date.now();

    // (b) disconnect timer state
    this.lastM1ClosedTs = null; // candle.ts in seconds
    this.lastArrivalMs = null; // wall-clock ms of last accepted candle
    this.frozen = false;
    this.freezeReason = null;
    this.frozenAt = null;

    // (c) enforcer state
    this.stopped = false; // FINAL
    this.stopReason = null;
    this.stoppedAt = null;

    // Observability counters
    this.blockedPrewarmCount = 0;
    this.blockedFrozenCount = 0;
    this.blockedFinalCount = 0;
    this.dispatchedCount = 0;
  }

  // ---------- (a) prewarm gate ----------
  isGateOpen() {
    const ex = this.executor;
    return ex.preWarmCount >= PREWARM_MIN_BARS && ex.model && ex.model.currentMacroSma !== null;
  }

  getPrewarmState() {
    return {
      preWarmCount: this.executor.preWarmCount,
      required: PREWARM_MIN_BARS,
      macroSma: this.executor.model ? this.executor.model.currentMacroSma : null,
      gateOpen: this.isGateOpen()
    };
  }

  /**
   * Count canonical prewarm bars via the frozen executor. No dispatch here by
   * construction (frozen preWarm only calls model.update).
   */
  preWarm(m1Candles = []) {
    if (this.stopped || this.frozen) return this.executor.preWarmCount;
    this.executor.preWarm(m1Candles);
    return this.executor.preWarmCount;
  }

  // ---------- settled counting (c) ----------
  /**
   * Settled = WIN + LOSS ex-PUSH, counted via ledger (primary) cross-checked
   * against in-memory executor metrics. Fail-closed: use max of both.
   */
  getSettledCount() {
    let ledgerSettled = 0;
    let ledgerWins = 0;
    let ledgerLosses = 0;
    let ledgerPushes = 0;
    try {
      if (this.executor.ledger && typeof this.executor.ledger.getSummary === 'function') {
        const s = this.executor.ledger.getSummary();
        ledgerWins = s.wins || 0;
        ledgerLosses = s.losses || 0;
        ledgerPushes = s.pushes || 0;
        ledgerSettled = ledgerWins + ledgerLosses;
      }
    } catch (_) {
      ledgerSettled = 0;
    }
    let execSettled = 0;
    let execWins = 0;
    let execLosses = 0;
    let execPushes = 0;
    try {
      if (typeof this.executor.getMetrics === 'function') {
        const m = this.executor.getMetrics();
        execWins = m.wins || 0;
        execLosses = m.losses || 0;
        execPushes = m.pushes || 0;
        execSettled = execWins + execLosses;
      } else if (Array.isArray(this.executor.settledTrades)) {
        for (const t of this.executor.settledTrades) {
          if (t.outcome === 'WIN') execWins++;
          else if (t.outcome === 'LOSS') execLosses++;
          else if (t.outcome === 'PUSH') execPushes++;
        }
        execSettled = execWins + execLosses;
      }
    } catch (_) {
      execSettled = 0;
    }
    return {
      settled: Math.max(ledgerSettled, execSettled),
      wins: Math.max(ledgerWins, execWins),
      losses: Math.max(ledgerLosses, execLosses),
      pushes: Math.max(ledgerPushes, execPushes)
    };
  }

  // ---------- (b) disconnect / freeze ----------
  isConnected() {
    try {
      if (this.executor.bridge && typeof this.executor.bridge.isConnected === 'boolean') {
        return this.executor.bridge.isConnected;
      }
    } catch (_) {
      return false;
    }
    return true;
  }

  setConnectionStatus(connected, nowMs = Date.now()) {
    try {
      if (this.executor.bridge && typeof this.executor.bridge.setConnectionStatus === 'function') {
        this.executor.bridge.setConnectionStatus(connected);
      }
    } catch (_) {
      // fall through to freeze below
    }
    if (!connected) {
      this.freeze('WS_DISCONNECT', nowMs);
    }
    // NOTE: no auto-unfreeze on reconnect. Frozen is sticky (no auto-restart
    // without new provenance). Reconnect intentionally does NOT clear `frozen`.
    return this.isConnected();
  }

  isFrozen() {
    return this.frozen === true;
  }

  isFinal() {
    return this.stopped === true;
  }

  freeze(reason = 'DISCONNECT', nowMs = Date.now()) {
    if (this.frozen || this.stopped) return this.getStatus();
    this.frozen = true;
    this.freezeReason = reason;
    this.frozenAt = new Date(nowMs).toISOString();
    // Record REJECTED/DISCONNECT if possible (best-effort, never throws).
    try {
      if (this.executor.ledger && typeof this.executor.ledger.recordEvent === 'function') {
        const tradeId = `TRADE_${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
        this.executor.ledger.recordEvent({
          tradeId,
          eventType: 'REJECTED',
          reason: `DISCONNECT_${reason}`,
          timestamp: nowMs
        });
      }
    } catch (_) {
      // ledger write failure must not crash supervisor; freeze still holds.
    }
    try {
      this.emitStatusReport(nowMs);
    } catch (_) {
      // status write failure must not crash supervisor.
    }
    return this.getStatus();
  }

  /**
   * Internal disconnect-gap check against previously tracked M1 close.
   * Returns a freeze reason string, or null if healthy.
   */
  checkDisconnectGap(m1Candle, arrivalTimeMs) {
    if (!this.isConnected()) return 'WS_DISCONNECTED';
    if (this.lastM1ClosedTs !== null && m1Candle && typeof m1Candle.ts === 'number') {
      const gapSec = m1Candle.ts - this.lastM1ClosedTs;
      if (gapSec > DISCONNECT_GAP_SECONDS) return `M1_GAP_${gapSec}S_EXCEEDS_${DISCONNECT_GAP_SECONDS}S`;
    }
    if (this.lastArrivalMs !== null && typeof arrivalTimeMs === 'number') {
      const gapMs = arrivalTimeMs - this.lastArrivalMs;
      if (gapMs > DISCONNECT_GAP_MS) return `WALLCLOCK_GAP_${gapMs}MS_EXCEEDS_${DISCONNECT_GAP_MS}MS`;
    }
    return null;
  }

  // ---------- (c) enforcer ----------
  checkEnforcer(nowMs = Date.now()) {
    if (this.stopped) return { final: true, reason: this.stopReason };
    const elapsed = nowMs - this.startTimeMs;
    if (elapsed >= MAX_DURATION_MS) {
      this.gracefulStop('TIME_30D', nowMs);
      return { final: true, reason: 'TIME_30D' };
    }
    const { settled } = this.getSettledCount();
    if (settled >= MAX_SETTLED_TRADES) {
      this.gracefulStop('N_100_SETTLED', nowMs);
      return { final: true, reason: 'N_100_SETTLED' };
    }
    return { final: false, reason: null };
  }

  gracefulStop(reason = 'N_100_SETTLED', nowMs = Date.now()) {
    if (this.stopped) return this.getStatus();
    this.stopped = true;
    this.stopReason = reason;
    this.stoppedAt = new Date(nowMs).toISOString();
    try {
      this.emitStatusReport(nowMs);
    } catch (_) {
      // never throw on status write
    }
    return this.getStatus();
  }

  getStatus() {
    if (this.stopped) return 'FINAL';
    if (this.frozen) return 'FROZEN';
    if (!this.isGateOpen()) return 'PREWARM';
    return 'ACTIVE_SHADOW';
  }

  /**
   * Gated candle entry point. Wraps the frozen executor.processCandle.
   *
   * Order of checks (fail-closed):
   *   1. FINAL  -> block, zero dispatch
   *   2. FROZEN -> block, zero dispatch (sticky, no auto-restart)
   *   3. disconnect (WS down or >300s gap) -> freeze + block
   *   4. enforcer pre-check (30d / 100 settled) -> FINAL + block
   *   5. prewarm gate -> block, zero dispatch (tracks timer, no delegation)
   *   6. delegate to frozen executor.processCandle (Predict BEFORE Update
   *      preserved inside frozen executor; supervisor never reorders it)
   *   7. enforcer post-check -> if limit now reached, graceful stop for NEXT candle
   */
  processCandle(m1Candle, microCandles = [], arrivalTimeMs = Date.now()) {
    const nowMs = typeof arrivalTimeMs === 'number' ? arrivalTimeMs : Date.now();

    // 1. FINAL: zero new dispatches.
    if (this.stopped) {
      this.blockedFinalCount++;
      return { direction: 'NO_SIGNAL', reason: 'SUPERVISOR_FINAL_STOP', status: 'FINAL', gated: true };
    }

    // 2. FROZEN: sticky, no auto-restart.
    if (this.frozen) {
      this.blockedFrozenCount++;
      return {
        direction: 'NO_SIGNAL',
        reason: `SUPERVISOR_FROZEN_${this.freezeReason || 'UNKNOWN'}`,
        status: 'FROZEN',
        gated: true
      };
    }

    // 3. Disconnect check (before touching executor).
    const gapReason = this.checkDisconnectGap(m1Candle, nowMs);
    if (gapReason) {
      this.freeze(gapReason, nowMs);
      this.blockedFrozenCount++;
      return { direction: 'NO_SIGNAL', reason: `SUPERVISOR_FROZEN_${gapReason}`, status: 'FROZEN', gated: true };
    }

    // 4. Enforcer pre-check.
    const pre = this.checkEnforcer(nowMs);
    if (pre.final) {
      this.blockedFinalCount++;
      return { direction: 'NO_SIGNAL', reason: `SUPERVISOR_FINAL_${pre.reason}`, status: 'FINAL', gated: true };
    }

    // 5. Prewarm gate: zero dispatch before gate. Do NOT delegate.
    if (!this.isGateOpen()) {
      this.blockedPrewarmCount++;
      // Keep disconnect timer tracking even while gated.
      if (m1Candle && typeof m1Candle.ts === 'number') this.lastM1ClosedTs = m1Candle.ts;
      this.lastArrivalMs = nowMs;
      return {
        direction: 'NO_SIGNAL',
        reason: 'PREWARM_GATE_BLOCKED',
        status: 'PREWARM',
        gated: true,
        prewarm: this.getPrewarmState()
      };
    }

    // 6. Delegate to frozen executor (Predict BEFORE Update lives inside).
    let signal;
    try {
      signal = this.executor.processCandle(m1Candle, microCandles, nowMs);
    } catch (err) {
      // Fail-closed: any executor/feed exception freezes supervision.
      this.freeze(`EXECUTOR_EXCEPTION_${err && err.message ? err.message : 'UNKNOWN'}`, nowMs);
      this.blockedFrozenCount++;
      return { direction: 'NO_SIGNAL', reason: 'SUPERVISOR_FROZEN_EXECUTOR_EXCEPTION', status: 'FROZEN', gated: true };
    }

    // Track timer after successful delegation.
    if (m1Candle && typeof m1Candle.ts === 'number') this.lastM1ClosedTs = m1Candle.ts;
    this.lastArrivalMs = nowMs;
    if (signal && (signal.direction === 'CALL' || signal.direction === 'PUT')) this.dispatchedCount++;

    // 7. Enforcer post-check: candle that reaches the limit is allowed;
    //    the NEXT candle is blocked with FINAL.
    this.checkEnforcer(nowMs);

    const out = signal && typeof signal === 'object' ? { ...signal } : { direction: 'NO_SIGNAL', reason: 'EMPTY' };
    out.status = this.getStatus();
    out.gated = false;
    return out;
  }

  emitStatusReport(nowMs = Date.now()) {
    const settled = this.getSettledCount();
    let executorMetrics = null;
    try {
      executorMetrics =
        typeof this.executor.getMetrics === 'function' ? this.executor.getMetrics() : { settledTrades: 0 };
    } catch (_) {
      executorMetrics = { error: 'METRICS_UNAVAILABLE' };
    }
    const status = this.getStatus();
    const report = {
      modelId: 'MODEL_H010_BTCUSDT_ORDERFLOW_ABSORPTION',
      specId: SPEC_ID,
      specVersion: SPEC_VERSION,
      venue: this.venue,
      asset: this.asset,
      status,
      timestamp: new Date(nowMs).toISOString(),
      metrics: executorMetrics,
      supervisor: {
        prewarm: this.getPrewarmState(),
        disconnect: {
          lastM1ClosedTs: this.lastM1ClosedTs,
          lastArrivalMs: this.lastArrivalMs,
          gapThresholdSeconds: DISCONNECT_GAP_SECONDS,
          isConnected: this.isConnected(),
          frozen: this.frozen,
          freezeReason: this.freezeReason,
          frozenAt: this.frozenAt
        },
        enforcer: {
          startTimeMs: this.startTimeMs,
          startTimeUtc: new Date(this.startTimeMs).toISOString(),
          elapsedMs: nowMs - this.startTimeMs,
          maxDurationMs: MAX_DURATION_MS,
          settled: settled.settled,
          wins: settled.wins,
          losses: settled.losses,
          pushes: settled.pushes,
          maxSettled: MAX_SETTLED_TRADES,
          stopped: this.stopped,
          stopReason: this.stopReason,
          stoppedAt: this.stoppedAt
        },
        bridgeConfig: { ...this.bridgeConfig },
        expirySeconds: this.expirySeconds,
        counters: {
          dispatched: this.dispatchedCount,
          blockedPrewarm: this.blockedPrewarmCount,
          blockedFrozen: this.blockedFrozenCount,
          blockedFinal: this.blockedFinalCount
        }
      }
    };
    const dir = path.dirname(this.statusPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.statusPath, JSON.stringify(report, null, 2));
    return report;
  }
}

module.exports = PaperSupervisorH010;
module.exports.SPEC_ID = SPEC_ID;
module.exports.SPEC_VERSION = SPEC_VERSION;
module.exports.VENUE = VENUE;
module.exports.ASSET = ASSET;
module.exports.EXPIRY_SECONDS = EXPIRY_SECONDS;
module.exports.BRIDGE_CONFIG = BRIDGE_CONFIG;
module.exports.PREWARM_MIN_BARS = PREWARM_MIN_BARS;
module.exports.DISCONNECT_GAP_SECONDS = DISCONNECT_GAP_SECONDS;
module.exports.MAX_SETTLED_TRADES = MAX_SETTLED_TRADES;
module.exports.MAX_DURATION_MS = MAX_DURATION_MS;

// No live start on direct invocation: print usage only (no daemon, no network).
if (require.main === module) {
  // eslint-disable-next-line no-console
  console.log(
    'paper_supervisor_h010: wrapper only. Instantiate via require() with frozen SPEC_PAPER_H010_v1.1.0 bridgeConfig. No live start performed.'
  );
}
