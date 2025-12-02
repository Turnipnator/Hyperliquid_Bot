import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import Decimal from 'decimal.js';
import pino from 'pino';
import WebSocket from 'ws';
import {
  Environment,
  MarketData,
  Order,
  OrderSide,
  OrderType,
  Position,
  Balance,
  TimeInForce,
  HyperliquidMeta,
  HyperliquidUserState,
  HyperliquidOrderResponse,
} from './types';

export interface HyperliquidConfig {
  privateKey: string;
  accountAddress: string;
  environment: Environment;
}

export class HyperliquidClient {
  private readonly wallet: ethers.Wallet;
  private readonly accountAddress: string;
  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private readonly api: AxiosInstance;
  private readonly logger: pino.Logger;
  private meta: HyperliquidMeta | null = null;
  private ws: WebSocket | null = null;

  constructor(config: HyperliquidConfig) {
    this.wallet = new ethers.Wallet(config.privateKey);
    this.accountAddress = config.accountAddress.toLowerCase();
    this.logger = pino({ name: 'HyperliquidClient' });

    // Set URLs based on environment
    if (config.environment === Environment.MAINNET) {
      this.baseUrl = 'https://api.hyperliquid.xyz';
      this.wsUrl = 'wss://api.hyperliquid.xyz/ws';
    } else {
      this.baseUrl = 'https://api.hyperliquid-testnet.xyz';
      this.wsUrl = 'wss://api.hyperliquid-testnet.xyz/ws';
    }

    this.api = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.logger.info(`Hyperliquid client initialized for ${config.environment}`);
  }

  async initialize(): Promise<void> {
    try {
      // Fetch meta information (universe of markets)
      this.meta = await this.getMeta();
      this.logger.info(`Loaded ${this.meta.universe.length} markets from Hyperliquid`);
    } catch (error) {
      this.logger.error({ error }, 'Failed to initialize Hyperliquid client');
      throw error;
    }
  }

  private async infoRequest(type: string, payload: any = {}): Promise<any> {
    try {
      const response = await axios.post(`${this.baseUrl}/info`, {
        type,
        ...payload,
      });
      return response.data;
    } catch (error) {
      this.logger.error({ error, type, payload }, 'Info request failed');
      throw error;
    }
  }

  private async exchangeRequest(action: any, nonce?: number): Promise<any> {
    try {
      const timestamp = nonce || Date.now();

      // Sign the action using EIP-712
      const signature = await this.signL1Action(action, timestamp);

      const payload = {
        action,
        nonce: timestamp,
        signature,
      };

      const response = await axios.post(`${this.baseUrl}/exchange`, payload);

      if (response.data.status === 'err') {
        throw new Error(`Exchange request failed: ${JSON.stringify(response.data)}`);
      }

      return response.data;
    } catch (error) {
      this.logger.error({ error, action }, 'Exchange request failed');
      throw error;
    }
  }

  private async signL1Action(action: any, nonce: number): Promise<string> {
    // Hyperliquid uses EIP-712 signing for L1 actions
    // Domain definition
    const domain = {
      name: 'Exchange',
      version: '1',
      chainId: 1337, // Hyperliquid uses chainId 1337
      verifyingContract: '0x0000000000000000000000000000000000000000',
    };

    // Message types depend on the action type
    // For orders, we use the 'Order' type
    const types = {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
      Order: [
        { name: 'a', type: 'uint32' },
        { name: 'b', type: 'bool' },
        { name: 'p', type: 'string' },
        { name: 'S', type: 'string' },
        { name: 'r', type: 'bool' },
        { name: 't', type: 'string' },
        { name: 'c', type: 'string' },
      ],
    };

    try {
      // Sign the typed data
      const signature = await this.wallet.signTypedData(domain, types, action);
      return signature;
    } catch (error) {
      this.logger.error({ error, action }, 'Failed to sign L1 action');
      throw error;
    }
  }

  // Get market metadata
  async getMeta(): Promise<HyperliquidMeta> {
    return await this.infoRequest('meta');
  }

