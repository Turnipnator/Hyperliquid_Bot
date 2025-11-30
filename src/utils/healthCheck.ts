import Decimal from 'decimal.js';
import { PriceData } from '../core/indicators/TechnicalIndicators';

export class HealthCheck {
  static validatePriceHistory(
    symbol: string,
    history: PriceData[],
    requiredPeriods: number
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!history || history.length === 0) {
      errors.push(`No price history for ${symbol}`);
      return { valid: false, errors };
    }

    if (history.length < requiredPeriods) {
      errors.push(
        `Insufficient history: ${history.length} < ${requiredPeriods} periods`
      );
    }

    // Check for invalid prices (zeros, negatives, NaN)
    for (let i = 0; i < history.length; i++) {
      const candle = history[i];
      if (
        candle.high.lessThanOrEqualTo(0) ||
        candle.low.lessThanOrEqualTo(0) ||
        candle.close.lessThanOrEqualTo(0)
      ) {
        errors.push(`Invalid price at index ${i}: ${JSON.stringify(candle)}`);
        break;
      }

      if (candle.high.lessThan(candle.low)) {
        errors.push(`High < Low at index ${i}`);
        break;
      }
    }

    return { valid: errors.length === 0, errors };
  }

  static validateSupportResistance(
    symbol: string,
    support: Decimal,
    resistance: Decimal,
    currentPrice: Decimal
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (support.lessThanOrEqualTo(0)) {
      errors.push(`Invalid support: ${support.toString()}`);
    }

    if (resistance.lessThanOrEqualTo(0)) {
      errors.push(`Invalid resistance: ${resistance.toString()}`);
    }

    if (support.greaterThanOrEqualTo(resistance)) {
      errors.push(
        `Support >= Resistance: ${support.toString()} >= ${resistance.toString()}`
      );
    }

    return { valid: errors.length === 0, errors };
  }
}
