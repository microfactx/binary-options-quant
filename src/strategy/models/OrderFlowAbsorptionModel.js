"use strict";

const ModelContract = require('./ModelContract');

/**
 * OrderFlowAbsorptionModel
 * HYPOTHESIS_010: Macro-Conditioned Order Flow Absorption & Terminal Microstructure Reversion on BTC/USDT.
 * 
 * Strict Causal Invariants:
 * 1. ATR(14) computed strictly over closed M1 bars [t-14 ... t-1].
 * 2. Macro SMA(1440) computed strictly over closed M1 bars [t-1440 ... t-1].
 * 3. M1 Stretch: Range_t >= 1.5 * ATR_14(t-1).
 * 4. Macro Filter: Reject PUT if Close > SMA1440 * (1 + 0.015); Reject CALL if Close < SMA1440 * (1 - 0.015).
 * 5. Extreme Timing: Low/High occurred before second :50 (< T+50s).
 * 6. Terminal 5s Geometry: 12th candle wick >= 0.35 * Range_5s, pro-fade close.
 * 7. Order Flow Absorption (12th candle):
 *    - Bull stretch fade (PUT): Delta_5s <= 0 OR TakerBuyShare_5s <= 0.45 (Buyer aggression absorbed).
 *    - Bear stretch fade (CALL): Delta_5s >= 0 OR TakerSellShare_5s <= 0.45 (Seller aggression absorbed).
 */
class OrderFlowAbsorptionModel extends ModelContract {
  constructor(
    atrPeriod = 14,
    stretchMultiplier = 1.5,
    minWickRatio = 0.35,
    maxTimingSec = 50,
    macroPeriod = 1440,
    macroTolerancePct = 0.015,
    absorptionShareThreshold = 0.45,
    expirySeconds = 60
  ) {
    super();
    this.atrPeriod = atrPeriod;
    this.stretchMultiplier = stretchMultiplier;
    this.minWickRatio = minWickRatio;
    this.maxTimingSec = maxTimingSec;
    this.macroPeriod = macroPeriod;
    this.macroTolerancePct = macroTolerancePct;
    this.absorptionShareThreshold = absorptionShareThreshold;
    this.expirySeconds = expirySeconds;

    this.trHistory = [];
    this.closesHistory = [];
    this.prevClose = null;
    this.currentAtr = null;
    this.currentMacroSma = null;
    this.macroSum = 0;
  }

  get id() {
    return 'ORDER_FLOW_ABSORPTION_MODEL';
  }

  get version() {
    return '1.0.0';
  }

