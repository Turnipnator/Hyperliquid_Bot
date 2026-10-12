"""
backtest_funding.py
===================
Backtests the two funding strategies in funding_signal.py on Binance daily
history, per coin and as an equal-split portfolio, by year, with robustness.

NODDY GUIDE
-----------
Run fetch_binance.py first (it now also downloads spot prices), then:
    python backtest_funding.py                          # carry (market-neutral)
    python backtest_funding.py --strategy fade          # fade (directional)
    python backtest_funding.py --robustness             # also try other thresholds
    python backtest_funding.py --strategy fade --robustness

HOW TO JUDGE EACH ONE
  CARRY is a yield strategy - it isn't trying to follow the market, so the
  benchmark is CASH (0%). Ask: "what yearly return, how steady, how bad was
  the worst patch?" Also check max_rally_% - the biggest price rise during a
  trade, which tells you how much spare margin the short leg would have needed.
  FADE is directional, so it's compared with simply holding the coins, and
  the long and short trades are reported separately.

HOW ONE DAY WORKS (no look-ahead): decide at day t's close from funding paid
up to then; trade at day t+1's open; hold through day t+1.

CARRY P&L per day, on `notional` of each leg:
    + spot move  - perp move     ("basis": usually tiny, since they track each other)
    + funding received by the short (or paid, if funding turns negative)
    - fees on entry/exit: BOTH legs, spot fee + perp fee

COSTS (edit to your real tiers):
    PERP_COST 0.055% per side (Hyperliquid taker + slippage)
    SPOT_COST 0.10% per side  (Binance spot taker)

NOT MODELLED - read before trusting results:
  * Funding is Binance's. Hyperliquid's funding (hourly) differs - often
    similar in direction, not identical. A live carry bot would earn ITS venue's.
  * Carry across TWO venues (e.g. Binance spot + Hyperliquid perp) means
    capital split between them, transfers, and two sets of counterparty risk.
  * Leg sizes are treated as constant; in reality they drift a little with price.
  * Liquidation of the short leg - reported via max_rally_%, not simulated.
  * Fade positions are held at a fixed weight (max ~10 days, so drift is small).
"""

import argparse
import os
from dataclasses import replace

import numpy as np
import pandas as pd

from backtest_momentum import DATA_DIR, RESULTS_DIR, hold_returns, load_coin, perf, to_utc_times, yearly
from funding_signal import CarryConfig, FadeConfig, carry_targets, fade_targets, trailing_apr

PERP_COST = 0.00045 + 0.0001   # per side, per unit of notional - EDIT to your tier
SPOT_COST = 0.001              # per side - EDIT (Binance spot taker 0.1%; less with BNB / maker)


def load(coin: str) -> pd.DataFrame:
    """Perp candles + daily funding (from backtest_momentum) + spot open price."""
    df = load_coin(coin)
    spot_path = f"{DATA_DIR}/{coin}_spot_1d.csv"
    if os.path.exists(spot_path):
        spot = pd.read_csv(spot_path)
        spot["time"] = to_utc_times(spot["time"])
        df["spot_open"] = df["time"].map(spot.set_index("time")["open"])
    else:
        df["spot_open"] = np.nan
    return df


# ---------------------------------------------------------------------------
# CARRY
# ---------------------------------------------------------------------------
def run_carry(df: pd.DataFrame, cfg: CarryConfig):
    targets = carry_targets(df, cfg).to_numpy()
    opens, sopen, fsum = df["open"].to_numpy(), df["spot_open"].to_numpy(), df["funding_sum"].to_numpy()
    n = len(df)

    state = 0
    rets, active = np.zeros(n), np.zeros(n)
    fees = funding = basis = 0.0
    entries, missing_spot, max_rally = 0, 0, 0.0
    entry_px = None

    for i in range(n - 1):
        # Decide at day i's close, trade at day i+1's open
        fee = 0.0
        if targets[i] != state:
            fee = cfg.notional * (SPOT_COST + PERP_COST)   # one side on EACH leg
            state = int(targets[i])
            entries += state
            entry_px = opens[i + 1] if state else None

        day = -fee
        if state and i + 2 < n:
            p_ret = opens[i + 2] / opens[i + 1] - 1
            if np.isnan(sopen[i + 1]) or np.isnan(sopen[i + 2]):
                s_ret = p_ret                      # no spot price that day: assume they matched
                missing_spot += 1
            else:
                s_ret = sopen[i + 2] / sopen[i + 1] - 1
            b = cfg.notional * (s_ret - p_ret)     # long spot minus short perp
            f = cfg.notional * fsum[i + 1]         # the short RECEIVES positive funding
            day += b + f
            basis += b
            funding += f
            max_rally = max(max_rally, opens[i + 2] / entry_px - 1)   # worst case for the short leg

        rets[i + 1] = day
        active[i + 1] = state
        fees += fee

    idx = df["time"]
    return pd.Series(rets, index=idx), pd.Series(active, index=idx), {
        "entries": entries, "fees": fees, "funding": funding, "basis": basis,
        "max_rally": max_rally, "missing_spot": missing_spot}


