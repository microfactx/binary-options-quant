"use strict";

const ModelContract = require('./ModelContract');

/**
 * BTCUSDTMicrostructureModel
 * HYPOTHESIS_009: Cross-Asset Microstructure Wick-Exhaustion & M1-Stretch Reversion on BTC/USDT.
 * 
 * Causal rules:
 * 1. ATR(14) computed strictly over previous closed M1 bars [t-14 ... t-1].
 * 2. M1 Stretch: Range_t >= 1.5 * ATR_14(t-1).
 * 3. Terminal 5s Wick: 12th candle of 5s [T+55, T+60) must have line-side wick >= 0.35 * Range_5s.
 * 4. Terminal 5s Polarity: 12th candle of 5s must close pro-fade (Close < Open for BULL, Close > Open for BEAR).
 * 5. Extreme Timing Guard: M1 extreme must have occurred before second :50 (< T+50s).
 */
class BTCUSDTMicrostructureModel extends ModelContract {
  constructor(atrPeriod = 14, stretchMultiplier = 1.5, minWickRatio = 0.35, maxTimingSec = 50, expirySeconds = 60) {
    super();
    this.atrPeriod = atrPeriod;
    this.stretchMultiplier = stretchMultiplier;
    this.minWickRatio = minWickRatio;
    this.maxTimingSec = maxTimingSec;
    this.expirySeconds = expirySeconds;

    this.trHistory = [];
    this.prevClose = null;
    this.currentAtr = null;
  }

  get id() {
    return 'BTCUSDT_MICROSTRUCTURE_MODEL';
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

    // 2. Micro 5s candles check (must have at least 11 of 12 internal 5s candles)
    if (!Array.isArray(microCandles) || microCandles.length < 11) {
      return { direction: 'NO_SIGNAL', reason: 'INSUFFICIENT_5S_CANDLES' };
    }

    // 3. Extreme Timing Guard
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

    // extremeIdx corresponds to seconds: extremeIdx * 5
    const extremeTimingSec = extremeIdx * 5;
    if (extremeTimingSec >= this.maxTimingSec) {
      return { direction: 'NO_SIGNAL', reason: 'LATE_EXTREME_BREAKOUT_MOMENTUM' };
    }

    // 4. Terminal 5s candle check (last candle in window)
    const terminal5s = microCandles[microCandles.length - 1];
    const rng5s = terminal5s.high - terminal5s.low;
    if (rng5s <= 0) {
      return { direction: 'NO_SIGNAL', reason: 'ZERO_RANGE_TERMINAL_5S' };
    }

    let terminalWick = 0.0;
    let proFadeClose = false;

    if (isBull) {
      // For BULL M1, fade is PUT; we demand UPPER wick and red close
      terminalWick = (terminal5s.high - Math.max(terminal5s.open, terminal5s.close)) / rng5s;
      proFadeClose = terminal5s.close < terminal5s.open;
    } else {
      // For BEAR M1, fade is CALL; we demand LOWER wick and green close
      terminalWick = (Math.min(terminal5s.open, terminal5s.close) - terminal5s.low) / rng5s;
      proFadeClose = terminal5s.close > terminal5s.open;
    }

    if (!proFadeClose) {
      return { direction: 'NO_SIGNAL', reason: 'TERMINAL_CLOSE_NOT_PRO_FADE' };
    }

    if (terminalWick < this.minWickRatio) {
      return { direction: 'NO_SIGNAL', reason: 'INSUFFICIENT_TERMINAL_WICK' };
    }

    // Symmetrical fade signal
    const direction = isBull ? 'PUT' : 'CALL';
    return {
      direction,
      stretch,
      terminalWick,
      extremeTimingSec,
      atr: this.currentAtr,
      reason: 'EXHAUSTION_CONFIRMED'
    };
  }

  update(m1Candle) {
    if (!m1Candle || typeof m1Candle.close !== 'number' || typeof m1Candle.high !== 'number' || typeof m1Candle.low !== 'number') {
      return;
    }

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
  }

  reset() {
    this.trHistory = [];
    this.prevClose = null;
    this.currentAtr = null;
  }
}

module.exports = BTCUSDTMicrostructureModel;
