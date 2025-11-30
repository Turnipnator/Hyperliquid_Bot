import Decimal from 'decimal.js';

export enum Environment {
  TESTNET = 'TESTNET',
  MAINNET = 'MAINNET',
}

export enum OrderSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum OrderType {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
}

export enum TimeInForce {
  GTC = 'Gtc', // Good til canceled
  IOC = 'Ioc', // Immediate or cancel
  ALO = 'Alo', // Add liquidity only (post-only)
}

export enum OrderStatus {
  OPEN = 'open',
  FILLED = 'filled',
  CANCELED = 'canceled',
  REJECTED = 'rejected',
}

export interface MarketData {
  symbol: string;
  last: Decimal;
  high24h: Decimal;
  low24h: Decimal;
  volume24h: Decimal;
  timestamp: number;
  bid: Decimal;
  ask: Decimal;
  markPrice: Decimal;
}

export interface OrderBook {
  symbol: string;
  bids: Array<{ price: Decimal; size: Decimal }>;
  asks: Array<{ price: Decimal; size: Decimal }>;
  timestamp: number;
}

export interface Order {
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price: Decimal;
  quantity: Decimal;
  filled: Decimal;
  remaining: Decimal;
  status: OrderStatus;
  timestamp: number;
}

export interface Position {
  symbol: string;
  side: OrderSide;
  quantity: Decimal;
  entryPrice: Decimal;
  markPrice: Decimal;
  liquidationPrice: Decimal;
  unrealizedPnl: Decimal;
  leverage: number;
  marginType: 'cross' | 'isolated';
}

export interface Balance {
  asset: string;
  available: Decimal;
  locked: Decimal;
  total: Decimal;
}

export interface Trade {
  tradeId: string;
  orderId: string;
  symbol: string;
  side: OrderSide;
  price: Decimal;
  quantity: Decimal;
  fee: Decimal;
  timestamp: number;
}

export interface Candle {
  timestamp: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
}

// Hyperliquid API specific types
export interface HyperliquidMeta {
  universe: Array<{
    name: string;
    szDecimals: number;
    maxLeverage: number;
  }>;
}

export interface HyperliquidUserState {
  assetPositions: Array<{
    position: {
      coin: string;
      szi: string;
      leverage: {
        type: string;
        value: number;
      };
      entryPx: string;
      positionValue: string;
      unrealizedPnl: string;
      liquidationPx: string | null;
    };
  }>;
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
  };
  crossMarginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
    totalRawUsd: string;
  };
}

export interface HyperliquidOrderResponse {
  status: 'ok' | 'err';
  response: {
    type: 'order' | 'error';
    data: {
      statuses: Array<{
        resting?: {
          oid: number;
        };
        filled?: {
          totalSz: string;
          avgPx: string;
          oid: number;
        };
        error?: string;
      }>;
    };
  };
}
