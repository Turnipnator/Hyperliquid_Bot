import axios from 'axios';
import Decimal from 'decimal.js';
import pino from 'pino';
import { PriceData } from '../../core/indicators/TechnicalIndicators';

export class BinanceDataService {
  private readonly baseUrl: string;
  private readonly logger: pino.Logger;

  constructor(baseUrl: string = 'https://api.binance.com') {
    this.baseUrl = baseUrl;
    this.logger = pino({ name: 'BinanceDataService' });
  }

  // Map Hyperliquid symbols to Binance symbols
  private mapSymbol(symbol: string): string | null {
    const symbolMap: { [key: string]: string | null } = {
      'BTC': 'BTCUSDT',
      'ETH': 'ETHUSDT',
      'SOL': 'SOLUSDT',
      'AVAX': 'AVAXUSDT',
      'HYPE': null, // Not on Binance
      'BNB': 'BNBUSDT',
      'SUI': 'SUIUSDT',
      'LINK': 'LINKUSDT',
      'XRP': 'XRPUSDT',
    };

    return symbolMap[symbol] || `${symbol}USDT`;
  }

  async getHistoricalCandles(
    symbol: string,
    interval: string = '5m',
    limit: number = 100
  ): Promise<PriceData[]> {
    try {
      const binanceSymbol = this.mapSymbol(symbol);

      if (!binanceSymbol) {
        this.logger.warn(`Symbol ${symbol} not available on Binance, skipping historical data`);
        return [];
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
