"""Offline checks for the backtest of our own pools (arbitrage swaps on a Chainlink price path).

Run: cd frontend && .venv/bin/python -I api/test_chain_history.py
"""
from __future__ import annotations

import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _engine as e  # noqa: E402

rng = np.random.default_rng(7)


def path(n=2000, vol=0.004, p0=2000e-12):
    """An hourly random walk of a raw token1-per-token0 price (WETH 18 / USDC 6 decimals: 2000 USDC = 2000e-12)."""
    return p0 * np.exp(np.cumsum(rng.normal(0, vol, n)))


def series(p, fee_pips=3000, L=1e15, spacing=60):
    ts = 1_780_000_000 + 3600.0 * np.arange(len(p))
    sw = e.arb_swaps(ts, p, L, fee_pips)
    sp1 = np.array(sw["sp1"])
    return e.Series(
        key="test", dec0=18, dec1=6, fee=fee_pips / 1e6, spacing=spacing, token0="WETH", token1="USDC",
        ts=np.array(sw["ts"]), sp0=np.array(sw["sp0"]), sp1=sp1, lpre=np.full(len(sp1), L), lpost=np.full(len(sp1), L),
        fee_raw=np.array(sw["fee"]), t0in=np.array(sw["t0in"], dtype=bool), tick=np.floor(2 * np.log(sp1) / e.LN).astype(np.int64),
        fee_per_l=np.array(sw["fee_per_l"]), source="chainlink",
    ), sw, ts


def order(lower: e.Side | None = None, upper: e.Side | None = None) -> dict:
    """An order as the app sends it: packed sides (made at tick 0 here, so levels are ticks from the entry price)."""
    w = lambda d: str(e.encode_word(d)) if d else "0"  # noqa: E731
    return {"lower": w(lower), "upper": w(upper)}


def req(**kw):
    r = {"pool": "test", "days": 60, "depositUsd": 10_000, "range": {"loPct": -5, "hiPct": 5}, "order": {}, "refTick": 0,
         "keeperFeeBps": 10, "slippagePct": 1, "delaySec": 12, "keeperCostUsd": 0.01, "keeperMode": "gas"}
    r.update(kw)
    return r


def test_pool_stays_in_the_fee_band():
    p = path()
    for fee in (100, 500, 3000, 10_000):
        _, sw, ts = series(p, fee)
        band = math.sqrt(1 - fee / 1e6)
        # after each swap the pool sits exactly on the edge of the band around the outside price
        ext = np.sqrt(p[np.searchsorted(ts, sw["ts"])])
        sp1 = np.array(sw["sp1"])
        assert np.all((sp1 >= ext * band * (1 - 1e-12)) & (sp1 <= ext / band * (1 + 1e-12))), fee
        # and swaps chain: each starts where the last ended
        assert np.allclose(np.array(sw["sp0"][1:]), sp1[:-1])


def test_fees_are_positive_and_match_the_trade():
    p = path()
    _, sw, _ = series(p, 3000, L=7e14)
    f = 0.003
    for sp0, sp1, fee, per_l, t0 in zip(sw["sp0"], sw["sp1"], sw["fee"], sw["fee_per_l"], sw["t0in"]):
        assert fee > 0 and per_l > 0
        net = (1 / sp1 - 1 / sp0) if t0 else (sp1 - sp0)  # token in per unit of liquidity
        assert math.isclose(per_l, net * f / (1 - f), rel_tol=1e-12)
        assert math.isclose(fee, 7e14 * per_l, rel_tol=1e-12)
        assert (sp1 < sp0) == t0  # token0 in pushes the price down


def test_moves_inside_the_band_do_not_trade():
    p = np.array([1.0, 1.001, 0.999, 1.0005, 1.02, 1.0195]) * 2000e-12
    _, sw, _ = series(p, 10_000)  # 1% band
    assert len(sw["ts"]) == 1  # only the 2% jump trades


def test_fees_do_not_depend_on_the_pool_size():
    p = path()
    a, _, ts = series(p, 3000, L=1e12)
    b, _, _ = series(p, 3000, L=1e18)
    ra = e.run(req(start=float(ts[0])), a)
    rb = e.run(req(start=float(ts[0])), b)
    assert math.isclose(ra["noRules"]["fees"], rb["noRules"]["fees"], rel_tol=1e-9)
    assert ra["noRules"]["fees"] > 0


