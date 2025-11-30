# Hyperliquid Trading Bot

Automated breakout trading bot for Hyperliquid Markets. Ported from the enclave-bot with identical strategy, position sizing, and risk management.

## Features

- **Breakout Strategy**: Detects price breakouts with volume confirmation
- **Trend Alignment**: Only trades with the trend (UPTREND for longs, DOWNTREND for shorts)
- **Risk Management**: Daily loss limits, position sizing, trailing stops
- **Telegram Integration**: Real-time notifications and bot control
- **Multi-Candle Detection**: Catches violent moves and slow grinds
- **Stop Loss Cooldown**: Prevents whipsaw re-entries (15 min cooldown)

## Quick Start

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Create Configuration

```bash
cp .env.example .env
```

Edit `.env` with your credentials:
- Get your Hyperliquid wallet private key and address
- Set `HYPERLIQUID_ENV=TESTNET` for testing
- Optionally configure Telegram bot

### 3. Run the Bot

```bash
# Development mode (with hot-reload)
pnpm dev

# Production mode
pnpm build
pnpm start

# Paper trading mode
pnpm start:paper
```

## Trading Pairs

BTC, AVAX, HYPE, ETH, SOL, BNB, SUI, LINK, XRP

## Strategy Parameters

- **Lookback Period**: 10 candles
- **Volume Multiplier**: 1.5x average
- **Trailing Stop**: 1.5% from peak
- **Take Profit**: 3% (optional)
- **Position Size**: $10 USD per trade
- **Max Daily Loss**: $100
- **Max Positions**: 3 concurrent

## Telegram Commands

- `/status` - View current positions and balance
- `/daily` - Daily P&L summary
- `/stop` - Emergency stop bot

## Important Notes

⚠️ **ALWAYS test on testnet first!**

- Set `HYPERLIQUID_ENV=TESTNET` in `.env`
- Use a dedicated trading wallet, not your main wallet
- Start with small position sizes
- Monitor the bot closely for the first week

## Documentation

See [CLAUDE.md](./CLAUDE.md) for complete documentation.

## Architecture

```
src/
├── config/          # Configuration loader
├── core/
│   ├── exchange/    # Hyperliquid API client
│   ├── indicators/  # Technical indicators
│   ├── risk/        # Risk management
│   └── strategy/    # Breakout strategy
├── services/
│   ├── data/        # Binance historical data
│   └── telegram/    # Telegram notifications
├── utils/           # Helper functions
└── index.ts         # Main bot orchestration
```

## License

MIT
