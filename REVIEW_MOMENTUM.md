# REVIEW_MOMENTUM.md — this bot vs the daily-momentum research

Review date: 2026-10-11. Read-only: no code, config, keys or containers were touched.
Source of the brief: `RESEARCH_MOMENTUM_HYPERLIQUID.md` §5.

## Verdict

**Alongside — but not in this account, and not yet. Leave this bot's logic alone.**

- **Filter: no.** The bot's own record does not support a momentum regime filter. Longs opened when
  the daily trend was 0 made the same per trade as longs opened when it was positive ($0.188 vs $0.185).
  Since March the "trend = 0" longs were the *better* half. A filter would have removed 56% of the
  long trades and $44.51 of the $78.92 long profit.
- **Replace: no.** Over the same 296 days this bot made +22.2% on the deposit; the momentum spec
  would have made about +14.7%. Neither number is proof of anything on one window, but there is no
  evidence for retiring the bot.
- **Shorts: the research finding holds here, weakly.** 28 shorts lost $10.41. Turning them off
  (`LONG_ONLY=true`) is a cheap, optional change for you to decide.
- **Alongside: yes in principle, with two blockers.** (1) Momentum positions held as perps in this
  account would be seized by this bot (it adopts any position it finds and puts its own 3% stop and
  1.3% take-profit on it). (2) At $384 the account is too small to run 4–5 sleeves above
  Hyperliquid's $10 minimum order. The Binance spot bot, or a separate Hyperliquid wallet on spot,
  is the right home once there is roughly $400+ to give it.

## Where the numbers come from

- There is **no SQLite ledger**; the bot stores nothing on disk. All history below is from
  Hyperliquid's read-only info API for the master account: 1,122 fills (2025-12-19 → 2026-10-11),
  1,292 funding payments, ledger updates, fee schedule, spot and perp metadata, order books.
- Trades were rebuilt from fills (flat → flat per coin). Net P&L per trade = closedPnl − fees + funding.
- Momentum trend for each trade = §2 steps 1–2 on Hyperliquid daily candles, using the last daily
  candle that had **closed before the entry**. No look-ahead.
- `research/backtest_momentum.py` is **missing** (`backtest_funding.py` was copied instead). I wrote
  a small independent simulator rather than wait; see section B for how closely it matches §3.
- The two currently open longs (SOL, LINK, +$1.23 unrealised) are excluded from trade statistics.

---

## A. What this bot is

| Item | Finding |
|---|---|
| Venue / product | Hyperliquid **perps**, mainnet, cross margin. No spot (spot wallet holds $0.0001). |
| Strategy | Intraday breakout on **5-minute** candles: price through the 40-candle high/low with a volume spike (1.5×, and min of last 3 candles ≥ 0.5×), or a >5% single candle, or >1.75% over 2–5 candles. |
| Entry filters | EMA20/50/200 stack, 3-layer trend (ATR range, price structure, EMA9/21/50), RSI (no long above 70, no short below 45), momentum score ≥ 0.70, 15-minute cooldown after a stop. |
| Coins | BTC, ETH, SOL, AVAX, BNB, SUI, LINK, XRP, TRX, ADA, HYPE, ZEC. History also includes TON and ARB. |
| Sizing | Fixed **$75** notional per trade ($50 before 2026-09-13), max 6 positions. Not volatility-scaled. |
| Leverage | `MAX_LEVERAGE=3` is only an internal exposure check; it is never sent to the exchange. Real exposure peaks near 6 × $75 = $450 on $384 (1.2×). Average long exposure over the whole history was **$78**, about 0.23× equity. |
| Exits | Hard 3% stop from entry; 5% trail from the peak (ratchets one way); at +1.3% bank 50%, the rest rides a 4% trail. |
| Shorts | Enabled since 2026-01-30 (`LONG_ONLY=false`), same rules mirrored. Rare: 28 of 451 trades. |
| Risk controls | $30 realised daily loss cap from exchange fills (pauses entries). No explicit liquidation buffer; none needed at ~1× on cross margin. |
| State | In memory only. On restart it cancels **all** open orders and re-adopts any open position as an "orphan" with fresh stops. |
| Scheduling | Signal loop every 60 s; stop/TP loop every 10 s. Runs in Docker on the VPS. |
| Orders | Entry: limit at the signal price, cancelled at once if it rests. Exit: IOC reduce-only limit 0.5% through the mark. 75% of fills were taker. |
| Fees | Perp 0.045% taker / 0.015% maker; spot 0.070% / 0.040%; 4% referral discount active. Average paid: 3.65 bps of $47.9k lifetime volume. |
| Telegram | Trade, error and daily-cap alerts; `/status`, `/positions`, `/daily`, `/weekly`, `/alltime`, `/stop`. |
| Sub-accounts | None exist. |