def carry_row(coin, df, rets, active, t):
    return {
        "coin": coin, "from": f"{df['time'].iloc[0]:%Y-%m-%d}", **perf(rets),
        "days_active_%": round(active.mean() * 100, 1), "entries": t["entries"],
        "funding_earned_%": round(t["funding"] * 100, 1), "basis_%": round(t["basis"] * 100, 1),
        "fees_%": round(t["fees"] * 100, 2), "max_rally_%": round(t["max_rally"] * 100, 1),
        "missing_spot_days": t["missing_spot"],
        "avg_funding_apr_%": round(trailing_apr(df["funding_sum"], 365).mean() * 100, 1),
    }


# ---------------------------------------------------------------------------
# FADE
# ---------------------------------------------------------------------------
def run_fade(df: pd.DataFrame, cfg: FadeConfig):
    targets = fade_targets(df, cfg).to_numpy()
    opens, fsum = df["open"].to_numpy(), df["funding_sum"].to_numpy()
    n = len(df)

    w = 0.0
    rets, weights = np.zeros(n), np.zeros(n)
    fees = funding = 0.0
    closed, seg = [], None

    for i in range(n - 1):
        fee = 0.0
        if targets[i] != w:
            fee = abs(targets[i] - w) * PERP_COST
            if seg is not None:                      # close the open trade
                closed.append({**seg, "exit_time": df["time"].iloc[i + 1],
                               "return_%": round((seg["growth"] * (1 - abs(w) * PERP_COST) - 1) * 100, 3)})
                seg = None
            w = targets[i]
            if w != 0:                               # open a new one
                seg = {"side": "LONG" if w > 0 else "SHORT", "entry_time": df["time"].iloc[i + 1],
                       "weight": round(abs(w), 3), "growth": 1 - abs(w) * PERP_COST}

        day = -fee
        if w != 0 and i + 2 < n:
            p_ret = opens[i + 2] / opens[i + 1] - 1
            carry = w * fsum[i + 1]                  # longs pay +funding, shorts receive it
            step = w * p_ret - carry
            day += step
            funding += carry
            seg["growth"] *= (1 + step)

        rets[i + 1] = day
        weights[i + 1] = w
        fees += fee

    if seg is not None:
        closed.append({**seg, "exit_time": df["time"].iloc[-1], "return_%": round((seg["growth"] - 1) * 100, 3)})
    idx = df["time"]
    pos = pd.DataFrame(closed)
    return pd.Series(rets, index=idx), pd.Series(weights, index=idx), {"fees": fees, "funding": funding}, pos


def side_summary(pos: pd.DataFrame, side: str) -> dict:
    k = side.lower()
    t = pos[pos["side"] == side] if not pos.empty else pos
    if t.empty:
        return {f"{k}_trades": 0, f"{k}_win_%": 0.0, f"{k}_avg_%": 0.0}
    return {f"{k}_trades": len(t), f"{k}_win_%": round((t["return_%"] > 0).mean() * 100, 1),
            f"{k}_avg_%": round(t["return_%"].mean(), 2)}


