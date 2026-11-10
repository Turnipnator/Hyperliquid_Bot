import { ClosedTrade } from './StreakPause';

/**
 * Daily Telegram digest of shadow trades: what the signals the bot did not
 * trade would have made. Pure formatting, no I/O.
 */

export interface ShadowBookSummary {
  title: string;
  closed: ClosedTrade[];
  openSymbols: string[];
  splitTags?: { tag: string; label: string }[]; // extra all-tracked lines for trades carrying each tag
}

export interface ShadowDigestInput {
  now: number;
  positionSizeUsd: number;
  streakPauseEnabled: boolean;
  streakPaused: boolean;
  lookback: number;
  recentSumPct: number;
  books: ShadowBookSummary[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function signed(value: number, digits: number): string {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(digits)}`;
}

function windowLine(label: string, trades: ClosedTrade[], positionSizeUsd: number): string {
  if (trades.length === 0) {
    return `  ${label}: none closed`;
  }
  const wins = trades.filter((t) => t.returnFraction > 0).length;
  const sum = trades.reduce((total, t) => total + t.returnFraction, 0);
  const usd = sum * positionSizeUsd;
  return `  ${label}: ${trades.length} closed, ${wins} W / ${trades.length - wins} L, ` +
    `${signed(sum * 100, 2)}% (${usd >= 0 ? '+' : '-'}$${Math.abs(usd).toFixed(2)} at $${positionSizeUsd}/trade)`;
}

export function formatShadowDigest(input: ShadowDigestInput): string {
  const lines: string[] = ['👻 Shadow trade digest'];
  if (input.streakPauseEnabled) {
    lines.push(
      input.streakPaused
        ? `Live bot: PAUSED - last ${input.lookback} trades sum to ${signed(input.recentSumPct, 2)}% (resumes above 0)`
        : `Live bot: TRADING - last ${input.lookback} trades sum to ${signed(input.recentSumPct, 2)}%`
    );
  }
  for (const book of input.books) {
    const since = (ms: number) => book.closed.filter((t) => t.closedAt >= input.now - ms);
    lines.push('');
    lines.push(book.title);
    lines.push(windowLine('last 24h', since(DAY_MS), input.positionSizeUsd));
    lines.push(windowLine('last 7d', since(7 * DAY_MS), input.positionSizeUsd));
    lines.push(windowLine('all tracked', book.closed, input.positionSizeUsd));
    for (const { tag, label } of book.splitTags ?? []) {
      lines.push(windowLine(label, book.closed.filter((t) => t.tag === tag), input.positionSizeUsd));
    }
    lines.push(`  open now: ${book.openSymbols.length > 0 ? book.openSymbols.join(', ') : 'none'}`);
  }
  return lines.join('\n');
}
