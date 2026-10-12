"""
backtest_momentum.py
====================
Backtests momentum_signal.py on Binance daily history, per coin AND as a
portfolio, with a year-by-year breakdown and a robustness check.

NODDY GUIDE
-----------
Run fetch_binance.py first, then:
    python backtest_momentum.py                     # default settings
    python backtest_momentum.py --robustness        # also try other lookbacks + long/short
    python backtest_momentum.py --target-vol 0.4    # lower risk per coin

THE PORTFOLIO: capital is split equally into one "sleeve" per coin (5 coins =
20% each). Each sleeve runs the signal on its own coin. Before a coin existed
on Binance its sleeve sits in cash (earning 0) - same for the benchmark, so
the comparison stays fair. Sleeves are rebalanced back to equal daily
(the small cost of that is not charged - flagged below).

THE BENCHMARK ("hold"): the same sleeves simply holding each coin, no fees,
no funding (like owning spot). The question this answers is:
    "Did the signal do better than just owning the coins?"
Look at drawdown and Sharpe as much as return - a strategy that makes a bit
less but halves the worst fall can be the better one to live with.

HOW ONE DAY WORKS (no look-ahead):
  1. At day t's close, compute the target weight from data up to day t.
  2. Trade at day t+1's open if should_trade() says the change is worth it.
     Fee = size of the change x cost per side.
  3. Hold through day t+1: earn weight x price move, pay weight x funding.
  4. As price moves, the weight drifts (a winning position becomes a larger
     share of the sleeve), which is what really happens between trades.

COSTS: Hyperliquid taker 0.045% + 0.01% slippage per unit traded (edit COST_PER_SIDE).
Funding: Binance's actual funding history, as a stand-in for Hyperliquid's.

NOT MODELLED: liquidations (irrelevant at <=1x), the cost of rebalancing
between sleeves, and differences between Binance and Hyperliquid funding.

Outputs in ./results/:
  momentum_summary.csv    per coin + portfolio vs hold
  momentum_yearly.csv     portfolio vs hold, each calendar year
  momentum_equity.csv     daily equity curves (for charting later)
  momentum_robustness.csv only with --robustness
"""

import argparse
import os
from dataclasses import replace

import numpy as np
import pandas as pd

from momentum_signal import MomentumConfig, compute_targets, should_trade

DATA_DIR = "data/binance"
RESULTS_DIR = "results"
COST_PER_SIDE = 0.00045 + 0.0001     # Hyperliquid taker fee + slippage - EDIT to your tier
DAYS_PER_YEAR = 365


def to_utc_times(col: pd.Series) -> pd.Series:
    """Parse time strings to UTC datetimes (handles with/without milliseconds)."""
    return pd.to_datetime(col, utc=True, format="ISO8601").dt.as_unit("ns")


def load_coin(coin: str) -> pd.DataFrame:
    """Daily candles plus 'funding_sum' = total funding paid during each day."""
    df = pd.read_csv(f"{DATA_DIR}/{coin}_1d.csv")
    df["time"] = to_utc_times(df["time"])

    fpath = f"{DATA_DIR}/{coin}_funding.csv"
    funding = pd.read_csv(fpath) if os.path.exists(fpath) else pd.DataFrame()
    if funding.empty:
        df["funding_sum"] = 0.0
        return df

    funding["time"] = to_utc_times(funding["time"])
    # A payment at 08:00 is for the 8 hours before it, so step back a minute
    # before deciding which day it belongs to; then add up each day's payments.
    day = (funding["time"] - pd.Timedelta(minutes=1)).dt.floor("24h")
    per_day = funding.groupby(day)["funding_rate"].sum()
    df["funding_sum"] = df["time"].map(per_day).fillna(0.0)
    return df


def run_coin(df: pd.DataFrame, cfg: MomentumConfig):
    """Simulate one coin's sleeve. Returns daily returns, daily weights, totals."""
    targets = compute_targets(df, cfg).to_numpy()
    opens = df["open"].to_numpy()
    fsum = df["funding_sum"].to_numpy()
    n = len(df)

    w = 0.0                        # weight currently held (fraction of the sleeve)
    rets = np.zeros(n)             # sleeve return on each day
    weights = np.zeros(n)          # weight held during each day
    fees = funding = turnover = 0.0
    trades = 0

    for i in range(n - 1):
        # 1+2) Decide on day i's close, trade at day i+1's open
        fee = 0.0
        if should_trade(w, targets[i], cfg.rebalance_band):
            change = abs(targets[i] - w)
            fee = change * COST_PER_SIDE
            turnover += change
            trades += 1
            w = targets[i]

        # 3) Hold through day i+1 (open i+1 -> open i+2)
        price_ret = opens[i + 2] / opens[i + 1] - 1 if i + 2 < n else 0.0
        carry = w * fsum[i + 1]               # + funding: longs pay; short (w<0) receives
        day_ret = w * price_ret - carry - fee

        rets[i + 1] = day_ret
        weights[i + 1] = w
        fees += fee
        funding += carry

        # 4) Weight drifts with price: position value vs total sleeve value
        if w != 0.0 and (1 + day_ret) > 0:
            w = w * (1 + price_ret) / (1 + day_ret)

    idx = df["time"]
    return (pd.Series(rets, index=idx), pd.Series(weights, index=idx),
            {"fees": fees, "funding": funding, "turnover": turnover, "trades": trades})


