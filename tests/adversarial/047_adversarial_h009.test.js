"use strict";

const BTCUSDTMicrostructureModel = require('../../src/strategy/models/BTCUSDTMicrostructureModel');
const ReversedBTCUSDTMicrostructureModel = require('../../src/strategy/models/ReversedBTCUSDTMicrostructureModel');

describe('HYPOTHESIS_009 Adversarial Red Team Suite (047)', () => {
  let model;
  let reversedModel;

  beforeEach(() => {
    model = new BTCUSDTMicrostructureModel(14, 1.5, 0.35, 50, 60);
    reversedModel = new ReversedBTCUSDTMicrostructureModel(14, 1.5, 0.35, 50, 60);
  });

  function warmUpModel(m, basePrice = 65000, count = 20) {
    for (let i = 0; i < count; i++) {
      m.update({
        open: basePrice,
        high: basePrice + 100,
        low: basePrice - 100,
        close: basePrice + 10,
        volume: 10
      });
    }
  }

  function makeMock5sCandles(isBullM1, extremeSecond = 20, lastWickRatio = 0.40, proFadeClose = true) {
    // 12 candles covering 0s to 55s
    const candles = [];
    const extremeIdx = Math.floor(extremeSecond / 5);

    for (let i = 0; i < 12; i++) {
      let open = 65000;
      let close = 65010;
      let high = 65020;
      let low = 64990;

      if (i === extremeIdx) {
        if (isBullM1) high = 65500; // Extreme high reached early/late
        else low = 64500;           // Extreme low reached early/late
      }

      if (i === 11) {
        // Terminal candle
        if (isBullM1) {
          open = 65100;
          close = proFadeClose ? 65050 : 65150; // pro-fade is red (close < open)
          high = 65050 + (65050 - 64950) * (lastWickRatio / (1 - lastWickRatio || 0.1));
          low = 64950;
        } else {
          open = 64900;
          close = proFadeClose ? 64950 : 64850; // pro-fade is green (close > open)
          low = 64900 - (65050 - 64900) * (lastWickRatio / (1 - lastWickRatio || 0.1));
          high = 65050;
        }
      }

      candles.push({ open, high, low, close, volume: 1 });
    }
    return candles;
  }

  test('047-A: Strict Causal Isolation (Zero Future Lookahead in ATR)', () => {
    warmUpModel(model, 65000, 20);
    const atrBefore = model.currentAtr;

    // Perturbing candle in predict() without update() must not alter currentAtr
    const perturbedM1 = { open: 65000, high: 75000, low: 55000, close: 70000, volume: 1000 };
    model.predict(perturbedM1, makeMock5sCandles(true, 15, 0.45, true));

    expect(model.currentAtr).toBe(atrBefore);
  });

  test('047-B: Symmetrical Inversion (Reversed Model Directional Mirroring)', () => {
    warmUpModel(model, 65000, 20);
    warmUpModel(reversedModel, 65000, 20);

    const m1Candle = { open: 65000, high: 65400, low: 64950, close: 65350, volume: 50 };
    const micro = makeMock5sCandles(true, 25, 0.40, true);

    const basePred = model.predict(m1Candle, micro);
    const revPred = reversedModel.predict(m1Candle, micro);

    if (basePred.direction !== 'NO_SIGNAL') {
      expect(basePred.direction).toBe('PUT');
      expect(revPred.direction).toBe('CALL');
    }
  });

  test('047-C: Timing Guard Rejection (Late Extrema >= 50s Suppressed)', () => {
    warmUpModel(model, 65000, 20);

    const m1Candle = { open: 65000, high: 65400, low: 64950, close: 65350, volume: 50 };
    // Extreme occurs at second 55 (index 11) -> late breakout
    const microLate = makeMock5sCandles(true, 55, 0.40, true);

    const pred = model.predict(m1Candle, microLate);
    expect(pred.direction).toBe('NO_SIGNAL');
    expect(pred.reason).toBe('LATE_EXTREME_BREAKOUT_MOMENTUM');
  });

  test('047-D: Terminal Polarity Guard (Counter-Fade Close Suppressed)', () => {
    warmUpModel(model, 65000, 20);

    const m1Candle = { open: 65000, high: 65400, low: 64950, close: 65350, volume: 50 };
    // Terminal candle closes green (proFadeClose = false) -> momentum not exhausted
    const microCounter = makeMock5sCandles(true, 20, 0.40, false);

    const pred = model.predict(m1Candle, microCounter);
    expect(pred.direction).toBe('NO_SIGNAL');
    expect(pred.reason).toBe('TERMINAL_CLOSE_NOT_PRO_FADE');
  });

  test('047-E: Insufficient Wick Guard (< 0.35 Suppressed)', () => {
    warmUpModel(model, 65000, 20);

    const m1Candle = { open: 65000, high: 65400, low: 64950, close: 65350, volume: 50 };
    const microTinyWick = makeMock5sCandles(true, 20, 0.10, true);

    const pred = model.predict(m1Candle, microTinyWick);
    expect(pred.direction).toBe('NO_SIGNAL');
    expect(pred.reason).toBe('INSUFFICIENT_TERMINAL_WICK');
  });

  test('047-F: Flat Range Guard (H === L -> NO_SIGNAL)', () => {
    warmUpModel(model, 65000, 20);
    const flatM1 = { open: 65000, high: 65000, low: 65000, close: 65000, volume: 0 };
    const pred = model.predict(flatM1, makeMock5sCandles(true, 20, 0.40, true));
    expect(pred.direction).toBe('NO_SIGNAL');
    expect(pred.reason).toBe('ZERO_RANGE');
  });
});
