import pino from 'pino';
import Decimal from 'decimal.js';
import http from 'http';
import { config } from './config/config';
import { HyperliquidClient } from './core/exchange/HyperliquidClient';
import { BreakoutStrategy } from './core/strategy/BreakoutStrategy';
import { RiskManager } from './core/risk/RiskManager';
import { TelegramService, BotStatusProvider } from './services/telegram/TelegramService';
import { BinanceDataService } from './services/data/BinanceDataService';
import { Environment } from './core/exchange/types';

const logger = pino({ name: 'Main', level: config.logLevel });

class HyperliquidBot implements BotStatusProvider {
  private client: HyperliquidClient;
  private strategy: BreakoutStrategy;
  private riskManager: RiskManager;
  private telegram?: TelegramService;
  private binanceData: BinanceDataService;
  private isRunning: boolean = false;
  private mainLoopInterval: NodeJS.Timeout | null = null;
  private trailingStopInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Initialize Hyperliquid client
    this.client = new HyperliquidClient({
      privateKey: config.privateKey,
      accountAddress: config.accountAddress,
      environment: config.environment,
    });

    // Initialize strategy
    this.strategy = new BreakoutStrategy(
      this.client,
      {
        lookbackPeriod: config.lookbackPeriod,
        volumeMultiplier: config.volumeMultiplier,
        trailingStopPercent: config.trailingStopPercent,
        positionSize: config.positionSize,
        useScalping: config.useScalping,
        breakoutBuffer: config.breakoutBuffer,
        takeProfitPercent: config.takeProfitPercent,
      }
    );

    // Initialize risk manager
    this.riskManager = new RiskManager({
      maxDailyLoss: config.maxDailyLoss,
      maxPositions: config.maxPositions,
      positionSize: config.positionSize,
      maxLeverage: config.maxLeverage,
      maxDrawdown: config.maxDrawdown,
    });

    // Initialize Telegram if enabled
    if (config.telegramEnabled && config.telegramBotToken && config.telegramChatId) {
      this.telegram = new TelegramService({
        botToken: config.telegramBotToken,
        chatId: config.telegramChatId,
        enabled: true,
      });
      this.telegram.setStatusProvider(this);
    }

    // Initialize Binance data service
    this.binanceData = new BinanceDataService(config.binanceBaseUrl);

