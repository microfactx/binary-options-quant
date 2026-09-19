"use strict";

/**
 * scripts/execution/demo_iqo_ops_supervisor.js
 *
 * Supervisor for track DEMO_IQO_OPS (IQ Option practice/demo operations).
 *
 * FROZEN FENCES: scripts/execution/demo_iqo_ops_fences_v1.0.0.json
 *   (track DEMO_IQO_OPS v1.0.0, state FROZEN).
 *
 * What this IS: demo-only rails — fixed stake, daily stop, disconnect freeze,
 * OTC rejection, observed-payout-only fills, append-only ledger. Signal input
 * is EXPLORATORY-UNVALIDATED and DISABLED by default (zero trading out of the
 * box). Outputs are QUARANTINED: no acceptance power, no promotion.
 *
 * What this IS NOT: it is not H010 (venue switch prohibited), not H011
 * (unfrozen), not evidence, not a live bridge. Frozen research modules
 * (executors, models, registries) are never imported here.
 *
 * Domain isolation: this file contains NO signal generation and NO sizing
 * logic. The signal provider is injected; sizing is frozen at 1.0 and
 * signal-supplied stake is ignored + logged.
 *
 * Paper settlement convention (LIMITATION, logged in every status report):
 * entry = dispatch observation close, exit = first observation close at
 * entryTs + 60s. Venue settlement may differ — this scaffold measures
 * operations, not economics.
 *
 * No live start on require. Instantiation only.
 */

const fs = require('fs');
const path = require('path');
const TradeLedger = require('../../src/execution/TradeLedger');
const PaperExecutionBridge = require('../../src/execution/PaperExecutionBridge');
const DemoIqoPayoutObserver = require('./demo_iqo_ops_payout_observer');

const TRACK_ID = 'DEMO_IQO_OPS';
const FENCE_VERSION = '1.0.0';
const VENUE = 'IQ_OPTION';
const ASSET = 'BTC/USD';
const MARKET = 'regular';
const ACCOUNT = 'practice';
const EXPIRY_SECONDS = 60;
const FIXED_STAKE = 1.0;
const DAILY_STOP_UNITS = 10.0;
const MAX_LATENCY_MS = 250;
const DISCONNECT_GAP_SECONDS = 300;
const DISCONNECT_GAP_MS = 300 * 1000;
const SIGNAL_MODE = 'DISABLED';
const EVIDENCE_STATUS = 'EXPLORATORY-UNVALIDATED-QUARANTINED';

/**
 * Default signal provider: always NO_SIGNAL. Out of the box this robot
 * trades nothing. Wiring a directional provider requires a NEW fence-config
 * version + new hash (signalMode ENABLED is not a value in v1.0.0).
 */
function DisabledSignalProvider() {
  return { direction: 'NO_SIGNAL', reason: 'SIGNAL_MODE_DISABLED_NO_CLAIMS' };
}

function utcDayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

