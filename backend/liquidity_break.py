from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, List, Any, Optional


def _side_from_delta(delta: float) -> str:
    return "BUY" if delta >= 0 else "SELL"


def rebuild_clusters_from_ticks(
    ticks: List[Dict[str, Any]],
    symbol: str,
    delta_th: float,
    price_step: float,
) -> List[Dict[str, Any]]:
    """
    Rebuild closed clusters from tick history.

    Tick schema expected (at minimum):
      - price: float
      - side: "buy" | "sell"
      - volume_synthetic: float (or fallback 1.0)
      - timestamp: int (ms)
    """
    if delta_th <= 0:
        raise ValueError("delta_th must be > 0")
    if price_step <= 0:
        raise ValueError("price_step must be > 0")

    closed: List[Dict[str, Any]] = []
    cid = 0

    # forming cluster state
    delta = 0.0
    vol_total = 0.0
    open_p = high_p = low_p = close_p = None
    ts_open = None
    ts_close = None
    level_vol: Dict[int, float] = {}

    def close_cluster():
        nonlocal cid, delta, vol_total, open_p, high_p, low_p, close_p, ts_open, ts_close, level_vol

        if open_p is None:
            return

        # POC = level with highest volume
        poc_level = max(level_vol.items(), key=lambda kv: kv[1])[0] if level_vol else int(round(open_p / price_step))
        poc = poc_level * price_step

        c = {
            "id": cid,
            "symbol": symbol,
            "side": _side_from_delta(delta),
            "poc": float(poc),
            "delta_final": float(delta),
            "volume_total": float(vol_total),
            "ts_open": int(ts_open) if ts_open is not None else None,
            "ts_close": int(ts_close) if ts_close is not None else None,
            "price_open": float(open_p),
            "price_high": float(high_p),
            "price_low": float(low_p),
            "price_close": float(close_p),
        }
        closed.append(c)
        cid += 1

        # reset forming
        delta = 0.0
        vol_total = 0.0
        open_p = high_p = low_p = close_p = None
        ts_open = None
        ts_close = None
        level_vol = {}

    for t in ticks:
        try:
            price = float(t["price"])
        except Exception:
            continue

        side = (t.get("side") or "buy").lower()
        vol = t.get("volume_synthetic")
        if not isinstance(vol, (int, float)):
            vol = 1.0
        vol = float(vol)

        ts = t.get("timestamp")
        try:
            ts = int(ts) if ts is not None else None
        except Exception:
            ts = None

        # discretize by integer level index to avoid float drift
        level = int(round(price / price_step))
        dp = level * price_step

        if open_p is None:
            open_p = dp
            high_p = dp
            low_p = dp
            close_p = dp
            ts_open = ts
            ts_close = ts

        # update OHLC
        close_p = dp
        high_p = max(high_p, dp)
        low_p = min(low_p, dp)
        ts_close = ts

        # delta accumulation
        if side == "buy":
            delta += vol
        else:
            delta -= vol

        vol_total += vol
        level_vol[level] = level_vol.get(level, 0.0) + vol

        # close condition
        if abs(delta) >= delta_th:
            close_cluster()

    # ignore forming cluster for liquidity breaks (requirement: only closed clusters)
    return closed


def detect_liquidity_breaks(
    closed_clusters: List[Dict[str, Any]],
    *,
    price_step: float,
    min_steps: int = 2,
) -> List[Dict[str, Any]]:
    """
    Liquidity break detection (opposite-cluster only) + minimum displacement filter.

    BUY break: BUY.poc > last SELL.poc by at least min_steps*price_step
    SELL break: SELL.poc < last BUY.poc by at least min_steps*price_step
    """
    if price_step <= 0:
        raise ValueError("price_step must be > 0")
    if min_steps < 1:
        min_steps = 1

    min_move = price_step * float(min_steps)

    last_buy: Optional[Dict[str, Any]] = None
    last_sell: Optional[Dict[str, Any]] = None
    breaks: List[Dict[str, Any]] = []

    for c in closed_clusters:
        side = c.get("side")
        poc = c.get("poc")
        if poc is None or side not in ("BUY", "SELL"):
            continue

        poc = float(poc)

        if side == "BUY":
            if last_sell is not None:
                prev = float(last_sell["poc"])
                if (poc - prev) >= min_move:
                    breaks.append({
                        "type": "SELLERS_REPRICED_HIGHER",
                        "previousPOC": prev,
                        "breakingPOC": poc,
                        "move": float(poc - prev),
                        "min_move": float(min_move),

                        # where it happened (for plotting)
                        "cluster_id": c.get("id"),
                        "time": c.get("ts_close"),

                        # extra context
                        "delta": c.get("delta_final"),
                        "breakingVolume": c.get("volume_total"),
                        "prev_cluster_id": last_sell.get("id"),
                        "prev_time": last_sell.get("ts_close"),
                    })
            last_buy = c

        else:  # SELL
            if last_buy is not None:
                prev = float(last_buy["poc"])
                if (prev - poc) >= min_move:
                    breaks.append({
                        "type": "BUYERS_REPRICED_LOWER",
                        "previousPOC": prev,
                        "breakingPOC": poc,
                        "move": float(prev - poc),
                        "min_move": float(min_move),

                        "cluster_id": c.get("id"),
                        "time": c.get("ts_close"),

                        "delta": c.get("delta_final"),
                        "breakingVolume": c.get("volume_total"),
                        "prev_cluster_id": last_buy.get("id"),
                        "prev_time": last_buy.get("ts_close"),
                    })
            last_sell = c

    return breaks