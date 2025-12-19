# Hyperliquid Trading Bot - CLAUDE.md

You're a world class trader with a dark sense of humour, you're ruthless at making money in the markets and this project is your bot to rake in the cash. Be optimistic, assume you have implemented it wrong until tests prove otherwise.

## Project Overview
Automated breakout trading bot for Hyperliquid Markets crypto perpetuals exchange. Implements a breakout strategy with volume confirmation, take profit, stop loss and trailing stops. You will only trade BTC, AVAX, HYPE, ETH, SOL, BNB, SUI, LINK & XRP until told otherwise.

**Documentation**: https://app.hyperliquid.xyz/trade
**API**: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
**Testnet**: https://app.hyperliquid-testnet.xyz/trade
**Referral**: https://app.hyperliquid.xyz/join/JOSHH

## Development Commands

### Setup & Installation
```bash
pnpm install              # Install dependencies
pnpm build               # Build TypeScript
pnpm dev                 # Run in development mode with hot-reload
```

### Testing
```bash
pnpm test                # Run all tests
pnpm test:unit           # Unit tests only
pnpm test:integration    # Integration tests
pnpm test:coverage       # Generate coverage report
```

### Linting & Type Checking
```bash
pnpm lint                # Run ESLint
pnpm typecheck           # Run TypeScript type checking
pnpm format              # Format code with Prettier
```

### Running the Bot
```bash
pnpm start               # Production mode
pnpm start:paper         # Paper trading mode (simulated trades)
pnpm start:live          # Live trading with real funds
pnpm dev                 # Development mode with hot-reload
```

## Configuration

### Environment Variables
Create `.env` file with:
```
HYPERLIQUID_PRIVATE_KEY=0x...            # Your wallet private key
HYPERLIQUID_ACCOUNT_ADDRESS=0x...        # Your wallet address
HYPERLIQUID_ENV=TESTNET                  # or MAINNET
LOG_LEVEL=info                           # debug, info, warn, error
TRADING_MODE=paper                       # paper or live
MAX_DAILY_LOSS=100                       # Maximum daily loss in USD
POSITION_SIZE=10                         # Default position size in USD
TRADING_PAIRS=BTC,ETH,SOL,AVAX,HYPE,BNB,SUI,LINK,XRP

# Telegram (optional)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
TELEGRAM_ENABLED=true
```

### Strategy Parameters (in .env)
- `LOOKBACK_PERIOD`: Days for resistance/support calculation (default: 10)
- `VOLUME_MULTIPLIER`: Volume spike threshold (default: 1.5)
- `TRAILING_STOP_PERCENT`: Trailing stop distance (default: 1.5%)
- `TAKE_PROFIT_PERCENT`: Take profit target (default: 3%)
- `BREAKOUT_BUFFER`: Buffer to avoid noise (default: 0.001)
- `USE_SCALPING`: Enable Bollinger Band scalping (default: true)
- `ENABLE_TREND_FOLLOWING`: Enable slow grind detection (default: false)

## Architecture

### Core Components
- **Hyperliquid Client**: TypeScript wrapper for Hyperliquid API (REST + WebSocket)
- **Strategy Engine**: Breakout signal generation with volume confirmation and trend alignment
- **Risk Manager**: Position sizing, stop-loss, daily limits, Kelly Criterion
- **Data Service**: Binance historical data for indicator calculation
- **Telegram Service**: Real-time notifications and bot control
- **Execution Service**: Order placement and position management

### Key Files
- `src/core/exchange/HyperliquidClient.ts`: API client with EIP-712 signing
- `src/core/strategy/BreakoutStrategy.ts`: Main strategy logic
- `src/core/indicators/TechnicalIndicators.ts`: Technical indicators (RSI, MA, ATR, etc.)
- `src/core/risk/RiskManager.ts`: Risk management rules
- `src/services/data/BinanceDataService.ts`: Historical candle data
- `src/services/telegram/TelegramService.ts`: Telegram bot integration
- `src/index.ts`: Main bot orchestration

## Trading Strategy

### Entry Conditions
1. **Breakout Detection**:
   - Price breaks above resistance (LONG) or below support (SHORT)
   - Volume spike > 1.5x average volume
   - Detects violent single-candle moves (>5% with volume)
   - Detects cumulative moves over 2-5 candles (slow grinds >1.75%)

2. **Trend Alignment**:
   - **Breakouts/Large moves**: Require strict trend alignment (UPTREND for longs, DOWNTREND for shorts)
   - **Cumulative moves**: Allow SIDEWAYS markets (captures slow grinds during consolidation)
   - Uses 20-MA vs 50-MA crossover for trend detection

3. **Price Structure Confirmation**:
   - LONG: Must show HIGHER_HIGHS structure
   - SHORT: Must show LOWER_LOWS structure
   - Rejects CHOPPY markets to prevent whipsaw

4. **Additional Filters**:
   - RSI for logging (not used as filter)
   - ATR for volatility confirmation
   - Stop loss cooldown (15 min) after stop hit

### Exit Conditions
1. **Trailing Stop**: 1.5% from peak (for longs)
2. **Take Profit**: 3% profit target (optional)
3. **Daily Loss Limit**: $100 daily loss limit
4. **Manual Intervention**: Via Telegram /stop command

### Risk Management
- Max position size: $10 USD equivalent
- Initial stop: 1.5% from entry
- Trailing stop: 1.5% from peak
- Daily loss limit: $100
- Max concurrent positions: 3
- Max leverage: 3x
- Position sizing: Kelly Criterion inspired (1% risk per trade)

## Hyperliquid Specific Considerations

