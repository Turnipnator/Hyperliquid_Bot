import Decimal from 'decimal.js';
import pino from 'pino';
import { HyperliquidClient } from '../exchange/HyperliquidClient';
import { OrderSide, OrderType } from '../exchange/types';
import { TechnicalIndicators, PriceData } from '../indicators/TechnicalIndicators';
import { config } from '../../config/config';
import { HealthCheck } from '../../utils/healthCheck';
import { TelegramService } from '../../services/telegram/TelegramService';

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
  private priceHistory: Map<string, PriceData[]> = new Map();
  private activeSignals: Map<string, Signal> = new Map();
  private trailingStops: Map<string, { high: Decimal; stop: Decimal }> = new Map();
  private trendHistory: Map<string, Array<'UPTREND' | 'DOWNTREND' | 'SIDEWAYS'>> = new Map();
  private stopLossCooldowns: Map<string, number> = new Map();
  private scanCounts: Map<string, number> = new Map();
  private readonly STOP_LOSS_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

  /**
   * Get trailing stop percentage based on 90-day volatility analysis
   * Tiered stops to match each pair's ATR (Average True Range):
   * - Low volatility (BTC/ETH/BNB): 6% - ATR ~3-5.5%
   * - Medium volatility (SOL/XRP): 8% - ATR ~6-6.5%
   * - High volatility (LINK/AVAX/SUI/HYPE): 10% - ATR ~7.5-8.5%
   */
  private getTrailingStopPercent(symbol: string): number {
    // Low volatility tier - 6% stop (~1.5x their ATR)
    if (symbol === 'BTC' || symbol === 'ETH' || symbol === 'BNB') {
      return 6;
    }

    // Medium volatility tier - 8% stop (~1.3x their ATR)
    if (symbol === 'SOL' || symbol === 'XRP') {
      return 8;
    }

    // High volatility tier - 10% stop (~1.3x their ATR)
    if (symbol === 'LINK' || symbol === 'AVAX' || symbol === 'SUI' || symbol === 'HYPE') {
      return 10;
    }

    // Default to config value for unknown pairs
    return this.config.trailingStopPercent;
  }

  constructor(client: HyperliquidClient, strategyConfig: BreakoutConfig, telegram?: TelegramService) {
    this.client = client;
    this.config = strategyConfig;
    this.telegram = telegram;
    this.logger = pino({ name: 'BreakoutStrategy', level: config.logLevel });
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
      const marketData = await this.client.getMarketData(symbol);

      const currentPriceData: PriceData = {
        high: marketData.high24h,
        low: marketData.low24h,
        close: marketData.last,
        volume: marketData.volume24h,
        timestamp: new Date(marketData.timestamp),
      };

      const history = this.priceHistory.get(symbol) || [];
      const previousPrice = history.length > 0 ? history[history.length - 1].close : new Decimal(0);

      history.push(currentPriceData);

      // Keep only necessary history
      const maxHistory = this.config.lookbackPeriod * 2;
      if (history.length > maxHistory) {
        history.splice(0, history.length - maxHistory);
      }

      this.priceHistory.set(symbol, history);

      this.logger.debug(`Updated ${symbol} price: ${previousPrice.toString()} -> ${currentPriceData.close.toString()} (${history.length} points)`);
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to update price history for ${symbol}`);
    }
  }

  public initializeWithHistoricalData(
    symbol: string,
    historicalData: PriceData[]
  ): void {
    this.priceHistory.set(symbol, [...historicalData]);
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

        if (signalType && volumeOK) {
          // Trend alignment
          let trendAligned = false;

          if (cumulativeMoveType !== null) {
            trendAligned = (signalType === 'BULLISH' && (trend === 'UPTREND' || trend === 'SIDEWAYS')) ||
                          (signalType === 'BEARISH' && (trend === 'DOWNTREND' || trend === 'SIDEWAYS'));
          } else {
            trendAligned = (signalType === 'BULLISH' && trend === 'UPTREND') ||
                          (signalType === 'BEARISH' && trend === 'DOWNTREND');
          }

          if (!trendAligned) {
            continue;
          }

          // Check if trend still valid
          if (signalType === 'BULLISH' && currentPrice.greaterThan(support)) {
            breakoutCandle = candle;
            breakoutType = 'BULLISH';
            break;
          } else if (signalType === 'BEARISH' && currentPrice.lessThan(resistance)) {
            breakoutCandle = candle;
            breakoutType = 'BEARISH';
            break;
          }
        }
      }

      const breakout = breakoutType;
      const volumeSpike = breakoutCandle !== null;

      if (breakout && volumeSpike && breakoutCandle) {
        // Reject counter-trend trades
        if (breakout === 'BULLISH' && trend === 'DOWNTREND') {
          this.logger.info(`${symbol}: BULLISH breakout REJECTED - trend is ${trend}`);
          return null;
        }

        if (breakout === 'BEARISH' && trend === 'UPTREND') {
          this.logger.info(`${symbol}: BEARISH breakout REJECTED - trend is ${trend}`);
          return null;
        }

        // Reject if price structure doesn't match
        if (breakout === 'BULLISH' && priceStructure === 'LOWER_LOWS') {
          this.logger.info(`${symbol}: BULLISH breakout REJECTED - price structure shows LOWER_LOWS`);
          return null;
        }

        if (breakout === 'BEARISH' && priceStructure === 'HIGHER_HIGHS') {
          this.logger.info(`${symbol}: BEARISH breakout REJECTED - price structure shows HIGHER_HIGHS`);
          return null;
        }

        // Reject choppy markets
        if (priceStructure === 'CHOPPY') {
          this.logger.info(`${symbol}: ${breakout} signal REJECTED - market is CHOPPY`);
          return null;
        }

        const side = breakout === 'BULLISH' ? OrderSide.BUY : OrderSide.SELL;
        const entryPrice = currentPrice;
        const trailingStopPct = this.getTrailingStopPercent(symbol);
        const stopLoss =
          breakout === 'BULLISH'
            ? entryPrice.times(1 - trailingStopPct / 100)
            : entryPrice.times(1 + trailingStopPct / 100);

        const rsi = TechnicalIndicators.calculateRSI(history);

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
          reason: `${breakout} breakout in ${trend}, ${priceStructure} structure, vol spike, RSI: ${rsi.toFixed(2)}`,
        };

        this.logger.info({ signal }, `✅ Signal generated for ${symbol}: ${side} in ${trend}`);
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

      // Log scan summary when no signal (every 10 scans to avoid spam)
      const scanCount = (this.scanCounts.get(symbol) || 0) + 1;
      this.scanCounts.set(symbol, scanCount);

      if (scanCount % 10 === 0) {
        const lastCandle = history[history.length - 1];
        const volRatio = lastCandle.volume.dividedBy(avgVolume).toFixed(2);
        const distToRes = resistance.minus(currentPrice).dividedBy(currentPrice).times(100).toFixed(2);
        const distToSup = currentPrice.minus(support).dividedBy(currentPrice).times(100).toFixed(2);

        this.logger.info({
          symbol,
          price: currentPrice.toFixed(2),
          resistance: resistance.toFixed(2),
          support: support.toFixed(2),
          distToResistance: `${distToRes}%`,
          distToSupport: `${distToSup}%`,
          volumeRatio: `${volRatio}x`,
          trend,
          structure: priceStructure,
        }, `📊 ${symbol}: No signal - Price $${currentPrice.toFixed(2)}, Trend: ${trend}, Vol: ${volRatio}x avg`);
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
        this.trailingStops.set(signal.symbol, {
          high: signal.entryPrice,
          stop: signal.stopLoss,
        });
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
        const signal = this.activeSignals.get(position.symbol);
        if (!signal) {
          continue;
        }

        const trailingStop = this.trailingStops.get(position.symbol);
        if (!trailingStop) {
          continue;
        }

        // Update trailing stop for longs
        if (position.side === OrderSide.BUY) {
          if (position.markPrice.greaterThan(trailingStop.high)) {
            trailingStop.high = position.markPrice;
            trailingStop.stop = position.markPrice.times(1 - this.getTrailingStopPercent(position.symbol) / 100);
            this.trailingStops.set(position.symbol, trailingStop);
            this.logger.info(`Updated trailing stop for ${position.symbol}: ${trailingStop.stop.toFixed(2)} (${this.getTrailingStopPercent(position.symbol)}% tiered stop)`);
          }

          // Check if stop hit
          if (position.markPrice.lessThanOrEqualTo(trailingStop.stop)) {
            this.logger.info(`🛑 Trailing stop hit for ${position.symbol}`);
            await this.closePosition(position.symbol, 'Trailing stop hit');
          }
        }

        // Check take profit
        if (signal.takeProfit) {
          if (position.side === OrderSide.BUY && position.markPrice.greaterThanOrEqualTo(signal.takeProfit)) {
            this.logger.info(`🎯 Take profit hit for ${position.symbol}`);
            await this.closePosition(position.symbol, 'Take profit target reached');
          } else if (position.side === OrderSide.SELL && position.markPrice.lessThanOrEqualTo(signal.takeProfit)) {
            this.logger.info(`🎯 Take profit hit for ${position.symbol}`);
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
