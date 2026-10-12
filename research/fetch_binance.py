"""
fetch_binance.py
================
Downloads LONG daily history from Binance USDⓈ-M perpetual futures:
  * daily candles (back to each contract's launch - BTC from Sept 2019)
  * funding payments (every 8 hours on most contracts)
and saves them in ./data/binance/ for backtest_momentum.py.

NODDY GUIDE
-----------
* Public market data - no API key or account needed.
* Usage:
      python fetch_binance.py                          # BTC ETH AVAX SOL ZEC
      python fetch_binance.py --coins BTC ETH DOGE     # any Binance perp, by coin name
      python fetch_binance.py --refresh                # re-download everything
* Output per coin:
      data/binance/BTC_1d.csv       -> time, open, high, low, close, volume
      data/binance/BTC_funding.csv  -> time, funding_rate (per payment, + = longs pay)
      data/binance/BTC_spot_1d.csv  -> spot daily candles (for the carry strategy)
  If you already have the perp files, a rerun only adds the missing spot files.
* Why Binance and not Hyperliquid? Hyperliquid only keeps ~5,000 candles and
  only launched in 2023. Binance perps go back to 2019-2020, so the test covers
  the 2021 bull, the 2022 crash, the 2023-24 recovery and so on. We still plan
  to TRADE on Hyperliquid - prices are near-identical between the two, and
  Binance funding is a reasonable stand-in for Hyperliquid's funding cost.
* If Binance blocks your location you'll see HTTP 451. That's a regional
  restriction on Binance's side, not a bug in this script.
"""

import argparse
import os
import time
from datetime import datetime, timezone

import pandas as pd
import requests

# Optional certificate fix (Macs / HTTPS-inspecting proxies): pip install truststore
try:
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

FAPI = "https://fapi.binance.com"      # Binance USDⓈ-M futures public API
SPOT_API = "https://api.binance.com"   # Binance spot public API (for the carry strategy)
DATA_DIR = "data/binance"
DAY_MS = 86_400_000                    # one day in milliseconds


def get(path: str, params: dict, max_retries: int = 6, base: str = FAPI):
    """GET one Binance endpoint, waiting and retrying politely if rate-limited.

    Binance uses HTTP 429 for "slow down" and 418 for "you ignored 429, now
    you're banned for a bit". Both include a Retry-After header in seconds.
    base = which Binance API (futures by default, SPOT_API for spot).
    """
    wait = 5
    for attempt in range(max_retries):
        resp = requests.get(base + path, params=params, timeout=30)
        if resp.status_code in (429, 418):
            wait = int(resp.headers.get("Retry-After", wait))
            print(f"   rate limited - waiting {wait}s (attempt {attempt + 1}/{max_retries})")
            time.sleep(wait)
            wait *= 2
            continue
        if resp.status_code == 451:
            raise SystemExit("Binance returned HTTP 451: not available from your location. "
                             "Try running this from your VPS instead.")
        if resp.status_code == 400:
            raise SystemExit(f"Binance rejected the request: {resp.text}  (is the symbol right?)")
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError("Still rate limited after several retries - wait a few minutes and rerun")