  predict(m1Candle, microCandles = []) {
    if (!m1Candle || typeof m1Candle.close !== 'number' || typeof m1Candle.open !== 'number' ||
        typeof m1Candle.high !== 'number' || typeof m1Candle.low !== 'number') {
      return { direction: 'NO_SIGNAL', reason: 'INVALID_M1_CANDLE' };
    }

    if (this.currentAtr === null || this.currentAtr <= 0) {
      return { direction: 'NO_SIGNAL', reason: 'INSUFFICIENT_LOOKBACK_ATR' };
    }

    const m1Range = m1Candle.high - m1Candle.low;
    if (m1Range <= 0) {
      return { direction: 'NO_SIGNAL', reason: 'ZERO_RANGE' };
    }

    // 1. M1 Stretch check
    const stretch = m1Range / this.currentAtr;
    if (stretch < this.stretchMultiplier) {
      return { direction: 'NO_SIGNAL', reason: 'STRETCH_BELOW_THRESHOLD' };
    }

    const m1Body = m1Candle.close - m1Candle.open;
    if (Math.abs(m1Body) <= 1e-8) {
      return { direction: 'NO_SIGNAL', reason: 'DOJI_NO_DIRECTION' };
    }
    const isBull = m1Body > 0;

    // 2. Macro Trend Protection Gate
    if (this.currentMacroSma !== null) {
      if (isBull) {
        // We want to enter PUT (fade high). Must not be in runaway parabolic rally.
        const maxAllowedPrice = this.currentMacroSma * (1 + this.macroTolerancePct);
        if (m1Candle.close > maxAllowedPrice) {
          return { direction: 'NO_SIGNAL', reason: 'MACRO_TREND_MEGA_RALLY_CONFLICT' };
        }
      } else {
        // We want to enter CALL (fade low). Must not be in runaway waterfall liquidation.
        const minAllowedPrice = this.currentMacroSma * (1 - this.macroTolerancePct);
        if (m1Candle.close < minAllowedPrice) {
          return { direction: 'NO_SIGNAL', reason: 'MACRO_TREND_MEGA_DUMP_CONFLICT' };
        }
      }
    }

    // 3. Micro 5s candles check (must have at least 11 of 12 internal 5s candles)
    if (!Array.isArray(microCandles) || microCandles.length < 11) {
      return { direction: 'NO_SIGNAL', reason: 'INSUFFICIENT_5S_CANDLES' };
    }

    // 4. Extreme Timing Guard
    let extremeIdx = 0;
    if (isBull) {
      let maxVal = -Infinity;
      for (let i = 0; i < microCandles.length; i++) {
        if (microCandles[i].high > maxVal) {
          maxVal = microCandles[i].high;
          extremeIdx = i;
        }
      }
    } else {
      let minVal = Infinity;
      for (let i = 0; i < microCandles.length; i++) {
        if (microCandles[i].low < minVal) {
          minVal = microCandles[i].low;
          extremeIdx = i;
        }
      }
    }

    const extremeTimingSec = extremeIdx * 5;
    if (extremeTimingSec >= this.maxTimingSec) {
      return { direction: 'NO_SIGNAL', reason: 'LATE_EXTREME_BREAKOUT_MOMENTUM' };
    }

    // 5. Terminal 5s candle geometric rejection
    const terminal5s = microCandles[microCandles.length - 1];
    const rng5s = terminal5s.high - terminal5s.low;
    if (rng5s <= 0) {
      return { direction: 'NO_SIGNAL', reason: 'ZERO_RANGE_TERMINAL_5S' };
    }

    let terminalWick = 0.0;
    let proFadeClose = false;

    if (isBull) {
      terminalWick = (terminal5s.high - Math.max(terminal5s.open, terminal5s.close)) / rng5s;
      proFadeClose = terminal5s.close < terminal5s.open;
    } else {
      terminalWick = (Math.min(terminal5s.open, terminal5s.close) - terminal5s.low) / rng5s;
      proFadeClose = terminal5s.close > terminal5s.open;
    }

    if (!proFadeClose) {
      return { direction: 'NO_SIGNAL', reason: 'TERMINAL_CLOSE_NOT_PRO_FADE' };
    }

    if (terminalWick < this.minWickRatio) {
      return { direction: 'NO_SIGNAL', reason: 'INSUFFICIENT_TERMINAL_WICK' };
    }

    // 6. Terminal 5s Order Flow Absorption Gate
    const buyVol = typeof terminal5s.taker_buy_vol === 'number' ? terminal5s.taker_buy_vol : 0;
    const sellVol = typeof terminal5s.taker_sell_vol === 'number' ? terminal5s.taker_sell_vol : 0;
    const deltaVol = buyVol - sellVol;
    const totalVol = buyVol + sellVol;

    if (isBull) {
      // Fading a bull rally to PUT: demand that buying aggression is exhausted/absorbed
      const absorbed = (deltaVol <= 0) || (totalVol > 0 && (buyVol / totalVol) <= this.absorptionShareThreshold);
      if (!absorbed) {
        return { direction: 'NO_SIGNAL', reason: 'BUY_AGGRESSION_NOT_ABSORBED' };
      }
    } else {
      // Fading a bear dump to CALL: demand that selling aggression is exhausted/absorbed
      const absorbed = (deltaVol >= 0) || (totalVol > 0 && (sellVol / totalVol) <= this.absorptionShareThreshold);
      if (!absorbed) {
        return { direction: 'NO_SIGNAL', reason: 'SELL_AGGRESSION_NOT_ABSORBED' };
      }
    }

    const direction = isBull ? 'PUT' : 'CALL';
    return {
      direction,
      stretch,
      terminalWick,
      deltaVol,
      extremeTimingSec,
      atr: this.currentAtr,
      macroSma: this.currentMacroSma,
      reason: 'ABSORPTION_EXHAUSTION_CONFIRMED'
    };
  }

  update(m1Candle) {
    if (!m1Candle || typeof m1Candle.close !== 'number' || typeof m1Candle.high !== 'number' || typeof m1Candle.low !== 'number') {
      return;
    }

    // 1. Update ATR(14)
    const hl = m1Candle.high - m1Candle.low;
    let tr = hl;
    if (this.prevClose !== null) {
      tr = Math.max(hl, Math.abs(m1Candle.high - this.prevClose), Math.abs(m1Candle.low - this.prevClose));
    }
    this.prevClose = m1Candle.close;
    this.trHistory.push(tr);

    if (this.trHistory.length === this.atrPeriod) {
      let sumTr = 0;
      for (let i = 0; i < this.atrPeriod; i++) sumTr += this.trHistory[i];
      this.currentAtr = sumTr / this.atrPeriod;
    } else if (this.trHistory.length > this.atrPeriod) {
      this.currentAtr = (this.currentAtr * (this.atrPeriod - 1) + tr) / this.atrPeriod;
    }

    // 2. Update Macro SMA(1440)
    this.closesHistory.push(m1Candle.close);
    this.macroSum += m1Candle.close;
    if (this.closesHistory.length > this.macroPeriod) {
      const removed = this.closesHistory.shift();
      this.macroSum -= removed;
      this.currentMacroSma = this.macroSum / this.macroPeriod;
    } else if (this.closesHistory.length === this.macroPeriod) {
      this.currentMacroSma = this.macroSum / this.macroPeriod;
    }
  }

  reset() {
    this.trHistory = [];
    this.closesHistory = [];
    this.prevClose = null;
    this.currentAtr = null;
    this.currentMacroSma = null;
    this.macroSum = 0;
  }
}

module.exports = OrderFlowAbsorptionModel;