  // Get all market mid prices
  async getAllMids(): Promise<{ [coin: string]: string }> {
    return await this.infoRequest('allMids');
  }

  // Get user state (positions, balances)
  async getUserState(address?: string): Promise<HyperliquidUserState> {
    const userAddress = address || this.accountAddress;
    return await this.infoRequest('clearinghouseState', { user: userAddress });
  }

  // Get L2 order book
  async getL2Book(coin: string): Promise<any> {
    return await this.infoRequest('l2Book', { coin });
  }

  // Get candle data
  async getCandles(
    coin: string,
    interval: string,
    startTime: number,
    endTime: number
  ): Promise<any> {
    return await this.infoRequest('candleSnapshot', {
      req: {
        coin,
        interval,
        startTime,
        endTime,
      },
    });
  }

  // Convert coin symbol to asset index
  private getCoinIndex(coin: string): number {
    if (!this.meta) {
      throw new Error('Meta not loaded. Call initialize() first.');
    }

    const index = this.meta.universe.findIndex((u) => u.name === coin);
    if (index === -1) {
      throw new Error(`Unknown coin: ${coin}`);
    }

    return index;
  }

  // Place an order
  async placeOrder(
    coin: string,
    side: OrderSide,
    price: Decimal,
    size: Decimal,
    orderType: OrderType = OrderType.LIMIT,
    reduceOnly: boolean = false,
    timeInForce: TimeInForce = TimeInForce.GTC
  ): Promise<HyperliquidOrderResponse> {
    const asset = this.getCoinIndex(coin);

    const orderAction = {
      type: 'order',
      orders: [
        {
          a: asset,
          b: side === OrderSide.BUY,
          p: price.toString(),
          s: size.toString(),
          r: reduceOnly,
          t: { limit: { tif: timeInForce } },
        },
      ],
      grouping: 'na',
    };

    return await this.exchangeRequest(orderAction);
  }

  // Cancel an order
  async cancelOrder(coin: string, orderId: number): Promise<any> {
    const asset = this.getCoinIndex(coin);

    const cancelAction = {
      type: 'cancel',
      cancels: [
        {
          a: asset,
          o: orderId,
        },
      ],
    };

    return await this.exchangeRequest(cancelAction);
  }

  // Cancel all orders for a coin
  async cancelAllOrders(coin?: string): Promise<any> {
    const cancelAction: any = {
      type: 'cancelByCloid',
      cancels: [],
    };

    if (coin) {
      const asset = this.getCoinIndex(coin);
      cancelAction.cancels.push({ asset, cloid: '*' });
    }

    return await this.exchangeRequest(cancelAction);
  }

  // Get latest candle from Hyperliquid (includes volume)
  async getLatestCandle(coin: string, interval: string = '5m'): Promise<{ high: Decimal; low: Decimal; close: Decimal; volume: Decimal } | null> {
    try {
      const endTime = Date.now();
      const startTime = endTime - (10 * 60 * 1000); // Last 10 minutes to ensure we get at least 1 candle

      const response = await this.infoRequest('candleSnapshot', {
        coin,
        interval,
        startTime,
        endTime,
      });

      if (!response || !Array.isArray(response) || response.length === 0) {
        return null;
      }

      // Get the most recent candle
      const latestCandle = response[response.length - 1];
      return {
        high: new Decimal(latestCandle.h),
        low: new Decimal(latestCandle.l),
        close: new Decimal(latestCandle.c),
        volume: new Decimal(latestCandle.v),
      };
    } catch (error) {
      this.logger.warn({ error, coin }, 'Failed to get latest candle, using fallback');
      return null;
    }
  }