# ---------------------------------------------------------------------------
# Portfolio + main
# ---------------------------------------------------------------------------
def portfolio(coins, data, strategy, cfg, keep_rows=True):
    """Equal sleeves per coin; a coin not yet listed sits in cash."""
    strat_cols, hold_cols, rows, all_pos = {}, {}, [], []
    for coin in coins:
        df = data[coin]
        if strategy == "carry":
            rets, active, t = run_carry(df, cfg)
            if keep_rows:
                rows.append(carry_row(coin, df, rets, active, t))
        else:
            rets, weights, t, pos = run_fade(df, cfg)
            if keep_rows:
                h = perf(hold_returns(df))
                rows.append({"coin": coin, "from": f"{df['time'].iloc[0]:%Y-%m-%d}", **perf(rets),
                             "hold_cagr_%": h["cagr_%"], "hold_max_dd_%": h["max_drawdown_%"],
                             "days_in_trade_%": round((weights != 0).mean() * 100, 1),
                             **side_summary(pos, "LONG"), **side_summary(pos, "SHORT"),
                             "fees_%": round(t["fees"] * 100, 2),
                             "funding_%": round(t["funding"] * 100, 2)})
                if not pos.empty:
                    all_pos.append(pos.assign(coin=coin))
        strat_cols[coin] = rets
        hold_cols[coin] = hold_returns(df)
    strat = pd.DataFrame(strat_cols).sort_index().fillna(0.0).sum(axis=1) / len(coins)
    hold = pd.DataFrame(hold_cols).sort_index().fillna(0.0).sum(axis=1) / len(coins)
    return strat, hold, rows, (pd.concat(all_pos) if all_pos else pd.DataFrame())


def main():
    parser = argparse.ArgumentParser(description="Backtest funding carry / fade")
    parser.add_argument("--strategy", choices=["carry", "fade"], default="carry")
    parser.add_argument("--coins", nargs="+", default=["BTC", "ETH", "AVAX", "SOL", "ZEC"])
    parser.add_argument("--robustness", action="store_true")
    args = parser.parse_args()

    os.makedirs(RESULTS_DIR, exist_ok=True)
    coins = [c for c in args.coins if os.path.exists(f"{DATA_DIR}/{c}_1d.csv")]
    for c in set(args.coins) - set(coins):
        print(f"skip {c}: no data - run: python fetch_binance.py --coins {c}")
    if not coins:
        return
    data = {c: load(c) for c in coins}
    if args.strategy == "carry":
        no_spot = [c for c in coins if data[c]["spot_open"].isna().all()]
        if no_spot:
            print(f"WARNING: no spot data for {no_spot} - basis is assumed zero. Run fetch_binance.py again.")

    cfg = CarryConfig() if args.strategy == "carry" else FadeConfig()
    strat, hold, rows, pos = portfolio(coins, data, args.strategy, cfg)
    rows.append({"coin": "PORTFOLIO", "from": f"{strat.index[0]:%Y-%m-%d}", **perf(strat)})
    summary = pd.DataFrame(rows)
    years = yearly(strat, hold)

    tag = f"funding_{args.strategy}"
    summary.to_csv(f"{RESULTS_DIR}/{tag}_summary.csv", index=False)
    years.to_csv(f"{RESULTS_DIR}/{tag}_yearly.csv", index=False)
    if not pos.empty:
        pos.to_csv(f"{RESULTS_DIR}/{tag}_positions.csv", index=False)

    with pd.option_context("display.width", 250, "display.max_columns", 40):
        print(f"\n=== {args.strategy.upper()}: per coin and portfolio ===")
        print(summary.to_string(index=False))
        print("\n=== Portfolio by calendar year (hold = just owning the coins, for market context) ===")
        print(years.to_string(index=False))

    if args.robustness:
        variants = []
        if args.strategy == "carry":
            for window in (3, 7, 14):
                for entry, exit_ in ((0.10, 0.03), (0.15, 0.05), (0.25, 0.10), (0.40, 0.15)):
                    v = replace(cfg, window=window, entry_apr=entry, exit_apr=exit_)
                    s, _, _, _ = portfolio(coins, data, "carry", v, keep_rows=False)
                    variants.append({"window_d": window, "entry_apr_%": entry * 100,
                                     "exit_apr_%": exit_ * 100, **perf(s)})
        else:
            for short_above in (0.40, 0.60, 1.00):
                for hold_days in (5, 10, 20):
                    v = replace(cfg, short_above_apr=short_above, max_hold_days=hold_days)
                    s, _, _, _ = portfolio(coins, data, "fade", v, keep_rows=False)
                    variants.append({"short_above_apr_%": short_above * 100, "max_hold_days": hold_days, **perf(s)})
            variants.append({"short_above_apr_%": "-", "max_hold_days": "HOLD", **perf(hold)})
        rob = pd.DataFrame(variants)
        rob.to_csv(f"{RESULTS_DIR}/{tag}_robustness.csv", index=False)
        print("\n=== Robustness: portfolio under other settings ===")
        print(rob.to_string(index=False))

    print(f"\nSaved to ./{RESULTS_DIR}/ ({tag}_*.csv)")


if __name__ == "__main__":
    main()