def test_fees_scale_with_the_deposit():
    p = path()
    s, _, ts = series(p)
    r1 = e.run(req(start=float(ts[0]), depositUsd=1_000), s)
    r2 = e.run(req(start=float(ts[0]), depositUsd=100_000), s)
    assert math.isclose(r2["noRules"]["fees"], 100 * r1["noRules"]["fees"], rel_tol=1e-6)


def test_rules_that_never_fire_change_nothing():
    p = path()
    s, _, ts = series(p, 100)
    # base (WETH) is token0 here: "falls 99%" is the lower side, a level 46,000 ticks below the entry price
    far = order(lower=e.Side(checker=e.CHECK_TICK, value=-46_000, actions=e.ACT_REMOVE | e.ACT_KEEP_FEES, remove_bps=e.BPS))
    r = e.run(req(start=float(ts[0]), order=far), s)
    assert r["deposit"] == 10_000 and r["rules"]["runs"] == 0
    assert math.isclose(r["rules"]["final"], r["noRules"]["final"], rel_tol=1e-9)


def test_quote_usd_scales_values():
    p = path()
    s, _, ts = series(p)
    base = e.run(req(start=float(ts[0])), s)
    s.quote_usd = np.full(len(s.ts), 2.0)  # the quote token is worth $2
    two = e.run(req(start=float(ts[0])), s)
    # the same deposit in USD buys half the liquidity, so the result in USD is the same
    assert math.isclose(base["noRules"]["final"], two["noRules"]["final"], rel_tol=1e-9)
    assert two["quoteUsd"] == 2.0


def test_a_stop_loss_runs_once_on_a_crash():
    p = np.concatenate([np.full(50, 2000e-12) * np.exp(rng.normal(0, 0.001, 50)), np.linspace(2000e-12, 1500e-12, 200)])
    s, _, ts = series(p)
    # 10% below the entry price, then sell everything into USDC (token1)
    stop = order(lower=e.Side(checker=e.CHECK_TICK, value=-1054, actions=e.ACT_REMOVE | e.ACT_KEEP_FEES | e.ACT_SWAP, remove_bps=e.BPS, swap_to_token1=True))
    r = e.run(req(start=float(ts[0]), days=30, order=stop), s)
    assert r["rules"]["runs"] == 1 and r["rules"]["closed"]
    assert r["rules"]["final"] > r["noRules"]["final"]  # it left before the rest of the fall


def test_a_stop_loss_runs_the_same_on_a_pool_quoted_the_other_way():
    """The app's words are made for its own pool (here WETH first); a recorded pool may list USDC first. The engine
    mirrors the words: the same stop on the same prices runs at the same swap and ends with the same value."""
    p = np.concatenate([np.full(50, 2000e-12) * np.exp(rng.normal(0, 0.001, 50)), np.linspace(2000e-12, 1500e-12, 200)])
    s, _, ts = series(p)
    # the same pool with token0 and token1 swapped: price inverted (raw units), decimals swapped
    f = e.Series(key="test", dec0=6, dec1=18, fee=s.fee, spacing=s.spacing, token0="USDC", token1="WETH", ts=s.ts,
                 sp0=1 / s.sp0, sp1=1 / s.sp1, lpre=s.lpre, lpost=s.lpost, fee_raw=s.fee_raw, t0in=~s.t0in,
                 tick=np.floor(2 * np.log(1 / s.sp1) / e.LN).astype(np.int64), fee_per_l=s.fee_per_l, source="chainlink")
    assert f.base_is0 is False
    stop = order(lower=e.Side(checker=e.CHECK_TICK, value=-1054, actions=e.ACT_REMOVE | e.ACT_KEEP_FEES | e.ACT_SWAP, remove_bps=e.BPS, swap_to_token1=True))
    a = e.run(req(start=float(ts[0]), days=30, order=stop, baseIs0=True), s)
    b = e.run(req(start=float(ts[0]), days=30, order=stop, baseIs0=True), f)
    assert a["rules"]["runs"] == b["rules"]["runs"] == 1
    assert a["events"][0]["t"] == b["events"][0]["t"]
    assert math.isclose(a["rules"]["final"], b["rules"]["final"], rel_tol=2e-3)
    assert b["sides"]["upper"]["checker"] == e.CHECK_TICK  # base falls = the tick rises in the mirrored pool


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  ", t.__name__)
    print(f"{len(tests)} passed")
