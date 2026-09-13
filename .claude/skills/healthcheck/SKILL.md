---
name: healthcheck
description: Run a comprehensive health check on the Hyperliquid trading bot
---

# Hyperliquid Trading Bot Health Check

Run a comprehensive health check on the hyperliquid-trading-bot. Work through each
section systematically and provide a summary dashboard at the end.

> **Important — how this bot stores state:** This bot keeps **NO data files**
> (`state.json` / `trading_stats.json` / `positions.json` do **not** exist). All
> truth lives in (a) the JSON logs and (b) the Hyperliquid exchange. Never `cat`
> data files — always derive balance, positions, P&L, and signals from the logs.
> Logs are JSON (pino): `level` 30=info, 40=warn, 50=error; `time` is epoch ms.

## VPS Details
- Server: vmi2859456.contaboserver.net
- SSH Key: ~/.ssh/claude_vps_key
- Container: hyperliquid-trading-bot
- Path: /root/HYPE_Bot

Run independent SSH calls in parallel where possible.

## 1. PROCESS STATUS
- Is the container running, healthy, and how long for? Any restarts?

```bash
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker ps --format '{{.Names}}\t{{.Status}}\t{{.RunningFor}}' | grep hyperliquid"
# Restart count + last exit (catches silent crash-loops a 'healthy' status hides):
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker inspect hyperliquid-trading-bot --format 'RestartCount={{.RestartCount}} OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}} StartedAt={{.State.StartedAt}}'"
```

## 2. LOG ANALYSIS
- Recent activity, and **how recent the last error was** (count alone is
  misleading — 50 DNS blips that all happened 2 days ago is fine).

```bash
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker logs hyperliquid-trading-bot --tail 60 2>&1"
# Error summary with recency. EAI_AGAIN = transient DNS, auto-recovers — note it but don't alarm.
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "L=\$(docker logs hyperliquid-trading-bot 2>&1); echo 'error(50) count:'; echo \"\$L\" | grep -c '\"level\":50'; echo 'EAI_AGAIN count:'; echo \"\$L\" | grep -c 'EAI_AGAIN'; echo 'last error time(ms):'; echo \"\$L\" | grep '\"level\":50' | tail -1 | grep -oE '\"time\":[0-9]+' | head -1; echo 'latest log time(ms):'; echo \"\$L\" | tail -1 | grep -oE '\"time\":[0-9]+' | head -1"
```
Convert the two epoch-ms timestamps and report **"last error was N hours ago"**.
If last error ≈ latest log → 🔴 active. If hours/days ago → 🟢 stale/recovered.

## 3. SIGNAL GENERATION
- Confirm the bot is evaluating pairs every cycle and filters are firing.

```bash
# Latest per-pair evaluation + any breakout signals/rejections:
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker logs hyperliquid-trading-bot 2>&1 | grep -iE 'No signal|breakout|signal|REJECTED|momentum' | tail -25"
```
Healthy = fresh per-pair lines (trend/structure/volumeRatio) and breakouts being
**correctly rejected** (low vol_min3, wrong trend) rather than silence.

## 4. PERFORMANCE & POSITIONS (from logs, not files)
- Balance trend, open positions, daily P&L, and recent closed trades.

```bash
# Current balance / positions / dailyPnl (bot prints 'Bot status' each cycle):
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker logs hyperliquid-trading-bot 2>&1 | grep 'Bot status' | tail -1"
# Trade lifecycle events (entries, fills, trailing-stop exits, closes):
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker logs hyperliquid-trading-bot 2>&1 | grep -iE 'opened|filled|Closed position|Trailing stop hit|stop hit|take profit|RESTING' | tail -20"
```
Compare balance against the last figure in `CLAUDE.local.md` to get the P&L trend.
**`dailyPnl` in 'Bot status' is synced every minute from exchange fills** (closedPnl − fees since
00:00 UTC) as of 2026-09-13, and `MAX_DAILY_LOSS` pauses new entries when hit — grep for
`Daily loss limit hit`, `Daily loss limit active`, `new entries resumed`. If it reads 0.00 on a day
that has closing fills, the sync is failing: grep `Could not sync daily P&L`. Cross-check against
the exchange directly:
```bash
# Realised P&L + fees from exchange fills (read-only; ~2000 most recent fills):
curl -s -X POST https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' -d '{"type":"userFills","user":"0xd6b199946b3e34f239f606da0a8024b8ecd390f5"}' | python3 -c "import sys,json,datetime as dt;f=json.load(sys.stdin);c=dt.datetime.now().timestamp()*1000-7*86400000;r=[x for x in f if x['time']>=c];print('fills 7d:',len(r),'closedPnl $%.2f'%sum(float(x['closedPnl']) for x in r),'fees $%.2f'%sum(float(x['fee']) for x in r))"
```
Repeated `RESTING ... Cancelling` for one symbol = limit orders never filling
(price moving away) — flag as churn, not an error.

