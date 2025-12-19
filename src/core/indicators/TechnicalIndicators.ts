import Decimal from 'decimal.js';

export interface PriceData {
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
  timestamp: Date;
}

export class TechnicalIndicators {
  public static calculateResistance(prices: PriceData[], lookbackPeriod: number): Decimal {
    // Need lookbackPeriod + 1 because we exclude the current candle
    if (prices.length < lookbackPeriod + 1) {
      throw new Error(`Insufficient data: need ${lookbackPeriod + 1} periods, got ${prices.length}`);
    }

    // Exclude current candle (-1) to prevent resistance from chasing price
    // This allows breakouts to be detected when price exceeds PREVIOUS highs
    const recentPrices = prices.slice(-lookbackPeriod - 1, -1);
    const highs = recentPrices.map((p) => p.high);
    return Decimal.max(...highs);
  }

  public static calculateSupport(prices: PriceData[], lookbackPeriod: number): Decimal {
    // Need lookbackPeriod + 1 because we exclude the current candle
    if (prices.length < lookbackPeriod + 1) {
      throw new Error(`Insufficient data: need ${lookbackPeriod + 1} periods, got ${prices.length}`);
    }

    // Exclude current candle (-1) to prevent support from chasing price
    // This allows breakdowns to be detected when price drops below PREVIOUS lows
    const recentPrices = prices.slice(-lookbackPeriod - 1, -1);
    const lows = recentPrices.map((p) => p.low);
    return Decimal.min(...lows);
  }

  public static calculateAverageVolume(prices: PriceData[], periods: number): Decimal {
    if (prices.length < periods) {
      throw new Error(`Insufficient data: need ${periods} periods, got ${prices.length}`);
    }

    const recentPrices = prices.slice(-periods);
    const totalVolume = recentPrices.reduce(
      (sum, p) => sum.plus(p.volume),
      new Decimal(0)
    );
    return totalVolume.dividedBy(periods);
  }

  public static isVolumeSpike(
    currentVolume: Decimal,
    averageVolume: Decimal,
    multiplier: number
  ): boolean {
    return currentVolume.greaterThan(averageVolume.times(multiplier));
  }

  public static calculateATR(prices: PriceData[], periods: number): Decimal {
    if (prices.length < periods + 1) {
      throw new Error(`Insufficient data for ATR calculation`);
    }

    const trueRanges: Decimal[] = [];
    for (let i = 1; i < prices.length; i++) {
      const high = prices[i].high;
      const low = prices[i].low;
      const prevClose = prices[i - 1].close;

      const tr1 = high.minus(low);
      const tr2 = high.minus(prevClose).abs();
      const tr3 = low.minus(prevClose).abs();

      trueRanges.push(Decimal.max(tr1, tr2, tr3));
    }

    const recentTRs = trueRanges.slice(-periods);
    const sum = recentTRs.reduce((acc, tr) => acc.plus(tr), new Decimal(0));
    return sum.dividedBy(periods);
  }