### Money

| | |
|---|---|
| Deposited (2025-11-30) | $314.13 |
| Account value now | $383.71 (**+$69.58, +22.2%**) |
| Closed P&L (gross) | +$89.52 |
| Fees | −$17.47 |
| **Funding** | **−$3.69** (paid $4.44, received $0.75) |
| Closed trades | 451: 60.1% winners, profit factor 1.28, average +$0.15 |
| Median hold | 9.8 hours (90% under 62 hours) |
| Worst realised drawdown | −11.7% (trough 2026-02-22) |

**Funding is small for this bot**: 4% of gross P&L, 5% of net, a fifth of what fees cost. Longs paid
about 4.3% a year on the notional they actually held, but they hold for hours, not months.

By month: Dec −3.69, Jan −22.03, Feb −3.53, Mar +14.05, Apr +7.28, May +12.53, Jun −2.79,
Jul +17.36, Aug +19.56, Sep +42.79, Oct to date −13.02.

The profit is concentrated: September is 62% of the total, and the ten best longs made $55.76.
The per-trade t-statistic is about 2. The edge is plausible, not proven.

---

## B. Comparison with the §2 spec

### B1. Does the bot already do something similar?

No. Almost nothing overlaps.

| | This bot | Momentum spec |
|---|---|---|
| Horizon | 5-minute candles, holds hours | Daily candles, holds weeks to months |
| Decision | Breakout event with volume | Sign of 30/90/180-day return |
| Sizing | Fixed $75 | Volatility-targeted fraction of a sleeve |
| Direction | Long and short | Long or flat |
| Trades | 451 in 10 months | 9–37 per coin in 10 months |

### B2. Shorts vs longs

| Side | Trades | Net | Avg | Win rate | Profit factor |
|---|---|---|---|---|---|
| Long | 423 | **+$78.92** | +$0.187 | 61.0% | 1.34 |
| Short | 28 | **−$10.41** | −$0.372 | 46.4% | 0.46 |

The direction agrees with the research. The strength does not: 24 of the 28 shorts were in
Dec–Feb, when longs were losing too (84 longs, −$16.07) and stops were set differently. The
4 shorts since March made +$1.22. Twenty-eight trades cannot settle it either way (t = −1.4).

### B3. Conflict check — same account

Running momentum inside this master account would collide with the bot in four places.

1. **Perp positions get adopted.** `updateTrailingStops()` treats every open perp position as its
   own. A momentum BTC long would get a 3% stop and a 1.3% half take-profit within 10 seconds. This
   rules out perps in this account. All five momentum coins are also in this bot's pair list.
2. **Startup cancels every open order** on the account (`cancelAllOrders()` with no coin filter).
   A momentum bot here must use IOC orders only. Whether Hyperliquid's `openOrders` returns spot
   orders to this call should be confirmed in dry-run before relying on either answer.
3. **The daily loss cap would be polluted.** `getFillsSince()` sums every fill on the account,
   and spot fills carry `closedPnl` too. A momentum loss could pause the breakout bot; a momentum
   gain could hide a breakout loss.
4. **Capital is physically split.** The bot must stay in Standard mode (Unified zeroes its view of
   the balance). Spot buys need USDC in the spot wallet, moved by a master-wallet signature — your
   action, not an API-wallet one, as far as I know; confirm before designing around it. Every dollar
   moved out also raises the breakout bot's leverage: at $184 of perp equity, six $75 positions is 2.4×.

Spot positions themselves are invisible to the bot (it reads `clearinghouseState` only), so spot
in this account is workable with a code change for point 3, but a separate wallet is cleaner.

Sub-accounts: none exist. My recollection is that Hyperliquid unlocks them at $100k lifetime
volume; this account has $47.9k. Verify, but assume a **second wallet** (own address, own API
wallet, own expiry date) is the practical route on Hyperliquid.

### B4. Venue fit

Hyperliquid spot, checked live today:

