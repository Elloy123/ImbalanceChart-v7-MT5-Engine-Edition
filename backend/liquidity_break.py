"""
Cluster rebuild + Liquidity Break detection (backend-side).

Pure functions — unit-testable without any MT5 or WebSocket dependencies.
"""
from typing import List, Dict, Any, Optional


def rebuild_clusters_from_ticks(
    ticks: List[Dict[str, Any]],
    symbol: str,
    delta_th: float,
    price_step: float,
) -> List[Dict[str, Any]]:
    """
    Iterate *ticks* in time order and return a list of **closed** cluster dicts.

    Parameters
    ----------
    ticks      : list of tick dicts containing at least:
                 'price', 'volume_synthetic', 'side' ('buy'/'sell'), 'timestamp'
    symbol     : instrument name (stored in each cluster snapshot)
    delta_th   : absolute delta threshold; cluster closes when abs(delta) >= delta_th
    price_step : price discretisation step (must be > 0)
    """
    if price_step <= 0:
        raise ValueError("price_step must be > 0")

    closed: List[Dict[str, Any]] = []

    # Current open cluster state
    delta: float = 0.0
    vol_by_level: Dict[int, float] = {}   # level_index -> cumulative volume
    ts_open: Optional[int] = None
    price_open: Optional[float] = None
    price_high: Optional[float] = None
    price_low: Optional[float] = None
    cluster_id: int = 0

    def _close_cluster(ts_close: int, price_close: float) -> Dict[str, Any]:
        nonlocal cluster_id
        cluster_id += 1

        # POC = level with maximum cumulative volume
        if not vol_by_level:
            poc = price_close
        else:
            poc_level = max(vol_by_level, key=lambda lvl: vol_by_level[lvl])
            poc = poc_level * price_step
        volume_total = sum(vol_by_level.values())
        side = "BUY" if delta >= 0 else "SELL"

        return {
            "id": cluster_id,
            "symbol": symbol,
            "side": side,
            "poc": round(poc, 10),
            "delta_final": round(delta, 4),
            "volume_total": round(volume_total, 4),
            "ts_open": ts_open,
            "ts_close": ts_close,
            "price_open": price_open,
            "price_high": price_high,
            "price_low": price_low,
            "price_close": round(price_close, 10),
        }

    def _reset_open():
        nonlocal delta, vol_by_level, ts_open, price_open, price_high, price_low
        delta = 0.0
        vol_by_level = {}
        ts_open = None
        price_open = None
        price_high = None
        price_low = None

    for tick in ticks:
        try:
            price: float = float(tick["price"])
            vol: float = float(tick["volume_synthetic"])
            side: str = str(tick["side"]).lower()
            ts: int = int(tick["timestamp"])
        except (KeyError, TypeError, ValueError):
            continue

        # Initialise open cluster on first valid tick
        if ts_open is None:
            ts_open = ts
            price_open = price
            price_high = price
            price_low = price

        # Accumulate delta
        if side == "buy":
            delta += vol
        else:
            delta -= vol

        # Discretise price to avoid float drift
        level = int(round(price / price_step))
        vol_by_level[level] = vol_by_level.get(level, 0.0) + vol

        # Update OHLC for the open cluster
        if price_high is None or price > price_high:
            price_high = price
        if price_low is None or price < price_low:
            price_low = price

        # Close cluster when threshold is crossed
        if abs(delta) >= delta_th:
            closed.append(_close_cluster(ts, price))
            _reset_open()

    # Discard any partially-open cluster (user wants closed clusters only)
    return closed


def detect_liquidity_breaks(
    closed_clusters: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Scan *closed_clusters* in order and return a list of liquidity-break events.

    Logic (opposite-cluster only):
    - BUY  cluster whose POC > last SELL cluster's POC  => SELLERS_REPRICED_HIGHER
    - SELL cluster whose POC < last BUY  cluster's POC  => BUYERS_REPRICED_LOWER
    """
    breaks: List[Dict[str, Any]] = []
    last_buy: Optional[Dict[str, Any]] = None
    last_sell: Optional[Dict[str, Any]] = None

    for cluster in closed_clusters:
        side = cluster.get("side", "")
        poc = cluster.get("poc", 0.0)

        if side == "BUY":
            if last_sell is not None and poc > last_sell["poc"]:
                breaks.append({
                    "type": "SELLERS_REPRICED_HIGHER",
                    "previousPOC": last_sell["poc"],
                    "breakingPOC": poc,
                    "delta": cluster["delta_final"],
                    "breakingVolume": cluster["volume_total"],
                    "time": cluster["ts_close"],
                    "cluster_id": cluster["id"],
                })
            last_buy = cluster

        elif side == "SELL":
            if last_buy is not None and poc < last_buy["poc"]:
                breaks.append({
                    "type": "BUYERS_REPRICED_LOWER",
                    "previousPOC": last_buy["poc"],
                    "breakingPOC": poc,
                    "delta": cluster["delta_final"],
                    "breakingVolume": cluster["volume_total"],
                    "time": cluster["ts_close"],
                    "cluster_id": cluster["id"],
                })
            last_sell = cluster

    return breaks