    logger.info('Hyperliquid Bot initialized');
  }

  async start(): Promise<void> {
    try {
      logger.info('🚀 Starting Hyperliquid Trading Bot...');
      logger.info(`Environment: ${config.environment}`);
      logger.info(`Trading Mode: ${config.tradingMode}`);
      logger.info(`Trading Pairs: ${config.tradingPairs.join(', ')}`);

      // Initialize Hyperliquid client
      await this.client.initialize();

      // Get initial balance
      const balance = await this.client.getBalance();
      logger.info(`Initial Balance: ${balance.total.toFixed(2)} USDC`);

      // Set initial balances for tracking
      this.riskManager.resetPeakBalance(balance.total);

      if (this.telegram) {
        this.telegram.setStartBalance(balance.total.toNumber());
        this.telegram.setDailyStartBalance(balance.total.toNumber());
        this.telegram.setWeeklyStartBalance(balance.total.toNumber());
        await this.telegram.notifyBotStarted(balance.total.toNumber());
      }

      // Load historical data for each trading pair
      logger.info('📊 Loading historical data...');
      for (const symbol of config.tradingPairs) {
        try {
          const historicalCandles = await this.binanceData.getHistoricalCandles(
            symbol,
            '5m',
            Math.max(100, config.lookbackPeriod * 2)
          );

          if (historicalCandles.length > 0) {
            this.strategy.initializeWithHistoricalData(symbol, historicalCandles);
            logger.info(`Loaded ${historicalCandles.length} candles for ${symbol}`);
          } else {
            logger.warn(`No historical data available for ${symbol}`);
          }
        } catch (error) {
          logger.error({ error, symbol }, `Failed to load historical data for ${symbol}`);
        }
      }

      this.isRunning = true;

      // Start main trading loop (every 1 minute)
      this.mainLoopInterval = setInterval(async () => {
        await this.mainLoop();
      }, 60 * 1000);

      // Start trailing stop update loop (every 10 seconds)
      this.trailingStopInterval = setInterval(async () => {
        await this.strategy.updateTrailingStops();
      }, 10 * 1000);

      logger.info('✅ Bot started successfully');

      // Run first iteration immediately
      await this.mainLoop();
    } catch (error) {
      logger.error({ error }, 'Failed to start bot');
      if (this.telegram) {
        await this.telegram.notifyError(`Failed to start bot: ${error}`, 'start');
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      logger.info('🛑 Stopping bot...');
      this.isRunning = false;

      if (this.mainLoopInterval) {
        clearInterval(this.mainLoopInterval);
        this.mainLoopInterval = null;
      }

      if (this.trailingStopInterval) {
        clearInterval(this.trailingStopInterval);
        this.trailingStopInterval = null;
      }

      const balance = await this.client.getBalance();
      const totalPnl = balance.total.minus(this.telegram?.startBalance || 0);

      if (this.telegram) {
        await this.telegram.notifyBotStopped(balance.total.toNumber(), totalPnl.toNumber());
      }

      logger.info('✅ Bot stopped');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Error stopping bot');
      process.exit(1);
    }
  }

  async restart(): Promise<void> {
    logger.info('🔄 Restarting bot...');
    await this.stop();
    await this.start();
  }

  private async mainLoop(): Promise<void> {
    try {
      if (!this.isRunning) {
        return;
      }

      logger.debug('Running main loop iteration...');

      // Check risk conditions
      const balance = await this.client.getBalance();
      const positions = await this.client.getPositions();

      if (this.riskManager.shouldStopTrading()) {
        logger.error('⛔ Risk manager triggered emergency stop');
        if (this.telegram) {
          await this.telegram.notifyError('Emergency stop triggered by risk manager', 'mainLoop');
        }
        await this.stop();
        return;
      }

      // Update price history for all pairs
      for (const symbol of config.tradingPairs) {
        try {
          await this.strategy.updatePriceHistory(symbol);
        } catch (error) {
          logger.error({ error, symbol }, `Failed to update price history for ${symbol}`);
        }
      }

      // Generate and execute signals if we have capacity
      if (positions.length < config.maxPositions) {
        for (const symbol of config.tradingPairs) {
          try {
            // Skip if already have position
            if (positions.find(p => p.symbol === symbol)) {
              continue;
            }

            // Generate signal
            const signal = await this.strategy.generateSignal(symbol);

            if (signal) {
              // Check risk before executing
              const requiredMargin = signal.entryPrice.times(this.riskManager.calculatePositionSize(
                balance,
                signal.entryPrice,
                signal.stopLoss
              ));

              if (this.riskManager.canOpenPosition(positions, balance, requiredMargin)) {
                logger.info(`📈 Executing signal for ${symbol}`);
                await this.strategy.executeSignal(signal);
              } else {
                logger.warn(`⚠️ Risk manager rejected signal for ${symbol}`);
              }
            }
          } catch (error) {
            logger.error({ error, symbol }, `Error processing ${symbol}`);
          }
        }
      }

      // Log current status
      const metrics = this.riskManager.getRiskMetrics(positions, balance);
      logger.info({
        balance: balance.total.toFixed(2),
        positions: positions.length,
        dailyPnl: metrics.dailyPnl.toFixed(2),
        riskScore: metrics.riskScore,
      }, 'Bot status');
    } catch (error) {
      logger.error({ error }, 'Error in main loop');
      if (this.telegram) {
        await this.telegram.notifyError(`Main loop error: ${error}`, 'mainLoop');
      }
    }
  }

  async getStatus(): Promise<{
    balance: number;
    positions: Array<{
      symbol: string;
      side: string;
      quantity: string;
      entryPrice: string;
      markPrice: string;
      unrealizedPnl: string;
    }>;
    dailyPnl: number;
    isRunning: boolean;
  }> {
    try {
      const balance = await this.client.getBalance();
      const positions = await this.client.getPositions();

      return {
        balance: balance.total.toNumber(),
        positions: positions.map(p => ({
          symbol: p.symbol,
          side: p.side,
          quantity: p.quantity.toString(),
          entryPrice: p.entryPrice.toFixed(2),
          markPrice: p.markPrice.toFixed(2),
          unrealizedPnl: p.unrealizedPnl.toFixed(2),
        })),
        dailyPnl: this.riskManager.getDailyPnl().toNumber(),
        isRunning: this.isRunning,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get status');
      throw error;
    }
  }
}

// Main entry point
async function main() {
  logger.info('🏁 Hyperliquid Trading Bot');
  logger.info('='.repeat(50));

  const bot = new HyperliquidBot();

  // Start health check server for Docker
  const healthServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  healthServer.listen(3000, () => {
    logger.info('Health check server listening on port 3000');
  });

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('\n👋 Received SIGINT, shutting down gracefully...');
    healthServer.close();
    await bot.stop();
  });

  process.on('SIGTERM', async () => {
    logger.info('\n👋 Received SIGTERM, shutting down gracefully...');
    healthServer.close();
    await bot.stop();
  });

  // Handle uncaught errors
  process.on('uncaughtException', async (error) => {
    logger.error({ error }, '💥 Uncaught exception');
    await bot.stop();
  });

  process.on('unhandledRejection', async (reason) => {
    logger.error({ reason }, '💥 Unhandled rejection');
    await bot.stop();
  });

  // Start the bot
  try {
    await bot.start();
  } catch (error) {
    logger.error({ error }, '❌ Failed to start bot');
    process.exit(1);
  }
}

// Run if this is the main module
if (require.main === module) {
  main().catch((error) => {
    logger.error({ error }, 'Fatal error');
    process.exit(1);
  });
}

export { HyperliquidBot };