## 4A. ORDER EXECUTION HEALTH — does signing actually work?
**The #1 silent killer.** The bot can look perfectly "healthy" — running, generating
signals, filtering correctly — while **every single order is rejected**. This happens
when the Hyperliquid API/agent wallet's approval lapses (they expire). Symptom:
`"User or API Wallet 0x… does not exist."` on every entry AND exit. Caught us
2026-06-19: an ETH long's trailing stop fired 7,900+ times over ~22h, every close
rejected, position left unprotected — yet `docker ps` said "healthy".

```bash
# Order-rejection count + age of the most recent failure:
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "L=\$(docker logs hyperliquid-trading-bot 2>&1); echo 'order failures:'; echo \"\$L\" | grep -ciE 'does not exist|Failed to execute signal|Failed to close position|Unexpected order status|divisible by tick size'; echo 'last failure time(ms):'; echo \"\$L\" | grep -iE 'does not exist|Failed to execute signal|Failed to close position|Unexpected order status|divisible by tick size' | tail -1 | grep -oE '\"time\":[0-9]+' | head -1"
# Are there ANY approved API/agent wallets on the master account? (read-only, no signing)
# Empty [] = NO agent approved = every order WILL fail. This is definitive.
curl -s -X POST https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' -d '{"type":"extraAgents","user":"0xd6b199946b3e34f239f606da0a8024b8ecd390f5"}'
# Ground-truth open positions / account value / liq price (read-only, no signing):
curl -s -X POST https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' -d '{"type":"clearinghouseState","user":"0xd6b199946b3e34f239f606da0a8024b8ecd390f5"}' | python3 -m json.tool
```
- `extraAgents` → `[]` means **no approved API wallet** → 🔴 execution dead. If it returns an
  agent, convert its `validUntil` (epoch ms) and report **days until expiry**; < 14 days = 🟡,
  < 3 days = 🔴 (agents last ~90 days max; renewing is a user-only action, see below). Fix is on
  app.hyperliquid.xyz (API → Generate → Authorize); the **master wallet signs it**.
  Claude CANNOT do this (no master key, by design) — it's a user action. Then update
  `HYPERLIQUID_PRIVATE_KEY` in `.env` and `down && up`.
- If failure last-time ≈ latest log time → 🔴 broken RIGHT NOW (not a stale blip).
- **Exchange-side rejections look like success at a glance.** The bot logs `Order placed for X`
  at info level even when the response carries `{"error": "..."}`, then a level-50
  `Unexpected order status`. Caught 2026-09-13: every ZEC entry rejected with
  `Price must be divisible by tick size` because `roundToIncrement()` hardcodes decimals per
  symbol and Hyperliquid allows **max 5 significant figures** (ZEC went >$1,000). A rejected
  ENTRY is a missed trade; a rejected EXIT (same helper via `exitLimitPrice()`) is an
  unprotected position retrying every 10 s. Check the rejection's coin against
  `clearinghouseState` — if that coin has an open position, treat as 🔴 stuck exit.
- A repeated `Trailing stop hit` for the SAME symbol every ~10s, each paired with an
  order failure = a position whose stop can't execute. Use `clearinghouseState` above
  for its real unrealizedPnl and `liquidationPx` (null = no liq risk) to gauge urgency.

