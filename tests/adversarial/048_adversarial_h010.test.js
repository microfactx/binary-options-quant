"use strict";

const OrderFlowAbsorptionModel = require('../../src/strategy/models/OrderFlowAbsorptionModel');
const ReversedOrderFlowAbsorptionModel = require('../../src/strategy/models/ReversedOrderFlowAbsorptionModel');

describe('048 - Adversarial Red Team Validation: HYPOTHESIS_010 (OrderFlowAbsorptionModel)', () => {
  let model;
  let reversedModel;

  beforeEach(() => {
    model = new OrderFlowAbsorptionModel(14, 1.5, 0.35, 50, 1440, 0.015, 0.45, 60);
    reversedModel = new ReversedOrderFlowAbsorptionModel(14, 1.5, 0.35, 50, 1440, 0.015, 0.45, 60);
  });

  function bootstrapModel(inst, atrValue = 100, smaValue = 60000) {
    // Feed 14 bars to prime ATR and 1440 bars to prime Macro SMA
    for (let i = 0; i < 1440; i++) {
      inst.update({
        open: smaValue - atrValue / 2,
        high: smaValue + atrValue / 2,
        low: smaValue - atrValue / 2,
        close: smaValue,
        volume: 10
      });
    }
  }

  test('048-A: Causal Lookback & Macro Filter Immunity against Runaway Trends', () => {
    bootstrapModel(model, 100, 60000);
    bootstrapModel(reversedModel, 100, 60000);

    // M1 candle stretched upward: High=62000, Low=60000, Range=2000 (20x ATR)
    // But Close=61500 > 60000 * 1.015 (60900) -> Must be blocked by Macro Trend Mega Rally Conflict
    const m1Runaway = {
      open: 60100,
      high: 62000,
      low: 60000,
      close: 61500,
      volume: 100
    };

    const dummyMicro = Array.from({ length: 12 }, (_, i) => ({
      high: 60000 + i * 100,
      low: 60000 + i * 100 - 20,
      open: 60000 + i * 100 - 10,
      close: 60000 + i * 100,
      taker_buy_vol: 5,
      taker_sell_vol: 5
    }));

    const res = model.predict(m1Runaway, dummyMicro);
    expect(res.direction).toBe('NO_SIGNAL');
    expect(res.reason).toBe('MACRO_TREND_MEGA_RALLY_CONFLICT');
  });

  test('048-B: Order Flow Absorption Gate - Aggressor Absorption Required', () => {
    bootstrapModel(model, 100, 60000);

    // Valid M1 Bull stretch within macro boundaries (Close = 60500 <= 60900)
    const m1Valid = {
      open: 60100,
      high: 60550,
      low: 60100,
      close: 60500, // Range = 450 (4.5x ATR)
      volume: 50
    };

    // Construct 12 micro bars where extreme is at second 30 (i=6)
    const micro = Array.from({ length: 12 }, (_, i) => ({
      high: i === 6 ? 60550 : 60400,
      low: 60200,
      open: 60300,
      close: 60350,
      taker_buy_vol: 10,
      taker_sell_vol: 10
    }));

    // 12th candle: Upper wick = (60500 - 60400) / (60500 - 60200) = 100/300 = 0.333 < 0.35 -> FAIL
    // Make 12th candle have upper wick: High=60500, Open=60350, Close=60300 (Red), Low=60250.
    // Range = 250. Upper wick = 60500 - 60350 = 150. Wick ratio = 150 / 250 = 0.60 >= 0.35. Pro-fade = Close(60300) < Open(60350).
    micro[11] = {
      high: 60500,
      low: 60250,
      open: 60350,
      close: 60300,
      taker_buy_vol: 80, // Heavy buying aggression (unabsorbed!)
      taker_sell_vol: 20
    };

    // Test 1: Unabsorbed buyer aggression -> NO_SIGNAL
    const resUnabsorbed = model.predict(m1Valid, micro);
    expect(resUnabsorbed.direction).toBe('NO_SIGNAL');
    expect(resUnabsorbed.reason).toBe('BUY_AGGRESSION_NOT_ABSORBED');

    // Test 2: Absorbed buyer aggression -> Delta <= 0 (Taker Buy=30, Taker Sell=70)
    micro[11].taker_buy_vol = 30;
    micro[11].taker_sell_vol = 70;
    const resAbsorbed = model.predict(m1Valid, micro);
    expect(resAbsorbed.direction).toBe('PUT');
    expect(resAbsorbed.reason).toBe('ABSORPTION_EXHAUSTION_CONFIRMED');
  });

  test('048-C: Timing Guard Strict Enforcement (< 50s)', () => {
    bootstrapModel(model, 100, 60000);

    const m1Valid = {
      open: 60100,
      high: 60550,
      low: 60100,
      close: 60500,
      volume: 50
    };

    // Extreme high placed at 11th candle (second :55)
    const microLate = Array.from({ length: 12 }, (_, i) => ({
      high: i === 11 ? 60550 : 60300,
      low: 60100,
      open: 60200,
      close: 60250,
      taker_buy_vol: 10,
      taker_sell_vol: 10
    }));

    microLate[11] = {
      high: 60550,
      low: 60200,
      open: 60400,
      close: 60300,
      taker_buy_vol: 20,
      taker_sell_vol: 80
    };

    const res = model.predict(m1Valid, microLate);
    expect(res.direction).toBe('NO_SIGNAL');
    expect(res.reason).toBe('LATE_EXTREME_BREAKOUT_MOMENTUM');
  });

  test('048-D: Numerical Fuzzing & Zero Division Defenses', () => {
    bootstrapModel(model, 100, 60000);

    // Zero range M1
    expect(model.predict({ open: 60000, high: 60000, low: 60000, close: 60000 }).direction).toBe('NO_SIGNAL');

    // Doji M1
    expect(model.predict({ open: 60000, high: 60500, low: 59500, close: 60000 }).direction).toBe('NO_SIGNAL');

    // Null/Invalid input
    expect(model.predict(null).direction).toBe('NO_SIGNAL');
    expect(model.predict({}).direction).toBe('NO_SIGNAL');
  });

  test('048-E: Reversed Negative Control Directional Symmetry', () => {
    bootstrapModel(model, 100, 60000);
    bootstrapModel(reversedModel, 100, 60000);

    const m1Valid = {
      open: 60100,
      high: 60550,
      low: 60100,
      close: 60500,
      volume: 50
    };

    const micro = Array.from({ length: 12 }, (_, i) => ({
      high: i === 5 ? 60550 : 60300,
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
      close: 60300,
      taker_buy_vol: 30,
      taker_sell_vol: 70
    };

    const baseRes = model.predict(m1Valid, micro);
    const revRes = reversedModel.predict(m1Valid, micro);

    expect(baseRes.direction).toBe('PUT');
    expect(revRes.direction).toBe('CALL');
    expect(revRes.reason).toBe('REVERSED_CONTROL_INVERSION');
  });
});
