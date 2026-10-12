"""
paper_logger.py
===============
PAPER-TRADES the daily momentum strategy. Sends no orders, needs no keys.

NODDY GUIDE
-----------
Once a day, just after midnight UTC, this script:
  1. downloads daily candles from Hyperliquid (public data),
  2. throws away the candle that is still forming,
  3. asks momentum_signal.py what weight each coin should have,
  4. pretends to trade at the new day's opening price (with a fee),
  5. writes it all to a small SQLite file and sends ONE Telegram line.

Each coin gets its own pretend pot of money (a "sleeve", $100 by default).

Usage:
    python paper_logger.py                      # normal daily run (safe to run twice)
    python paper_logger.py --no-telegram        # print instead of sending
    python paper_logger.py --start 2026-09-01   # first run only: back-fill from that day
    python paper_logger.py --status             # show the pretend portfolio
    python paper_logger.py --verify             # re-check every logged weight from fresh data

Telegram: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment, or pass
--env-file pointing at a file containing those two lines (only those two are read).

It never touches the live trading bot, its container or its account.
"""

import argparse
import json
import math
import os
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import pandas as pd

from momentum_signal import MomentumConfig, latest_target, should_trade

HL_INFO = "https://api.hyperliquid.xyz/info"
DAY_MS = 86_400_000
DEFAULT_COINS = ["BTC", "ETH", "SOL", "AVAX", "ZEC"]
MIN_ORDER_USD = 10.0        # Hyperliquid minimum order value - counted, not enforced, on paper
HISTORY_DAYS = 260          # 180-day lookback + 30-day vol window + spare
HERE = os.path.dirname(os.path.abspath(__file__))