class DemoIqoOpsSupervisor {
  constructor(options = {}) {
    // ---- Fence enforcement (fail-closed, constructor-time) ----
    const account = options.account || ACCOUNT;
    if (account !== ACCOUNT) {
      throw new Error(`DEMO OPS ERROR: account must be '${ACCOUNT}' (got '${account}'). Live BLOCKED.`);
    }
    if (options.liveTrading === true) {
      throw new Error('DEMO OPS ERROR: liveTrading=true rejected. Live BLOCKED.');
    }
    const venue = options.venue || VENUE;
    if (venue !== VENUE) throw new Error(`DEMO OPS ERROR: venue must be ${VENUE} (got ${venue}).`);
    const asset = options.asset || ASSET;
    if (asset !== ASSET) throw new Error(`DEMO OPS ERROR: asset must be ${ASSET} (got ${asset}).`);
    const expirySeconds = options.expirySeconds !== undefined ? options.expirySeconds : EXPIRY_SECONDS;
    if (expirySeconds !== EXPIRY_SECONDS) {
      throw new Error(`DEMO OPS ERROR: expirySeconds must be ${EXPIRY_SECONDS} (got ${expirySeconds}).`);
    }
    const defaultStake = options.defaultStake !== undefined ? options.defaultStake : FIXED_STAKE;
    if (defaultStake !== FIXED_STAKE) {
      throw new Error(
        `DEMO OPS ERROR: defaultStake must be ${FIXED_STAKE} fixed (got ${defaultStake}). Martingale/Kelly prohibited.`
      );
    }
    const signalMode = options.signalMode || SIGNAL_MODE;
    if (signalMode !== SIGNAL_MODE) {
      throw new Error(
        `DEMO OPS ERROR: signalMode '${signalMode}' not in fence v1.0.0 (only '${SIGNAL_MODE}'). New version + hash required.`
      );
    }

    this.trackId = TRACK_ID;
    this.fenceVersion = FENCE_VERSION;
    this.venue = VENUE;
    this.asset = ASSET;
    this.market = MARKET;
    this.account = ACCOUNT;
    this.expirySeconds = EXPIRY_SECONDS;
    this.signalMode = SIGNAL_MODE;

    this.ledgerPath =
      options.ledgerPath || path.join(__dirname, '..', '..', 'research', 'execution', 'demo_iqo_ops_ledger.jsonl');
    this.statusPath =
      options.statusPath || path.join(__dirname, '..', '..', 'research', 'reports', 'DEMO_IQO_OPS_STATUS.json');
    const payoutLogPath =
      options.payoutLogPath ||
      path.join(__dirname, '..', '..', 'research', 'execution', 'demo_iqo_payout_log.jsonl');

    this.ledger = new TradeLedger(this.ledgerPath);
    // NOTE: payoutRate here is a transport placeholder, never an assumption:
    // dispatch is blocked until the observer holds a venue snapshot, and the
    // bridge rate is synced from the observer immediately before each fill.
    this.bridge = new PaperExecutionBridge({
      ledger: this.ledger,
      maxLatencyMs: options.maxLatencyMs !== undefined ? options.maxLatencyMs : MAX_LATENCY_MS,
      payoutRate: 0.85,
      defaultStake: FIXED_STAKE
    });
    if (this.bridge.maxLatencyMs !== MAX_LATENCY_MS) {
      throw new Error(`DEMO OPS ERROR: maxLatencyMs must be ${MAX_LATENCY_MS}.`);
    }
    this.payoutObserver = new DemoIqoPayoutObserver(payoutLogPath);

    this.signalProvider =
      typeof options.signalProvider === 'function' ? options.signalProvider : DisabledSignalProvider;

    this.pendingTrades = []; // {tradeId, direction, entryPrice, entryTs, payoutRate}
    this.settledTrades = []; // {tradeId, direction, entryPrice, exitPrice, outcome, pnl, settledDay}
    this.dayPnl = new Map(); // utcDay -> realized pnl (WIN+LOSS, PUSH=0)
    this.rebuildDailyFromLedger();

    this.lastObsTs = null;
    this.lastArrivalMs = null;
    this.frozen = false;
    this.freezeReason = null;
    this.frozenAt = null;

    this.counters = {
      dispatched: 0,
      blockedDailyStop: 0,
      blockedFrozen: 0,
      blockedOtc: 0,
      blockedWrongAsset: 0,
      blockedPayoutUnknown: 0,
      blockedSignalDisabled: 0,
      blockedInvalidObs: 0,
      tamperStakeAttempts: 0
    };
  }

  rebuildDailyFromLedger() {
    let events = [];
    try {
      events = this.ledger.readAllEvents();
    } catch (_) {
      events = [];
    }
    for (const ev of events) {
      if (ev.eventType === 'SETTLED' && typeof ev.payoutProfit === 'number') {
        const day = utcDayKey(typeof ev.timestamp === 'number' ? ev.timestamp : Date.parse(ev.recordedAtUtc));
        this.dayPnl.set(day, (this.dayPnl.get(day) || 0) + ev.payoutProfit);
        this.settledTrades.push({
          tradeId: ev.tradeId,
          direction: ev.direction,
          entryPrice: ev.entryPrice,
          exitPrice: ev.exitPrice,
          outcome: ev.outcome,
          pnl: ev.payoutProfit,
          settledDay: day
        });
      }
    }
  }

  getDayPnl(nowMs) {
    return this.dayPnl.get(utcDayKey(nowMs)) || 0;
  }

  isFrozen() {
    return this.frozen === true;
  }