## 4B. STUCK EXITS — is every open position still being protected?
**The #2 silent killer (caught 2026-09-02).** `closePosition()` places a **GTC limit
reduce-only order at a snapshot of the mark price**, then adds the symbol to
`pendingCloseOrders`, which **suppresses all further stop/TP checks for that symbol
until the position disappears**. If that limit never fills (price snapshot was stale
during a fast move), the order rests on the book forever and the position sits with
NO working stop. A SUI runner was left this way for 12 days (entry 0.8016, drifted to
0.7078 = −11.7% against a "4% trail") with a resting sell at 0.9164. Nothing in
sections 1–4A flags it: container healthy, 0 order failures, position just looks open.

```bash
# Resting orders on the exchange (read-only). The bot cancels its own unfilled ENTRY
# orders within seconds and never intends to leave anything resting, so ANY order here
# older than a few minutes is a stuck exit. reduceOnly=true + timestamp hours/days old = 🔴.
curl -s -X POST https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' -d '{"type":"frontendOpenOrders","user":"0xd6b199946b3e34f239f606da0a8024b8ecd390f5"}' | python3 -c "import sys,json,datetime as dt;o=json.load(sys.stdin);print('open orders:',len(o));[print(x['coin'],x['side'],'px',x['limitPx'],'sz',x['sz'],'reduceOnly',x['reduceOnly'],'age_h=%.1f'%((dt.datetime.now().timestamp()*1000-x['timestamp'])/3.6e6)) for x in o]"
# Cross-check: every open position should show RECENT 'trailing stop for <SYM>' activity
# (an update or a hit). A position with zero such lines in the whole log window while its
# price moved = the bot has stopped watching it.
COINS=$(curl -s -X POST https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' -d '{"type":"clearinghouseState","user":"0xd6b199946b3e34f239f606da0a8024b8ecd390f5"}' | python3 -c "import sys,json;print(' '.join(p['position']['coin'] for p in json.load(sys.stdin)['assetPositions']))")
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "L=\$(docker logs hyperliquid-trading-bot 2>&1); for s in $COINS; do echo \"\$s: trailing-stop-updates=\$(echo \"\$L\" | grep -c \"trailing stop for \$s\") stop-hits=\$(echo \"\$L\" | grep -c \"Trailing stop hit for \$s\")\"; done"
```
- Any resting reduce-only order older than ~5 min → 🔴 **stuck exit**. The position's
  distance from entry (from `clearinghouseState` in 4A) tells you how much it has cost.
- **Recovery** (user decision — it realises the loss): cancel the resting order on
  app.hyperliquid.xyz and close the position manually, OR `docker compose down && up`
  — startup cancels all open orders and orphan-recovery re-adopts the position with a
  stop 5% from entry, closing it on the first tick if price is already beyond that.
- **Root cause is in code** (`BreakoutStrategy.closePosition`): a GTC limit exit with
  no fill confirmation and a `pendingCloseOrders` flag that is never re-validated.
  Until fixed, this check is the only thing that catches it.

## 5. WIN RATE / EDGE (best-effort from logs)
```bash
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "L=\$(docker logs hyperliquid-trading-bot 2>&1); echo 'closes:'; echo \"\$L\" | grep -c 'Closed position'; echo 'trailing-stop exits:'; echo \"\$L\" | grep -c 'Trailing stop hit'; echo 'take-profit exits:'; echo \"\$L\" | grep -ci 'take profit'"
```
Logs rotate (10m×3), so counts are a window, not all-time — **say so**. If a hard
win rate is needed, note it's only fully available via Telegram `/alltime`.

## 6. SYSTEM RESOURCES (incl. swap)
```bash
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "free -h && echo '---DISK---' && df -h / && echo '---SWAP---' && swapon --show && echo '---CPU---' && top -bn1 | head -8"
# Container's own resource use:
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker stats hyperliquid-trading-bot --no-stream --format 'CPU={{.CPUPerc}} MEM={{.MemUsage}} ({{.MemPerc}})'"
```
A 2GB swapfile (swappiness=10) was added 2026-06-02 as OOM insurance — verify it's
still present. Swap absent = 🟡 (risk of OOM-killing the container on a spike).