  public static calculateRSI(prices: PriceData[], periods = 14): Decimal {
    if (prices.length < periods + 1) {
      throw new Error(`Insufficient data for RSI calculation`);
    }

    const changes: Decimal[] = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i].close.minus(prices[i - 1].close));
    }

    const recentChanges = changes.slice(-periods);
    const gains = recentChanges.filter((c) => c.greaterThan(0));
    const losses = recentChanges.filter((c) => c.lessThan(0)).map((c) => c.abs());

    const totalGain = gains.reduce((sum, g) => sum.plus(g), new Decimal(0));
    const totalLoss = losses.reduce((sum, l) => sum.plus(l), new Decimal(0));

    const avgGain = totalGain.dividedBy(periods);
    const avgLoss = totalLoss.dividedBy(periods);

    if (avgLoss.isZero()) {
      return new Decimal(100);
    }

    const rs = avgGain.dividedBy(avgLoss);
    return new Decimal(100).minus(new Decimal(100).dividedBy(rs.plus(1)));
  }

  public static calculateSMA(prices: Decimal[], periods: number): Decimal {
    if (prices.length < periods) {
      throw new Error(`Insufficient data for SMA calculation`);
    }

    const recentPrices = prices.slice(-periods);
    const sum = recentPrices.reduce((acc, p) => acc.plus(p), new Decimal(0));
    return sum.dividedBy(periods);
  }

  public static calculateEMA(prices: Decimal[], periods: number): Decimal {
    if (prices.length < periods) {
      throw new Error(`Insufficient data for EMA calculation`);
    }

    const multiplier = new Decimal(2).dividedBy(periods + 1);
    let ema = this.calculateSMA(prices.slice(0, periods), periods);

    for (let i = periods; i < prices.length; i++) {
      ema = prices[i].times(multiplier).plus(ema.times(new Decimal(1).minus(multiplier)));
    }

    return ema;
  }

  public static calculateBollingerBands(
    prices: Decimal[],
    periods = 20,
    stdDev = 2
  ): { upper: Decimal; middle: Decimal; lower: Decimal } {
    if (prices.length < periods) {
      throw new Error(`Insufficient data for Bollinger Bands calculation`);
    }

    const sma = this.calculateSMA(prices, periods);
    const recentPrices = prices.slice(-periods);

    const squaredDiffs = recentPrices.map((p) => p.minus(sma).pow(2));
    const variance = squaredDiffs.reduce((sum, d) => sum.plus(d), new Decimal(0)).dividedBy(periods);
    const standardDeviation = variance.sqrt();

    return {
      upper: sma.plus(standardDeviation.times(stdDev)),
      middle: sma,
      lower: sma.minus(standardDeviation.times(stdDev)),
    };
  }

  public static detectBreakout(
    currentPrice: Decimal,
    resistance: Decimal,
    support: Decimal,
    buffer = 0.001
  ): 'BULLISH' | 'BEARISH' | null {
    const resistanceWithBuffer = resistance.times(1 + buffer);
    const supportWithBuffer = support.times(1 - buffer);

    if (currentPrice.greaterThan(resistanceWithBuffer)) {
      return 'BULLISH';
    }

    if (currentPrice.lessThan(supportWithBuffer)) {
      return 'BEARISH';
    }

    return null;
  }

  public static detectTrend(
    prices: PriceData[],
    shortPeriod = 20,
    longPeriod = 50
  ): 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS' {
    if (prices.length < longPeriod) {
      return 'SIDEWAYS';
    }

    const closePrices = prices.map(p => p.close);
    const ma20 = this.calculateSMA(closePrices.slice(-shortPeriod), shortPeriod);
    const ma50 = this.calculateSMA(closePrices.slice(-longPeriod), longPeriod);

    const threshold = ma50.times(0.002);

    if (ma20.greaterThan(ma50.plus(threshold))) {
      return 'UPTREND';
    } else if (ma20.lessThan(ma50.minus(threshold))) {
      return 'DOWNTREND';
    } else {
      return 'SIDEWAYS';
    }
  }

  public static detectPriceStructure(
    prices: PriceData[],
    lookback = 10
  ): 'HIGHER_HIGHS' | 'LOWER_LOWS' | 'CHOPPY' {
    if (prices.length < lookback * 2) {
      return 'CHOPPY';
    }

    const recentPrices = prices.slice(-lookback * 2);
    const firstHalf = recentPrices.slice(0, lookback);
    const secondHalf = recentPrices.slice(lookback);

    const firstHigh = Decimal.max(...firstHalf.map(p => p.high));
    const firstLow = Decimal.min(...firstHalf.map(p => p.low));
    const secondHigh = Decimal.max(...secondHalf.map(p => p.high));
    const secondLow = Decimal.min(...secondHalf.map(p => p.low));

    if (secondHigh.greaterThan(firstHigh) && secondLow.greaterThan(firstLow)) {
      return 'HIGHER_HIGHS';
    }

    if (secondHigh.lessThan(firstHigh) && secondLow.lessThan(firstLow)) {
      return 'LOWER_LOWS';
    }

    return 'CHOPPY';
  }

  public static isTrendConfirmed(
    prices: PriceData[],
    expectedTrend: 'UPTREND' | 'DOWNTREND'
  ): boolean {
    const maTrend = this.detectTrend(prices);
    const structure = this.detectPriceStructure(prices);

    if (expectedTrend === 'UPTREND') {
      return maTrend === 'UPTREND' && structure === 'HIGHER_HIGHS';
    } else {
      return maTrend === 'DOWNTREND' && structure === 'LOWER_LOWS';
    }
  }
}