  freeze(reason, nowMs = Date.now()) {
    if (this.frozen) return this.getStatus();
    this.frozen = true;
    this.freezeReason = reason;
    this.frozenAt = new Date(nowMs).toISOString();
    try {
      this.emitStatusReport(nowMs);
    } catch (_) {
      // never throw on status write
    }
    return this.getStatus();
  }

  setConnectionStatus(connected, nowMs = Date.now()) {
    try {
      if (this.bridge && typeof this.bridge.setConnectionStatus === 'function') {
        this.bridge.setConnectionStatus(connected);
      }
    } catch (_) {
      // fall through to freeze below
    }
    if (!connected) this.freeze('WS_DISCONNECT', nowMs);
    // Sticky: reconnect does NOT unfreeze (manual reset + new provenance required).
    return this.getStatus();
  }

  getStatus() {
    if (this.frozen) return 'FROZEN';
    return 'ACTIVE_DEMO';
  }

  /**
   * Gated observation entry point. obs = {asset, market, ts (sec), close}.
   * Order (fail-closed): frozen -> daily stop -> disconnect gap -> market/asset
   * gate -> settle due -> payout-known gate -> signalMode gate -> dispatch.
   */
  processObservation(obs, arrivalTimeMs = Date.now()) {
    const nowMs = typeof arrivalTimeMs === 'number' ? arrivalTimeMs : Date.now();

    if (this.frozen) {
      this.counters.blockedFrozen++;
      return { direction: 'NO_SIGNAL', reason: `DEMO_FROZEN_${this.freezeReason || 'UNKNOWN'}`, status: 'FROZEN' };
    }

    if (!obs || typeof obs.close !== 'number' || typeof obs.ts !== 'number') {
      this.counters.blockedInvalidObs++;
      return { direction: 'NO_SIGNAL', reason: 'INVALID_OBSERVATION', status: this.getStatus() };
    }

    // Daily stop (UTC day, realized WIN+LOSS only; PUSH contributes 0).
    if (this.getDayPnl(nowMs) <= -DAILY_STOP_UNITS) {
      this.counters.blockedDailyStop++;
      return { direction: 'NO_SIGNAL', reason: 'DAILY_STOP_10U_REACHED', status: this.getStatus() };
    }

    // Disconnect gap (>300s without M1 close or wall-clock stall) -> sticky freeze.
    if (this.lastObsTs !== null && obs.ts - this.lastObsTs > DISCONNECT_GAP_SECONDS) {
      this.freeze(`M1_GAP_${obs.ts - this.lastObsTs}S_EXCEEDS_${DISCONNECT_GAP_SECONDS}S`, nowMs);
      this.counters.blockedFrozen++;
      return { direction: 'NO_SIGNAL', reason: 'DEMO_FROZEN_FEED_GAP', status: 'FROZEN' };
    }
    if (this.lastArrivalMs !== null && nowMs - this.lastArrivalMs > DISCONNECT_GAP_MS) {
      this.freeze(`WALLCLOCK_GAP_${nowMs - this.lastArrivalMs}MS`, nowMs);
      this.counters.blockedFrozen++;
      return { direction: 'NO_SIGNAL', reason: 'DEMO_FROZEN_WALLCLOCK_GAP', status: 'FROZEN' };
    }
    try {
      if (this.bridge && this.bridge.isConnected === false) {
        this.freeze('WS_DISCONNECTED', nowMs);
        this.counters.blockedFrozen++;
        return { direction: 'NO_SIGNAL', reason: 'DEMO_FROZEN_DISCONNECTED', status: 'FROZEN' };
      }
    } catch (_) {
      this.freeze('WS_STATUS_UNKNOWN', nowMs);
      this.counters.blockedFrozen++;
      return { direction: 'NO_SIGNAL', reason: 'DEMO_FROZEN_WS_UNKNOWN', status: 'FROZEN' };
    }

    // Venue/instrument gates: regular BTC/USD only. OTC and wrong assets rejected.
    if (obs.asset !== this.asset) {
      this.counters.blockedWrongAsset++;
      this.lastObsTs = obs.ts;
      this.lastArrivalMs = nowMs;
      return { direction: 'NO_SIGNAL', reason: 'WRONG_ASSET_REJECTED', status: this.getStatus() };
    }
    if (obs.market !== this.market) {
      this.counters.blockedOtc++;
      this.lastObsTs = obs.ts;
      this.lastArrivalMs = nowMs;
      return { direction: 'NO_SIGNAL', reason: 'NON_REGULAR_MARKET_REJECTED', status: this.getStatus() };
    }

    // Settle due pendings at 60s expiry on feed closes (paper convention).
    const remaining = [];
    for (const p of this.pendingTrades) {
      if (obs.ts >= p.entryTs + EXPIRY_SECONDS) {
        const settlement = this.bridge.settlePosition(p.tradeId, obs.close, nowMs);
        const day = utcDayKey(nowMs);
        this.dayPnl.set(day, (this.dayPnl.get(day) || 0) + (settlement.payoutProfit || 0));
        this.settledTrades.push({
          tradeId: p.tradeId,
          direction: p.direction,
          entryPrice: p.entryPrice,
          exitPrice: obs.close,
          outcome: settlement.outcome,
          pnl: settlement.payoutProfit || 0,
          settledDay: day
        });
      } else {
        remaining.push(p);
      }
    }
    this.pendingTrades = remaining;

    // Payout-known gate: no venue snapshot, no dispatch. Never assume.
    const rate = this.payoutObserver.getRate(this.asset, this.market);
    if (!rate) {
      this.counters.blockedPayoutUnknown++;
      this.lastObsTs = obs.ts;
      this.lastArrivalMs = nowMs;
      return { direction: 'NO_SIGNAL', reason: 'PAYOUT_UNKNOWN_NO_DISPATCH', status: this.getStatus() };
    }

    // Signal gate: DISABLED blocks every directional provider output.
    let signal;
    try {
      signal = this.signalProvider(obs, { supervisor: this });
    } catch (err) {
      this.freeze(`SIGNAL_EXCEPTION_${(err && err.message) || 'UNKNOWN'}`, nowMs);
      this.counters.blockedFrozen++;
      return { direction: 'NO_SIGNAL', reason: 'DEMO_FROZEN_SIGNAL_EXCEPTION', status: 'FROZEN' };
    }
    if (!signal || (signal.direction !== 'CALL' && signal.direction !== 'PUT')) {
      this.lastObsTs = obs.ts;
      this.lastArrivalMs = nowMs;
      return { direction: 'NO_SIGNAL', reason: (signal && signal.reason) || 'NO_DIRECTIONAL_SIGNAL', status: this.getStatus() };
    }
    // v1.0.0: directional output while DISABLED is blocked + counted.
    this.counters.blockedSignalDisabled++;
    if (signal.stake !== undefined && signal.stake !== FIXED_STAKE) this.counters.tamperStakeAttempts++;
    this.lastObsTs = obs.ts;
    this.lastArrivalMs = nowMs;
    return { direction: 'NO_SIGNAL', reason: 'SIGNAL_MODE_DISABLED_BLOCKED', status: this.getStatus(), providerDirection: signal.direction };
  }

