"use strict";

const OrderFlowAbsorptionModel = require('./OrderFlowAbsorptionModel');

/**
 * ReversedOrderFlowAbsorptionModel
 * Negative mirror control for HYPOTHESIS_010.
 * Inverts direction (PUT -> CALL, CALL -> PUT) to verify that the alpha does not originate from arbitrary volatility.
 */
class ReversedOrderFlowAbsorptionModel extends OrderFlowAbsorptionModel {
  get id() {
    return 'REVERSED_ORDER_FLOW_ABSORPTION_MODEL';
  }

  get version() {
    return '1.0.0';
  }

  predict(m1Candle, microCandles = []) {
    const baseResult = super.predict(m1Candle, microCandles);
    if (baseResult.direction === 'NO_SIGNAL') {
      return baseResult;
    }

    return {
      ...baseResult,
      direction: baseResult.direction === 'CALL' ? 'PUT' : 'CALL',
      reason: 'REVERSED_CONTROL_INVERSION'
    };
  }
}

module.exports = ReversedOrderFlowAbsorptionModel;
