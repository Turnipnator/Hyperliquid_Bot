import Decimal from 'decimal.js';
import pino from 'pino';
import { Position, Balance } from '../exchange/types';

export interface RiskConfig {
  maxDailyLoss: Decimal;
  maxPositions: number;
  positionSize: Decimal;
  maxLeverage: number;
  maxDrawdown: Decimal;
}

export interface RiskMetrics {
  dailyPnl: Decimal;
  openPositions: number;
  totalExposure: Decimal;
  currentDrawdown: Decimal;
  riskScore: number;
}

export class RiskManager {
  private readonly config: RiskConfig;
  private readonly logger: pino.Logger;
  private dailyPnl: Decimal = new Decimal(0);
  private dailyPnlResetTime: Date;
  private peakBalance: Decimal = new Decimal(0);
  private trades: Array<{ pnl: Decimal; timestamp: Date }> = [];

  constructor(config: RiskConfig, initialBalance?: Decimal) {
    this.config = config;
    this.logger = pino({ name: 'RiskManager' });
    this.dailyPnlResetTime = new Date();
    if (initialBalance) {
      this.peakBalance = initialBalance;
    }
  }

  public canOpenPosition(
    positions: Position[],
    balance: Balance,
    requiredMargin: Decimal
  ): boolean {
    this.resetDailyPnlIfNeeded();

    // Check daily loss limit
    if (this.dailyPnl.lessThanOrEqualTo(this.config.maxDailyLoss.negated())) {
      this.logger.warn(`Daily loss limit reached: ${this.dailyPnl}`);
      return false;
    }

    // Check max positions
    if (positions.length >= this.config.maxPositions) {
      this.logger.debug(`Max positions reached: ${positions.length}`);
      return false;
    }

    // Check available balance
    if (balance.available.lessThan(requiredMargin)) {
      this.logger.warn(`Insufficient balance: ${balance.available} < ${requiredMargin}`);
      return false;
    }

    // Check total exposure
    const totalExposure = this.calculateTotalExposure(positions);
    const maxExposure = balance.total.times(this.config.maxLeverage);

    if (totalExposure.plus(requiredMargin).greaterThan(maxExposure)) {
      this.logger.warn(`Max exposure reached: ${totalExposure} + ${requiredMargin} > ${maxExposure}`);
      return false;
    }

    // Check drawdown
    const currentDrawdown = this.calculateDrawdown(balance.total);
    if (currentDrawdown.greaterThan(this.config.maxDrawdown)) {
      this.logger.warn(`Max drawdown reached: ${currentDrawdown}%`);
      return false;
    }

    return true;
  }

  public calculatePositionSize(
    balance: Balance,
    entryPrice: Decimal,
    stopLoss: Decimal
  ): Decimal {
    // Kelly Criterion inspired position sizing
    const riskPerTrade = balance.total.times(0.01); // Risk 1% per trade
    const stopDistance = entryPrice.minus(stopLoss).abs();
    const stopPercent = stopDistance.dividedBy(entryPrice);

    if (stopPercent.isZero()) {
      return this.config.positionSize;
    }

    const positionValue = riskPerTrade.dividedBy(stopPercent);
    const positionSize = positionValue.dividedBy(entryPrice);

    // Apply limits
    const maxSize = this.config.positionSize.times(2);
    const minSize = this.config.positionSize.times(0.1);

    if (positionSize.greaterThan(maxSize)) {
      return maxSize;
    }

    if (positionSize.lessThan(minSize)) {
      return minSize;
    }

    return positionSize;
  }

  public updatePnl(pnl: Decimal): void {
    this.resetDailyPnlIfNeeded();
    this.dailyPnl = this.dailyPnl.plus(pnl);
    this.trades.push({ pnl, timestamp: new Date() });

    this.logger.info(`PnL updated: Daily: ${this.dailyPnl}, Trade: ${pnl}`);
  }

  public getRiskMetrics(positions: Position[], balance: Balance): RiskMetrics {
    this.resetDailyPnlIfNeeded();

    const totalExposure = this.calculateTotalExposure(positions);
    const currentDrawdown = this.calculateDrawdown(balance.total);
    const riskScore = this.calculateRiskScore(positions, balance);

    return {
      dailyPnl: this.dailyPnl,
      openPositions: positions.length,
      totalExposure,
      currentDrawdown,
      riskScore,
    };
  }