  /**
   * Internal dispatch path, reachable only when signalMode allows directionals
   * (no such mode exists in fence v1.0.0 — kept for versioned enablement).
   * Isolated here so v1.0.0 review can verify it is unreachable.
   */
  dispatchDirectional(signal, obs, nowMs, rate) {
    if (signal.stake !== undefined && signal.stake !== FIXED_STAKE) {
      this.counters.tamperStakeAttempts++;
    }
    this.bridge.payoutRate = rate.payoutRate;
    const observation = { timestamp: nowMs, close: obs.close, asset: this.asset };
    const dispatch = this.bridge.dispatchOrder(
      { direction: signal.direction, expirySeconds: EXPIRY_SECONDS, reason: 'EXPLORATORY-UNVALIDATED' },
      observation,
      nowMs
    );
    if (dispatch.status !== 'FILLED') return dispatch;
    try {
      this.ledger.recordEvent({
        tradeId: dispatch.tradeId,
        eventType: 'PAYOUT_APPLIED',
        asset: this.asset,
        market: this.market,
        payoutRate: rate.payoutRate,
        payoutSource: rate.source,
        payoutSnapshotTs: rate.snapshotTs,
        stake: FIXED_STAKE,
        timestamp: nowMs
      });
    } catch (_) {
      // ledger append failure must not leave a naked position: fail-closed.
      try {
        this.bridge.activePositions.delete(dispatch.tradeId);
      } catch (_) {
        // ignore secondary failure
      }
      return { status: 'REJECTED', reason: 'PAYOUT_EVENT_LOG_FAILED', tradeId: dispatch.tradeId };
    }
    this.pendingTrades.push({
      tradeId: dispatch.tradeId,
      direction: signal.direction,
      entryPrice: obs.close,
      entryTs: obs.ts,
      payoutRate: rate.payoutRate
    });
    this.counters.dispatched++;
    return dispatch;
  }

