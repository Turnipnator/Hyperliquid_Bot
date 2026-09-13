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
  // Realised P&L for the current UTC day. Owned by setDailyPnl(), which the
  // main loop feeds from exchange fills every minute - never tallied in memory,
  // so it survives restarts and counts manual closes.
  private dailyPnl: Decimal = new Decimal(0);
  private peakBalance: Decimal = new Decimal(0);

  constructor(config: RiskConfig, initialBalance?: Decimal) {
    this.config = config;
    this.logger = pino({ name: 'RiskManager' });
    if (initialBalance) {
      this.peakBalance = initialBalance;
    }
  }

  public canOpenPosition(
    positions: Position[],
    balance: Balance,
    requiredMargin: Decimal
  ): boolean {
    // Check daily loss limit
    if (this.isDailyLossLimitHit()) {
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

  /**
   * Replace today's realised P&L with the figure derived from exchange fills
   * (closedPnl minus fees since 00:00 UTC).
   */
  public setDailyPnl(pnl: Decimal): void {
    this.dailyPnl = pnl;
  }

  /** True while today's realised loss has reached MAX_DAILY_LOSS. */
  public isDailyLossLimitHit(): boolean {
    return this.dailyPnl.lessThanOrEqualTo(this.config.maxDailyLoss.negated());
  }

  public getRiskMetrics(positions: Position[], balance: Balance): RiskMetrics {
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

  public resetPeakBalance(currentBalance: Decimal): void {
    this.peakBalance = currentBalance;
    this.logger.info(`Peak balance reset to: ${currentBalance}`);
  }

  public getDailyPnl(): Decimal {
    return this.dailyPnl;
  }
}
