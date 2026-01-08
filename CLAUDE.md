# Hyperliquid Trading Bot - Claude Code Instructions

## CRITICAL RULES

1. **DO NOT modify the core strategy** without explicit request - The breakout strategy with volume confirmation is working. Don't change unless asked.

2. **NEVER rebuild with --no-cache** - This broke the EIP-712 signing in the past by pulling incompatible dependencies. Always use normal `docker compose build`.

3. **Always backup before significant changes** - Create a backup before modifying core logic.

4. **Test after changes** - Always verify the container is healthy after deployment.

---

## Project Overview

Automated breakout trading bot for Hyperliquid perpetuals exchange. Uses wallet signing (EIP-712) for authentication and Binance for historical candle data.

### Current Configuration
- **Position Size**: $75 per trade
- **Max Positions**: 6 concurrent
- **Volume Multiplier**: 1.5x average
- **Trailing Stop**: 5%
- **Max Daily Loss**: $30
- **Trading Pairs**: BTC, ETH, SOL, AVAX, HYPE, BNB, SUI, LINK, XRP

---

## Project Structure

```
hyperliquid-bot/
├── src/
│   ├── index.ts                    # Main entry point
│   ├── core/
│   │   ├── exchange/
│   │   │   └── HyperliquidClient.ts  # API client with EIP-712 signing
│   │   ├── strategy/
│   │   │   └── BreakoutStrategy.ts   # Main strategy logic
│   │   ├── indicators/               # Technical indicators
│   │   └── risk/                     # Risk management
│   ├── services/
│   │   ├── data/
│   │   │   └── BinanceDataService.ts # Historical candle data
│   │   └── telegram/                 # Telegram notifications
│   ├── config/                       # Configuration
│   └── utils/                        # Utilities
├── logs/                             # Log files (mounted volume)
├── docker-compose.yml                # Container configuration
├── Dockerfile                        # Build instructions
├── .env                              # Secrets and config (not in git)
├── package.json                      # Dependencies
└── tsconfig.json                     # TypeScript config
```

---

## Trading Strategy

### Entry Conditions
1. **Breakout Detection**:
   - Price breaks above resistance (LONG) or below support (SHORT)
   - Volume spike > 1.5x average volume
   - Detects violent single-candle moves (>5% with volume)
   - Detects cumulative moves over 2-5 candles (slow grinds >1.75%)

2. **Trend Alignment**:
   - Uses 20-MA vs 50-MA crossover for trend detection
   - Price structure confirmation (HIGHER_HIGHS for longs, LOWER_LOWS for shorts)
   - Rejects CHOPPY markets to prevent whipsaw

3. **Stop Loss Cooldown**: 15 minutes after stop hit to prevent revenge trading

### Exit Conditions
- **Trailing Stop**: 5% from peak
- **Take Profit**: Disabled (let trailing stop control exits)
- **Daily Loss Limit**: $30

---

## Configuration

### Environment Variables (.env)
```bash
# Hyperliquid Authentication (wallet signing)
HYPERLIQUID_PRIVATE_KEY=0x...
HYPERLIQUID_ACCOUNT_ADDRESS=0x...
HYPERLIQUID_ENV=MAINNET

# Trading
TRADING_MODE=live
TRADING_PAIRS=BTC,ETH,SOL,AVAX,HYPE,BNB,SUI,LINK,XRP
POSITION_SIZE=75              # USD per position
MAX_POSITIONS=6
MAX_DAILY_LOSS=30
MAX_LEVERAGE=3

# Strategy
LOOKBACK_PERIOD=20
VOLUME_MULTIPLIER=1.5         # Require 1.5x volume
TRAILING_STOP_PERCENT=5
USE_SCALPING=true
BREAKOUT_BUFFER=0.001

# Telegram
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_CHAT_ID=xxx
TELEGRAM_ENABLED=true

# Data Source
BINANCE_BASE_URL=https://api.binance.com

# Logging
LOG_LEVEL=info
```

---

## VPS Deployment

See `CLAUDE.local.md` for VPS connection details and deployment commands.
This file is gitignored and contains sensitive server information.

---