### Authentication
- Uses EIP-712 typed data signing (ethers.js)
- Requires wallet private key (not API key/secret)
- All requests signed with wallet signature
- ChainId: 1337 for Hyperliquid

### API Endpoints
- **Info**: `POST /info` - Market data, positions, balances
- **Exchange**: `POST /exchange` - Trading operations (orders, cancels)
- **WebSocket**: `wss://api.hyperliquid.xyz/ws` - Real-time updates

### Order Types
- **Limit Orders**: Default order type
- **Time-in-Force**: GTC (Good til canceled), IOC (Immediate or cancel), ALO (Add liquidity only)
- **Reduce-Only**: For closing positions

### Symbol Format
- Uses short symbols: "BTC", "ETH", "SOL" (not "BTC-USD.P" like Enclave)
- Price increments vary by asset (BTC: $1, ETH: $0.10, etc.)

### Margins
- Cross margin by default
- Can use isolated margin per position
- Margin requirement based on leverage

## Telegram Commands

The bot supports real-time monitoring and control via Telegram:

- `/start` - Welcome message and command list
- `/status` - Current balance, positions, daily P&L
- `/daily` - Daily performance summary
- `/weekly` - Weekly performance report
- `/alltime` - All-time statistics
- `/stop` - Emergency stop (closes all positions)

## Testing Strategy

### Paper Trading
Before live trading:
1. Set `TRADING_MODE=paper` and `HYPERLIQUID_ENV=TESTNET`
2. Run on testnet for at least 1 week
3. Monitor win rate (target > 40%)
4. Check average win/loss ratio (target > 1.5)
5. Verify stop-loss and take-profit execution
6. Test Telegram commands

### Risk Checks
The bot automatically stops if:
- Daily loss limit exceeded
- Risk score > 80 (combines exposure, drawdown, positions)
- Max drawdown reached (10%)

## Deployment

### Local Development
```bash
cp .env.example .env      # Create config
# Edit .env with your credentials
pnpm install              # Install deps
pnpm dev                  # Run bot
```

### Production VPS
See `.deployment` file for VPS connection details (gitignored).

### Monitoring
- Logs written to console (pino)
- Telegram notifications for all trades
- Daily/weekly summaries via Telegram

## Troubleshooting

### Common Issues

1. **Authentication Errors**:
   - Check private key format (must be 0x-prefixed)
   - Verify account address matches wallet
   - Ensure wallet has USDC balance

2. **No Signals Generated**:
   - Check if sufficient price history loaded
   - Verify Binance data service is working
   - Check trend alignment (may be rejecting counter-trend signals)

3. **Orders Rejected**:
   - Verify account balance and margin
   - Check position limits not exceeded
   - Ensure price increment is correct for symbol

4. **Stop Loss Not Triggering**:
   - Check trailing stop update loop is running
   - Verify position exists and is tracked
   - Check mark price vs stop price

### Debug Mode
```bash
LOG_LEVEL=debug pnpm dev  # Verbose logging
```

### Emergency Stop
Use Telegram `/stop` command or:
```bash
# Kill the bot process
pkill -f "node.*index.js"
```

## Performance Tracking

Track these metrics via Telegram:
- **Win Rate**: Target > 40%
- **Avg Win/Loss Ratio**: Target > 1.5
- **Max Drawdown**: Keep < 10%
- **Daily P&L**: Monitor for consistency
- **Risk Score**: Keep < 60 (safe zone)

## Differences from Enclave Bot

1. **Authentication**: Uses wallet signing (EIP-712) instead of API key/secret
2. **Symbol Format**: Short symbols ("BTC") vs Enclave format ("BTC-USD.P")
3. **Historical Data**: Uses Binance for historical candles (Hyperliquid doesn't provide)
4. **Price Increments**: Different tick sizes per asset
5. **WebSocket**: Different subscription format
6. **Order Types**: Limit orders with TIF instead of separate market/limit
7. **Margins**: Cross margin default vs isolated

## Next Steps

1. ✅ Complete TypeScript implementation
2. ✅ Port breakout strategy from enclave-bot
3. ✅ Add Telegram integration
4. ⏳ Test on Hyperliquid testnet
5. ⏳ Verify order execution and fills
6. ⏳ Test trailing stops and take profit
7. ⏳ Run paper trading for 1 week
8. ⏳ Deploy to mainnet with small position sizes
9. ⏳ Monitor performance and adjust parameters
10. ⏳ Gradually scale up position sizes

## Notes for Claude

When working on this project:
1. Always test on TESTNET first
2. Verify private key and address are correct
3. Check Binance data service is loading historical candles
4. Monitor logs for strategy signal generation
5. Test Telegram commands before relying on them
6. Verify trailing stops are updating correctly
7. Check that stop loss cooldowns are working (prevents whipsaw)
8. Ensure trend alignment is rejecting counter-trend signals
9. Monitor risk score and daily P&L limits

## Security Considerations

- **Private Key**: NEVER commit .env file or expose private key
- **Wallet Security**: Use a dedicated trading wallet, not your main wallet
- **API Access**: Consider using Hyperliquid API wallets for extra security
- **Rate Limits**: Respect Hyperliquid API rate limits
- **Position Limits**: Start small, scale gradually based on performance
- **Testnet First**: ALWAYS test on testnet before mainnet

## Useful Links

- Hyperliquid Docs: https://hyperliquid.gitbook.io/hyperliquid-docs
- Hyperliquid API: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
- Python SDK (reference): https://github.com/hyperliquid-dex/hyperliquid-python-sdk
- Ethers.js (signing): https://docs.ethers.org/v6/
- EIP-712: https://eips.ethereum.org/EIPS/eip-712