def hold_returns(df: pd.DataFrame) -> pd.Series:
    """Benchmark: just own the coin (open-to-open), aligned like run_coin's returns."""
    opens = df["open"]
    r = opens.shift(-1) / opens - 1     # day i's return = open i -> open i+1 (same as run_coin)
    r.iloc[0] = 0.0                     # strategy can't act on day 0 either, so neither does hold
    return pd.Series(r.fillna(0.0).to_numpy(), index=df["time"])


def perf(rets: pd.Series) -> dict:
    """Headline numbers from a series of daily returns."""
    rets = rets.fillna(0.0)
    equity = (1 + rets).cumprod()
    years = len(rets) / DAYS_PER_YEAR
    total = equity.iloc[-1] - 1
    vol = rets.std() * np.sqrt(DAYS_PER_YEAR)
    peak = equity.cummax()
    return {
        "return_%": round(total * 100, 1),
        "cagr_%": round(((1 + total) ** (1 / years) - 1) * 100, 1) if equity.iloc[-1] > 0 else -100.0,
        "vol_%": round(vol * 100, 1),
        "sharpe": round(rets.mean() / rets.std() * np.sqrt(DAYS_PER_YEAR), 2) if rets.std() > 0 else 0.0,
        "max_drawdown_%": round(((equity - peak) / peak).min() * 100, 1),
    }


def run_portfolio(coins, data, cfg):
    """Equal sleeves per coin. Returns (strategy daily returns, hold daily returns, per-coin rows, curves)."""
    strat_cols, hold_cols, rows = {}, {}, []
    for coin in coins:
        df = data[coin]
        rets, weights, totals = run_coin(df, cfg)
        hold = hold_returns(df)
        strat_cols[coin], hold_cols[coin] = rets, hold
        s, h = perf(rets), perf(hold)
        rows.append({
            "coin": coin, "from": f"{df['time'].iloc[0]:%Y-%m-%d}", "days": len(df),
            **s,
            "hold_return_%": h["return_%"], "hold_cagr_%": h["cagr_%"],
            "hold_sharpe": h["sharpe"], "hold_max_dd_%": h["max_drawdown_%"],
            "days_invested_%": round((weights.abs() > 0).mean() * 100, 1),
            "avg_weight": round(weights.abs().mean(), 2),
            "trades": totals["trades"], "turnover_x": round(totals["turnover"], 1),
            "fees_%": round(totals["fees"] * 100, 2), "funding_%": round(totals["funding"] * 100, 2),
        })

    # Line coins up on the same calendar; a coin not yet listed = cash (0 return)
    strat = pd.DataFrame(strat_cols).sort_index().fillna(0.0)
    hold = pd.DataFrame(hold_cols).sort_index().fillna(0.0)
    n = len(coins)
    return strat.sum(axis=1) / n, hold.sum(axis=1) / n, rows


def yearly(strat: pd.Series, hold: pd.Series) -> pd.DataFrame:
    """Calendar-year returns and worst drawdown, strategy vs hold."""
    out = []
    for year, s in strat.groupby(strat.index.year):
        h = hold[hold.index.year == year]
        s_eq, h_eq = (1 + s).cumprod(), (1 + h).cumprod()
        out.append({
            "year": year,
            "strategy_%": round((s_eq.iloc[-1] - 1) * 100, 1),
            "hold_%": round((h_eq.iloc[-1] - 1) * 100, 1),
            "strategy_max_dd_%": round(((s_eq - s_eq.cummax()) / s_eq.cummax()).min() * 100, 1),
            "hold_max_dd_%": round(((h_eq - h_eq.cummax()) / h_eq.cummax()).min() * 100, 1),
        })
    return pd.DataFrame(out)


