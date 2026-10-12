"""
momentum_signal.py
==================
Daily time-series momentum with volatility targeting.

NODDY GUIDE
-----------
The idea in one line: "if a coin has gone up over the last few months, hold
some of it; the wilder it's being, hold less."

Step by step, once per DAY (at the daily close):
  1. VOTES - look back 30, 90 and 180 days. For each, ask "is price higher
     now than it was then?" Yes = +1 vote, no = -1 vote.
  2. TREND = the average vote. Three lookbacks give four possible values:
        all up -> 1.0     two up -> 0.33     one up -> -0.33    none up -> -1.0
     In long-only mode (the default) anything below zero becomes 0 = flat.
     Using several lookbacks means no single "magic number" decides it, and
     the position builds up / winds down in steps instead of all-or-nothing.
  3. VOLATILITY SIZING - measure how violently the coin has moved over the
     last 30 days (annualised volatility). Size = target_vol / actual_vol.
     e.g. target 50%, coin running at 100% vol -> hold half as much.
     This gives each coin a similar amount of RISK, so a wild coin like ZEC
     can't dominate the portfolio, and positions shrink in crashes (when
     volatility spikes) - which is exactly when you want smaller positions.
  4. TARGET WEIGHT = trend x size, capped at max_weight.
     Weight is a fraction of the capital set aside for that coin:
        0.0 = flat, 0.5 = half exposed, 1.0 = fully exposed (no leverage).

Why this rather than the 1h/4h signal? Daily trend-following across months
is the most-studied trend strategy in crypto and other markets. It trades
rarely (fees matter far less) and doesn't try to catch hourly wiggles.
It's still NOT guaranteed to work - the backtest is there to check.

No look-ahead: compute_targets() only ever uses closes up to and including
day t to make day t's target. backtest_momentum.py then trades at the NEXT
day's open. There's a built-in self-test for this - run:
    python momentum_signal.py
"""

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass
class MomentumConfig:
    lookbacks: tuple = (30, 90, 180)   # days - each one casts a vote
    vol_window: int = 30               # days used to measure volatility
    target_vol: float = 0.50           # aim each coin's position at ~50% annual volatility
    max_weight: float = 1.0            # cap exposure; 1.0 = no leverage
    allow_short: bool = False          # False = long or flat only
    rebalance_band: float = 0.10       # skip trades smaller than 10% of the coin's capital


def compute_targets(df: pd.DataFrame, cfg: MomentumConfig) -> pd.Series:
    """Target weight for every day, using only data up to that day.

    df needs a 'close' column of DAILY closes, oldest first.
    Returns a Series aligned with df: the weight wanted after each day's close.
    """
    close = df["close"]

    # 1+2) Average of +1/-1 votes across the lookbacks.
    #      close.shift(L) = the close L days ago, so this only looks backwards.
    votes = sum(np.sign(close / close.shift(L) - 1) for L in cfg.lookbacks) / len(cfg.lookbacks)
    if not cfg.allow_short:
        votes = votes.clip(lower=0)    # negative trend -> flat, never short

    # 3) Realised volatility: std of daily log returns, scaled to a year (365 days - crypto never closes)
    log_ret = np.log(close).diff()
    realised_vol = log_ret.rolling(cfg.vol_window).std() * np.sqrt(365)

    # 4) Size the position and cap it. Early days (not enough history) -> NaN -> 0.
    weight = (votes * cfg.target_vol / realised_vol).clip(-cfg.max_weight, cfg.max_weight)
    return weight.replace([np.inf, -np.inf], np.nan).fillna(0.0)


def latest_target(df: pd.DataFrame, cfg: MomentumConfig | None = None) -> float:
    """For a LIVE bot: the weight to hold now. Pass CLOSED daily candles only."""
    return float(compute_targets(df, cfg or MomentumConfig()).iloc[-1])


def should_trade(current: float, target: float, band: float) -> bool:
    """Only trade when it's worth it - keeps fees down.

    Always act when going to or from flat, otherwise only if the change is
    bigger than the band (e.g. 0.42 -> 0.47 isn't worth paying fees for).
    """
    if target == 0.0:
        return current != 0.0
    if current == 0.0:
        return True
    return abs(target - current) > band


# ---------------------------------------------------------------------------
# Self-test:  python momentum_signal.py
# Proves there's no look-ahead: targets computed on data cut off at day t must
# exactly match targets computed on the full history, for every day up to t.
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    rng = np.random.default_rng(0)
    n = 900
    close = 100 * np.exp(np.cumsum(rng.normal(0.0005, 0.04, n)))
    df = pd.DataFrame({"close": close})
    cfg = MomentumConfig()

    full = compute_targets(df, cfg)
    for cut in (200, 450, 899):
        partial = compute_targets(df.iloc[: cut + 1], cfg)
        assert np.allclose(partial.to_numpy(), full.iloc[: cut + 1].to_numpy()), f"look-ahead at {cut}!"
    print("No look-ahead: OK")
    print("Weights seen:", sorted(set(np.round(full[full > 0].to_numpy(), 2)))[:6], "...")
    print(f"Days invested: {(full > 0).mean():.0%}   average weight when in: {full[full > 0].mean():.2f}")