def fetch_daily_candles(symbol: str, spot: bool = False, start_ms: int = 0) -> pd.DataFrame:
    """All daily candles for one perp (or spot pair if spot=True), up to yesterday."""
    path, base, limit = ("/api/v3/klines", SPOT_API, 1000) if spot else ("/fapi/v1/klines", FAPI, 1500)
    rows, cursor = [], start_ms         # startTime=0 -> Binance starts at the first candle
    while True:
        batch = get(path, {"symbol": symbol, "interval": "1d", "startTime": cursor, "limit": limit},
                    base=base)
        if not batch:
            break
        rows.extend(batch)
        cursor = batch[-1][0] + DAY_MS  # next page starts the day after the last candle
        if len(batch) < limit:
            break                       # a part-full page means we've reached today
        time.sleep(0.5)
    if not rows:
        raise RuntimeError(f"No candles returned for {symbol} ({'spot' if spot else 'perp'})")

    # Each candle is a list: [open_time, open, high, low, close, volume, close_time, ...]
    df = pd.DataFrame(rows).iloc[:, :7]
    df.columns = ["t", "open", "high", "low", "close", "volume", "close_time"]
    now_ms = int(time.time() * 1000)
    df = df[df["close_time"] < now_ms]  # drop today's unfinished candle
    out = pd.DataFrame({
        "time": pd.to_datetime(df["t"], unit="ms", utc=True),
        "open": df["open"].astype(float),
        "high": df["high"].astype(float),
        "low": df["low"].astype(float),
        "close": df["close"].astype(float),
        "volume": df["volume"].astype(float),
    })
    return out.drop_duplicates("time").sort_values("time").reset_index(drop=True)


def fetch_funding(symbol: str, start_ms: int) -> pd.DataFrame:
    """All funding payments for one perp since start_ms (1000 rows ≈ 11 months per call)."""
    rows, cursor = [], start_ms
    while True:
        batch = get("/fapi/v1/fundingRate", {"symbol": symbol, "startTime": cursor, "limit": 1000})
        if not batch:
            break
        rows.extend(batch)
        cursor = batch[-1]["fundingTime"] + 1
        if len(batch) < 1000:
            break
        time.sleep(1.0)

    if not rows:
        return pd.DataFrame(columns=["time", "funding_rate"])
    raw = pd.DataFrame(rows)
    out = pd.DataFrame({
        "time": pd.to_datetime(raw["fundingTime"], unit="ms", utc=True),
        "funding_rate": raw["fundingRate"].astype(float),   # e.g. 0.0001 = 0.01% per payment
    })
    return out.drop_duplicates("time").sort_values("time").reset_index(drop=True)


def main():
    parser = argparse.ArgumentParser(description="Fetch long daily history from Binance perps")
    parser.add_argument("--coins", nargs="+", default=["BTC", "ETH", "AVAX", "SOL", "ZEC"])
    parser.add_argument("--refresh", action="store_true", help="re-download even if files exist")
    args = parser.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    for coin in args.coins:
        candle_file = f"{DATA_DIR}/{coin}_1d.csv"
        funding_file = f"{DATA_DIR}/{coin}_funding.csv"
        spot_file = f"{DATA_DIR}/{coin}_spot_1d.csv"
        symbol = f"{coin}USDT"              # Binance naming, e.g. BTCUSDT (same for perp and spot)

        # --- Perp candles + funding (skipped if we already have them) ----------
        if not args.refresh and os.path.exists(candle_file) and os.path.exists(funding_file):
            print(f"{coin:5s} perp + funding already downloaded - skipping")
            first_ms = int(pd.Timestamp(pd.read_csv(candle_file, nrows=1)["time"][0]).timestamp() * 1000)
        else:
            candles = fetch_daily_candles(symbol)
            first_ms = int(candles["time"].iloc[0].timestamp() * 1000)
            funding = fetch_funding(symbol, first_ms)
            candles.to_csv(candle_file, index=False)   # save only after BOTH succeed
            funding.to_csv(funding_file, index=False)
            print(f"{coin:5s} {len(candles):5d} days  {candles['time'].iloc[0]:%Y-%m-%d} -> "
                  f"{candles['time'].iloc[-1]:%Y-%m-%d}  {len(funding):6d} funding payments")
            time.sleep(2)

        # --- Spot candles, from the perp's first day (needed by the carry strategy)
        if args.refresh or not os.path.exists(spot_file):
            spot = fetch_daily_candles(symbol, spot=True, start_ms=first_ms)
            spot.to_csv(spot_file, index=False)
            print(f"{coin:5s} {len(spot):5d} spot days downloaded")
            time.sleep(1)

    print(f"Done at {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC. Files in ./{DATA_DIR}/")


if __name__ == "__main__":
    main()