## Development Commands

### Local Development
```bash
pnpm install              # Install dependencies
pnpm build               # Build TypeScript
pnpm dev                 # Run with hot-reload
```

### Testing
```bash
pnpm test                # Run all tests
pnpm test:unit           # Unit tests only
pnpm typecheck           # TypeScript type checking
```

---

## Telegram Commands

- `/start` - Welcome message and command list
- `/status` - Current balance, positions, daily P&L
- `/daily` - Daily performance summary
- `/weekly` - Weekly performance report
- `/alltime` - All-time statistics
- `/stop` - Emergency stop (closes all positions)

---

## Docker Configuration

### Logging (prevents disk fill)
```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

### Health Check
HTTP health check on port 3000 every 30 seconds.

### Data Persistence
- `./logs` mounted to `/app/logs`

---

## Hyperliquid Exchange Specifics

### Authentication
- Uses EIP-712 typed data signing (ethers.js)
- Requires wallet private key (NOT API key/secret)
- ChainId: 1337 for Hyperliquid

### API Endpoints
- **Info**: `POST /info` - Market data, positions, balances
- **Exchange**: `POST /exchange` - Trading operations
- **WebSocket**: `wss://api.hyperliquid.xyz/ws`

### Symbol Format
- Short symbols: "BTC", "ETH", "SOL" (NOT "BTC-USD.P")
- Price increments vary by asset

### Historical Data
- Hyperliquid doesn't provide historical candles
- Uses Binance API for historical data
- Real-time data from Hyperliquid WebSocket

### Documentation
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api

---

## Common Tasks

### Check why no trades are happening
```bash
docker logs hyperliquid-trading-bot 2>&1 | grep -i 'signal\|breakout\|rejected' | tail -20
```

### Adjust position sizing
Edit `.env`:
```bash
POSITION_SIZE=75  # USD amount per position
```

### Check open positions
```bash
docker logs hyperliquid-trading-bot 2>&1 | grep -i 'position\|opened\|closed' | tail -20
```

---

## Troubleshooting

### API Signing Errors
**NEVER rebuild with --no-cache** - this pulls new npm dependencies that can break EIP-712 signing. If you get signing errors after a rebuild:
1. Restore the old Docker image from backup
2. Or rebuild without --no-cache

### Container keeps restarting
```bash
docker logs --tail 100 hyperliquid-trading-bot
```

### No signals generating
- Check if Binance data service is loading historical candles
- Verify trend alignment isn't rejecting all signals
- Check volume multiplier isn't too high

### Authentication errors
- Verify private key format (must be 0x-prefixed)
- Check account address matches wallet
- Ensure wallet has USDC balance

---

## Other Bots

For reference, other bots use similar patterns:
- **Binance Bot**: Python, most mature, same momentum approach
- **Enclave Bot**: TypeScript, similar strategy
- **Gold Bot**: Oanda forex

All use: Docker Compose, Telegram notifications.

---

## Key Differences from Other Bots

| Aspect | Binance Bot | Enclave Bot | Hyperliquid Bot |
|--------|-------------|-------------|-----------------|
| Language | Python | TypeScript | TypeScript |
| Exchange | Binance Spot | Enclave Perps | Hyperliquid Perps |
| Auth | API Key | API Key | Wallet Signing |
| Historical Data | Binance | Enclave WS | Binance (external) |
| Symbol Format | BTCUSDT | BTC-USD.P | BTC |

---

## Notes for Claude

When working on this project:
1. **Use pnpm** - Not npm or yarn
2. **NEVER use --no-cache** - Breaks EIP-712 signing
3. **Wallet signing** - Uses ethers.js EIP-712, not API key/secret
4. **Historical data from Binance** - Hyperliquid doesn't provide it
5. **TypeScript strict mode** - Follow existing patterns
6. **Test in paper mode first** - Set `TRADING_MODE=paper`
7. **Check Binance data service** - If no candles, no signals

## Security Reminders

- **Private Key**: NEVER commit .env or expose private key
- **Dedicated Wallet**: Use a trading wallet, not your main wallet
- **Start Small**: Scale up based on performance
