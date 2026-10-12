# RESEARCH_MOMENTUM_HYPERLIQUID.md — Daily momentum research → review against this Hyperliquid bot

> **For Claude Code.** This file hands over research done outside this repo.
> Your job is a **read-only review** of this bot against the research, ending in a
> recommendation and a plan for Paul to approve. **Do not modify live code, config,
> keys or running containers.** Follow the repo's pre-implementation planning
> contract (goal / assumptions / plan before any code), scaled to blast radius —
> this bot trades real money.

Reference implementation (copied alongside this file, in `research/`):
`momentum_signal.py` (the signal), `backtest_momentum.py` (backtester),
`fetch_binance.py` (data). If they're missing, ask Paul to copy them in.

---

## 1. What was researched (Oct 2026)

Goal: find a dynamic long/short crypto strategy worth running. Tested in order:

| # | Idea | Data | Result | Status |
|---|------|------|--------|--------|
| 1 | 1h EMA-trend + momentum + ADX regime, long/short | Hyperliquid, 7 months | Lost money on BTC/ETH/AVAX/SOL even before fees; ~75 entries/coin | **Rejected** |
| 2 | Same signal on 4h | Hyperliquid, 2.3 years | Shorts lost on 4/5 coins (incl. coins that fell 25–65%); long-only < buy-and-hold | **Rejected** |
| 3 | GMX (Avalanche) as venue | — | ~2x fees + borrow vs Hyperliquid; worse on every coin | **Rejected** |
| 4 | **Daily time-series momentum, vol-targeted, long-only** | Binance, ~7 years | Robust across settings; much smaller drawdowns; beats hold on Sharpe **on spot** | **Candidate** |
| 5 | Funding carry (long spot + short perp when funding high) | Binance, ~7 years | ~4.3%/yr, ~0% in 2022/2025/2026, short-leg liquidation risk in rallies | **Parked** |
| 6 | Funding fade (short extreme +funding, long extreme −funding) | Binance, ~7 years | Lost under all 9 settings | **Rejected** |

Consistent lessons: **shorting crypto trends loses money**, and **perp funding is a large
cost for longs** (~44% cumulative on BTC/ETH over 7 years on Binance; Hyperliquid funding
is hourly and differs in detail but is similar in direction — longs usually pay).

Why Binance data: Hyperliquid's API only serves ~5,000 candles per interval and launched in
2023, so it can't give a multi-cycle daily test. Prices are near-identical across venues.

## 2. The candidate strategy — exact spec

Universe: BTC, ETH, AVAX, SOL, ZEC. Capital split into **equal sleeves** (1/N each).
Runs **once per day** on the **closed** daily candle (00:00 UTC). Never use the forming candle.

Per coin, at each daily close:

1. **Votes**: for each lookback L in (30, 90, 180) days → `sign(close_t / close_{t-L} − 1)`.
2. **Trend** = mean of votes, then **clipped at 0** (long-only). Possible values: 0, ⅓, ⅔, 1.
3. **Realised vol** = std of daily log returns over 30 days × √365.
4. **Target weight** = `trend × 0.50 / realised_vol`, capped at **1.0** (no leverage).
   Weight is a fraction of that coin's sleeve (0 = all cash, 1 = fully invested).
5. **Rebalance band**: only trade if `|target − current| > 0.10`, except always act
   when going to or from 0.
6. Execute at the next open (in practice: shortly after 00:00 UTC).

Signal can be computed from Binance daily candles or Hyperliquid daily candles (HL's 1d
interval gives far more than the 180+30 days needed for a live signal).

## 3. Results (Binance daily, Sept 2019 → Oct 2026)

Portfolio, default settings (30/90/180):

| | Strategy on **spot** (0.1%/side, no funding) | Strategy on **perps** (0.055%/side + funding) | Buy & hold |
|---|---|---|---|
| CAGR | **26.8%** | 22.5% | 66.8% |
| Volatility | 19.9% | 19.8% | 74.1% |
| Sharpe | **1.29** | 1.12 | 1.07 |
| Max drawdown | −24.0% | −24.8% | −84.9% |

