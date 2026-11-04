import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { HyperliquidFill } from '../exchange/types';
import { PriceData } from '../indicators/TechnicalIndicators';

/**
 * Losing-streak pause (STREAK_PAUSE_TRADES = N).
 *
 * New entries are allowed only while the last N closed trades sum to a profit.
 * While paused, signals are not executed but tracked as "shadow" trades,
 * simulated on closed 5m candles with the bot's own exit rules. Shadow and real
 * trades share one history, so the bot resumes once the signals it skipped
 * start winning again. Real trades come from exchange fills (survive restarts);
 * shadow trades are persisted to a JSON file in the mounted logs volume.
 *
 * Replay on 313 real trades (2026-04-25 → 2026-11-02, see CLAUDE.local.md):
 * the 09-29 → 11-02 losing run cut from −$55 to −$2…−$14 depending on N.
 */

export interface ExitRules {
  initialStopPercent: number;
  trailingStopPercent: number;
  runnerTrailingStopPercent: number;
  takeProfitPercent: number;
  partialFraction: number; // 0 = full close at TP
}

export interface ClosedTrade {
  symbol: string;
  source: 'real' | 'shadow';
  openedAt: number;
  closedAt: number;
  returnFraction: number; // net of fees, as a fraction of entry notional
}

interface ShadowTrade {
  symbol: string;
  isLong: boolean;
  entry: number;
  openedAt: number;
  lastCandleTs: number; // candles at or before this are already processed
  stop: number;
  extreme: number; // peak for longs, trough for shorts
  remaining: number;
  banked: number;
  tpTaken: boolean;
  rules: ExitRules;
}

interface PersistedState {
  open: ShadowTrade[];
  closed: ClosedTrade[];
}

// Taker fee per side assumed for shadow trades (Hyperliquid base tier).
export const SHADOW_FEE_RATE = 0.00045;
const MAX_SHADOW_AGE_MS = 21 * 24 * 60 * 60 * 1000;
const MAX_CLOSED_SHADOWS = 100;

export class StreakPause {
  private readonly logger = pino({ name: 'StreakPause' });
  private realTrades: ClosedTrade[] = [];
  private openShadows: ShadowTrade[] = [];
  private closedShadows: ClosedTrade[] = [];

  constructor(
    private readonly lookback: number,
    private readonly statePath?: string
  ) {
    this.load();
  }

  public isEnabled(): boolean {
    return this.lookback > 0;
  }

  /**
   * Closed trades rebuilt from fills: a trade opens on the first Open fill for a
   * coin and closes on the fill that takes the position back to zero. Closes
   * whose opening fill is outside the window are ignored.
   */
  public static tradesFromFills(fills: HyperliquidFill[]): ClosedTrade[] {
    const sorted = [...fills].sort((a, b) => a.time - b.time);
    const open = new Map<string, { openedAt: number; cost: number; pnl: number }>();
    const trades: ClosedTrade[] = [];
    for (const fill of sorted) {
      const size = Number(fill.sz);
      const fee = Number(fill.fee || 0);
      if (fill.dir === 'Open Long' || fill.dir === 'Open Short') {
        const trade = open.get(fill.coin) ?? { openedAt: fill.time, cost: 0, pnl: 0 };
        trade.cost += size * Number(fill.px);
        trade.pnl -= fee;
        open.set(fill.coin, trade);
      } else if (fill.dir === 'Close Long' || fill.dir === 'Close Short') {
        const trade = open.get(fill.coin);
        if (!trade) continue;
        trade.pnl += Number(fill.closedPnl || 0) - fee;
        const startPosition = Math.abs(Number(fill.startPosition ?? NaN));
        if (Math.abs(startPosition - size) < 1e-9 && trade.cost > 0) {
          trades.push({
            symbol: fill.coin,
            source: 'real',
            openedAt: trade.openedAt,
            closedAt: fill.time,
            returnFraction: trade.pnl / trade.cost,
          });
          open.delete(fill.coin);
        }
      }
    }
    return trades;
  }

  public setRealTrades(trades: ClosedTrade[]): void {
    this.realTrades = trades;
  }

  /** The last N closed trades, real and shadow, by close time. */
  public recentTrades(): ClosedTrade[] {
    return [...this.realTrades, ...this.closedShadows]
      .sort((a, b) => a.closedAt - b.closedAt)
      .slice(-this.lookback);
  }

  public recentSum(): number {
    return this.recentTrades().reduce((sum, t) => sum + t.returnFraction, 0);
  }

  /** Paused when the last N closed trades (and there are at least N) do not sum to a profit. */
  public isPaused(): boolean {
    if (!this.isEnabled()) return false;
    const recent = this.recentTrades();
    return recent.length >= this.lookback && this.recentSum() <= 0;
  }

  public hasOpenShadow(symbol: string): boolean {
    return this.openShadows.some((s) => s.symbol === symbol);
  }