| Coin | Spot pair | 24h volume | Spread | Depth within 0.2% | Usable? |
|---|---|---|---|---|---|
| BTC | UBTC/USDC | $64.7M | 0.1 bp | ~$640k a side | Yes |
| ETH | UETH/USDC | $6.0M | 0.8 bp | ~$290–460k | Yes |
| SOL | USOL/USDC | $2.6M | 0.9 bp | ~$270–330k | Yes |
| ZEC | UZEC/USDC | $8.7M | 1.6 bp | ~$160–190k | Yes |
| AVAX | UAVAX/USDC | **$14k** | **30 bp** | **$585 bid** | **No** |

- AVAX has no usable spot market. It was also the weak coin in the research (Sharpe 0.37). A
  Hyperliquid spot version is a **four-coin** basket.
- These are bridged (Unit) tokens, so they carry bridge risk that Binance spot does not.
- Spot taker fee is 0.070%, lower than the 0.1% the research assumed.
- **Minimum order $10 is the binding problem.** The 10% rebalance band on a sleeve is below $10
  for any sleeve under $100, and typical target weights are 0.2–0.4, so first entries on a $50
  sleeve are $10–20. Workable from about **$100 a sleeve**, comfortable from $250. That is
  $400–$1,000 for four coins against a $384 account that is already in use.
- Perps as a fallback: ZEC perp size steps are 0.01 ZEC ≈ $12.50, too coarse for a small sleeve.

**Spot vs perps on Hyperliquid specifically.** Using Hyperliquid's own hourly funding since
2025-10-01, weighted by when the momentum spec would have been long: BTC 1.8%, ETH 1.7%, ZEC 1.2%,
SOL 0.9%, AVAX 0.7% of sleeve per year. That is about 1–2 points a year, less than the research's
~4 points from Binance. While actually long the rate was 6–10% a year, so a long bull phase would
cost more. Spot is still the better instrument (no funding, no liquidation, invisible to this bot),
but on a few hundred dollars the difference is a dollar or two a year. Separation matters far more.

### Check of the research numbers

My independent simulator on Binance spot daily candles (Sept 2019 → today, 0.1% a side, equal
fifths, cash until a coin lists):

| | Mine | Research §3 |
|---|---|---|
| CAGR | 29.1% | 26.8% |
| Volatility | 20.3% | 19.9% |
| Sharpe | 1.36 | 1.29 |
| Max drawdown | −24.0% | −24.0% |
| 2022 | −10.3% | −10.0% |

Close enough to say the headline reproduces. Other lookback sets ranked in the same order as §3
(Sharpe 0.96 to 1.79). My version ignores intra-sleeve weight drift, which probably explains the gap.

Same spec over this bot's live window on Hyperliquid candles (0.07% a side): **+14.7%**, max
drawdown −7.3%, while BTC −3%, ETH −11%, SOL −8%, AVAX −9% held (ZEC +214%). It did what it claims:
stayed mostly in cash through a falling market.

---

## C. Regime split of this bot's own trades

Trend = §2 value at the last daily close before entry (30/90/180).

| Group | Trades | Net | Avg | Win rate | Profit factor |
|---|---|---|---|---|---|
| Long, trend > 0 | 186 | +$34.41 | +$0.185 | 62.9% | 1.34 |
| Long, trend = 0 | 237 | +$44.51 | +$0.188 | 59.5% | 1.34 |
| Short, trend > 0 | 3 | +$0.65 | +$0.217 | 33.3% | 2.06 |
| Short, trend = 0 | 25 | −$11.06 | −$0.442 | 48.0% | 0.40 |

Longs are indistinguishable by regime (permutation test p = 0.99).

By period, longs only:

| Period | trend > 0 | trend = 0 |
|---|---|---|
| 2025-12-19 → 02-28 | none | 84 trades, −$16.07 |
| 2026-03-01 → 06-07 | 78, +$5.58 | 86, **+$30.16** |
| 2026-06-08 → 09-01 | 44, +$2.45 | 62, **+$20.37** |
| 2026-09-02 → now | 64, +$26.38 | 5, +$10.06 |

- Losses do **not** cluster in trend = 0. The only losing block is Dec–Feb, where every entry was
  trend = 0 because nothing was trending; that period also had different stop settings, so regime
  and bot version cannot be separated there.
- From March onward, trend = 0 longs made $60.58 (profit factor 1.87) against $34.41 (1.34).
- Other lookback sets say the same or worse for a filter: with 20/60/120, 60/120/240 and
  90/180/365 the trend = 0 longs earned $61–69 and the trend > 0 longs $10–18.
