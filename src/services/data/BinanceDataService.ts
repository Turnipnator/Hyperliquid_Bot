import axios from 'axios';
import Decimal from 'decimal.js';
import pino from 'pino';
import { PriceData } from '../../core/indicators/TechnicalIndicators';

export class BinanceDataService {
  private readonly baseUrl: string;
  private readonly hyperliquidUrl: string;
  private readonly logger: pino.Logger;

  constructor(baseUrl: string = 'https://api.binance.com') {
    this.baseUrl = baseUrl;
    this.hyperliquidUrl = 'https://api.hyperliquid.xyz';
    this.logger = pino({ name: 'BinanceDataService' });
  }

  // Map Hyperliquid symbols to Binance symbols
  private mapSymbol(symbol: string): string | null {
    const symbolMap: { [key: string]: string | null } = {
      'BTC': 'BTCUSDT',
      'ETH': 'ETHUSDT',
      'SOL': 'SOLUSDT',
      'AVAX': 'AVAXUSDT',
      'HYPE': null, // Not on Binance - use Hyperliquid API
      'BNB': 'BNBUSDT',
      'SUI': 'SUIUSDT',
      'LINK': 'LINKUSDT',
      'XRP': 'XRPUSDT',
    };

    // Use 'in' check to properly handle null values
    if (symbol in symbolMap) {
      return symbolMap[symbol];
    }
    return `${symbol}USDT`;
  }

  // Fetch candles directly from Hyperliquid for tokens not on Binance
  private async getHyperliquidCandles(
    symbol: string,
    interval: string = '5m',
    limit: number = 100
  ): Promise<PriceData[]> {
    try {
      const endTime = Date.now();
      // Calculate start time based on interval and limit
      const intervalMs = this.getIntervalMs(interval);
      const startTime = endTime - (intervalMs * limit);

      const response = await axios.post(
        `${this.hyperliquidUrl}/info`,
        {
          type: 'candleSnapshot',
          req: {
            coin: symbol,
            interval: interval,
            startTime: startTime,
            endTime: endTime,
          },
        },
        { timeout: 10000 }
      );

      if (!response.data || !Array.isArray(response.data)) {
        this.logger.warn(`No candle data returned from Hyperliquid for ${symbol}`);
        return [];
      }

      const candles: PriceData[] = response.data.map((candle: any) => ({
        high: new Decimal(candle.h),
        low: new Decimal(candle.l),
        close: new Decimal(candle.c),
        volume: new Decimal(candle.v),
        timestamp: new Date(candle.t),
      }));

      this.logger.info(`Fetched ${candles.length} historical candles for ${symbol} from Hyperliquid`);
      return candles;
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to fetch Hyperliquid candles for ${symbol}`);
      return [];
    }
  }

  // Convert interval string to milliseconds
  private getIntervalMs(interval: string): number {
    const intervals: { [key: string]: number } = {
      '1m': 60 * 1000,
      '3m': 3 * 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '30m': 30 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '2h': 2 * 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
      '8h': 8 * 60 * 60 * 1000,
      '12h': 12 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000,
    };
    return intervals[interval] || 5 * 60 * 1000; // Default to 5m
  }

  async getHistoricalCandles(
    symbol: string,
    interval: string = '5m',
    limit: number = 100
  ): Promise<PriceData[]> {
    try {
      const binanceSymbol = this.mapSymbol(symbol);

      // If not on Binance, use Hyperliquid's candle API
      if (!binanceSymbol) {
        this.logger.info(`${symbol} not on Binance, fetching from Hyperliquid API`);
        return this.getHyperliquidCandles(symbol, interval, limit);
      }

      const response = await axios.get(`${this.baseUrl}/api/v3/klines`, {
        params: {
          symbol: binanceSymbol,
          interval,
          limit,
        },
        timeout: 10000,
      });

      const candles: PriceData[] = response.data.map((candle: any[]) => ({
        high: new Decimal(candle[2]),
        low: new Decimal(candle[3]),
        close: new Decimal(candle[4]),
        volume: new Decimal(candle[5]),
        timestamp: new Date(candle[0]),
      }));

      this.logger.info(`Fetched ${candles.length} historical candles for ${symbol}`);
      return candles;
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to fetch historical candles for ${symbol}`);
      return [];
    }
  }

  async get24HourStats(symbol: string): Promise<{
    high24h: Decimal;
    low24h: Decimal;
    volume24h: Decimal;
  } | null> {
    try {
      const binanceSymbol = this.mapSymbol(symbol);

      if (!binanceSymbol) {
        return null;
      }

      const response = await axios.get(`${this.baseUrl}/api/v3/ticker/24hr`, {
        params: {
          symbol: binanceSymbol,
        },
        timeout: 10000,
      });

      return {
        high24h: new Decimal(response.data.highPrice),
        low24h: new Decimal(response.data.lowPrice),
        volume24h: new Decimal(response.data.volume),
      };
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to fetch 24h stats for ${symbol}`);
      return null;
    }
  }
}
