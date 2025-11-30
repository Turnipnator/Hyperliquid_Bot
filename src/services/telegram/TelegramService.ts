import TelegramBot from 'node-telegram-bot-api';
import pino from 'pino';
import Decimal from 'decimal.js';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

export interface BotStatusProvider {
  getStatus(): Promise<{
    balance: number;
    positions: Array<{
      symbol: string;
      side: string;
      quantity: string;
      entryPrice: string;
      unrealizedPnl: string;
    }>;
    dailyPnl: number;
    isRunning: boolean;
  }>;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export class TelegramService {
  private bot: TelegramBot | null = null;
  private chatId: string;
  private enabled: boolean;
  private logger: pino.Logger;
  public startBalance: number = 0;
  private dailyStartBalance: number = 0;
  private weeklyStartBalance: number = 0;
  private dailyTrades: { wins: number; losses: number; total: number } = { wins: 0, losses: 0, total: 0 };
  private weeklyTrades: { wins: number; losses: number; total: number } = { wins: 0, losses: 0, total: 0 };
  private allTimeTrades: { wins: number; losses: number; total: number } = { wins: 0, losses: 0, total: 0 };
  private statusProvider?: BotStatusProvider;

  constructor(config: TelegramConfig) {
    this.logger = pino({ name: 'TelegramService' });
    this.chatId = config.chatId;
    this.enabled = config.enabled;

    if (this.enabled && config.botToken) {
      try {
        this.bot = new TelegramBot(config.botToken, { polling: true });
        this.setupCommandHandlers();
        this.logger.info('Telegram bot initialized successfully with command handlers');
      } catch (error) {
        this.logger.error({ error }, 'Failed to initialize Telegram bot');
        this.enabled = false;
      }
    } else {
      this.logger.info('Telegram notifications disabled');
    }
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.enabled || !this.bot) {
      return;
    }

    try {
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (error) {
      this.logger.error({ error }, 'Failed to send Telegram message');
    }
  }

  async notifyPositionOpened(
    symbol: string,
    side: string,
    size: string,
    entryPrice: Decimal,
    stopLoss: Decimal,
    takeProfit: Decimal | undefined,
    reason: string
  ): Promise<void> {
    const emoji = side === 'BUY' ? '🟢' : '🔴';
    const direction = side === 'BUY' ? 'LONG' : 'SHORT';

    const message = `${emoji} <b>Position Opened</b>

<b>${symbol}</b> ${direction}
Size: ${size}
Entry: $${entryPrice.toFixed(2)}
Stop Loss: $${stopLoss.toFixed(2)}
${takeProfit ? `Take Profit: $${takeProfit.toFixed(2)}` : ''}

Reason: ${reason}`;

    await this.sendMessage(message);
  }

  async notifyPositionClosed(
    symbol: string,
    side: string,
    closePrice: Decimal,
    pnl: number,
    reason: string
  ): Promise<void> {
    const emoji = pnl >= 0 ? '💰' : '📉';
    const pnlEmoji = pnl >= 0 ? '✅' : '❌';
    const direction = side === 'BUY' ? 'LONG' : 'SHORT';

    this.recordTrade(pnl >= 0);

    const message = `${emoji} <b>Position Closed</b>

<b>${symbol}</b> ${direction}
Close Price: $${closePrice.toFixed(2)}
${pnlEmoji} P&L: $${pnl.toFixed(2)}

Reason: ${reason}`;

    await this.sendMessage(message);
  }

  async notifyError(error: string, context?: string): Promise<void> {
    const message = `⚠️ <b>Error Alert</b>

${context ? `Context: ${context}\n` : ''}Error: ${error}

Please check the bot!`;

    await this.sendMessage(message);
  }

  async notifyDailySummary(
    balance: number,
    dailyPnl: number,
    totalTrades: number,
    wins: number,
    losses: number
  ): Promise<void> {
    const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '0.0';
    const emoji = dailyPnl >= 0 ? '📈' : '📉';
    const pnlPercent = this.dailyStartBalance > 0
      ? ((dailyPnl / this.dailyStartBalance) * 100).toFixed(2)
      : '0.00';

    const message = `${emoji} <b>Daily Summary</b>

Balance: $${balance.toFixed(2)}
Daily P&L: $${dailyPnl.toFixed(2)} (${pnlPercent}%)

Trades: ${totalTrades}
Wins: ${wins} | Losses: ${losses}
Win Rate: ${winRate}%`;

    await this.sendMessage(message);
  }

  async notifyBotStarted(balance: number): Promise<void> {
    this.startBalance = balance;
    this.dailyStartBalance = balance;

    const message = `🤖 <b>Hyperliquid Bot Started</b>

Status: ✅ Online
Balance: $${balance.toFixed(2)}
Mode: Live Trading

Ready to trade on Hyperliquid!`;

    await this.sendMessage(message);
  }

  async notifyBotStopped(balance: number, totalPnl: number): Promise<void> {
    const emoji = totalPnl >= 0 ? '💰' : '📉';
    const pnlPercent = this.startBalance > 0
      ? ((totalPnl / this.startBalance) * 100).toFixed(2)
      : '0.00';

    const message = `🛑 <b>Bot Stopped</b>

Final Balance: $${balance.toFixed(2)}
${emoji} Total P&L: $${totalPnl.toFixed(2)} (${pnlPercent}%)`;

    await this.sendMessage(message);
  }

  setDailyStartBalance(balance: number): void {
    this.dailyStartBalance = balance;
  }

  setStartBalance(balance: number): void {
    this.startBalance = balance;
  }

  setWeeklyStartBalance(balance: number): void {
    this.weeklyStartBalance = balance;
  }

  setStatusProvider(provider: BotStatusProvider): void {
    this.statusProvider = provider;
  }

  recordTrade(isWin: boolean): void {
    if (isWin) {
      this.dailyTrades.wins++;
      this.weeklyTrades.wins++;
      this.allTimeTrades.wins++;
    } else {
      this.dailyTrades.losses++;
      this.weeklyTrades.losses++;
      this.allTimeTrades.losses++;
    }
    this.dailyTrades.total++;
    this.weeklyTrades.total++;
    this.allTimeTrades.total++;
  }

  resetDailyStats(): void {
    this.dailyTrades = { wins: 0, losses: 0, total: 0 };
  }

  resetWeeklyStats(): void {
    this.weeklyTrades = { wins: 0, losses: 0, total: 0 };
  }

  private setupCommandHandlers(): void {
    if (!this.bot) return;

    // /start command
    this.bot.onText(/\/start/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;

      const welcomeMessage = `🤖 <b>Hyperliquid Trading Bot</b>

Welcome! I'm your automated trading assistant for Hyperliquid Markets.

<b>Available Commands:</b>
/status - Current bot status and positions
/daily - Daily P&L summary
/weekly - Weekly performance report
/alltime - All-time statistics
/stop - Emergency stop bot

Use these commands to monitor your trading bot.`;

      await this.sendMessage(welcomeMessage);
    });

    // /status command
    this.bot.onText(/\/status/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;

      try {
        if (!this.statusProvider) {
          await this.sendMessage('❌ Status provider not available');
          return;
        }

        const status = await this.statusProvider.getStatus();

        let positionsText = '';
        if (status.positions.length > 0) {
          positionsText = '\n\n<b>Open Positions:</b>\n';
          for (const pos of status.positions) {
            const pnlEmoji = parseFloat(pos.unrealizedPnl) >= 0 ? '✅' : '❌';
            positionsText += `\n${pos.symbol} ${pos.side}\n`;
            positionsText += `  Size: ${pos.quantity}\n`;
            positionsText += `  Entry: $${pos.entryPrice}\n`;
            positionsText += `  ${pnlEmoji} P&L: $${pos.unrealizedPnl}\n`;
          }
        } else {
          positionsText = '\n\nNo open positions';
        }

        const statusEmoji = status.isRunning ? '✅' : '🛑';
        const message = `📊 <b>Bot Status</b>

Status: ${statusEmoji} ${status.isRunning ? 'Online' : 'Offline'}
Balance: $${status.balance.toFixed(2)}
Daily P&L: $${status.dailyPnl.toFixed(2)}${positionsText}`;

        await this.sendMessage(message);
      } catch (error) {
        this.logger.error({ error }, 'Failed to get status');
        await this.sendMessage('❌ Failed to get bot status');
      }
    });