## 7. CONFIGURATION REVIEW
```bash
# NOTE: the volume knob is VOLUME_MULTIPLIER (not VOLUME_THRESHOLD).
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "grep -E 'TRADING_MODE|TRADING_PAIRS|POSITION_SIZE|MAX_POSITIONS|MAX_DAILY_LOSS|MAX_LEVERAGE|VOLUME_MULTIPLIER|TRAILING_STOP_PERCENT|TAKE_PROFIT_PERCENT|LONG_ONLY|MIN_MOMENTUM_SCORE|ENABLE_' /root/HYPE_Bot/.env 2>/dev/null"
```
Sanity-check against `CLAUDE.local.md` "Current Bot Status". Flag drift (e.g. doc
says POSITION_SIZE=75 but .env=50) as a note, not a failure.

## 8. DEPLOYED-CODE VERIFICATION
Per the `--no-cache` footgun in CLAUDE.local.md, confirm the running container
actually contains recent strategy changes (don't trust that a rebuild took).

```bash
# Latest change (2026-09-13): sig-fig price rounding + delisted-pair skip + exchange-fed daily loss cap.
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker exec hyperliquid-trading-bot sh -c \"echo client=\$(grep -c 'roundPrice\|getUntradeableReason' /app/dist/core/exchange/HyperliquidClient.js) index=\$(grep -c getUntradeableReason /app/dist/index.js) oldtable=\$(grep -c 'Default to 3 decimal places' /app/dist/core/strategy/BreakoutStrategy.js) dailycap=\$(grep -c isDailyLossLimitHit /app/dist/core/risk/RiskManager.js) sync=\$(grep -c syncDailyPnl /app/dist/index.js)\""
# Expect client>=4, index>=1, oldtable=0, dailycap>=1, sync>=1. Also confirm no pair is being evaluated that the exchange
# has delisted: any 'Skipping <SYM>: delisted' warning at startup means TRADING_PAIRS needs cleaning.
# Previous change (2026-09-02): hard initial stop + IOC exits + pending-close re-validation.
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker exec hyperliquid-trading-bot grep -c 'getInitialStopPercent\|TimeInForce.IOC\|PENDING_CLOSE_TIMEOUT_MS' /app/dist/core/strategy/BreakoutStrategy.js && echo 'initial-stop / IOC-exit code present' || echo 'MISSING - rebuild may not have applied'"
# And that the env actually reached the container (restart alone does NOT reload .env):
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker exec hyperliquid-trading-bot printenv INITIAL_STOP_PERCENT EXIT_SLIPPAGE_PERCENT"
# Older gate still expected: 'vol_min3' in the same file.
```
Adjust the grep string to whatever the most recent code change was.

## 9. HYPERLIQUID-SPECIFIC CHECKS
- Exchange reachability: signing works if orders place/cancel cleanly (Section 4).
- DNS blips to `api.hyperliquid.xyz` (EAI_AGAIN) are transient and self-heal.
- No funding/rate-limit exposure when flat (0 positions). If positions are open,
  note them and that funding accrues on perps held through funding intervals.

## 10. RECOMMENDATIONS
Prioritised: **P1 (Critical)** immediate, **P2 (Important)** soon, **P3 (Nice to have)**.

## 11. SUMMARY DASHBOARD
| Check | Status | Notes |
|-------|--------|-------|
| Process Running | 🟢/🔴 | uptime, restart count, OOMKilled |
| Logs Healthy | 🟢/🟡/🔴 | last error age, not just count |
| Order Execution | 🟢/🔴 | orders place/close cleanly; API wallet approved (extraAgents != []) |
| Stuck Exits | 🟢/🔴 | no resting reduce-only orders; every open position has recent trailing-stop activity |
| Signals Active | 🟢/🔴 | evaluating + filtering correctly |
| Performance | 🟢/🟡/🔴 | balance trend, open positions, daily P&L |
| Resources (incl swap) | 🟢/🟡/🔴 | RAM/disk/CPU/swap |
| Deployed Code Current | 🟢/🔴 | running JS matches latest change; INITIAL_STOP_PERCENT visible in container env |
| Strategy Edge | 🟢/🟡/🔴 | win rate window, disciplined rejects |

Traffic light: 🟢 All good / 🟡 Minor issues / 🔴 Needs attention