- On the five research coins alone the split leans the other way (trend > 0: 70 trades, +$22.97;
  trend = 0: 66, +$4.25), driven by ZEC and AVAX. Not significant (t ≈ 1.3) and it reverses on
  SUI, XRP, BTC and BNB.
- Oddity, not a finding: longs with all three votes up lost $8.26 over 120 trades, while one-vote
  longs made $42.67 over 66. I would not act on a pattern found by slicing this finely.

The likely reason a daily filter does not help: the bot buys intraday breakouts and is out in
hours. Sharp rebounds inside a daily downtrend are exactly what it catches.

Losses do cluster in **shorts in trend = 0** (25 trades, −$11.06), with the caveat in B2.

---

## D. Recommendation

1. **Do not filter, do not replace.** Evidence in C.
2. **Run momentum alongside, in a separate home, after a paper phase.** The two are complementary
   on paper: one trades hourly breakouts, the other holds for months and sits in cash in bear markets.
   Preferred home is the Binance spot bot (real spot, all five coins, no bridge risk, no conflict
   with this bot); second choice is a new Hyperliquid wallet trading UBTC/UETH/USOL/UZEC.
3. **Optional, your call: `LONG_ONLY=true`.** It gives up 4 trades in the last 7 months and removes
   the bot's worst-performing category. The evidence is thin, so I would not call it necessary.
4. **Do not move capital out of this account** to fund momentum. It shrinks the bot that is
   working and still leaves the sleeves under the minimum order.

---

## E. Implementation plan (for approval — nothing has been built)

### Goal

Find out, at no risk, whether the momentum spec behaves live as it does in the backtest, and
decide where it should run, without changing this bot's trading.

### Assumptions

- The breakout strategy stays as is (CLAUDE.md rule 1).
- Lookbacks 30/90/180, target vol 50%, cap 1.0, band 10%, as in §2. Not 14/30/60.
- Momentum never shares a perp account with this bot.
- New capital, not capital taken from this bot, funds any live version.
- `research/backtest_momentum.py` gets copied in, so the paper phase is checked against the
  research's own code rather than my reproduction.

### Plan

| Step | What | Touches live bot? |
|---|---|---|
| 0 | Copy `backtest_momentum.py` into `research/`. Re-run it and reconcile with the table in B. | No |
| 1 | **Paper signal logger.** A standalone script (no keys, public data only), run once a day at about 00:05 UTC from cron, outside the bot's container. It computes targets from closed daily candles with `momentum_signal.py`, applies the band, records the hypothetical trade at the next open with 0.07% cost in a small SQLite file, and sends one Telegram line. | No |
| 2 | Run step 1 for at least 4 weeks and at least 10 hypothetical trades. Compare each day's weights against a fresh backtest run; they must match exactly. | No |
| 3 | **Decision gate (you).** Home, capital, basket. Inputs: step 2 results and the Binance spot bot review. | No |
| 4 | Dry-run on the chosen venue with real order construction but no submission: check minimum order, size decimals, IOC behaviour, and (if Hyperliquid) whether spot orders appear in `openOrders`. | No |
| 5 | Live at the smallest size that clears the minimum order (about $100 a sleeve), with a kill switch and a daily reconciliation message. | Only if it shares this master account: then `getFillsSince()` must ignore spot fills, which is a code change to this bot needing its own approval, backup and deploy. |
| Optional | `LONG_ONLY=true` in the VPS `.env`, then `docker compose down && docker compose up -d`. | Yes: env only, you run it |

### What runs in paper or dry-run first

Everything in steps 1, 2 and 4. No order is sent and no key is needed until step 5.

### What you need to approve

1. Recommendation D as a whole (alongside, separate home, no filter, no replace).
2. Whether to turn shorts off now.
3. Building the step 1 paper logger, and where it runs (VPS cron or the Mac).
4. At the step 3 gate: Binance spot bot or a new Hyperliquid wallet; how much new capital; four
   coins or five (AVAX only makes sense on Binance).
5. Any change to this bot's code, if momentum ever shares its master account.

### Open items I could not settle from here

- Sub-account volume requirement and whether an API wallet can move USDC between spot and perps
  (both from memory, both need checking against current Hyperliquid docs).
- Whether `openOrders` includes spot orders (step 4).
- The research's survivorship caveat stands: the five coins were picked in 2026, and ZEC in
  particular was picked after a +180% year.