    // /daily command
    this.bot.onText(/\/daily/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;

      try {
        if (!this.statusProvider) {
          await this.sendMessage('❌ Status provider not available');
          return;
        }

        const status = await this.statusProvider.getStatus();
        const dailyPnl = status.dailyPnl;
        const emoji = dailyPnl >= 0 ? '📈' : '📉';
        const winRate = this.dailyTrades.total > 0
          ? ((this.dailyTrades.wins / this.dailyTrades.total) * 100).toFixed(1)
          : '0.0';
        const pnlPercent = this.dailyStartBalance > 0
          ? ((dailyPnl / this.dailyStartBalance) * 100).toFixed(2)
          : '0.00';

        const message = `${emoji} <b>Daily Summary</b>

Balance: $${status.balance.toFixed(2)}
Daily P&L: $${dailyPnl.toFixed(2)} (${pnlPercent}%)

Trades Today: ${this.dailyTrades.total}
Wins: ${this.dailyTrades.wins} | Losses: ${this.dailyTrades.losses}
Win Rate: ${winRate}%`;

        await this.sendMessage(message);
      } catch (error) {
        this.logger.error({ error }, 'Failed to get daily stats');
        await this.sendMessage('❌ Failed to get daily summary');
      }
    });

    // /stop command (emergency stop)
    this.bot.onText(/\/stop/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;

      try {
        await this.sendMessage('🛑 Emergency stop requested...');

        if (!this.statusProvider) {
          await this.sendMessage('❌ Cannot stop: Status provider not available');
          return;
        }

        await this.statusProvider.stop();
      } catch (error) {
        this.logger.error({ error }, 'Failed to stop bot');
        await this.sendMessage('❌ Failed to stop bot');
      }
    });

    this.logger.info('Telegram command handlers registered');
  }
}
