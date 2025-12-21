import Decimal from 'decimal.js';
import pino from 'pino';
import { HyperliquidClient } from '../exchange/HyperliquidClient';
import { OrderSide, OrderType } from '../exchange/types';
import { TechnicalIndicators, PriceData } from '../indicators/TechnicalIndicators';
import { config } from '../../config/config';
import { HealthCheck } from '../../utils/healthCheck';
import { TelegramService } from '../../services/telegram/TelegramService';
import { BinanceDataService } from '../../services/data/BinanceDataService';

export interface BreakoutConfig {
  lookbackPeriod: number;
  volumeMultiplier: number;
  trailingStopPercent: number;
  positionSize: Decimal;
  useScalping: boolean;
  breakoutBuffer: number;
  takeProfitPercent?: number;
}

export interface Signal {
  symbol: string;
  side: OrderSide;
  entryPrice: Decimal;
  stopLoss: Decimal;
  takeProfit?: Decimal;
  confidence: number;
  reason: string;
}

export class BreakoutStrategy {
  private readonly client: HyperliquidClient;
  private readonly config: BreakoutConfig;
  private readonly logger: pino.Logger;
  private readonly telegram?: TelegramService;
  private readonly dataService: BinanceDataService;
  private priceHistory: Map<string, PriceData[]> = new Map();
  private lastCandleTimestamp: Map<string, number> = new Map(); // Track last candle time to avoid duplicates
  private activeSignals: Map<string, Signal> = new Map();
  private trailingStops: Map<string, { high: Decimal; stop: Decimal }> = new Map();
  private trendHistory: Map<string, Array<'UPTREND' | 'DOWNTREND' | 'SIDEWAYS'>> = new Map();
  private stopLossCooldowns: Map<string, number> = new Map();
  private scanCounts: Map<string, number> = new Map();
  private recentlyClosedPositions: Map<string, number> = new Map(); // Prevents duplicate close attempts
  private readonly STOP_LOSS_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
  private readonly CLOSE_POSITION_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes to avoid duplicate closes

  /**
   * Get trailing stop percentage - flat 5% for all pairs
   * Matches Binance/Enclave bot configuration for consistency
   */
  private getTrailingStopPercent(_symbol: string): number {
    return 5;
  }

  constructor(client: HyperliquidClient, strategyConfig: BreakoutConfig, telegram?: TelegramService) {
    this.client = client;
    this.config = strategyConfig;
    this.telegram = telegram;
    this.logger = pino({ name: 'BreakoutStrategy', level: config.logLevel });
    this.dataService = new BinanceDataService(config.binanceBaseUrl);
  }

  private roundToIncrement(price: Decimal, symbol: string): Decimal {
    let increment: number;

    // Price increments for Hyperliquid markets
    if (symbol === 'BTC') {
      increment = 1; // Whole dollars
    } else if (symbol === 'ETH') {
      increment = 0.1; // 1 decimal place
    } else if (symbol === 'SOL' || symbol === 'BNB' || symbol === 'AVAX') {
      increment = 0.01; // 2 decimal places
    } else if (symbol === 'LINK' || symbol === 'HYPE') {
      increment = 0.001; // 3 decimal places
    } else if (symbol === 'XRP' || symbol === 'SUI') {
      increment = 0.0001; // 4 decimal places
    } else {
      increment = 0.001; // Default to 3 decimal places
    }

    const priceNumber = price.toNumber();
    const rounded = Math.round(priceNumber / increment) * increment;
    return new Decimal(rounded.toFixed(8));
  }