  getMetrics() {
    const wins = this.settledTrades.filter((t) => t.outcome === 'WIN').length;
    const losses = this.settledTrades.filter((t) => t.outcome === 'LOSS').length;
    const pushes = this.settledTrades.filter((t) => t.outcome === 'PUSH').length;
    const resolved = wins + losses;
    return {
      totalTrades: this.settledTrades.length,
      wins,
      losses,
      pushes,
      winRateInformationalOnly: resolved > 0 ? wins / resolved : 0,
      netPnl: this.settledTrades.reduce((acc, t) => acc + (t.pnl || 0), 0),
      pendingCount: this.pendingTrades.length
    };
  }

  emitStatusReport(nowMs = Date.now()) {
    const report = {
      trackId: TRACK_ID,
      fenceVersion: FENCE_VERSION,
      venue: this.venue,
      asset: this.asset,
      market: this.market,
      account: this.account,
      evidenceStatus: EVIDENCE_STATUS,
      quarantineNotice:
        'Outputs are operational measurements only (connectivity, latency, fills, payout snapshots). NOT statistical evidence. MUST NOT feed H011 IS/OOS or any registry decision.',
      settlementLimitation:
        'Paper settles on feed closes (entry close, first close at entryTs+60s). Venue settlement may differ.',
      status: this.getStatus(),
      timestamp: new Date(nowMs).toISOString(),
      dayPnlUtc: this.getDayPnl(nowMs),
      dailyStopUnits: DAILY_STOP_UNITS,
      frozen: this.frozen,
      freezeReason: this.freezeReason,
      frozenAt: this.frozenAt,
      lastObservedPayout: this.payoutObserver.getRate(this.asset, this.market),
      metrics: this.getMetrics(),
      counters: { ...this.counters },
      fences: {
        fixedStake: FIXED_STAKE,
        expirySeconds: EXPIRY_SECONDS,
        maxLatencyMs: MAX_LATENCY_MS,
        disconnectFreezeSeconds: DISCONNECT_GAP_SECONDS,
        signalMode: this.signalMode,
        liveTrading: false
      }
    };
    const dir = path.dirname(this.statusPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.statusPath, JSON.stringify(report, null, 2));
    return report;
  }
}

module.exports = DemoIqoOpsSupervisor;
module.exports.TRACK_ID = TRACK_ID;
module.exports.FENCE_VERSION = FENCE_VERSION;
module.exports.VENUE = VENUE;
module.exports.ASSET = ASSET;
module.exports.MARKET = MARKET;
module.exports.ACCOUNT = ACCOUNT;
module.exports.EXPIRY_SECONDS = EXPIRY_SECONDS;
module.exports.FIXED_STAKE = FIXED_STAKE;
module.exports.DAILY_STOP_UNITS = DAILY_STOP_UNITS;
module.exports.MAX_LATENCY_MS = MAX_LATENCY_MS;
module.exports.DISCONNECT_GAP_SECONDS = DISCONNECT_GAP_SECONDS;
module.exports.SIGNAL_MODE = SIGNAL_MODE;
module.exports.EVIDENCE_STATUS = EVIDENCE_STATUS;
module.exports.DisabledSignalProvider = DisabledSignalProvider;

// No live start on direct invocation: print usage only (no daemon, no network).
if (require.main === module) {
  // eslint-disable-next-line no-console
  console.log(
    'demo_iqo_ops_supervisor: DEMO_IQO_OPS v1.0.0 rails only. Instantiate via require(). Default signal DISABLED (zero trading). Live BLOCKED.'
  );
}