def day_str(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d")


def day_ms(day: str) -> int:
    return int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def fetch_daily(coin: str, start_ms: int, retries: int = 4) -> list[dict]:
    """Daily candles for one coin, oldest first: [{t, open, close}, ...]. t = candle open time (ms)."""
    body = json.dumps({
        "type": "candleSnapshot",
        "req": {"coin": coin, "interval": "1d", "startTime": start_ms, "endTime": int(time.time() * 1000)},
    }).encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request(HL_INFO, body, {"Content-Type": "application/json"})
            raw = json.load(urllib.request.urlopen(req, timeout=30))
            return sorted(({"t": int(c["t"]), "open": float(c["o"]), "close": float(c["c"])} for c in raw),
                          key=lambda c: c["t"])
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(5 * (attempt + 1))
    return []


def signal_for(candles: list[dict], signal_t: int, cfg: MomentumConfig) -> dict:
    """Target weight after the daily candle that OPENED at signal_t has closed.

    Only candles up to and including that one are passed to the signal, so nothing
    later (and never the forming candle) can leak in.
    """
    closed = [c for c in candles if c["t"] <= signal_t]
    if not closed or closed[-1]["t"] != signal_t:
        raise RuntimeError(f"no candle for {day_str(signal_t)}")
    df = pd.DataFrame({"close": [c["close"] for c in closed]})
    close = df["close"]
    # trend and vol are recomputed here for the log only; the weight comes from momentum_signal
    need = max(max(cfg.lookbacks), cfg.vol_window)
    trend = vol = float("nan")
    if len(close) > need:
        votes = [math.copysign(1, close.iloc[-1] / close.iloc[-1 - L] - 1) if close.iloc[-1] != close.iloc[-1 - L] else 0
                 for L in cfg.lookbacks]
        trend = max(0.0, sum(votes) / len(votes))
        log_ret = (close / close.shift(1)).apply(math.log)
        vol = float(log_ret.iloc[-cfg.vol_window:].std() * math.sqrt(365))
    return {"close": closed[-1]["close"], "trend": trend, "vol": vol, "target": latest_target(df, cfg),
            "history": len(closed)}


# ---------------------------------------------------------------------------
# storage
# ---------------------------------------------------------------------------
def open_db(path: str) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sleeves (coin TEXT PRIMARY KEY, units REAL NOT NULL, cash REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS daily (
            day TEXT NOT NULL,            -- signal day: the daily candle that closed (UTC)
            coin TEXT NOT NULL,
            close REAL, trend REAL, vol REAL,
            target REAL NOT NULL,         -- weight wanted after that close
            weight_before REAL NOT NULL,  -- weight held at the next open, before trading
            action TEXT NOT NULL,         -- BUY / SELL / HOLD
            weight_after REAL NOT NULL,
            exec_px REAL NOT NULL,        -- next day's open
            trade_usd REAL NOT NULL,      -- signed notional traded
            cost_usd REAL NOT NULL,
            below_min INTEGER NOT NULL,   -- 1 = a real order this size would be under the $10 minimum
            sleeve_usd REAL NOT NULL,     -- sleeve value at exec_px after costs
            logged_at TEXT NOT NULL,
            PRIMARY KEY (day, coin)
        );
    """)
    return db


def get_meta(db, key, default=None):
    row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(db, key, value):
    db.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
               (key, str(value)))


def init_or_check_settings(db, args) -> tuple[list[str], float, float]:
    """First run stores the settings; later runs must use the same ones (a changed
    sleeve size or fee half-way through would make the record meaningless)."""
    stored = get_meta(db, "coins")
    if stored is None:
        set_meta(db, "coins", ",".join(args.coins))
        set_meta(db, "sleeve_usd", args.sleeve_usd)
        set_meta(db, "fee", args.fee)
        for coin in args.coins:
            db.execute("INSERT INTO sleeves(coin,units,cash) VALUES(?,?,?)", (coin, 0.0, args.sleeve_usd))
        db.commit()
    coins = get_meta(db, "coins").split(",")
    sleeve_usd, fee = float(get_meta(db, "sleeve_usd")), float(get_meta(db, "fee"))
    for name, given, kept in (("coins", args.coins, coins), ("sleeve-usd", args.sleeve_usd, sleeve_usd),
                              ("fee", args.fee, fee)):
        if given != kept:
            print(f"note: --{name} {given} ignored; this database was started with {kept}", file=sys.stderr)
    return coins, sleeve_usd, fee


# ---------------------------------------------------------------------------
# one signal day
# ---------------------------------------------------------------------------
def process_day(db, coins, candles, signal_t, fee, cfg) -> list[dict]:
    """Log the signal for the candle opened at signal_t and paper-trade at the next open."""
    rows = []
    for coin in coins:
        sig = signal_for(candles[coin], signal_t, cfg)
        nxt = next((c for c in candles[coin] if c["t"] == signal_t + DAY_MS), None)
        if nxt is None:
            raise RuntimeError(f"{coin}: next day's open not available yet for {day_str(signal_t)}")
        px = nxt["open"]
        s = db.execute("SELECT units, cash FROM sleeves WHERE coin=?", (coin,)).fetchone()
        units, cash = s["units"], s["cash"]
        value = cash + units * px
        before = units * px / value if value > 0 else 0.0
        target = sig["target"]
        trade_usd = cost = 0.0
        action = "HOLD"
        if should_trade(before, target, cfg.rebalance_band):
            trade_usd = (target - before) * value
            cost = abs(trade_usd) * fee
            units = 0.0 if target == 0.0 else units + trade_usd / px
            cash -= trade_usd + cost
            action = "BUY" if trade_usd > 0 else "SELL"
        value = cash + units * px
        after = units * px / value if value > 0 else 0.0
        row = dict(day=day_str(signal_t), coin=coin, close=sig["close"], trend=sig["trend"], vol=sig["vol"],
                   target=target, weight_before=before, action=action, weight_after=after, exec_px=px,
                   trade_usd=trade_usd, cost_usd=cost,
                   below_min=int(action != "HOLD" and abs(trade_usd) < MIN_ORDER_USD), sleeve_usd=value,
                   logged_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
        db.execute("UPDATE sleeves SET units=?, cash=? WHERE coin=?", (units, cash, coin))
        db.execute(f"INSERT INTO daily({','.join(row)}) VALUES({','.join('?' * len(row))})", tuple(row.values()))
        rows.append(row)
    db.commit()   # one commit per day: a crash never leaves a half-logged day
    return rows


def summary_line(rows: list[dict], start_equity: float, caught_up: int) -> str:
    parts = []
    for r in rows:
        if r["action"] == "HOLD":
            parts.append(f"{r['coin']} {r['weight_after']:.2f}")
        else:
            flag = " (<$10)" if r["below_min"] else ""
            parts.append(f"{r['coin']} {r['weight_before']:.2f}→{r['weight_after']:.2f} "
                         f"{r['action']} ${abs(r['trade_usd']):.0f}{flag}")
    equity = sum(r["sleeve_usd"] for r in rows)
    extra = f" | caught up {caught_up} days" if caught_up > 1 else ""
    return (f"📝 PAPER momentum {rows[0]['day']} (not real trades): " + " · ".join(parts) +
            f" | equity ${equity:.2f} ({(equity / start_equity - 1) * 100:+.1f}%){extra}")


# ---------------------------------------------------------------------------
# telegram
# ---------------------------------------------------------------------------
def telegram_creds(env_file: str | None) -> tuple[str | None, str | None]:
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if env_file and not (token and chat):
        with open(env_file) as fh:
            for line in fh:
                key, _, value = line.strip().partition("=")
                if key == "TELEGRAM_BOT_TOKEN":
                    token = value.strip().strip('"\'')
                elif key == "TELEGRAM_CHAT_ID":
                    chat = value.strip().strip('"\'')
    return token, chat


def notify(text: str, args) -> None:
    print(text)
    if args.no_telegram:
        return
    token, chat = telegram_creds(args.env_file)
    if not (token and chat):
        print("(telegram not configured - printed only)", file=sys.stderr)
        return
    data = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
    try:
        urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data, timeout=20)
    except Exception as exc:   # never include the URL: it contains the token
        print(f"telegram send failed: {type(exc).__name__}", file=sys.stderr)


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------
def run(db, args, cfg) -> int:
    coins, sleeve_usd, fee = init_or_check_settings(db, args)
    last = db.execute("SELECT MAX(day) AS d FROM daily").fetchone()["d"]
    now = int(time.time() * 1000)
    latest_closed_t = (now // DAY_MS) * DAY_MS - DAY_MS      # open time of the newest CLOSED daily candle
    if last is not None:
        first_t = day_ms(last) + DAY_MS
    elif args.start:
        first_t = day_ms(args.start)
    else:
        first_t = latest_closed_t
    if first_t > latest_closed_t:
        print(f"nothing to do: {last} is already logged")
        return 0

    start_ms = first_t - HISTORY_DAYS * DAY_MS
    candles = {coin: fetch_daily(coin, start_ms) for coin in coins}
    rows, done = [], 0
    for signal_t in range(first_t, latest_closed_t + 1, DAY_MS):
        rows = process_day(db, coins, candles, signal_t, fee, cfg)
        done += 1
    notify(summary_line(rows, sleeve_usd * len(coins), done), args)
    return 0


def status(db) -> int:
    coins = (get_meta(db, "coins") or "").split(",")
    if coins == [""]:
        print("empty database - nothing logged yet")
        return 0
    sleeve_usd = float(get_meta(db, "sleeve_usd"))
    first, last, n = db.execute("SELECT MIN(day), MAX(day), COUNT(DISTINCT day) FROM daily").fetchone()
    print(f"paper momentum: {n} days logged, {first} -> {last}, fee {float(get_meta(db, 'fee')) * 100:.3f}%/side, "
          f"${sleeve_usd:.0f} per sleeve")
    total = 0.0
    for coin in coins:
        r = db.execute("SELECT * FROM daily WHERE coin=? ORDER BY day DESC LIMIT 1", (coin,)).fetchone()
        t = db.execute("SELECT COUNT(*) n, COALESCE(SUM(cost_usd),0) c, COALESCE(SUM(below_min),0) b "
                       "FROM daily WHERE coin=? AND action!='HOLD'", (coin,)).fetchone()
        total += r["sleeve_usd"]
        print(f"  {coin:5s} weight {r['weight_after']:.2f} (target {r['target']:.2f}, trend {r['trend']:.2f}, "
              f"vol {r['vol']:.2f})  sleeve ${r['sleeve_usd']:8.2f} ({(r['sleeve_usd'] / sleeve_usd - 1) * 100:+6.1f}%)  "
              f"trades {t['n']:3d}  under-$10 {t['b']:3d}  costs ${t['c']:.2f}")
    start = sleeve_usd * len(coins)
    print(f"  TOTAL ${total:.2f} ({(total / start - 1) * 100:+.1f}%) as of the {last} close + 1 day open")
    return 0


def verify(db, cfg) -> int:
    """Recompute every logged target from freshly downloaded candles. They must match exactly."""
    coins = (get_meta(db, "coins") or "").split(",")
    first = db.execute("SELECT MIN(day) AS d FROM daily").fetchone()["d"]
    if first is None:
        print("nothing logged yet")
        return 0
    bad = checked = revised = 0
    for coin in coins:
        candles = fetch_daily(coin, day_ms(first) - HISTORY_DAYS * DAY_MS)
        for r in db.execute("SELECT day, close, target FROM daily WHERE coin=? ORDER BY day", (coin,)):
            sig = signal_for(candles, day_ms(r["day"]), cfg)
            checked += 1
            if abs(sig["close"] - r["close"]) > 1e-9 * max(1.0, abs(r["close"])):
                revised += 1
                print(f"  {r['day']} {coin}: close was {r['close']} when logged, exchange now says {sig['close']}")
            if abs(sig["target"] - r["target"]) > 1e-9:
                bad += 1
                print(f"  MISMATCH {r['day']} {coin}: logged target {r['target']:.6f}, recomputed {sig['target']:.6f}")
    print(f"verify: {checked} weights checked, {bad} mismatches, {revised} revised closes")
    return 1 if bad else 0


def main() -> int:
    p = argparse.ArgumentParser(description="Paper-trade the daily momentum strategy (no orders, no keys).")
    p.add_argument("--db", default=os.path.join(HERE, "paper_momentum.db"))
    p.add_argument("--coins", nargs="+", default=DEFAULT_COINS)
    p.add_argument("--sleeve-usd", type=float, default=100.0, help="pretend capital per coin")
    p.add_argument("--fee", type=float, default=0.0007, help="cost per side (0.0007 = Hyperliquid spot taker)")
    p.add_argument("--start", help="first run only: back-fill from this signal day (YYYY-MM-DD)")
    p.add_argument("--env-file", help="file holding TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID")
    p.add_argument("--no-telegram", action="store_true")
    p.add_argument("--status", action="store_true")
    p.add_argument("--verify", action="store_true")
    args = p.parse_args()

    cfg = MomentumConfig()   # 30/90/180, 50% target vol, cap 1.0, long-only, 10% band
    db = open_db(args.db)
    try:
        if args.status:
            return status(db)
        if args.verify:
            return verify(db, cfg)
        return run(db, args, cfg)
    except Exception as exc:
        notify(f"⚠️ PAPER momentum logger failed: {type(exc).__name__}: {exc}", args)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