  public async updatePriceHistory(symbol: string): Promise<void> {
    try {
      // Fetch latest 5m candles from the same source as historical data
      // This ensures volume comparisons are apples-to-apples
      const recentCandles = await this.dataService.getHistoricalCandles(symbol, '5m', 5);

      if (!recentCandles || recentCandles.length === 0) {
        this.logger.debug(`No recent candles fetched for ${symbol}`);
        return;
      }

      const history = this.priceHistory.get(symbol) || [];
      const lastKnownTimestamp = this.lastCandleTimestamp.get(symbol) || 0;
      let newCandlesAdded = 0;

      // Only add candles that are newer than what we have
      for (const candle of recentCandles) {
        const candleTime = candle.timestamp.getTime();
        if (candleTime > lastKnownTimestamp) {
          history.push(candle);
          this.lastCandleTimestamp.set(symbol, candleTime);
          newCandlesAdded++;
        }
      }

      // Keep only necessary history (50 candles = ~4 hours of 5m data)
      const maxHistory = Math.max(50, this.config.lookbackPeriod * 2);
      if (history.length > maxHistory) {
        history.splice(0, history.length - maxHistory);
      }

      this.priceHistory.set(symbol, history);

      if (newCandlesAdded > 0) {
        const latestCandle = history[history.length - 1];
        this.logger.debug(`${symbol}: Added ${newCandlesAdded} new candle(s), total: ${history.length}, latest close: $${latestCandle.close.toFixed(2)}`);
      }
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to update price history for ${symbol}`);
    }
  }

  public initializeWithHistoricalData(
    symbol: string,
    historicalData: PriceData[]
  ): void {
    this.priceHistory.set(symbol, [...historicalData]);

    // Set the last candle timestamp to avoid re-adding these candles
    if (historicalData.length > 0) {
      const lastCandle = historicalData[historicalData.length - 1];
      this.lastCandleTimestamp.set(symbol, lastCandle.timestamp.getTime());
    }

    this.logger.info(
      { symbol, dataPoints: historicalData.length },
      `Initialized ${symbol} with historical data`
    );
  }

  public async generateSignal(symbol: string): Promise<Signal | null> {
    const history = this.priceHistory.get(symbol);
    this.logger.debug(`Price history for ${symbol}: ${history?.length || 0} points, required: ${this.config.lookbackPeriod}`);

    if (!history || history.length < this.config.lookbackPeriod) {
      this.logger.debug(`Insufficient price history for ${symbol}. Have: ${history?.length || 0}, need: ${this.config.lookbackPeriod}`);
      return null;
    }

    // Validate price history quality
    const historyCheck = HealthCheck.validatePriceHistory(symbol, history, this.config.lookbackPeriod);
    if (!historyCheck.valid) {
      this.logger.error({ symbol, errors: historyCheck.errors }, `Price history validation failed for ${symbol}`);
      return null;
    }

    // Check if already have an active position
    if (this.activeSignals.has(symbol)) {
      this.logger.debug(`Already have active signal for ${symbol} - skipping`);
      return null;
    }

    // Check stop loss cooldown
    const cooldownTimestamp = this.stopLossCooldowns.get(symbol);
    if (cooldownTimestamp) {
      const timeElapsed = Date.now() - cooldownTimestamp;
      if (timeElapsed < this.STOP_LOSS_COOLDOWN_MS) {
        const minutesRemaining = Math.ceil((this.STOP_LOSS_COOLDOWN_MS - timeElapsed) / 60000);
        this.logger.info(`⏱️  ${symbol} BLOCKED by stop loss cooldown - ${minutesRemaining} min remaining`);
        return null;
      } else {
        this.stopLossCooldowns.delete(symbol);
        this.logger.info(`✅ Stop loss cooldown expired for ${symbol}`);
      }
    }

    try {
      const resistance = TechnicalIndicators.calculateResistance(
        history,
        this.config.lookbackPeriod
      );
      const support = TechnicalIndicators.calculateSupport(
        history,
        this.config.lookbackPeriod
      );

      const currentPrice = history[history.length - 1].close;

      // Validate support/resistance
      const srCheck = HealthCheck.validateSupportResistance(symbol, support, resistance, currentPrice);
      if (!srCheck.valid) {
        this.logger.error({ symbol, errors: srCheck.errors }, `Support/Resistance validation failed`);
        return null;
      }

      const avgVolume = TechnicalIndicators.calculateAverageVolume(
        history,
        Math.min(20, history.length)
      );

      // Check trend direction
      const trend = TechnicalIndicators.detectTrend(history, 20, 50);
      const priceStructure = TechnicalIndicators.detectPriceStructure(history, 10);

      // Check last 5 candles for breakout + volume spike
      const candleLookback = Math.min(5, history.length);
      let breakoutCandle: PriceData | null = null;
      let breakoutType: 'BULLISH' | 'BEARISH' | null = null;

      for (let i = history.length - 1; i >= history.length - candleLookback; i--) {
        const candle = history[i];
        const candleBreakout = TechnicalIndicators.detectBreakout(
          candle.close,
          resistance,
          support,
          this.config.breakoutBuffer
        );
        const candleVolumeSpike = TechnicalIndicators.isVolumeSpike(
          candle.volume,
          avgVolume,
          this.config.volumeMultiplier
        );

        // Detect large single-candle moves (>5%)
        let largeMoveType: 'BULLISH' | 'BEARISH' | null = null;
        if (i > 0) {
          const prevCandle = history[i - 1];
          const pctChange = candle.close.minus(prevCandle.close).dividedBy(prevCandle.close).times(100);

          if (pctChange.lessThan(-5) && candleVolumeSpike) {
            largeMoveType = 'BEARISH';
          } else if (pctChange.greaterThan(5) && candleVolumeSpike) {
            largeMoveType = 'BULLISH';
          }
        }

        // Detect cumulative moves over 2-5 candles
        let cumulativeMoveType: 'BULLISH' | 'BEARISH' | null = null;
        if (i >= 1) {
          for (const windowSize of [2, 3, 4, 5]) {
            if (i >= windowSize - 1) {
              const startIdx = i - windowSize + 1;
              const startCandle = history[startIdx];
              const endCandle = candle;

              const cumulativeChange = endCandle.close.minus(startCandle.close)
                .dividedBy(startCandle.close)
                .times(100);

              let totalVolume = new Decimal(0);
              for (let j = startIdx; j <= i; j++) {
                totalVolume = totalVolume.plus(history[j].volume);
              }
              const avgWindowVolume = totalVolume.dividedBy(windowSize);
              const volumeRatio = avgWindowVolume.dividedBy(avgVolume);

              if (cumulativeChange.lessThan(-1.75) && volumeRatio.greaterThanOrEqualTo(0.2)) {
                cumulativeMoveType = 'BEARISH';
                break;
              } else if (cumulativeChange.greaterThan(1.75) && volumeRatio.greaterThanOrEqualTo(0.2)) {
                cumulativeMoveType = 'BULLISH';
                break;
              }
            }
          }
        }

        const signalType = candleBreakout || largeMoveType || cumulativeMoveType;
        const volumeOK = candleVolumeSpike || (cumulativeMoveType !== null);

        // Debug: Log signal detection status for latest candle only
        if (i === history.length - 1) {
          const volRatio = candle.volume.dividedBy(avgVolume).toFixed(2);
          this.logger.debug({
            symbol,
            candleBreakout,
            largeMoveType,
            cumulativeMoveType,
            volumeSpike: candleVolumeSpike,
            volumeRatio: `${volRatio}x`,
            requiredVol: `${this.config.volumeMultiplier}x`,
            signalType,
            volumeOK,
          }, `${symbol}: Signal check - breakout: ${candleBreakout || 'none'}, largeMove: ${largeMoveType || 'none'}, cumulative: ${cumulativeMoveType || 'none'}, vol: ${volRatio}x`);
        }

        if (signalType && volumeOK) {
          // Signal found - will be validated by strict trend + EMA filters later
          this.logger.debug(`${symbol}: ${signalType} signal found in ${trend} market - pending trend/EMA validation`);

          // Check if price action still valid
          if (signalType === 'BULLISH' && currentPrice.greaterThan(support)) {
            breakoutCandle = candle;
            breakoutType = 'BULLISH';
            this.logger.info(`${symbol}: Found BULLISH signal - price $${candle.close.toFixed(2)}, vol ${candle.volume.dividedBy(avgVolume).toFixed(1)}x, above support`);
            break;
          } else if (signalType === 'BEARISH' && currentPrice.lessThan(resistance)) {
            breakoutCandle = candle;
            breakoutType = 'BEARISH';
            this.logger.info(`${symbol}: Found BEARISH signal - price $${candle.close.toFixed(2)}, vol ${candle.volume.dividedBy(avgVolume).toFixed(1)}x, below resistance`);
            break;
          }
        }
      }

      const breakout = breakoutType;
      const volumeSpike = breakoutCandle !== null;

      if (breakout && volumeSpike && breakoutCandle) {
        this.logger.info(`${symbol}: ${breakout} breakout detected in ${trend} market`);

        // STRICT TREND FILTER - Matching Binance_Bot approach
        // Require trend alignment for all signals (prevents counter-trend entries)
        if (breakout === 'BULLISH' && trend !== 'UPTREND') {
          this.logger.info(`${symbol}: BULLISH breakout REJECTED - trend is ${trend}, need UPTREND`);
          return null;
        }

        if (breakout === 'BEARISH' && trend !== 'DOWNTREND') {
          this.logger.info(`${symbol}: BEARISH breakout REJECTED - trend is ${trend}, need DOWNTREND`);
          return null;
        }

        // EMA STACKING CHECK - Matching Binance_Bot's stricter filtering
        // For BULLISH: price > EMA9 > EMA21 > EMA50
        // For BEARISH: price < EMA9 < EMA21 < EMA50
        const emaCheck = TechnicalIndicators.isEmaAligned(history, breakout);
        if (!emaCheck.aligned) {
          this.logger.info(`${symbol}: ${breakout} breakout REJECTED - ${emaCheck.reason}`);
          return null;
        }
        this.logger.info(`${symbol}: EMA alignment confirmed - ${emaCheck.reason}`);

        // Price structure filters - reject obvious counter-moves
        if (breakout === 'BULLISH' && priceStructure === 'LOWER_LOWS') {
          this.logger.info(`${symbol}: BULLISH breakout REJECTED - price structure shows LOWER_LOWS`);
          return null;
        }

        if (breakout === 'BEARISH' && priceStructure === 'HIGHER_HIGHS') {
          this.logger.info(`${symbol}: BEARISH breakout REJECTED - price structure shows HIGHER_HIGHS`);
          return null;
        }

        // CHOPPY market filter - reject ranging markets like Binance_Bot
        if (priceStructure === 'CHOPPY') {
          this.logger.info(`${symbol}: ${breakout} breakout REJECTED - price structure is CHOPPY (ranging market)`);
          return null;
        }

        // Calculate RSI early for filtering
        const rsi = TechnicalIndicators.calculateRSI(history);

        // RSI Filter - avoid buying overbought, avoid shorting oversold
        const RSI_OVERBOUGHT = 70;
        const RSI_OVERSOLD = 30;

        if (breakout === 'BULLISH' && rsi.greaterThan(RSI_OVERBOUGHT)) {
          this.logger.info(`${symbol}: BULLISH signal REJECTED - RSI ${rsi.toFixed(2)} > ${RSI_OVERBOUGHT} (overbought)`);
          return null;
        }

        if (breakout === 'BEARISH' && rsi.lessThan(RSI_OVERSOLD)) {
          this.logger.info(`${symbol}: BEARISH signal REJECTED - RSI ${rsi.toFixed(2)} < ${RSI_OVERSOLD} (oversold)`);
          return null;
        }

        const side = breakout === 'BULLISH' ? OrderSide.BUY : OrderSide.SELL;
        const entryPrice = currentPrice;
        const trailingStopPct = this.getTrailingStopPercent(symbol);
        const stopLoss =
          breakout === 'BULLISH'
            ? entryPrice.times(1 - trailingStopPct / 100)
            : entryPrice.times(1 + trailingStopPct / 100);

        let confidence = 0.7;

        const atr = TechnicalIndicators.calculateATR(history, Math.min(14, history.length - 1));
        const atrPercent = atr.dividedBy(entryPrice).times(100);

        if (atrPercent.greaterThan(1)) {
          confidence += 0.1;
        }

        let takeProfit: Decimal | undefined;
        if (this.config.takeProfitPercent) {
          takeProfit = breakout === 'BULLISH'
            ? entryPrice.times(1 + this.config.takeProfitPercent / 100)
            : entryPrice.times(1 - this.config.takeProfitPercent / 100);
        }

        if (breakout === 'BULLISH' && priceStructure === 'HIGHER_HIGHS') {
          confidence += 0.1;
        } else if (breakout === 'BEARISH' && priceStructure === 'LOWER_LOWS') {
          confidence += 0.1;
        }

        confidence += 0.1; // Recent breakout bonus

        const signal: Signal = {
          symbol,
          side,
          entryPrice,
          stopLoss,
          takeProfit,
          confidence,
          reason: `${breakout} breakout in ${trend}, ${priceStructure} structure, EMA aligned, vol spike, RSI: ${rsi.toFixed(2)}`,
        };

        this.logger.info({ signal }, `✅ Signal generated for ${symbol}: ${side} in ${trend} (EMA aligned)`);
        return signal;
      }

      // Trend following signals (if enabled)
      if (config.enableTrendFollowing) {
        const trendFollowingSignal = this.generateTrendFollowingSignal(
          symbol,
          history,
          currentPrice,
          trend,
          priceStructure,
          avgVolume
        );
        if (trendFollowingSignal) {
          return trendFollowingSignal;
        }
      }

      // Log scan summary when no signal (every 5 scans for better visibility)
      const scanCount = (this.scanCounts.get(symbol) || 0) + 1;
      this.scanCounts.set(symbol, scanCount);

      if (scanCount % 5 === 0) {
        const lastCandle = history[history.length - 1];
        const volRatio = lastCandle.volume.dividedBy(avgVolume).toFixed(2);
        const distToRes = resistance.minus(currentPrice).dividedBy(currentPrice).times(100).toFixed(2);
        const distToSup = currentPrice.minus(support).dividedBy(currentPrice).times(100).toFixed(2);

        // Check why no signal was generated
        const breakoutDetected = currentPrice.greaterThan(resistance) || currentPrice.lessThan(support);
        const volumeOK = parseFloat(volRatio) >= this.config.volumeMultiplier;

        let reason = 'waiting for breakout';
        if (breakoutDetected && !volumeOK) {
          reason = `breakout detected but vol too low (${volRatio}x < ${this.config.volumeMultiplier}x)`;
        } else if (!breakoutDetected && volumeOK) {
          reason = `vol OK but price in range (${distToRes}% to res, ${distToSup}% to sup)`;
        } else if (breakoutDetected && volumeOK) {
          reason = `signal found but filtered (trend: ${trend}, structure: ${priceStructure})`;
        }

        this.logger.info({
          symbol,
          price: currentPrice.toFixed(2),
          resistance: resistance.toFixed(2),
          support: support.toFixed(2),
          distToResistance: `${distToRes}%`,
          distToSupport: `${distToSup}%`,
          volumeRatio: `${volRatio}x`,
          volumeThreshold: `${this.config.volumeMultiplier}x`,
          trend,
          structure: priceStructure,
          reason,
        }, `📊 ${symbol}: No signal - ${reason}`);
      }

      return null;
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to generate signal for ${symbol}`);
      return null;
    }
  }

  private updateTrendHistory(symbol: string, trend: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS'): void {
    const history = this.trendHistory.get(symbol) || [];
    history.push(trend);

    if (history.length > 10) {
      history.shift();
    }

    this.trendHistory.set(symbol, history);
  }

  private hasConsecutiveTrend(
    symbol: string,
    expectedTrend: 'UPTREND' | 'DOWNTREND',
    minConsecutive: number
  ): boolean {
    const history = this.trendHistory.get(symbol) || [];

    if (history.length < minConsecutive) {
      return false;
    }

    const recent = history.slice(-minConsecutive);
    return recent.every(t => t === expectedTrend);
  }

  private generateTrendFollowingSignal(
    symbol: string,
    history: PriceData[],
    currentPrice: Decimal,
    trend: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS',
    priceStructure: 'HIGHER_HIGHS' | 'LOWER_LOWS' | 'CHOPPY',
    avgVolume: Decimal
  ): Signal | null {
    try {
      this.updateTrendHistory(symbol, trend);

      const minConsecutive = config.trendFollowingMinConsecutiveTrends;
      const smaPeriod = config.trendFollowingSmaPeriod;
      const maxDistanceFromHigh = config.trendFollowingMaxDistanceFromHigh / 100;

      if (history.length < smaPeriod) {
        return null;
      }

      const closePrices = history.map(h => h.close);
      const sma = TechnicalIndicators.calculateSMA(closePrices, smaPeriod);

      const currentVolume = history[history.length - 1].volume;
      const volumeRatio = currentVolume.dividedBy(avgVolume);

      if (volumeRatio.lessThan(this.config.volumeMultiplier)) {
        return null;
      }

      const recentPrices = history.slice(-smaPeriod);
      const recentHigh = Decimal.max(...recentPrices.map(p => p.high));
      const recentLow = Decimal.min(...recentPrices.map(p => p.low));

      // SHORT signal
      if (this.hasConsecutiveTrend(symbol, 'DOWNTREND', minConsecutive)) {
        if (currentPrice.lessThan(sma)) {
          const distanceFromHigh = recentHigh.minus(currentPrice).dividedBy(recentHigh);

          if (distanceFromHigh.lessThanOrEqualTo(maxDistanceFromHigh)) {
            if (priceStructure === 'LOWER_LOWS') {
              const entryPrice = currentPrice;
              const stopLoss = entryPrice.times(1 + this.getTrailingStopPercent(symbol) / 100);

              const rsi = TechnicalIndicators.calculateRSI(history);

              let takeProfit: Decimal | undefined;
              if (this.config.takeProfitPercent) {
                takeProfit = entryPrice.times(1 - this.config.takeProfitPercent / 100);
              }

              const signal: Signal = {
                symbol,
                side: OrderSide.SELL,
                entryPrice,
                stopLoss,
                takeProfit,
                confidence: 0.65,
                reason: `TREND-FOLLOWING SHORT: ${minConsecutive} consecutive DOWNTREND, price < SMA(${smaPeriod}), LOWER_LOWS, RSI: ${rsi.toFixed(2)}`,
              };

              this.logger.info({ signal }, `📉 TREND-FOLLOWING SHORT signal for ${symbol}`);
              return signal;
            }
          }
        }
      }

      // LONG signal
      if (this.hasConsecutiveTrend(symbol, 'UPTREND', minConsecutive)) {
        if (currentPrice.greaterThan(sma)) {
          const distanceFromLow = currentPrice.minus(recentLow).dividedBy(recentLow);

          if (distanceFromLow.lessThanOrEqualTo(maxDistanceFromHigh)) {
            if (priceStructure === 'HIGHER_HIGHS') {
              const entryPrice = currentPrice;
              const stopLoss = entryPrice.times(1 - this.getTrailingStopPercent(symbol) / 100);

              const rsi = TechnicalIndicators.calculateRSI(history);

              let takeProfit: Decimal | undefined;
              if (this.config.takeProfitPercent) {
                takeProfit = entryPrice.times(1 + this.config.takeProfitPercent / 100);
              }

              const signal: Signal = {
                symbol,
                side: OrderSide.BUY,
                entryPrice,
                stopLoss,
                takeProfit,
                confidence: 0.65,
                reason: `TREND-FOLLOWING LONG: ${minConsecutive} consecutive UPTREND, price > SMA(${smaPeriod}), HIGHER_HIGHS, RSI: ${rsi.toFixed(2)}`,
              };

              this.logger.info({ signal }, `📈 TREND-FOLLOWING LONG signal for ${symbol}`);
              return signal;
            }
          }
        }
      }

      return null;
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to generate trend-following signal`);
      return null;
    }
  }

  public async executeSignal(signal: Signal, customQuantity?: Decimal): Promise<void> {
    try {
      this.logger.info(`Executing signal for ${signal.symbol}: ${signal.side} @ ${signal.entryPrice}`);

      // Double-check no active position
      if (this.activeSignals.has(signal.symbol)) {
        this.logger.warn(`🚫 BLOCKED: Already have active signal for ${signal.symbol}`);
        return;
      }

      // Check cooldown
      const cooldownTimestamp = this.stopLossCooldowns.get(signal.symbol);
      if (cooldownTimestamp) {
        const timeElapsed = Date.now() - cooldownTimestamp;
        if (timeElapsed < this.STOP_LOSS_COOLDOWN_MS) {
          const minutesRemaining = Math.ceil((this.STOP_LOSS_COOLDOWN_MS - timeElapsed) / 60000);
          this.logger.warn(`🚫 BLOCKED: ${signal.symbol} in cooldown - ${minutesRemaining} min remaining`);
          return;
        }
      }

      // Check if position exists
      const existingPositions = await this.client.getPositions();
      const existingPosition = existingPositions.find(p => p.symbol === signal.symbol);
      if (existingPosition) {
        this.logger.warn(`🚫 BLOCKED: Position already exists for ${signal.symbol}`);
        this.activeSignals.set(signal.symbol, signal);
        return;
      }

      // Calculate quantity
      let quantity: Decimal;
      if (customQuantity) {
        quantity = customQuantity;
      } else {
        const positionSizeUSD = new Decimal(this.config.positionSize);
        quantity = positionSizeUSD.dividedBy(signal.entryPrice);
        this.logger.info(`Position sizing: $${positionSizeUSD} / $${signal.entryPrice} = ${quantity} ${signal.symbol}`);
      }

      // Round price and quantity
      const entryPrice = this.roundToIncrement(signal.entryPrice, signal.symbol);
      const stopLossPrice = this.roundToIncrement(signal.stopLoss, signal.symbol);

      // Place order
      const orderResponse = await this.client.placeOrder(
        signal.symbol,
        signal.side,
        entryPrice,
        quantity,
        OrderType.LIMIT
      );

      this.logger.info({ orderResponse }, `Order placed for ${signal.symbol}`);

      // Register active signal
      this.activeSignals.set(signal.symbol, signal);

      // Initialize trailing stop
      if (signal.side === OrderSide.BUY) {
        // For longs: track the high, stop is below
        this.trailingStops.set(signal.symbol, {
          high: signal.entryPrice,
          stop: signal.stopLoss,
        });
        this.logger.info(`Initialized trailing stop for ${signal.symbol} LONG: stop at ${signal.stopLoss.toFixed(2)} (tracking high from ${signal.entryPrice.toFixed(2)})`);
      } else {
        // For shorts: track the low (stored in 'high' field), stop is above
        this.trailingStops.set(signal.symbol, {
          high: signal.entryPrice, // This is the LOW for shorts
          stop: signal.stopLoss,   // Stop is above entry for shorts
        });
        this.logger.info(`Initialized trailing stop for ${signal.symbol} SHORT: stop at ${signal.stopLoss.toFixed(2)} (tracking low from ${signal.entryPrice.toFixed(2)})`);
      }

      // Notify via Telegram
      if (this.telegram) {
        await this.telegram.notifyPositionOpened(
          signal.symbol,
          signal.side,
          quantity.toString(),
          signal.entryPrice,
          signal.stopLoss,
          signal.takeProfit,
          signal.reason
        );
      }

      this.logger.info(`✅ Successfully executed signal for ${signal.symbol}`);
    } catch (error) {
      this.logger.error({ error, signal }, `Failed to execute signal for ${signal.symbol}`);
      if (this.telegram) {
        await this.telegram.notifyError(`Failed to execute ${signal.symbol}: ${error}`, 'executeSignal');
      }
    }
  }

  public async updateTrailingStops(): Promise<void> {
    try {
      const positions = await this.client.getPositions();

      for (const position of positions) {
        // Skip positions that were recently closed (prevents duplicate close attempts)
        const closedTimestamp = this.recentlyClosedPositions.get(position.symbol);
        if (closedTimestamp) {
          const elapsed = Date.now() - closedTimestamp;
          if (elapsed < this.CLOSE_POSITION_COOLDOWN_MS) {
            this.logger.debug(`Skipping ${position.symbol} - position was closed ${Math.round(elapsed / 1000)}s ago, waiting for settlement`);
            continue;
          } else {
            // Cooldown expired, remove from recently closed
            this.recentlyClosedPositions.delete(position.symbol);
          }
        }

        let trailingStop = this.trailingStops.get(position.symbol);

        // Initialize trailing stop and take profit for orphan positions (positions without tracking)
        if (!trailingStop) {
          const stopPercent = this.getTrailingStopPercent(position.symbol);
          if (position.side === OrderSide.BUY) {
            // For longs: stop is below entry
            trailingStop = {
              high: position.entryPrice,
              stop: position.entryPrice.times(1 - stopPercent / 100),
            };
          } else {
            // For shorts: stop is above entry
            trailingStop = {
              high: position.entryPrice, // This is the LOW for shorts
              stop: position.entryPrice.times(1 + stopPercent / 100),
            };
          }
          this.trailingStops.set(position.symbol, trailingStop);
          this.logger.info(`Initialized trailing stop for orphan ${position.symbol} ${position.side}: stop at ${trailingStop.stop.toFixed(2)} (${stopPercent}% from entry ${position.entryPrice.toFixed(2)})`);

          // Also create a synthetic signal with take profit for orphan positions
          if (!this.activeSignals.has(position.symbol) && this.config.takeProfitPercent) {
            const takeProfitPercent = this.config.takeProfitPercent;
            let takeProfit: Decimal;
            if (position.side === OrderSide.BUY) {
              // For longs: take profit is above entry
              takeProfit = position.entryPrice.times(1 + takeProfitPercent / 100);
            } else {
              // For shorts: take profit is below entry
              takeProfit = position.entryPrice.times(1 - takeProfitPercent / 100);
            }

            const syntheticSignal: Signal = {
              symbol: position.symbol,
              side: position.side === OrderSide.BUY ? OrderSide.BUY : OrderSide.SELL,
              entryPrice: position.entryPrice,
              stopLoss: trailingStop.stop,
              takeProfit: takeProfit,
              confidence: 0.5, // Unknown confidence for recovered positions
              reason: 'Recovered orphan position',
            };
            this.activeSignals.set(position.symbol, syntheticSignal);
            this.logger.info(`Initialized take profit for orphan ${position.symbol} ${position.side}: TP at ${takeProfit.toFixed(2)} (${takeProfitPercent}% from entry ${position.entryPrice.toFixed(2)})`);
          }
        }

        // Update trailing stop for longs
        if (position.side === OrderSide.BUY) {
          if (position.markPrice.greaterThan(trailingStop.high)) {
            trailingStop.high = position.markPrice;
            trailingStop.stop = position.markPrice.times(1 - this.getTrailingStopPercent(position.symbol) / 100);
            this.trailingStops.set(position.symbol, trailingStop);
            this.logger.info(`Updated trailing stop for ${position.symbol} LONG: stop at ${trailingStop.stop.toFixed(2)} (${this.getTrailingStopPercent(position.symbol)}% below high of ${trailingStop.high.toFixed(2)})`);
          }

          // Check if stop hit (price dropped below stop)
          if (position.markPrice.lessThanOrEqualTo(trailingStop.stop)) {
            this.logger.info(`🛑 Trailing stop hit for ${position.symbol} LONG at ${position.markPrice.toFixed(2)}`);
            await this.closePosition(position.symbol, 'Trailing stop hit');
          }
        }

        // Update trailing stop for shorts
        if (position.side === OrderSide.SELL) {
          // For shorts, we track the LOW and stop is ABOVE it
          // trailingStop.high is repurposed as "low" for shorts
          if (position.markPrice.lessThan(trailingStop.high)) {
            trailingStop.high = position.markPrice; // This is actually the LOW for shorts
            trailingStop.stop = position.markPrice.times(1 + this.getTrailingStopPercent(position.symbol) / 100);
            this.trailingStops.set(position.symbol, trailingStop);
            this.logger.info(`Updated trailing stop for ${position.symbol} SHORT: stop at ${trailingStop.stop.toFixed(2)} (${this.getTrailingStopPercent(position.symbol)}% above low of ${trailingStop.high.toFixed(2)})`);
          }

          // Check if stop hit (price rose above stop)
          if (position.markPrice.greaterThanOrEqualTo(trailingStop.stop)) {
            this.logger.info(`🛑 Trailing stop hit for ${position.symbol} SHORT at ${position.markPrice.toFixed(2)}`);
            await this.closePosition(position.symbol, 'Trailing stop hit');
          }
        }

        // Check take profit (only if we have an active signal with take profit)
        const signal = this.activeSignals.get(position.symbol);
        if (signal?.takeProfit) {
          if (position.side === OrderSide.BUY && position.markPrice.greaterThanOrEqualTo(signal.takeProfit)) {
            this.logger.info(`🎯 Take profit hit for ${position.symbol} at ${position.markPrice.toFixed(2)}`);
            await this.closePosition(position.symbol, 'Take profit target reached');
          } else if (position.side === OrderSide.SELL && position.markPrice.lessThanOrEqualTo(signal.takeProfit)) {
            this.logger.info(`🎯 Take profit hit for ${position.symbol} at ${position.markPrice.toFixed(2)}`);
            await this.closePosition(position.symbol, 'Take profit target reached');
          }
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to update trailing stops');
    }
  }

  public async closePosition(symbol: string, reason: string): Promise<void> {
    try {
      // Check if we recently tried to close this position (prevents duplicate notifications)
      const recentClose = this.recentlyClosedPositions.get(symbol);
      if (recentClose && Date.now() - recentClose < this.CLOSE_POSITION_COOLDOWN_MS) {
        this.logger.debug(`Skipping close for ${symbol} - already closed ${Math.round((Date.now() - recentClose) / 1000)}s ago`);
        return;
      }

      const positions = await this.client.getPositions();
      const position = positions.find(p => p.symbol === symbol);

      if (!position) {
        this.logger.warn(`No position found for ${symbol}`);
        return;
      }

      // Close position with market order
      const closeSide = position.side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;
      const closePrice = this.roundToIncrement(position.markPrice, symbol);

      await this.client.placeOrder(
        symbol,
        closeSide,
        closePrice,
        position.quantity,
        OrderType.LIMIT,
        true // reduce-only
      );

      // Mark position as recently closed to prevent duplicate close attempts
      this.recentlyClosedPositions.set(symbol, Date.now());

      // Notify
      if (this.telegram) {
        await this.telegram.notifyPositionClosed(
          symbol,
          position.side,
          closePrice,
          position.unrealizedPnl.toNumber(),
          reason
        );
      }

      // Cleanup
      this.activeSignals.delete(symbol);
      this.trailingStops.delete(symbol);

      // Set cooldown if stop loss
      if (reason.includes('stop')) {
        this.stopLossCooldowns.set(symbol, Date.now());
      }

      this.logger.info(`✅ Closed position for ${symbol}: ${reason}`);
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to close position for ${symbol}`);
    }
  }

  public getActiveSignals(): Map<string, Signal> {
    return this.activeSignals;
  }
}
