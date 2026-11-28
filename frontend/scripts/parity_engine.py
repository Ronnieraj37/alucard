"""Runs the backtest engine (api/_engine.py) on synthetic price paths for scripts/parity.ts.

stdin: {"paths": [{"ts": [...], "ticks": [...]}], "oracleStart": t, "range": [tl, tu],
        "jobs": [{"order": {...words...}, "path": i}]}
stdout: [{"swaps": n, "events": [[row, upper side?], ...], "ratio": final value / value of just holding}]

The pool of test/EditorParity.t.sol: created at `oracleStart` at tick 0 (exactly price 1), with its liquidity (POOL_L), moved to a point inside each path tick by one swap (none when it is already there), with a
keeper that looks after every swap with no delay.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "api"))
import _engine as e  # noqa: E402


# the liquidity of test/EditorParity.t.sol's pool (RuleSetup's full-range 100e18), so the order's own swaps (re-centring,
# a move's way back) pay the same price impact in both
POOL_L = 100e18
ORDER_L = 1e15  # the order's liquidity there


def series(path: dict, oracle_start: float) -> e.Series:
    ticks = np.array(path["ticks"], dtype=np.int64)
    # a price strictly inside each tick, so floor(tick of the price) is exactly that tick (as on-chain)
    sp1 = (np.power(1.0001, ticks / 2.0) + np.power(1.0001, (ticks + 1) / 2.0)) / 2.0
    sp1[0] = 1.0  # the pool starts at exactly price 1; the test's first move swaps into tick 0's middle
    sp0 = np.concatenate([sp1[:1], sp1[:-1]])
    n = len(ticks)
    swapped = np.zeros(n, dtype=bool)
    swapped[1:] = sp1[1:] != sp0[1:]
    # each move is one swap paying the pool's 0.3% fee: per unit of liquidity in range, the input that moves the price
    # times f / (1 - f) (the order earns these fees in the replay too)
    f = 0.003
    down = sp1 < sp0
    with np.errstate(divide="ignore"):
        per_l = np.where(down, 1.0 / sp1 - 1.0 / sp0, sp1 - sp0)
    fee_per_l = np.where(swapped, np.abs(per_l) * f / (1 - f), 0.0)
    s = e.Series(key="synthetic", dec0=18, dec1=18, fee=f, spacing=60, token0="WETH", token1="USDC",
                 ts=np.array(path["ts"], dtype=float), sp0=sp0, sp1=sp1, lpre=np.full(n, POOL_L), lpost=np.full(n, POOL_L),
                 fee_raw=np.zeros(n), t0in=down, tick=np.floor(2.0 * np.log(sp1) / e.LN).astype(np.int64),
                 fee_per_l=fee_per_l, swapped=swapped, oracle_start=oracle_start)
    assert (s.tick[1:] == ticks[1:]).all()
    return s


def main() -> None:
    req = json.load(sys.stdin)
    cache: dict[int, e.Series] = {}
    out = []
    for job in req["jobs"]:
        p = job["path"]
        if p not in cache:
            cache[p] = series(req["paths"][p], float(req["oracleStart"]))
        s = cache[p]
        r = e.run_series(s, None, {"order": job["order"], "homeIndex": 1, "refTick": 0, "baseIs0": True, "ticks": req["range"],
                                   "start": float(s.ts[0]), "days": 10_000, "liquidity": ORDER_L, "delaySec": 0, "keeperFeeBps": 10, "slippagePct": 5})
        index = {float(t): i for i, t in enumerate(s.ts)}
        # money: what the owner ends with, over what the deposited tokens are worth if just held (both at the last price)
        out.append({"swaps": r["swaps"], "events": [[index[ev["t"]], ev["side"] == "upper"] for ev in r["events"]],
                    "ratio": r["rules"]["final"] / r["hold"]["final"]})
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