  // Get market data for a coin
  async getMarketData(coin: string): Promise<MarketData> {
    try {
      const [mids, l2Book, latestCandle] = await Promise.all([
        this.getAllMids(),
        this.getL2Book(coin),
        this.getLatestCandle(coin),
      ]);

      const mid = mids[coin];
      if (!mid) {
        throw new Error(`No market data for ${coin}`);
      }

      const last = new Decimal(mid);
      const bid = l2Book.levels[0]?.[0]?.px
        ? new Decimal(l2Book.levels[0][0].px)
        : last;
      const ask = l2Book.levels[1]?.[0]?.px
        ? new Decimal(l2Book.levels[1][0].px)
        : last;

      // Use candle data for high/low/volume if available
      const high24h = latestCandle?.high || last;
      const low24h = latestCandle?.low || last;
      const volume24h = latestCandle?.volume || new Decimal(0);

      return {
        symbol: coin,
        last,
        high24h,
        low24h,
        volume24h,
        timestamp: Date.now(),
        bid,
        ask,
        markPrice: last,
      };
    } catch (error) {
      this.logger.error({ error, coin }, 'Failed to get market data');
      throw error;
    }
  }

  // Get positions
  async getPositions(): Promise<Position[]> {
    try {
      const userState = await this.getUserState();
      const positions: Position[] = [];

      for (const assetPosition of userState.assetPositions) {
        const pos = assetPosition.position;
        const size = new Decimal(pos.szi);

        // Skip empty positions
        if (size.isZero()) {
          continue;
        }

        const side = size.greaterThan(0) ? OrderSide.BUY : OrderSide.SELL;
        const quantity = size.abs();

        positions.push({
          symbol: pos.coin,
          side,
          quantity,
          entryPrice: new Decimal(pos.entryPx),
          markPrice: new Decimal(pos.positionValue).dividedBy(quantity),
          liquidationPrice: pos.liquidationPx
            ? new Decimal(pos.liquidationPx)
            : new Decimal(0),
          unrealizedPnl: new Decimal(pos.unrealizedPnl),
          leverage: pos.leverage.value,
          marginType: pos.leverage.type === 'cross' ? 'cross' : 'isolated',
        });
      }

      return positions;
    } catch (error) {
      this.logger.error({ error }, 'Failed to get positions');
      throw error;
    }
  }

  // Get balance
  async getBalance(): Promise<Balance> {
    try {
      const userState = await this.getUserState();
      const accountValue = new Decimal(userState.crossMarginSummary.accountValue);
      const marginUsed = new Decimal(userState.crossMarginSummary.totalMarginUsed);
      const available = accountValue.minus(marginUsed);

      return {
        asset: 'USDC',
        available,
        locked: marginUsed,
        total: accountValue,
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to get balance');
      throw error;
    }
  }

  // Connect to WebSocket for real-time updates
  connectWebSocket(onMessage: (data: any) => void): void {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.logger.info('WebSocket connected');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        onMessage(message);
      } catch (error) {
        this.logger.error({ error }, 'Failed to parse WebSocket message');
      }
    });

    this.ws.on('error', (error) => {
      this.logger.error({ error }, 'WebSocket error');
    });

    this.ws.on('close', () => {
      this.logger.warn('WebSocket disconnected');
      // Attempt to reconnect after 5 seconds
      setTimeout(() => this.connectWebSocket(onMessage), 5000);
    });
  }

  // Subscribe to market data
  subscribeToTrades(coin: string): void {
    if (!this.ws) {
      throw new Error('WebSocket not connected');
    }

    const subscription = {
      method: 'subscribe',
      subscription: {
        type: 'trades',
        coin,
      },
    };

    this.ws.send(JSON.stringify(subscription));
    this.logger.info({ coin }, 'Subscribed to trades');
  }

  // Subscribe to user events
  subscribeToUserEvents(address?: string): void {
    if (!this.ws) {
      throw new Error('WebSocket not connected');
    }

    const userAddress = address || this.accountAddress;

    const subscription = {
      method: 'subscribe',
      subscription: {
        type: 'userEvents',
        user: userAddress,
      },
    };

    this.ws.send(JSON.stringify(subscription));
    this.logger.info({ user: userAddress }, 'Subscribed to user events');
  }

  disconnectWebSocket(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
