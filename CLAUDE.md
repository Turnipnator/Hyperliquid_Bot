> **Common Patterns**: See `~/trading-bot-skill.md` for deployment, Docker, Telegram, and strategy patterns shared across all trading bots.

---

# Hyperliquid Trading Bot - Claude Code Instructions

## CRITICAL RULES

1. **DO NOT modify the core strategy** without explicit request - The breakout strategy with volume confirmation is working. Don't change unless asked.

2. **NEVER rebuild with --no-cache** - This broke the EIP-712 signing in the past by pulling incompatible dependencies. Always use normal `docker compose build`.

3. **Always backup before significant changes** - Create a backup before modifying core logic.

4. **Test after changes** - Always verify the container is healthy after deployment.

5. **API wallet expires 2027-03-12 16:16 UTC — renew by 2027-03-05** - Agent `0xdc6841…` ("13_Sep",
   authorised 2026-09-13, 180-day validity). When it lapses EVERY order is rejected while the container
   still reads healthy. Procedure below. Any healthcheck within 30 days of expiry must say so unprompted.

---

## Recurring Maintenance: API Wallet Renewal

**Next due: 2027-03-05. Hard expiry: 2027-03-12 16:16 UTC.**

Hyperliquid agent/API wallets expire (180 days max as of Sep 2026). Renewal needs the master wallet
signature, so it is a **user action** — Claude can only verify the result.

1. app.hyperliquid.xyz → API → Generate a new API wallet → name it → click **Authorize** AND sign the
   wallet popup. Generating alone does nothing on-chain (this step was skipped three times in June 2026).
2. Put the new **private key** (not the address) in `HYPERLIQUID_PRIVATE_KEY` in the VPS `.env`.
   `HYPERLIQUID_ACCOUNT_ADDRESS` stays the master account. Never paste the key into chat.
3. `docker compose down && docker compose up -d` (a plain restart does not reload `.env`).
4. Verify, read-only: the new address appears with a future `validUntil` in
   ```bash
   curl -s -X POST https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' -d '{"type":"extraAgents","user":"0xd6b199946b3e34f239f606da0a8024b8ecd390f5"}'
   ```
   and the `.env` key derives to it. Then update this section, `CLAUDE.local.md`, and the memory index.

| Agent | Authorised | Expires |
|-------|------------|---------|
| `0xa09c4c35e9236decb4c06245cdbdb526578776b3` "new" | 2026-06-19 | 2026-09-17 (superseded) |
| `0xdc6841a299e6b12e804a3ef2fde03a44445d7ebb` "13_Sep" | 2026-09-13 | **2027-03-12 16:16 UTC** |

---

## Project Overview

Automated breakout trading bot for Hyperliquid perpetuals exchange. Uses wallet signing (EIP-712) for authentication and Binance for historical candle data.

### Current Configuration
- **Position Size**: $50 per trade
- **Max Positions**: 6 concurrent
- **Volume Multiplier**: 1.5x average
- **Initial Stop**: 3% hard from entry
- **Trailing Stop**: 5%
- **Max Daily Loss**: $30 (NOT enforced in code — `updatePnl()` is never called)
- **Trading Pairs**: BTC, ETH, SOL, AVAX, BNB, SUI, LINK, XRP, TRX, ADA, HYPE, ZEC (12 pairs — TON removed 2026-09-13, delisted on Hyperliquid)

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
- **Initial Stop**: hard 3% from entry (`INITIAL_STOP_PERCENT`, 2026-09-02). The 5% trail from the
  peak only ratchets the stop tighter, never looser, so no trade sits more than 3% under entry.
- **Trailing Stop**: 5% from peak pre-TP; 4% for the runner post-TP
- **Exit execution**: IOC reduce-only limit 0.5% through the mark (fills as taker or not at all,
  never rests). An unfilled close is retried every 10 s; a position still open 2 min after a
  reported close has its resting orders cancelled and its stop checks re-armed.
- **Take Profit**: 1.3% PARTIAL scale-out (2% for meme coins) - banks 50% of the
  position, remaining 50% "runner" rides a 4% trail (`RUNNER_TRAILING_STOP_PERCENT`)
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
TRADING_PAIRS=BTC,ETH,SOL,AVAX,BNB,SUI,LINK,XRP,TRX,ADA,HYPE,ZEC
POSITION_SIZE=50              # USD per position
MAX_POSITIONS=6
MAX_DAILY_LOSS=30
MAX_LEVERAGE=3

# Strategy
LOOKBACK_PERIOD=40
VOLUME_MULTIPLIER=1.5         # Require 1.5x volume
VOL_MIN3_THRESHOLD=0.5        # sustained volume: min of last 3 candles must be >= 0.5x
TRAILING_STOP_PERCENT=5       # trail from peak (ratchets up only)
INITIAL_STOP_PERCENT=3        # hard stop from entry; trail takes over once it is tighter
EXIT_SLIPPAGE_PERCENT=0.5     # IOC exit limit cushion through the mark (default 0.5)
TAKE_PROFIT_PERCENT=1.3       # partial scale-out trigger
PARTIAL_TP_ENABLED=true       # bank 50% at TP, let the rest run
PARTIAL_TP_FRACTION=0.5
RUNNER_TRAILING_STOP_PERCENT=4  # tighter trail for the post-TP runner
MIN_MOMENTUM_SCORE=0.70
LONG_ONLY=false               # shorting enabled
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
- Prices: max **5 significant figures** and at most (6 − szDecimals) decimals; integers always valid.
  `HyperliquidClient.roundPrice()` derives this from `meta` — never hardcode per-symbol increments
  (that broke every ZEC order once ZEC crossed $1,000 in Sep 2026)
- Delisted perps stay in `meta` with `isDelisted: true` (TON since mid-2026); startup skips them
  with a warning via `getUntradeableReason()`

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
POSITION_SIZE=50  # USD amount per position
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
