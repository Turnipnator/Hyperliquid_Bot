---
name: healthcheck
description: Run a comprehensive health check on the Hyperliquid trading bot
---

# Hyperliquid Trading Bot Health Check

Run a comprehensive health check on the hyperliquid-trading-bot. Work through each section systematically and provide a summary dashboard at the end.

## VPS Details
- Server: vmi2859456.contaboserver.net
- SSH Key: ~/.ssh/claude_vps_key
- Container: hyperliquid-trading-bot
- Path: /root/HYPE_Bot

## 1. PROCESS STATUS
- Is the bot process running? Check with `docker ps`
- How long has it been running (uptime)?
- Any recent restarts or crashes?

```bash
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker ps --format '{{.Names}}\t{{.Status}}\t{{.RunningFor}}' | grep hyperliquid"
```

## 2. LOG ANALYSIS
- Check the last 100 lines of logs for errors, warnings, or anomalies
- Identify any recurring error patterns
- Look for WebSocket connection issues

```bash
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker logs hyperliquid-trading-bot --tail 100 2>&1"
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker logs hyperliquid-trading-bot 2>&1 | grep -iE 'error|warn|fail|disconnect|reconnect' | tail -20"
```

## 3. SIGNAL GENERATION
- Is the bot actively producing trading signals?
- What was the last signal generated and when?
- Check data files for recent activity

```bash
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "ls -la /root/HYPE_Bot/data/"
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker exec hyperliquid-trading-bot cat /app/data/state.json 2>/dev/null || echo 'No state file'"
```

## 4. PERFORMANCE METRICS
- Check current trades/positions
- Review recent P&L if logged
- Check open positions and unrealised P&L

```bash
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker exec hyperliquid-trading-bot cat /app/data/trading_stats.json 2>/dev/null || echo 'No stats file'"
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "docker exec hyperliquid-trading-bot cat /app/data/positions.json 2>/dev/null || echo 'No positions file'"
```

## 5. SYSTEM RESOURCES
- RAM usage, disk space, CPU usage

```bash
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "free -h && echo '---' && df -h / && echo '---' && top -bn1 | head -12"
```

## 6. CONFIGURATION REVIEW
- Check key environment variables are set correctly

```bash
ssh -i ~/.ssh/claude_vps_key root@vmi2859456.contaboserver.net "grep -E 'ENABLE_|TRADING_PAIRS|VOLUME_THRESHOLD' /root/HYPE_Bot/.env 2>/dev/null | head -15"
```

## 7. HYPERLIQUID-SPECIFIC CHECKS
- WebSocket connection status to exchange
- Current open positions and unrealised P&L
- Funding rate considerations if holding perps
- API rate limit usage (are we near limits?)

## 8. STRATEGY EDGE ASSESSMENT
- Calculate win rate from stats
- Is the strategy performing as expected?
- Any parameter tweaks recommended?

## 9. RECOMMENDATIONS
Provide prioritised recommendations:
- P1 (Critical): Issues that need immediate attention
- P2 (Important): Should be addressed soon
- P3 (Nice to have): Optimisations for later

## 10. SUMMARY DASHBOARD
Present a quick status summary table:

| Check | Status | Notes |
|-------|--------|-------|
| Process Running | ?/? | |
| Logs Healthy | ?/?/? | |
| Signals Active | ?/? | |
| Resources OK | ?/?/? | |
| WebSocket Connected | ?/? | |
| Strategy Edge | ?/?/? | |

Traffic light summary: ? All good / ? Minor issues / ? Needs attention