  private calculateTotalExposure(positions: Position[]): Decimal {
    return positions.reduce(
      (total, pos) => total.plus(pos.quantity.times(pos.markPrice)),
      new Decimal(0)
    );
  }

  private calculateDrawdown(currentBalance: Decimal): Decimal {
    if (this.peakBalance.isZero()) {
      return new Decimal(0);
    }

    const drawdown = this.peakBalance.minus(currentBalance).dividedBy(this.peakBalance).times(100);
    return Decimal.max(drawdown, new Decimal(0));
  }

  private calculateRiskScore(positions: Position[], balance: Balance): number {
    let score = 0;

    // Position count risk (0-25 points)
    const positionRatio = positions.length / this.config.maxPositions;
    score += positionRatio * 25;

    // Exposure risk (0-25 points)
    const exposure = this.calculateTotalExposure(positions);
    const exposureRatio = exposure.dividedBy(balance.total.times(this.config.maxLeverage));
    score += Math.min(exposureRatio.toNumber() * 25, 25);

    // Daily loss risk (0-25 points)
    const lossRatio = this.dailyPnl.abs().dividedBy(this.config.maxDailyLoss);
    if (this.dailyPnl.lessThan(0)) {
      score += Math.min(lossRatio.toNumber() * 25, 25);
    }

    // Drawdown risk (0-25 points)
    const drawdownRatio = this.calculateDrawdown(balance.total).dividedBy(this.config.maxDrawdown);
    score += Math.min(drawdownRatio.toNumber() * 25, 25);

    return Math.round(score);
  }

  private resetDailyPnlIfNeeded(): void {
    const now = new Date();
    const resetTime = new Date(this.dailyPnlResetTime);
    resetTime.setDate(resetTime.getDate() + 1);

    if (now >= resetTime) {
      this.dailyPnl = new Decimal(0);
      this.dailyPnlResetTime = now;
      this.trades = this.trades.filter(
        (t) => t.timestamp >= new Date(now.getTime() - 24 * 60 * 60 * 1000)
      );
      this.logger.info('Daily PnL reset');
    }
  }

  public getWinRate(): number {
    const wins = this.trades.filter((t) => t.pnl.greaterThan(0)).length;
    const total = this.trades.length;

    if (total === 0) {
      return 0;
    }

    return (wins / total) * 100;
  }

  public getAverageWinLoss(): { avgWin: Decimal; avgLoss: Decimal; ratio: Decimal } {
    const wins = this.trades.filter((t) => t.pnl.greaterThan(0));
    const losses = this.trades.filter((t) => t.pnl.lessThan(0));

    const avgWin = wins.length > 0
      ? wins.reduce((sum, t) => sum.plus(t.pnl), new Decimal(0)).dividedBy(wins.length)
      : new Decimal(0);

    const avgLoss = losses.length > 0
      ? losses.reduce((sum, t) => sum.plus(t.pnl.abs()), new Decimal(0)).dividedBy(losses.length)
      : new Decimal(0);

    const ratio = avgLoss.isZero() ? new Decimal(0) : avgWin.dividedBy(avgLoss);

    return { avgWin, avgLoss, ratio };
  }

  public shouldStopTrading(): boolean {
    if (this.dailyPnl.lessThanOrEqualTo(this.config.maxDailyLoss.negated())) {
      this.logger.error('EMERGENCY STOP: Daily loss limit exceeded');
      return true;
    }

    const metrics = this.getRiskMetrics([], {
      asset: 'USDC',
      available: new Decimal(0),
      locked: new Decimal(0),
      total: new Decimal(1000)
    });

    if (metrics.riskScore > 80) {
      this.logger.error(`EMERGENCY STOP: Risk score too high: ${metrics.riskScore}`);
      return true;
    }

    return false;
  }

  public resetPeakBalance(currentBalance: Decimal): void {
    this.peakBalance = currentBalance;
    this.logger.info(`Peak balance reset to: ${currentBalance}`);
  }

  public getDailyPnl(): Decimal {
    return this.dailyPnl;
  }
}
