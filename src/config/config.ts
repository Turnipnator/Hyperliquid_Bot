import { config as dotenvConfig } from 'dotenv';
import Decimal from 'decimal.js';
import { Environment } from '../core/exchange/types';

dotenvConfig();

export interface Config {
  // API Configuration
  privateKey: string;
  accountAddress: string;
  environment: Environment;

  // Trading Mode
  tradingMode: 'paper' | 'live';

  // Markets
  tradingPairs: string[];

  // Risk Management
  maxDailyLoss: Decimal;
  maxPositions: number;
  positionSize: Decimal;
  maxLeverage: number;
  maxDrawdown: Decimal;

  // Breakout Strategy
  lookbackPeriod: number;
  volumeMultiplier: number;
  trailingStopPercent: number;
  useScalping: boolean;
  breakoutBuffer: number;
  takeProfitPercent?: number;

  // Trend Following Strategy
  enableTrendFollowing: boolean;
  trendFollowingSmaPeriod: number;
  trendFollowingMinConsecutiveTrends: number;
  trendFollowingMaxDistanceFromHigh: number;

  // Telegram
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramEnabled: boolean;

  // Logging
  logLevel: string;

  // Data Source
  binanceBaseUrl: string;
}

function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (!value && !defaultValue) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || defaultValue || '';
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseFloat(value) : defaultValue;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

function getEnvDecimal(key: string, defaultValue: string): Decimal {
  const value = process.env[key] || defaultValue;
  return new Decimal(value);
}

function validateConfig(config: Config): void {
  // Validate private key format (0x prefixed hex)
  if (!config.privateKey.match(/^0x[0-9a-fA-F]{64}$/)) {
    throw new Error('HYPERLIQUID_PRIVATE_KEY must be a valid 0x-prefixed private key');
  }

  // Validate account address format
  if (!config.accountAddress.match(/^0x[0-9a-fA-F]{40}$/)) {
    throw new Error('HYPERLIQUID_ACCOUNT_ADDRESS must be a valid 0x-prefixed address');
  }

  // Validate numeric values are positive
  if (config.maxDailyLoss.lessThanOrEqualTo(0)) {
    throw new Error('MAX_DAILY_LOSS must be positive');
  }
  if (config.maxPositions <= 0) {
    throw new Error('MAX_POSITIONS must be positive');
  }
  if (config.positionSize.lessThanOrEqualTo(0)) {
    throw new Error('POSITION_SIZE must be positive');
  }
  if (config.maxLeverage <= 0) {
    throw new Error('MAX_LEVERAGE must be positive');
  }
  if (config.maxDrawdown.lessThanOrEqualTo(0) || config.maxDrawdown.greaterThan(100)) {
    throw new Error('MAX_DRAWDOWN must be between 0 and 100');
  }

  // Validate strategy parameters
  if (config.lookbackPeriod < 2) {
    throw new Error('LOOKBACK_PERIOD must be at least 2');
  }
  if (config.volumeMultiplier <= 0) {
    throw new Error('VOLUME_MULTIPLIER must be positive');
  }
  if (config.trailingStopPercent <= 0 || config.trailingStopPercent >= 100) {
    throw new Error('TRAILING_STOP_PERCENT must be between 0 and 100');
  }
  if (
    config.takeProfitPercent &&
    (config.takeProfitPercent <= 0 || config.takeProfitPercent >= 1000)
  ) {
    throw new Error('TAKE_PROFIT_PERCENT must be between 0 and 1000');
  }

  // Validate trading mode
  if (config.tradingMode !== 'paper' && config.tradingMode !== 'live') {
    throw new Error('TRADING_MODE must be "paper" or "live"');
  }

  // Validate trading pairs
  if (config.tradingPairs.length === 0) {
    throw new Error('TRADING_PAIRS must contain at least one pair');
  }
}

export function loadConfig(): Config {
  const config = {
    // API Configuration
    privateKey: getEnvVar('HYPERLIQUID_PRIVATE_KEY'),
    accountAddress: getEnvVar('HYPERLIQUID_ACCOUNT_ADDRESS').toLowerCase(),
    environment: getEnvVar('HYPERLIQUID_ENV', 'TESTNET') as Environment,

    // Trading Mode
    tradingMode: getEnvVar('TRADING_MODE', 'paper') as 'paper' | 'live',

    // Markets - note: Hyperliquid uses different symbol format
    tradingPairs: getEnvVar('TRADING_PAIRS', 'BTC,ETH,SOL,AVAX,HYPE,BNB,SUI,LINK,XRP')
      .split(',')
      .map((s) => s.trim()),

    // Risk Management
    maxDailyLoss: getEnvDecimal('MAX_DAILY_LOSS', '100'),
    maxPositions: getEnvNumber('MAX_POSITIONS', 3),
    positionSize: getEnvDecimal('POSITION_SIZE', '10'),
    maxLeverage: getEnvNumber('MAX_LEVERAGE', 3),
    maxDrawdown: getEnvDecimal('MAX_DRAWDOWN', '10'),

    // Breakout Strategy
    lookbackPeriod: getEnvNumber('LOOKBACK_PERIOD', 10),
    volumeMultiplier: getEnvNumber('VOLUME_MULTIPLIER', 1.5),
    trailingStopPercent: getEnvNumber('TRAILING_STOP_PERCENT', 1.5),
    useScalping: getEnvBoolean('USE_SCALPING', true),
    breakoutBuffer: getEnvNumber('BREAKOUT_BUFFER', 0.001),
    takeProfitPercent: process.env.TAKE_PROFIT_PERCENT
      ? getEnvNumber('TAKE_PROFIT_PERCENT', 3)
      : undefined,

    // Trend Following Strategy
    enableTrendFollowing: getEnvBoolean('ENABLE_TREND_FOLLOWING', false),
    trendFollowingSmaPeriod: getEnvNumber('TREND_FOLLOWING_SMA_PERIOD', 20),
    trendFollowingMinConsecutiveTrends: getEnvNumber(
      'TREND_FOLLOWING_MIN_CONSECUTIVE_TRENDS',
      3
    ),
    trendFollowingMaxDistanceFromHigh: getEnvNumber(
      'TREND_FOLLOWING_MAX_DISTANCE_FROM_HIGH',
      2
    ),

    // Telegram
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    telegramEnabled: getEnvBoolean('TELEGRAM_ENABLED', false),

    // Logging
    logLevel: getEnvVar('LOG_LEVEL', 'info'),

    // Data Source
    binanceBaseUrl: getEnvVar('BINANCE_BASE_URL', 'https://api.binance.com'),
  };

  // Validate configuration
  validateConfig(config);

  return config;
}

export const config = loadConfig();