  public openShadowCount(): number {
    return this.openShadows.length;
  }

  public openShadow(
    symbol: string,
    isLong: boolean,
    entry: number,
    candleTs: number,
    rules: ExitRules,
    now: number = Date.now()
  ): void {
    if (this.hasOpenShadow(symbol)) return;
    const stopDistance = rules.initialStopPercent / 100;
    this.openShadows.push({
      symbol,
      isLong,
      entry,
      openedAt: now,
      lastCandleTs: candleTs,
      stop: isLong ? entry * (1 - stopDistance) : entry * (1 + stopDistance),
      extreme: entry,
      remaining: 1,
      banked: 0,
      tpTaken: false,
      rules,
    });
    this.save();
  }

  /**
   * Walk each open shadow through the closed candles it has not seen yet.
   * Per candle: stop check first (conservative), then the new extreme, the
   * partial TP, and a one-way trail ratchet - the same order the 10-s stop loop
   * meets them in practice. Returns the shadows that closed.
   */
  public advanceShadows(
    historyFor: (symbol: string) => PriceData[] | undefined,
    now: number = Date.now()
  ): ClosedTrade[] {
    const closed: ClosedTrade[] = [];
    for (const shadow of [...this.openShadows]) {
      const candles = (historyFor(shadow.symbol) ?? []).filter(
        (c) => c.timestamp.getTime() > shadow.lastCandleTs
      );
      let exitPrice: number | null = null;
      let closedAt = now;
      for (const candle of candles) {
        const high = candle.high.toNumber();
        const low = candle.low.toNumber();
        const ts = candle.timestamp.getTime();
        shadow.lastCandleTs = ts;
        if (shadow.isLong ? low <= shadow.stop : high >= shadow.stop) {
          exitPrice = shadow.stop;
          closedAt = ts;
          break;
        }
        this.stepShadow(shadow, high, low);
      }
      if (exitPrice === null && now - shadow.openedAt > MAX_SHADOW_AGE_MS && candles.length > 0) {
        exitPrice = candles[candles.length - 1].close.toNumber();
      }
      if (exitPrice !== null) {
        const move = shadow.isLong ? exitPrice / shadow.entry - 1 : 1 - exitPrice / shadow.entry;
        const trade: ClosedTrade = {
          symbol: shadow.symbol,
          source: 'shadow',
          openedAt: shadow.openedAt,
          closedAt,
          returnFraction: shadow.banked + shadow.remaining * move - 2 * SHADOW_FEE_RATE,
        };
        this.openShadows = this.openShadows.filter((s) => s !== shadow);
        this.closedShadows.push(trade);
        closed.push(trade);
      }
    }
    if (this.closedShadows.length > MAX_CLOSED_SHADOWS) {
      this.closedShadows.splice(0, this.closedShadows.length - MAX_CLOSED_SHADOWS);
    }
    this.save();
    return closed;
  }

  private stepShadow(shadow: ShadowTrade, high: number, low: number): void {
    const { rules } = shadow;
    shadow.extreme = shadow.isLong ? Math.max(shadow.extreme, high) : Math.min(shadow.extreme, low);
    const tp = rules.takeProfitPercent / 100;
    const tpHit = shadow.isLong ? high >= shadow.entry * (1 + tp) : low <= shadow.entry * (1 - tp);
    if (tp > 0 && !shadow.tpTaken && tpHit) {
      const fraction = rules.partialFraction > 0 ? rules.partialFraction : 1;
      shadow.banked += fraction * tp;
      shadow.remaining -= fraction;
      shadow.tpTaken = true;
      if (shadow.remaining <= 1e-9) {
        // Full close at TP: park the stop at the TP so the next candle exits flat.
        shadow.remaining = 0;
      }
    }
    const trail = (shadow.tpTaken ? rules.runnerTrailingStopPercent : rules.trailingStopPercent) / 100;
    shadow.stop = shadow.isLong
      ? Math.max(shadow.stop, shadow.extreme * (1 - trail))
      : Math.min(shadow.stop, shadow.extreme * (1 + trail));
  }

  private load(): void {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    try {
      const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as PersistedState;
      this.openShadows = Array.isArray(state.open) ? state.open : [];
      this.closedShadows = Array.isArray(state.closed) ? state.closed : [];
      this.logger.info(
        { open: this.openShadows.length, closed: this.closedShadows.length },
        'Loaded shadow trades'
      );
    } catch (error) {
      this.logger.warn({ error, path: this.statePath }, 'Could not read shadow trade state - starting empty');
    }
  }

  private save(): void {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const state: PersistedState = { open: this.openShadows, closed: this.closedShadows };
      fs.writeFileSync(this.statePath, JSON.stringify(state));
    } catch (error) {
      this.logger.warn({ error, path: this.statePath }, 'Could not save shadow trade state');
    }
  }
}