**Key finding for a Hyperliquid bot**: because the strategy is long-only and ≤1x, perps add
cost (funding) and no benefit. Running it on perps cost ~4 percentage points a year vs spot.
If this bot trades HL **perps**, that matters; if it trades HL **spot**, check which of the
5 coins HL spot actually lists (HL spot tokens are often wrapped, e.g. "UBTC"/"UETH"/"USOL" —
**verify current listings, liquidity/spreads and spot fees; do not assume**).

By year (spot portfolio): 2020 +42.4 / 2021 +83.9 / **2022 −10.0 (hold −80.1)** /
2023 +34.9 / 2024 +39.7 / 2025 +7.4 / 2026 YTD +12.9.

Per coin (spot): BTC CAGR 33.8% (hold 34.1%) with max DD −27% (hold −77%);
ETH 37.3% (DD −32.5% vs −79%); SOL 40.2%; ZEC 15.4%; **AVAX weak** 6.5% (Sharpe 0.37).
Average exposure is low (12–37% of each sleeve).

Robustness (portfolio Sharpe, spot): 30/90/180 → 1.29 · 20/60/120 → 1.55 ·
60/120/240 → 1.27 · 14/30/60 → 1.76 · 90/180/365 → 0.90. All positive; 4/5 beat hold.
**Do not pick 14/30/60 because it topped the table.** Paul's intended choice: 30/90/180 or a blend.

## 4. Known limitations

- **Survivorship / hindsight**: coins chosen in 2026; a rule-based broader basket is **not yet tested**.
- ~7 years ≈ 2 cycles. Long-only crypto beta with a trend filter: value is **drawdown control**,
  not beating hold on return, and it is **correlated with the market**.
- Funding in the perp column is Binance's, as a proxy for Hyperliquid's.
- Cross-sleeve rebalancing cost not modelled; fills assumed at the daily open.

## 5. Your review task (read-only)

**A. Describe this bot accurately** (code, config, SQLite trade ledger if present):
**spot or perps?**, strategy logic, timeframe, coins, sizing, leverage, entry/exit rules, whether
it shorts, risk controls (stops, liquidation buffer), state storage, scheduling, Telegram alerts,
order types, fee tier if visible. If perps: how much funding has it paid historically (from fills /
ledger / `userFunding` history) relative to its P&L?

**B. Compare with the spec in §2.**
1. Does this bot already do something similar?
2. If it shorts: how have its **short** trades performed vs its longs? (The research found shorts
   lose consistently — check whether this bot's own record agrees.)
3. **Conflict check**: would both strategies trade the same coins in the same account/vault?
   Note whether HL sub-accounts are used or available.
4. Venue fit: HL minimum order value (~$10) vs small sleeve rebalances; HL spot availability for
   each coin (§3); whether a spot version needs a separate spot balance.

**C. High-value analysis if a trade ledger exists**: for each historical trade of THIS bot,
compute the momentum `trend` (§2 steps 1–2) for that coin on the day it opened, using only data
available then. Report P&L, win rate and count split by regime (`trend == 0` vs `trend > 0`) and by
side (long/short). If losses cluster in `trend == 0` and/or in shorts, a **regime filter** (allow longs
only when trend > 0; disable shorts) may beat a rewrite.

**D. Recommend one of**, with evidence:
- **Filter**: keep this bot, gate entries by momentum regime (and/or drop shorts).
- **Alongside**: run the momentum strategy as a separate sub-account — on HL spot if listed, else
  consider the Binance spot bot as the home for it (a separate review covers that bot).
- **Replace**: retire this bot's logic in favour of the momentum strategy.
- **Neither**: say why.

**E. Deliverable**: write `REVIEW_MOMENTUM.md` in this repo containing A–D, plus a step-by-step
implementation plan (goal / assumptions / plan), what runs in dry-run/paper mode first, and what
Paul must approve. **Stop there. No code changes to the live bot.**
