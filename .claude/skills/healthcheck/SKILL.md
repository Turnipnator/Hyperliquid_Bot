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
Repeated `RESTING ... Cancelling` for one symbol = limit orders never filling
(price moving away) — flag as churn, not an error.

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
# Example: confirm the decoupled sustained-volume gate is in the running JS:
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker exec hyperliquid-trading-bot grep -l 'vol_min3' /app/dist/core/strategy/BreakoutStrategy.js && echo 'vol_min3 gate present' || echo 'MISSING - rebuild may not have applied'"
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
| Signals Active | 🟢/🔴 | evaluating + filtering correctly |
| Performance | 🟢/🟡/🔴 | balance trend, open positions, daily P&L |
| Resources (incl swap) | 🟢/🟡/🔴 | RAM/disk/CPU/swap |
| Deployed Code Current | 🟢/🔴 | running JS matches latest change |
| Strategy Edge | 🟢/🟡/🔴 | win rate window, disciplined rejects |

Traffic light: 🟢 All good / 🟡 Minor issues / 🔴 Needs attention
