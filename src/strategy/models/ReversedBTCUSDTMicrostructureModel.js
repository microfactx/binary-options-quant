"use strict";

const BTCUSDTMicrostructureModel = require('./BTCUSDTMicrostructureModel');

/**
 * ReversedBTCUSDTMicrostructureModel
 * Negative Directional Control for HYPOTHESIS_009.
 * Emits CALL when the base model emits PUT, and PUT when base model emits CALL.
 */
class ReversedBTCUSDTMicrostructureModel extends BTCUSDTMicrostructureModel {
  get id() {
    return 'REVERSED_BTCUSDT_MICROSTRUCTURE_MODEL';
  }

  get version() {
    return '1.0.0';
  }

  predict(m1Candle, microCandles = []) {
    const base = super.predict(m1Candle, microCandles);
    if (base.direction === 'CALL') {
      return { ...base, direction: 'PUT', reversedFrom: 'CALL' };
    }
    if (base.direction === 'PUT') {
      return { ...base, direction: 'CALL', reversedFrom: 'PUT' };
    }
    return base;
  }
}

module.exports = ReversedBTCUSDTMicrostructureModel;
