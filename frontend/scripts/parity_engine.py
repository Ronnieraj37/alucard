"""Runs the backtest engine (api/_engine.py) on synthetic price paths for scripts/parity.ts.

stdin: {"paths": [{"ts": [...], "ticks": [...]}], "jobs": [{"rules": {...}, "path": i}]}
stdout: [{"ticks": [tl, tu], "sides": {...}, "swaps": n, "events": [[swap index, upper side?], ...]}]

A keeper that looks after every swap with no delay, and a pool deep enough that the order does not move the price.
"""
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "api"))
import _engine as e  # noqa: E402


def series(path: dict) -> e.Series:
    ticks = np.array(path["ticks"], dtype=np.int64)
    # a price strictly inside each tick, so floor(tick of the price) is exactly that tick (as on-chain)
    sp1 = (np.power(1.0001, ticks / 2.0) + np.power(1.0001, (ticks + 1) / 2.0)) / 2.0
    sp0 = np.concatenate([sp1[:1], sp1[:-1]])
    n = len(ticks)
    s = e.Series(key="synthetic", dec0=18, dec1=18, fee=0.003, spacing=60, token0="WETH", token1="USDC",
                 ts=np.array(path["ts"], dtype=float), sp0=sp0, sp1=sp1, lpre=np.full(n, 1e26), lpost=np.full(n, 1e26),
                 fee_raw=np.zeros(n), t0in=np.zeros(n, dtype=bool), tick=np.floor(2.0 * np.log(sp1) / e.LN).astype(np.int64))
    assert (s.tick == ticks).all()
    return s


def main() -> None:
    req = json.load(sys.stdin)
    cache: dict[int, e.Series] = {}
    out = []
    for job in req["jobs"]:
        p = job["path"]
        if p not in cache:
            cache[p] = series(req["paths"][p])
        s = cache[p]
        r = e.run_series(s, None, {"rules": job["rules"], "start": float(s.ts[0]), "days": 10_000, "delaySec": 0,
                                   "range": {"loPct": -5, "hiPct": 5}, "keeperFeeBps": 10, "slippagePct": 1})
        index = {float(t): i for i, t in enumerate(s.ts)}
        out.append({"ticks": r["ticks"], "sides": r["sides"], "swaps": r["swaps"],
                    "events": [[index[ev["t"]], ev["side"] == "upper"] for ev in r["events"]]})
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
