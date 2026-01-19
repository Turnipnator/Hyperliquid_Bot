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

  /**
   * Calculate the MINIMUM volume ratio over the last N candles
   * This is the "sustained volume" filter from Binance_Bot
   * Requires volume to be consistently high, not just a single spike
   */
  public static calculateMinVolumeRatio(
    prices: PriceData[],
    avgVolume: Decimal,
    lookbackCandles = 3
  ): Decimal {
    if (prices.length < lookbackCandles) {
      return new Decimal(0);
    }

    const recentCandles = prices.slice(-lookbackCandles);
    const volumeRatios = recentCandles.map(p => p.volume.dividedBy(avgVolume));

    // Return the MINIMUM volume ratio (weakest candle)
    return Decimal.min(...volumeRatios);
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

  /**
   * Calculate RSI using Wilder's Smoothing Method (industry standard)
   * This matches pandas-ta and other professional trading libraries
   *
   * Wilder's smoothing: avg = (prev_avg * (N-1) + current) / N
   * This is equivalent to EMA with alpha = 1/N
   */
  public static calculateRSI(prices: PriceData[], periods = 14): Decimal {
    if (prices.length < periods + 1) {
      throw new Error(`Insufficient data for RSI calculation`);
    }

    // Calculate all price changes
    const gains: Decimal[] = [];
    const losses: Decimal[] = [];

    for (let i = 1; i < prices.length; i++) {
      const change = prices[i].close.minus(prices[i - 1].close);
      if (change.greaterThan(0)) {
        gains.push(change);
        losses.push(new Decimal(0));
      } else {
        gains.push(new Decimal(0));
        losses.push(change.abs());
      }
    }

    // First average: SMA of first N periods
    let avgGain = new Decimal(0);
    let avgLoss = new Decimal(0);

    for (let i = 0; i < periods; i++) {
      avgGain = avgGain.plus(gains[i]);
      avgLoss = avgLoss.plus(losses[i]);
    }
    avgGain = avgGain.dividedBy(periods);
    avgLoss = avgLoss.dividedBy(periods);

    // Apply Wilder's smoothing for remaining periods
    // Formula: smoothed = (prev * (N-1) + current) / N
    const smoothingFactor = new Decimal(periods - 1);

    for (let i = periods; i < gains.length; i++) {
      avgGain = avgGain.times(smoothingFactor).plus(gains[i]).dividedBy(periods);
      avgLoss = avgLoss.times(smoothingFactor).plus(losses[i]).dividedBy(periods);
    }

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

  /**
   * 3-Layer Trend Detection (matching Binance_Bot's stricter filtering)
   *
   * Layer 1: ATR-based range detection (catches tight ranges)
   * Layer 2: Price structure analysis (higher highs/lower lows)
   * Layer 3: EMA alignment confirmation
   *
   * ALL THREE layers must confirm for bullish/bearish, otherwise sideways
   */
  public static detectTrend(
    prices: PriceData[],
    shortPeriod = 20,
    longPeriod = 50
  ): 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS' {
    if (prices.length < longPeriod) {
      return 'SIDEWAYS';
    }

    const recent = prices.slice(-20);
    const currentPrice = recent[recent.length - 1].close;

    // === LAYER 1: ATR-based Range Detection ===
    // If price is oscillating in a tight range relative to volatility = RANGING
    const atr = this.calculateATR(prices, 14);
    const recent10 = prices.slice(-10);
    const recentHigh = recent10.reduce((max, p) => p.high.greaterThan(max) ? p.high : max, recent10[0].high);
    const recentLow = recent10.reduce((min, p) => p.low.lessThan(min) ? p.low : min, recent10[0].low);
    const priceRangePct = recentHigh.minus(recentLow).dividedBy(currentPrice);
    const atrPct = atr.dividedBy(currentPrice);

    // If price range < 2x ATR, it's ranging/choppy
    if (priceRangePct.lessThan(atrPct.times(2))) {
      return 'SIDEWAYS';
    }

    // === LAYER 2: Price Structure Analysis ===
    // Check if making higher highs AND higher lows (uptrend structure)
    // or lower highs AND lower lows (downtrend structure)
    const firstHalf = prices.slice(-20, -10);
    const secondHalf = prices.slice(-10);

    const firstHalfHigh = firstHalf.reduce((max, p) => p.high.greaterThan(max) ? p.high : max, firstHalf[0].high);
    const secondHalfHigh = secondHalf.reduce((max, p) => p.high.greaterThan(max) ? p.high : max, secondHalf[0].high);
    const firstHalfLow = firstHalf.reduce((min, p) => p.low.lessThan(min) ? p.low : min, firstHalf[0].low);
    const secondHalfLow = secondHalf.reduce((min, p) => p.low.lessThan(min) ? p.low : min, secondHalf[0].low);

    const higherHighs = secondHalfHigh.greaterThan(firstHalfHigh);
    const higherLows = secondHalfLow.greaterThan(firstHalfLow);
    const lowerHighs = secondHalfHigh.lessThan(firstHalfHigh);
    const lowerLows = secondHalfLow.lessThan(firstHalfLow);

    const structureBullish = higherHighs && higherLows;
    const structureBearish = lowerHighs && lowerLows;

    // Mixed/choppy structure - reject
    if (!structureBullish && !structureBearish) {
      return 'SIDEWAYS';
    }

    // === LAYER 3: EMA Alignment Confirmation ===
    // Must use same periods as Binance_Bot: EMA20/50/200
    const closePrices = prices.map(p => p.close);
    const emaFast = this.calculateEMA(closePrices, 20);
    const emaSlow = this.calculateEMA(closePrices, 50);
    const emaTrend = this.calculateEMA(closePrices, 200);

    const emaBullish = emaFast.greaterThan(emaSlow) && emaSlow.greaterThan(emaTrend);
    const emaBearish = emaFast.lessThan(emaSlow) && emaSlow.lessThan(emaTrend);

    // Only return bullish/bearish if ALL layers confirm
    if (structureBullish && emaBullish) {
      return 'UPTREND';
    } else if (structureBearish && emaBearish) {
      return 'DOWNTREND';
    } else {
      return 'SIDEWAYS';
    }
  }

  /**
   * Detect EMA Stack trend (EMA20 > EMA50 > EMA200 for BULLISH)
   * This is the strong trend confirmation used by Enclave - requires ALL 3 EMAs aligned
   * BULLISH: EMA20 > EMA50 > EMA200 (full bullish stack)
   * BEARISH: EMA20 < EMA50 < EMA200 (full bearish stack)
   * SIDEWAYS: Mixed alignment = NO TRADE (choppy market)
   */
  public static detectEMAStack(
    prices: PriceData[]
  ): { trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS'; ema20: Decimal; ema50: Decimal; ema200: Decimal } {
    if (prices.length < 200) {
      return {
        trend: 'SIDEWAYS',
        ema20: new Decimal(0),
        ema50: new Decimal(0),
        ema200: new Decimal(0)
      }; // Not enough data for full EMA stack
    }

    const closePrices = prices.map(p => p.close);
    const ema20 = this.calculateEMA(closePrices, 20);
    const ema50 = this.calculateEMA(closePrices, 50);
    const ema200 = this.calculateEMA(closePrices, 200);

    // BULLISH: EMA20 > EMA50 > EMA200 (all stacked bullishly)
    if (ema20.greaterThan(ema50) && ema50.greaterThan(ema200)) {
      return { trend: 'BULLISH', ema20, ema50, ema200 };
    }

    // BEARISH: EMA20 < EMA50 < EMA200 (all stacked bearishly)
    if (ema20.lessThan(ema50) && ema50.lessThan(ema200)) {
      return { trend: 'BEARISH', ema20, ema50, ema200 };
    }

    // Mixed alignment = SIDEWAYS (choppy, ranging)
    return { trend: 'SIDEWAYS', ema20, ema50, ema200 };
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

  /**
   * Calculate MACD (Moving Average Convergence Divergence)
   * Returns MACD line, signal line, and histogram
   */
  public static calculateMACD(
    prices: PriceData[],
    fastPeriod = 12,
    slowPeriod = 26,
    signalPeriod = 9
  ): { macd: Decimal; signal: Decimal; histogram: Decimal } {
    if (prices.length < slowPeriod + signalPeriod) {
      throw new Error(`Insufficient data for MACD calculation`);
    }

    const closePrices = prices.map(p => p.close);

    // Calculate fast and slow EMAs
    const fastEma = this.calculateEMA(closePrices, fastPeriod);
    const slowEma = this.calculateEMA(closePrices, slowPeriod);

    // MACD line = fast EMA - slow EMA
    const macdLine = fastEma.minus(slowEma);

    // For signal line, we need historical MACD values
    // Calculate MACD for each point and then EMA of those
    const macdHistory: Decimal[] = [];
    for (let i = slowPeriod; i <= closePrices.length; i++) {
      const slice = closePrices.slice(0, i);
      const fast = this.calculateEMA(slice, fastPeriod);
      const slow = this.calculateEMA(slice, slowPeriod);
      macdHistory.push(fast.minus(slow));
    }

    // Signal line = EMA of MACD line
    const signalLine = macdHistory.length >= signalPeriod
      ? this.calculateEMA(macdHistory, signalPeriod)
      : macdLine;

    // Histogram = MACD - Signal
    const histogram = macdLine.minus(signalLine);

    return {
      macd: macdLine,
      signal: signalLine,
      histogram: histogram
    };
  }

  /**
   * Check if MACD confirms trend direction
   * For BULLISH: MACD > Signal AND Histogram > 0
   * For BEARISH: MACD < Signal AND Histogram < 0
   */
  public static isMacdAligned(
    prices: PriceData[],
    direction: 'BULLISH' | 'BEARISH'
  ): { aligned: boolean; reason: string; macd: Decimal; signal: Decimal; histogram: Decimal } {
    try {
      const { macd, signal, histogram } = this.calculateMACD(prices);

      if (direction === 'BULLISH') {
        const macdAboveSignal = macd.greaterThan(signal);
        const histogramPositive = histogram.greaterThan(0);

        if (macdAboveSignal && histogramPositive) {
          return {
            aligned: true,
            reason: `MACD bullish: ${macd.toFixed(4)} > ${signal.toFixed(4)}, hist ${histogram.toFixed(4)}`,
            macd, signal, histogram
          };
        }

        if (!macdAboveSignal) {
          return {
            aligned: false,
            reason: `MACD ${macd.toFixed(4)} below signal ${signal.toFixed(4)}`,
            macd, signal, histogram
          };
        }
        return {
          aligned: false,
          reason: `MACD histogram negative: ${histogram.toFixed(4)}`,
          macd, signal, histogram
        };
      } else {
        const macdBelowSignal = macd.lessThan(signal);
        const histogramNegative = histogram.lessThan(0);

        if (macdBelowSignal && histogramNegative) {
          return {
            aligned: true,
            reason: `MACD bearish: ${macd.toFixed(4)} < ${signal.toFixed(4)}, hist ${histogram.toFixed(4)}`,
            macd, signal, histogram
          };
        }

        if (!macdBelowSignal) {
          return {
            aligned: false,
            reason: `MACD ${macd.toFixed(4)} above signal ${signal.toFixed(4)}`,
            macd, signal, histogram
          };
        }
        return {
          aligned: false,
          reason: `MACD histogram positive: ${histogram.toFixed(4)}`,
          macd, signal, histogram
        };
      }
    } catch (error) {
      return {
        aligned: false,
        reason: 'Insufficient data for MACD',
        macd: new Decimal(0),
        signal: new Decimal(0),
        histogram: new Decimal(0)
      };
    }
  }

  public static isEmaAligned(
    prices: PriceData[],
    direction: 'BULLISH' | 'BEARISH'
  ): { aligned: boolean; reason: string } {
    if (prices.length < 50) {
      return { aligned: false, reason: 'Insufficient data for EMA alignment' };
    }

    const closePrices = prices.map(p => p.close);
    const currentPrice = closePrices[closePrices.length - 1];

    // Calculate EMAs (9, 21, 50 periods - common fast/medium/slow setup)
    const ema9 = this.calculateEMA(closePrices, 9);
    const ema21 = this.calculateEMA(closePrices, 21);
    const ema50 = this.calculateEMA(closePrices, 50);

    if (direction === 'BULLISH') {
      // For bullish: price > EMA9 > EMA21 > EMA50
      const priceAboveEma9 = currentPrice.greaterThan(ema9);
      const ema9AboveEma21 = ema9.greaterThan(ema21);
      const ema21AboveEma50 = ema21.greaterThan(ema50);

      if (priceAboveEma9 && ema9AboveEma21 && ema21AboveEma50) {
        return { aligned: true, reason: 'EMAs bullish aligned: P > EMA9 > EMA21 > EMA50' };
      }

      // Provide specific rejection reason
      if (!priceAboveEma9) {
        return { aligned: false, reason: `Price ${currentPrice.toFixed(2)} below EMA9 ${ema9.toFixed(2)}` };
      }
      if (!ema9AboveEma21) {
        return { aligned: false, reason: `EMA9 ${ema9.toFixed(2)} below EMA21 ${ema21.toFixed(2)}` };
      }
      return { aligned: false, reason: `EMA21 ${ema21.toFixed(2)} below EMA50 ${ema50.toFixed(2)}` };
    } else {
      // For bearish: price < EMA9 < EMA21 < EMA50
      const priceBelowEma9 = currentPrice.lessThan(ema9);
      const ema9BelowEma21 = ema9.lessThan(ema21);
      const ema21BelowEma50 = ema21.lessThan(ema50);

      if (priceBelowEma9 && ema9BelowEma21 && ema21BelowEma50) {
        return { aligned: true, reason: 'EMAs bearish aligned: P < EMA9 < EMA21 < EMA50' };
      }

      // Provide specific rejection reason
      if (!priceBelowEma9) {
        return { aligned: false, reason: `Price ${currentPrice.toFixed(2)} above EMA9 ${ema9.toFixed(2)}` };
      }
      if (!ema9BelowEma21) {
        return { aligned: false, reason: `EMA9 ${ema9.toFixed(2)} above EMA21 ${ema21.toFixed(2)}` };
      }
      return { aligned: false, reason: `EMA21 ${ema21.toFixed(2)} above EMA50 ${ema50.toFixed(2)}` };
    }
  }

  /**
   * Calculate VWAP (Volume Weighted Average Price)
   * Uses the available price data to calculate typical price weighted by volume
   */
  public static calculateVWAP(prices: PriceData[]): Decimal {
    if (prices.length === 0) {
      throw new Error('No data for VWAP calculation');
    }

    let cumulativeTPV = new Decimal(0); // Cumulative (Typical Price * Volume)
    let cumulativeVolume = new Decimal(0);

    for (const candle of prices) {
      // Typical price = (High + Low + Close) / 3
      const typicalPrice = candle.high.plus(candle.low).plus(candle.close).dividedBy(3);
      cumulativeTPV = cumulativeTPV.plus(typicalPrice.times(candle.volume));
      cumulativeVolume = cumulativeVolume.plus(candle.volume);
    }

    if (cumulativeVolume.isZero()) {
      return prices[prices.length - 1].close; // Return last close if no volume
    }

    return cumulativeTPV.dividedBy(cumulativeVolume);
  }

  /**
   * Calculate momentum score - weighted combination of multiple factors
   * Matching Binance_Bot's momentum scoring system
   *
   * Weights:
   * - Trend strength: 35%
   * - RSI momentum: 25%
   * - MACD momentum: 20%
   * - Volume momentum: 10%
   * - VWAP strength: 10%
   *
   * Returns score from 0 to 1, where >= 0.70 is considered high conviction
   */
  public static calculateMomentumScore(
    prices: PriceData[],
    currentVolume: Decimal,
    averageVolume: Decimal,
    direction: 'BULLISH' | 'BEARISH'
  ): {
    score: Decimal;
    components: {
      trendStrength: Decimal;
      rsiMomentum: Decimal;
      macdMomentum: Decimal;
      volumeMomentum: Decimal;
      vwapStrength: Decimal;
    };
    details: string;
  } {
    const currentPrice = prices[prices.length - 1].close;

    // 1. Trend Strength (35%)
    // Based on EMA alignment and trend detection
    let trendStrength = new Decimal(0);
    const trend = this.detectTrend(prices);
    const emaCheck = this.isEmaAligned(prices, direction);

    if (direction === 'BULLISH') {
      if (trend === 'UPTREND') trendStrength = trendStrength.plus(0.5);
      if (emaCheck.aligned) trendStrength = trendStrength.plus(0.5);
    } else {
      if (trend === 'DOWNTREND') trendStrength = trendStrength.plus(0.5);
      if (emaCheck.aligned) trendStrength = trendStrength.plus(0.5);
    }

    // 2. RSI Momentum (25%)
    // For BULLISH: RSI 40-60 = neutral, 60-70 = good momentum, <40 = weak
    // For BEARISH: RSI 40-60 = neutral, 30-40 = good momentum, >60 = weak
    let rsiMomentum = new Decimal(0);
    try {
      const rsi = this.calculateRSI(prices);
      const rsiNum = rsi.toNumber();

      if (direction === 'BULLISH') {
        if (rsiNum >= 50 && rsiNum <= 70) {
          rsiMomentum = new Decimal(Math.min((rsiNum - 40) / 30, 1)); // Scale 40-70 to 0-1
        } else if (rsiNum > 70) {
          rsiMomentum = new Decimal(0.3); // Overbought, weak momentum
        } else if (rsiNum >= 30) {
          rsiMomentum = new Decimal(0.5); // Neutral
        }
      } else {
        if (rsiNum <= 50 && rsiNum >= 30) {
          rsiMomentum = new Decimal(Math.min((60 - rsiNum) / 30, 1)); // Scale 30-60 to 1-0
        } else if (rsiNum < 30) {
          rsiMomentum = new Decimal(0.3); // Oversold, weak momentum
        } else if (rsiNum <= 70) {
          rsiMomentum = new Decimal(0.5); // Neutral
        }
      }
    } catch {
      rsiMomentum = new Decimal(0.5); // Default neutral if calculation fails
    }

    // 3. MACD Momentum (20%)
    let macdMomentum = new Decimal(0);
    try {
      const macdCheck = this.isMacdAligned(prices, direction);
      if (macdCheck.aligned) {
        // Scale based on histogram strength
        const histAbs = macdCheck.histogram.abs();
        const signalAbs = macdCheck.signal.abs();
        if (!signalAbs.isZero()) {
          const histRatio = histAbs.dividedBy(signalAbs);
          macdMomentum = Decimal.min(histRatio, new Decimal(1)); // Cap at 1
        } else {
          macdMomentum = new Decimal(0.7); // MACD aligned but weak signal
        }
      } else {
        macdMomentum = new Decimal(0.2); // Not aligned
      }
    } catch {
      macdMomentum = new Decimal(0.5);
    }

    // 4. Volume Momentum (10%)
    // Normalize volume ratio (1.5x = 0.75, 2x = 1.0)
    let volumeMomentum = new Decimal(0);
    if (!averageVolume.isZero()) {
      const volRatio = currentVolume.dividedBy(averageVolume);
      volumeMomentum = Decimal.min(volRatio.dividedBy(2), new Decimal(1)); // 2x volume = 1.0
    }

    // 5. VWAP Strength (10%)
    // For BULLISH: price > VWAP = 1.0, else 0.3
    // For BEARISH: price < VWAP = 1.0, else 0.3
    let vwapStrength = new Decimal(0.3);
    try {
      const vwap = this.calculateVWAP(prices.slice(-20)); // Use last 20 candles for VWAP
      if (direction === 'BULLISH' && currentPrice.greaterThan(vwap)) {
        vwapStrength = new Decimal(1);
      } else if (direction === 'BEARISH' && currentPrice.lessThan(vwap)) {
        vwapStrength = new Decimal(1);
      }
    } catch {
      vwapStrength = new Decimal(0.5);
    }

    // Calculate weighted score
    const score = trendStrength.times(0.35)
      .plus(rsiMomentum.times(0.25))
      .plus(macdMomentum.times(0.20))
      .plus(volumeMomentum.times(0.10))
      .plus(vwapStrength.times(0.10));

    const details = `trend=${trendStrength.toFixed(2)}, rsi=${rsiMomentum.toFixed(2)}, macd=${macdMomentum.toFixed(2)}, vol=${volumeMomentum.toFixed(2)}, vwap=${vwapStrength.toFixed(2)}`;

    return {
      score,
      components: {
        trendStrength,
        rsiMomentum,
        macdMomentum,
        volumeMomentum,
        vwapStrength,
      },
      details,
    };
  }
}