def main():
    parser = argparse.ArgumentParser(description="Backtest daily momentum on Binance history")
    parser.add_argument("--coins", nargs="+", default=["BTC", "ETH", "AVAX", "SOL", "ZEC"])
    parser.add_argument("--target-vol", type=float, default=0.50)
    parser.add_argument("--max-weight", type=float, default=1.0)
    parser.add_argument("--allow-short", action="store_true")
    parser.add_argument("--spot", action="store_true",
                        help="simulate running on SPOT instead of perps: no funding, spot-style fees")
    parser.add_argument("--spot-cost", type=float, default=0.001,
                        help="spot cost per side with --spot (default 0.1%% = Binance spot taker; check yours)")
    parser.add_argument("--robustness", action="store_true",
                        help="also re-run with other lookbacks and long/short, to check it isn't one lucky setting")
    args = parser.parse_args()

    os.makedirs(RESULTS_DIR, exist_ok=True)
    coins = [c for c in args.coins if os.path.exists(f"{DATA_DIR}/{c}_1d.csv")]
    for c in set(args.coins) - set(coins):
        print(f"skip {c}: no data - run: python fetch_binance.py --coins {c}")
    if not coins:
        return
    data = {c: load_coin(c) for c in coins}

    # --spot: same strategy, but holding the actual coin instead of a perp.
    # Spot pays no funding (you own the coin, nobody to pay), but spot trading
    # fees are usually higher than perp fees. Long-only and <=1x only.
    global COST_PER_SIDE
    if args.spot:
        if args.allow_short or args.max_weight > 1:
            raise SystemExit("--spot can't short or use leverage - drop --allow-short / --max-weight > 1")
        COST_PER_SIDE = args.spot_cost
        for df in data.values():
            df["funding_sum"] = 0.0
        print(f"SPOT mode: funding off, cost {COST_PER_SIDE:.3%} per side")

    cfg = MomentumConfig(target_vol=args.target_vol, max_weight=args.max_weight,
                         allow_short=args.allow_short)
    strat, hold, rows = run_portfolio(coins, data, cfg)

    # Portfolio row alongside the per-coin rows
    s, h = perf(strat), perf(hold)
    rows.append({"coin": "PORTFOLIO", "from": f"{strat.index[0]:%Y-%m-%d}", "days": len(strat), **s,
                 "hold_return_%": h["return_%"], "hold_cagr_%": h["cagr_%"],
                 "hold_sharpe": h["sharpe"], "hold_max_dd_%": h["max_drawdown_%"]})
    summary = pd.DataFrame(rows)
    years = yearly(strat, hold)

    sfx = "_spot" if args.spot else ""          # keep spot results separate from perp results
    summary.to_csv(f"{RESULTS_DIR}/momentum_summary{sfx}.csv", index=False)
    years.to_csv(f"{RESULTS_DIR}/momentum_yearly{sfx}.csv", index=False)
    pd.DataFrame({"strategy": (1 + strat).cumprod(), "hold": (1 + hold).cumprod()}) \
        .to_csv(f"{RESULTS_DIR}/momentum_equity{sfx}.csv")

    with pd.option_context("display.width", 250, "display.max_columns", 40):
        mode = "long/short" if cfg.allow_short else "long-only"
        print(f"\n=== Per coin and portfolio ({mode}, target vol {cfg.target_vol:.0%}) ===")
        print(summary.to_string(index=False))
        print("\n=== Portfolio by calendar year ===")
        print(years.to_string(index=False))

    if args.robustness:
        # Same strategy, different reasonable settings. If only ONE of these
        # looks good, that's luck. If most look similar, the idea is sturdier.
        variants = []
        for lbs in [(30, 90, 180), (20, 60, 120), (60, 120, 240), (14, 30, 60), (90, 180, 365)]:
            for short in ((False,) if args.spot else (False, True)):   # spot can't short
                v_cfg = replace(cfg, lookbacks=lbs, allow_short=short)
                v_strat, _, _ = run_portfolio(coins, data, v_cfg)
                variants.append({"lookbacks": "/".join(map(str, lbs)),
                                 "mode": "long/short" if short else "long-only", **perf(v_strat)})
        variants.append({"lookbacks": "-", "mode": "HOLD (benchmark)", **perf(hold)})
        rob = pd.DataFrame(variants)
        rob.to_csv(f"{RESULTS_DIR}/momentum_robustness{sfx}.csv", index=False)
        print("\n=== Robustness: portfolio under other settings ===")
        print(rob.to_string(index=False))

    print(f"\nSaved to ./{RESULTS_DIR}/ (momentum_*.csv)")


if __name__ == "__main__":
    main()
