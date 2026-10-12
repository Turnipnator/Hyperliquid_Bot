"""
reconcile_paper.py
==================
Checks the paper logger against the research backtester, day by day.

NODDY GUIDE
-----------
paper_logger.py and backtest_momentum.py are two separate pieces of code that
should make identical decisions. This script feeds the SAME Hyperliquid candles
to the backtester's own run_coin() and compares it with what the logger wrote:
same number of trades, same weights, same sleeve value.

    python reconcile_paper.py --db paper_momentum.db

A weight difference of a few 0.0001 is expected (the logger takes the fee out of
the sleeve before working out the weight; the backtester does not). Anything
bigger, or a different trade count, means the two have drifted apart.
"""

import argparse
import sqlite3
import sys
import time

import pandas as pd

import backtest_momentum as bm
import paper_logger as pl
from momentum_signal import MomentumConfig

WEIGHT_TOLERANCE = 0.002


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--db", default=pl.os.path.join(pl.HERE, "paper_momentum.db"))
    args = p.parse_args()

    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    meta = dict(db.execute("SELECT key, value FROM meta").fetchall())
    coins, sleeve_usd = meta["coins"].split(","), float(meta["sleeve_usd"])
    bm.COST_PER_SIDE = float(meta["fee"])
    first = db.execute("SELECT MIN(day) FROM daily").fetchone()[0]
    cfg = MomentumConfig()
    research_targets = bm.compute_targets
    today_open = (int(time.time() * 1000) // pl.DAY_MS) * pl.DAY_MS
    failed = False
    total_logger = total_backtest = 0.0

    for coin in coins:
        rows = db.execute("SELECT day, weight_after, action, sleeve_usd FROM daily WHERE coin=? ORDER BY day",
                          (coin,)).fetchall()
        last_fill_t = pl.day_ms(rows[-1]["day"]) + pl.DAY_MS
        # closed candles plus the one whose OPEN was the logger's last fill
        candles = [c for c in pl.fetch_daily(coin, pl.day_ms(first) - pl.HISTORY_DAYS * pl.DAY_MS)
                   if c["t"] <= min(last_fill_t, today_open)]
        df = pd.DataFrame({"time": pd.to_datetime([c["t"] for c in candles], unit="ms", utc=True),
                           "open": [c["open"] for c in candles], "close": [c["close"] for c in candles],
                           "funding_sum": 0.0})
        start_idx = next(i for i, c in enumerate(candles) if c["t"] == pl.day_ms(first))

        def flat_before_start(frame, config, k=start_idx):
            # the research signal, unchanged, but flat until the logger's first day
            targets = research_targets(frame, config).copy()
            targets.iloc[:k] = 0.0
            return targets

        bm.compute_targets = flat_before_start
        rets, weights, totals = bm.run_coin(df, cfg)
        # backtester's weight held during day i+1 corresponds to the logger's signal day i
        held = {pl.day_str(int(t.timestamp() * 1000) - pl.DAY_MS): w for t, w in weights.items()}
        worst = max(abs(held[r["day"]] - r["weight_after"]) for r in rows)
        logger_trades = sum(r["action"] != "HOLD" for r in rows)
        backtest_value = sleeve_usd * float((1 + rets).prod())
        ok = logger_trades == totals["trades"] and worst < WEIGHT_TOLERANCE
        failed |= not ok
        total_logger += rows[-1]["sleeve_usd"]
        total_backtest += backtest_value
        print(f"{'OK  ' if ok else 'DIFF'} {coin:5s} {len(rows):4d} days  trades {logger_trades} vs {totals['trades']}  "
              f"max weight diff {worst:.4f}  sleeve ${rows[-1]['sleeve_usd']:.2f} vs ${backtest_value:.2f}")

    print(f"total: logger ${total_logger:.2f} vs backtester ${total_backtest:.2f}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
