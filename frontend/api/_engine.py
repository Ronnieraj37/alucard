"""Alucard backtest engine: replays real Uniswap swaps against a position with rules.

Semantics follow src/ConditionalOrders.sol run by run:
  * a side fires when its condition holds after a swap (EDGE: tick past edge +- value, TICK: a tick level, possibly
    in another pool, TIME: lastRun + minutes, TRAIL: the price turned back `value` ticks from the best tick seen).
    A side may have a second condition joined by AND / OR.
  * trailing stops: the best tick is updated at every swap (assumes someone pokes each new best, as the keeper does)
  * hold: the side is armed (poke) `delay` seconds after its condition first holds, if it still holds then; it may run
    from hold to 2 x hold after arming, if its condition holds then; otherwise the arming expires and it is re-armed
  * a keeper executes it `delay` seconds later, at the price after the first swap at or past that time, and only if
    the condition still holds then (the contract re-checks)
  * remove (removeBps) -> keeper reserve (maxKeeperFeeBps of what came out) -> fees kept or paid out (bit 0)
    -> optional swap (stops at the slippage limit, skipped if already past it) -> optional add (same range, or
    one-sided next to the price) -> side updated (lastRun, TICK step, or cleared) -> keeper paid -> close if no
    liquidity is left or both sides are off -> refused if the same side would fire again at once (WouldRefire)

Fees use the validated swap replay of lp_study (lp_sim.swap_shares): each swap pays a unit of liquidity
overlap_fraction / pool_liquidity of its LP fee. Valid while the position is small next to the pool.

Not modelled, stated in the output: the position's own swaps do not move later prices; price manipulation; MEV.

Only numpy. Pure functions, so tests in lp_study can import this file directly.
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field, replace

import numpy as np

LN = math.log(1.0001)
MIN_TICK, MAX_TICK = -887272, 887272
BPS = 10_000
CHECK_OFF, CHECK_EDGE, CHECK_TICK, CHECK_TIME, CHECK_TRAIL, CHECK_ORACLE = 0, 1, 2, 3, 4, 5
LEVELS = (CHECK_TICK, CHECK_ORACLE)  # a price level: the pool's price or the pair's Chainlink price; a repeating one steps
COMBINE_NONE, COMBINE_AND, COMBINE_OR = 0, 1, 2
BASE_TIME = 1_767_225_600  # OrderState.BASE_TIME: stored times round up to the minute after this
ACT_KEEP_FEES, ACT_REMOVE, ACT_SWAP, ACT_ADD = 1, 2, 4, 8
ADD_SAME, ADD_ONE_SIDED = 0, 1
MAX_RUNS = 5000

QUOTE_RANK = ["USDC", "USDT", "DAI", "WETH", "ETH", "WBTC", "LINK"]
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_data")
_CACHE: dict[str, "Series"] = {}


# ---------------------------------------------------------------- data


@dataclass
class Series:
    key: str
    dec0: int
    dec1: int
    fee: float
    spacing: int
    token0: str
    token1: str
    ts: np.ndarray
    sp0: np.ndarray
    sp1: np.ndarray
    lpre: np.ndarray
    lpost: np.ndarray
    fee_raw: np.ndarray
    t0in: np.ndarray
    tick: np.ndarray  # tick after each swap

    @property
    def base_is0(self) -> bool:
        """The base is the token people price ("1 WETH = x USDC"); same ranking as the frontend's lib/pools.ts."""
        rank = lambda t: QUOTE_RANK.index(t) if t in QUOTE_RANK else len(QUOTE_RANK)  # noqa: E731
        return rank(self.token0) > rank(self.token1)

    def price(self, sp):
        """Base price in quote (USDC per WETH for the recorded pools) from a raw sqrt price."""
        t1per0 = np.square(sp) * 10.0 ** (self.dec0 - self.dec1)
        return t1per0 if self.base_is0 else 1.0 / t1per0

    def tick_at_price(self, price: float) -> float:
        t1per0 = price if self.base_is0 else 1.0 / price
        return math.log(t1per0 * 10.0 ** (self.dec1 - self.dec0)) / LN


def load(key: str) -> Series:
    if key in _CACHE:
        return _CACHE[key]
    z = np.load(os.path.join(DATA_DIR, f"{key}.npz"))
    m = json.loads(str(z["meta"]))
    sp1 = z["sp1"]
    s = Series(
        key=key, dec0=m["dec0"], dec1=m["dec1"], fee=m["fee"], spacing=m["spacing"], token0=m["token0"], token1=m["token1"],
        ts=z["ts"], sp0=z["sp0"], sp1=sp1, lpre=z["lpre"], lpost=z["lpost"], fee_raw=z["fee"], t0in=z["t0in"].astype(bool),
        tick=np.floor(2.0 * np.log(sp1) / LN).astype(np.int64),
    )
    _CACHE[key] = s
    return s


POOL_LABELS = {"eth_usdc_030": "ETH/USDC 0.30% (Ethereum mainnet)", "eth_usdc_005": "ETH/USDC 0.05% (Ethereum mainnet)"}
OTHER_POOL = {"eth_usdc_030": "eth_usdc_005", "eth_usdc_005": "eth_usdc_030"}


# ---------------------------------------------------------------- Uniswap math (raw units, as in lp_study/univ3.py)


def sqrt_at(tick) -> float:
    return 1.0001 ** (tick / 2.0)


def amounts(L: float, sp: float, sa: float, sb: float) -> tuple[float, float]:
    spc = min(max(sp, sa), sb)
    return L * (1.0 / spc - 1.0 / sb), L * (spc - sa)


def liquidity_for(sp: float, sa: float, sb: float, a0: float, a1: float) -> float:
    if sp <= sa:
        return a0 / (1 / sa - 1 / sb)
    if sp >= sb:
        return a1 / (sb - sa)
    return min(a0 / (1 / sp - 1 / sb), a1 / (sp - sa))


def overlap_frac(sp0, sp1, sa, sb):
    lo_p, hi_p = np.minimum(sp0, sp1), np.maximum(sp0, sp1)
    lo, hi = np.maximum(lo_p, sa), np.minimum(hi_p, sb)
    up = sp1 > sp0
    ok = (hi > lo) & (hi_p > lo_p)
    with np.errstate(divide="ignore", invalid="ignore"):
        num = np.where(up, hi - lo, 1.0 / lo - 1.0 / hi)
        den = np.where(up, hi_p - lo_p, 1.0 / lo_p - 1.0 / hi_p)
        return np.clip(np.where(ok, num / den, 0.0), 0.0, 1.0)


def floor_to(t: float, s: int) -> int:
    return int(math.floor(t / s) * s)


def min_usable(s: int) -> int:
    return math.ceil(MIN_TICK / s) * s


def max_usable(s: int) -> int:
    return math.floor(MAX_TICK / s) * s


def ticks_for_pct(pct: float) -> int:
    return max(0, round(math.log(1 + pct / 100) / LN))


def ticks_for_move(pct: float, rise: bool) -> int:
    """Ticks for a base-price move of pct: a rise (up lane) or a fall (down lane). Same as lib/rules.ts."""
    x = math.log(1 + pct / 100) if rise else -math.log(1 - min(pct, 99.99) / 100)
    return max(1, round(x / LN))


def stored_time(t: float) -> float:
    """A time as the contract stores it: minutes after BASE_TIME, rounded up."""
    if t <= BASE_TIME:
        return t
    return BASE_TIME + math.ceil((t - BASE_TIME) / 60) * 60


# ---------------------------------------------------------------- rules: UI model -> contract sides (port of frontend lib/rules.ts)


@dataclass
class Side:
    edge: int = 0
    checker: int = 0
    value: int = 0
    check_pool: str | None = None  # TICK: key of the pool whose tick is read (None = own pool)
    actions: int = 0
    remove_bps: int = 0
    swap_to_token1: bool = False
    add_mode: int = 0
    repeat: bool = False
    shape: int = 0
    last_run: float = 0.0
    checker2: int = 0
    value2: int = 0
    check_pool2: str | None = None
    combine: int = 0
    hold_min: int = 0
    armed_at: float = 0.0  # hold: when the side was armed (0 = not armed)
    best: int = 0  # TRAIL: best tick seen
    runs_left: int = 0

    def conds(self):
        """(checker, value, pool) of condition A and, if any, condition B."""
        out = [(self.checker, self.value, self.check_pool)]
        if self.combine != COMBINE_NONE and self.checker2 != CHECK_OFF:
            out.append((self.checker2, self.value2, self.check_pool2))
        return out

    def trails(self) -> bool:
        return any(c == CHECK_TRAIL for c, _, _ in self.conds())

    def trail_pool(self) -> str | None:
        return next((p for c, _, p in self.conds() if c == CHECK_TRAIL), None)


def contract_side(base_is0: bool, lane: str) -> str:
    return "upper" if (lane == "up") == base_is0 else "lower"


def _encode_trigger(s: Series, lane_id: str, t: dict, entry_price: float, watched: Series) -> tuple[int, int, str | None]:
    if t["kind"] == "leave":
        return CHECK_EDGE, ticks_for_pct(t.get("bufferPct") or 0), None
    if t["kind"] in ("price", "otherPool"):
        price = t["price"] if "price" in t and t["price"] is not None else entry_price * (1 + (t.get("pricePct") or 0) / 100)
        return CHECK_TICK, round(watched.tick_at_price(price)), (watched.key if watched.key != s.key else None)
    if t["kind"] == "oracle":  # the pair's Chainlink price as a tick of this pool
        price = t["price"] if "price" in t and t["price"] is not None else entry_price * (1 + (t.get("pricePct") or 0) / 100)
        return CHECK_ORACLE, round(s.tick_at_price(price)), None
    if t["kind"] == "trail":
        return CHECK_TRAIL, ticks_for_move(t.get("trailPct") or 5, lane_id == "up"), None
    return CHECK_TIME, max(1, round((t.get("hours") or 24) * 60)), None


def encode_lane(s: Series, lane_id: str, lane: dict, entry_price: float, watched: Series,
                other: Series | None = None, other_entry: float | None = None) -> tuple[str, Side]:
    """lane: {trigger, trigger2?, combine?, holdMinutes?, maxRuns?, actions: [{kind, pct?, to?, widthPct?}], repeat, stepPct?}
    trigger: {kind, bufferPct?, pricePct?, price?, hours?, trailPct?}.
    Price triggers come as pricePct (relative to the entry price of the pool they watch), because absolute prices of
    today do not apply to a past window; `price` (absolute) is accepted too, for tests.
    `watched` is the pool that decides the contract side (the first trigger that reads another pool); `other` is
    that other pool when a trigger reads it."""
    side_name = contract_side(watched.base_is0, lane_id)
    d = Side()
    t = lane.get("trigger")
    acts = {a["kind"]: a for a in lane.get("actions", [])}
    if not t or not acts:
        return side_name, d
    upper = side_name == "upper"
    follow = acts.get("follow")

    def enc(tr: dict):
        if tr["kind"] == "otherPool":  # reads the other pool, priced from that pool's entry price
            pool = other if other is not None else watched
            return _encode_trigger(s, lane_id, tr, other_entry if other is not None and other_entry is not None else entry_price, pool)
        return _encode_trigger(s, lane_id, tr, entry_price, s)

    d.checker, d.value, d.check_pool = enc(t)
    if t["kind"] == "leave" and follow and lane.get("repeat"):
        d.value = max(d.value, s.spacing)
    t2 = lane.get("trigger2")
    if t2:
        d.checker2, d.value2, d.check_pool2 = enc(t2)
        d.combine = COMBINE_OR if lane.get("combine") == "or" else COMBINE_AND

    collect = "collect" in acts
    bits = 0 if collect else ACT_KEEP_FEES
    if "withdraw" in acts:
        bits |= ACT_REMOVE
        d.remove_bps = round((acts["withdraw"].get("pct") or 100) * 100)
    elif collect:
        bits |= ACT_REMOVE
        d.remove_bps = 0
    if "convert" in acts:
        bits |= ACT_SWAP
        to_base = acts["convert"].get("to") == "base"
        target_is0 = s.base_is0 == to_base
        d.swap_to_token1 = not target_is0
    if "readd" in acts:
        bits |= ACT_ADD
        d.add_mode = ADD_SAME
    if follow:
        bits |= ACT_ADD | ACT_REMOVE
        d.remove_bps = BPS
        d.add_mode = ADD_ONE_SIDED
        w = max(1, min(2047, math.ceil(ticks_for_pct(follow.get("widthPct") or 5) / s.spacing)))
        d.shape = w if upper else (w << 11)
    d.actions = bits
    d.repeat = bool(lane.get("repeat"))
    steps = d.checker in LEVELS or (d.combine != COMBINE_NONE and d.checker2 in LEVELS)
    if d.repeat and steps and not follow:  # with Follow the shape field holds the new range's width
        d.shape = ticks_for_pct(lane.get("stepPct") or 5)
    d.hold_min = max(0, round(lane.get("holdMinutes") or 0))
    d.runs_left = max(0, round(lane.get("maxRuns") or 0)) if d.repeat else 0
    return side_name, d


# ---------------------------------------------------------------- simulation


@dataclass
class Params:
    keeper_fee_bps: int = 10
    slippage_steps: int = 10  # x10 ticks, like Order.maxSlippage
    delay_s: float = 12.0
    keeper_cost_usd: float = 0.01  # gas cost of one run in USD
    keeper_mode: str = "gas"  # "gas": paid gas cost (native-ETH pools); "ceiling": takes the whole reserve (ERC20 pools)


@dataclass
class State:
    L: float = 0.0
    tl: int = 0
    tu: int = 0
    f0: float = 0.0  # uncollected fees of the position, raw
    f1: float = 0.0
    w0: float = 0.0  # owner's wallet (everything paid out), raw
    w1: float = 0.0
    sides: dict = field(default_factory=dict)
    open: bool = True
    keeper_usd: float = 0.0
    fees_usd: float = 0.0  # fees earned, valued when collected
    runs: int = 0
    in_range_s: float = 0.0
    live_s: float = 0.0


class Sim:
    def __init__(self, s: Series, i0: int, i1: int, p: Params, other: Series | None):
        self.s, self.i0, self.i1, self.p, self.other = s, i0, i1, p, other
        self.events: list[dict] = []
        self.samples: dict[int, float] = {}
        self.ranges: dict[int, tuple[float, float]] = {}
        # other pool's tick at each of our swaps (for TICK checks on another pool)
        if other is not None:
            idx = np.clip(np.searchsorted(other.ts, s.ts[i0:i1], side="right") - 1, 0, len(other.ts) - 1)
            self.other_tick = np.full(len(s.ts), 0, dtype=np.int64)
            self.other_tick[i0:i1] = other.tick[idx]
        else:
            self.other_tick = None

    def usd(self, a0: float, a1: float, sp: float) -> float:
        s = self.s
        price = float(s.price(sp))
        h0, h1 = a0 / 10**s.dec0, a1 / 10**s.dec1
        # value in quote units: the quote token is worth 1, the base token `price`
        return h0 + h1 * price if not s.base_is0 else h0 * price + h1

    # ---- conditions
    def _ticks(self, pool: str | None) -> np.ndarray:
        if pool and self.other_tick is not None:
            return self.other_tick
        return self.s.tick

    def _cond_mask(self, st: State, name: str, d: Side, cond: tuple, i: int, j: int) -> np.ndarray:
        checker, value, pool = cond
        if checker == CHECK_TIME:
            return self.s.ts[i:j] >= d.last_run + value * 60
        t = self._ticks(pool)[i:j]
        if checker == CHECK_EDGE:
            return t >= st.tu + value if name == "upper" else t < st.tl - value
        if checker == CHECK_TICK:
            return t >= value if name == "upper" else t < value
        if checker == CHECK_ORACLE:
            # no Chainlink history is recorded: the pool's own price stands in for the feed (see the caveats)
            o = self.s.tick[i:j]
            return o >= value if name == "upper" else o < value
        if checker == CHECK_TRAIL:
            # the best tick is moved at every swap: lower side keeps the highest tick, upper side the lowest
            if name == "upper":
                best = np.minimum(d.best, np.minimum.accumulate(t))
                return t >= best + value
            best = np.maximum(d.best, np.maximum.accumulate(t))
            return t < best - value
        return np.zeros(j - i, dtype=bool)

    def mask(self, st: State, name: str, d: Side, i: int, j: int) -> np.ndarray:
        cs = d.conds()
        m = self._cond_mask(st, name, d, cs[0], i, j)
        if len(cs) == 2:
            m2 = self._cond_mask(st, name, d, cs[1], i, j)
            m = (m & m2) if d.combine == COMBINE_AND else (m | m2)
        return m

    def cond_at(self, st: State, name: str, d: Side, k: int) -> bool:
        return bool(self.mask(st, name, d, k, k + 1)[0])

    def move_best(self, st: State, i: int, k: int) -> None:
        """Trailing stops: take the best tick of swaps (i, k] (someone pokes each new best)."""
        for name, d in st.sides.items():
            if d.checker == CHECK_OFF or not d.trails() or k <= i:
                continue
            t = self._ticks(d.trail_pool())[i + 1 : k + 1]
            d.best = int(min(d.best, t.min())) if name == "upper" else int(max(d.best, t.max()))

    def first_true(self, st: State, name: str, d: Side, i: int) -> int | None:
        """First index >= i where the side's condition holds (searches in growing chunks)."""
        end = self.i1
        step = 4096
        d = replace(d)  # trailing best moves while scanning; keep the side itself unchanged
        while i < end:
            j = min(end, i + step)
            hit = np.flatnonzero(self.mask(st, name, d, i, j))
            if len(hit):
                return i + int(hit[0])
            self._carry_best(name, d, i, j)
            i = j
            step *= 4
        return None

    def _carry_best(self, name: str, d: Side, i: int, j: int) -> None:
        if d.trails() and j > i:
            t = self._ticks(d.trail_pool())[i:j]
            d.best = int(min(d.best, t.min())) if name == "upper" else int(max(d.best, t.max()))

    def _after_delay(self, j: int) -> int:
        k = int(np.searchsorted(self.s.ts, self.s.ts[j] + self.p.delay_s, side="left"))
        return max(k, j)

    def next_event(self, st: State, name: str, d: Side, i: int, start: int) -> tuple[int, str] | None:
        """The next thing that happens to a side, looking at swaps from `start` on (`i` is the swap the simulation
        is at): ("exec", k) or, for a side with a hold, ("arm", k)."""
        if not d.hold_min:
            j = self.first_true(st, name, d, start)
            return None if j is None else (self._after_delay(j), "exec")
        hold = d.hold_min * 60
        now = float(self.s.ts[i])
        if d.armed_at and now <= d.armed_at + 2 * hold:
            open_at = int(np.searchsorted(self.s.ts, d.armed_at + hold, side="left"))
            j = self.first_true(st, name, d, max(start, open_at))
            if j is not None and self.s.ts[j] <= d.armed_at + 2 * hold:
                k = self._after_delay(j) if self.s.ts[j] < d.armed_at + hold + self.p.delay_s else j
                return (k, "exec")
            # the window passes without the condition: the arming expires, look for a new one after it
            start = max(start, int(np.searchsorted(self.s.ts, d.armed_at + 2 * hold, side="right")))
        j = self.first_true(st, name, d, start)
        return None if j is None else (self._after_delay(j), "arm")

    # ---- fees and time in range for swaps (i, k]
    def accrue(self, st: State, i: int, k: int) -> None:
        if k <= i:
            return
        s = self.s
        sl = slice(i + 1, k + 1)
        if st.L > 0:
            sa, sb = sqrt_at(st.tl), sqrt_at(st.tu)
            sp0, sp1 = s.sp0[sl], s.sp1[sl]
            frac = overlap_frac(sp0, sp1, sa, sb)
            start_in = (sp0 >= sa) & (sp0 <= sb)
            # The position's own liquidity is part of the pool, so it can never earn more than the whole fee. This also
            # bounds swaps that sweep through near-empty ticks, where the pool's liquidity reads close to zero.
            share = st.L * frac / (np.where(start_in, s.lpre[sl], s.lpost[sl]) + st.L)
            fee = s.fee_raw[sl]
            t0 = s.t0in[sl]
            c0 = np.cumsum(np.where(t0, share * fee, 0.0))
            c1 = np.cumsum(np.where(t0, 0.0, share * fee))
            # samples inside this stretch
            for idx in [x for x in self.samples_wanted if i < x <= k]:
                r = idx - (i + 1)
                a0, a1 = amounts(st.L, s.sp1[idx], sa, sb)
                self.samples[idx] = self.usd(st.w0 + a0 + st.f0 + c0[r], st.w1 + a1 + st.f1 + c1[r], s.sp1[idx])
                self.ranges[idx] = (st.tl, st.tu)
            st.f0 += float(c0[-1])
            st.f1 += float(c1[-1])
            dur = np.diff(s.ts[i : k + 1])
            inr = (sp1 >= sa) & (sp1 <= sb)
            st.in_range_s += float(np.sum(dur * inr))
            st.live_s += float(np.sum(dur))
        else:
            for idx in [x for x in self.samples_wanted if i < x <= k]:
                self.samples[idx] = self.usd(st.w0, st.w1, s.sp1[idx])

    # ---- one run of one side at swap k
    def execute(self, st: State, name: str, k: int) -> State | None:
        s, p = self.s, self.p
        d = st.sides[name]
        sp = float(s.sp1[k])
        tick = int(s.tick[k])
        sa, sb = sqrt_at(st.tl), sqrt_at(st.tu)
        new = replace(st, sides={n: replace(x) for n, x in st.sides.items()})
        nd = new.sides[name]

        ref_tick = self.ref_tick(st, name, d, k)

        # like the contract's integer liquidity * bps / 10_000: removing 100% leaves exactly nothing
        remove_l = (new.L if d.remove_bps >= BPS else new.L * d.remove_bps / BPS) if d.actions & ACT_REMOVE else 0.0
        a0, a1 = amounts(remove_l, sp, sa, sb)
        f0, f1 = new.f0, new.f1  # every modifyLiquidity collects all fees
        new.fees_usd += self.usd(f0, f1, sp)
        out0, out1 = a0 + f0, a1 + f1
        new.L -= remove_l
        new.f0 = new.f1 = 0.0
        cap = p.keeper_fee_bps / BPS
        res0, res1 = out0 * cap, out1 * cap
        swaps = bool(d.actions & ACT_SWAP)
        if swaps:  # a run that swaps sets the keeper's ceiling after the swap, on what the swap left
            if d.swap_to_token1:
                res0 = 0.0
            else:
                res1 = 0.0
        w0, w1 = out0 - res0, out1 - res1
        if not d.actions & ACT_KEEP_FEES:
            w0 -= min(f0, w0)
            w1 -= min(f1, w1)
        pay0, pay1 = out0 - res0 - w0, out1 - res1 - w1  # fees sent to the owner

        note = []
        if swaps:
            b0, b1 = w0, w1
            w0, w1, swapped = self.swap(w0, w1, d.swap_to_token1, sp, ref_tick, k)
            note.append(swapped)
            # ceiling on the bought amount, and on anything that stayed unsold
            if d.swap_to_token1:
                r_sold, r_bought = w0 * cap, max(0.0, w1 - b1) * cap
                res0, res1, w0, w1 = r_sold, res1 + r_bought, w0 - r_sold, w1 - r_bought
            else:
                r_sold, r_bought = w1 * cap, max(0.0, w0 - b0) * cap
                res1, res0, w1, w0 = r_sold, res0 + r_bought, w1 - r_sold, w0 - r_bought
        if d.actions & ACT_ADD:
            s_ = s.spacing
            if d.add_mode == ADD_ONE_SIDED:
                fl = floor_to(tick, s_)
                if name == "upper":
                    ntu, ntl = fl, fl - (d.shape & 2047) * s_
                    use0, use1 = 0.0, w1
                else:
                    ntl = fl + s_
                    ntu, use0, use1 = ntl + ((d.shape >> 11) & 2047) * s_, w0, 0.0
                if ntl >= min_usable(s_) and ntu <= max_usable(s_) and ntu > ntl:
                    nsa, nsb = sqrt_at(ntl), sqrt_at(ntu)
                    la = liquidity_for(sp, nsa, nsb, use0, use1) * 0.9999
                    if la > 0:
                        c0, c1 = amounts(la, sp, nsa, nsb)
                        w0, w1 = w0 - c0, w1 - c1
                        new.L, new.tl, new.tu = new.L + la, ntl, ntu
                        nd_lo, nd_hi = sorted((float(s.price(nsa)), float(s.price(nsb))))
                        note.append(f"new range {fmt(nd_lo)}-{fmt(nd_hi)}")
            else:
                la = liquidity_for(sp, sa, sb, w0, w1) * 0.9999 if (w0 > 0 or w1 > 0) else 0.0
                if la > 0:
                    c0, c1 = amounts(la, sp, sa, sb)
                    w0, w1 = w0 - c0, w1 - c1
                    new.L += la
                    note.append(f"re-added {fmt(self.usd(c0, c1, sp))} USD")

        nd.last_run = stored_time(float(s.ts[k]))
        nd.armed_at = 0.0
        again_ = d.repeat
        if again_ and d.runs_left:
            nd.runs_left = d.runs_left - 1  # a limited side switches off after its last run
            again_ = nd.runs_left != 0
        if again_:
            if nd.trails():
                nd.best = int(self._ticks(nd.trail_pool())[k])  # the trail starts again from the price after the run
            if not (d.actions & ACT_ADD and d.add_mode == ADD_ONE_SIDED):
                step = d.shape if name == "upper" else -d.shape
                if d.checker in LEVELS:
                    nd.value = d.value + step
                if d.combine != COMBINE_NONE and d.checker2 in LEVELS:
                    nd.value2 = d.value2 + step
        else:
            new.sides[name] = Side(edge=d.edge)

        # keeper pay out of the reserve
        res_usd = self.usd(res0, res1, sp)
        if p.keeper_mode == "ceiling" or res_usd <= 0:
            frac = 1.0
        else:
            frac = min(1.0, p.keeper_cost_usd / res_usd)
        new.keeper_usd += res_usd * frac
        back0, back1 = res0 * (1 - frac), res1 * (1 - frac)

        # what was not re-added goes to the owner
        new.w0 += w0 + pay0 + back0
        new.w1 += w1 + pay1 + back1
        new.runs += 1

        both_off = all(x.checker == CHECK_OFF for x in new.sides.values())
        if new.L <= 0 or both_off:
            nsa, nsb = sqrt_at(new.tl), sqrt_at(new.tu)
            r0, r1 = amounts(new.L, sp, nsa, nsb)
            new.w0 += r0
            new.w1 += r1
            new.L = 0.0
            new.open = False
            note.append("position closed")
        else:
            again = new.sides[name]
            # a side with a hold cannot loop (it needs a new arming), so the contract does not check it
            if again.checker != CHECK_OFF and not again.hold_min and self.cond_at(new, name, again, k):
                return None  # WouldRefire: the contract refuses the run
        self.events.append({"t": float(s.ts[k]), "price": float(s.price(sp)), "side": name, "note": note})
        return new

    def ref_tick(self, st: State, name: str, d: Side, k: int) -> int:
        """ConditionalOrders._refTick: the level of the first condition that is true and is a price of this pair,
        otherwise the current price."""
        def ref_for(cond):
            checker, value, _ = cond  # the other recorded pool is the same pair, so its ticks count
            if checker == CHECK_EDGE:
                return st.tu + value if name == "upper" else st.tl - value
            if checker in LEVELS:
                return value
            if checker == CHECK_TRAIL:
                return d.best + value if name == "upper" else d.best - value
            return None
        cs = d.conds()
        a_met = bool(self._cond_mask(st, name, d, cs[0], k, k + 1)[0])
        if a_met or d.combine != COMBINE_OR:
            r = ref_for(cs[0])
            if r is not None:
                return int(r)
        if len(cs) == 2:
            r = ref_for(cs[1])
            if r is not None:
                return int(r)
        return int(self.s.tick[k])

    def swap(self, w0: float, w1: float, zero_for_one: bool, sp: float, ref_tick: int, k: int):
        """Swap all of one token at the pool's liquidity at that moment, stopping at the slippage limit."""
        s, p = self.s, self.p
        amount_in = w0 if zero_for_one else w1
        if amount_in <= 0:
            return w0, w1, "nothing to convert"
        slip = p.slippage_steps * 10
        limit_tick = max(MIN_TICK + 1, min(MAX_TICK - 1, ref_tick - slip if zero_for_one else ref_tick + slip))
        sl = sqrt_at(limit_tick)
        if (zero_for_one and sl >= sp) or (not zero_for_one and sl <= sp):
            return w0, w1, "convert skipped: price already past the limit"
        L = float(s.lpost[k])
        net = amount_in * (1 - s.fee)
        if zero_for_one:  # token0 in, price falls
            cap = L * (1 / sl - 1 / sp)
            used = min(net, cap)
            sp_new = L * sp / (L + used * sp)
            out = L * (sp - sp_new)
            gross = used / (1 - s.fee)
            return w0 - gross, w1 + out, ("converted" if used == net else "partly converted (limit)")
        cap = L * (sl - sp)
        used = min(net, cap)
        sp_new = sp + used / L
        out = L * (1 / sp - 1 / sp_new)
        gross = used / (1 - s.fee)
        return w0 + out, w1 - gross, ("converted" if used == net else "partly converted (limit)")

    # ---- whole run
    def run(self, st: State, sample_idx: list[int]) -> State:
        """Like a keeper that looks after every swap: at each swap, every side that can act does (run it, or arm
        its hold), each at most once per kind. A refused run (WouldRefire) is tried again at the next swap."""
        self.samples_wanted = sample_idx
        self.arms = 0
        self.refused = 0
        i = self.i0
        done: set[tuple[str, str]] = {(n, k) for n in ("lower", "upper") for k in ("exec", "arm")}  # nothing at i0
        guard = 4 * (self.i1 - self.i0) + 10_000
        while st.open and st.runs < MAX_RUNS and guard > 0:
            guard -= 1
            best = None
            for name, d in st.sides.items():
                if d.checker == CHECK_OFF:
                    continue
                ev = self.next_event(st, name, d, i, i)
                if ev is not None and ev[0] == i and (name, ev[1]) in done:
                    ev = self.next_event(st, name, d, i, i + 1)
                if ev is not None and (best is None or ev[0] < best[0]):
                    best = (ev[0], ev[1], name)
            if best is None:
                break
            k, kind, name = best
            if k >= self.i1:
                break
            if k != i:
                done = set()
            self.accrue(st, i, k)
            self.move_best(st, i, k)
            i = k
            done.add((name, kind))
            d = st.sides[name]
            if not self.cond_at(st, name, d, k):
                continue  # the price moved back before the keeper's transaction
            if kind == "arm":
                d.armed_at = stored_time(float(self.s.ts[k]))
                self.arms += 1
                continue
            if d.hold_min:
                hold = d.hold_min * 60
                if not (d.armed_at and d.armed_at + hold <= self.s.ts[k] <= d.armed_at + 2 * hold):
                    continue
            nxt = self.execute(st, name, k)
            if nxt is None:
                self.refused += 1  # the contract reverts (WouldRefire); the keeper tries again later
                continue
            st = nxt
        self.accrue(st, i, self.i1 - 1)
        return st


def fmt(x: float) -> str:
    return f"{x:,.0f}" if abs(x) >= 100 else f"{x:,.4g}"


# ---------------------------------------------------------------- entry point


def _reads_other(lane: dict) -> bool:
    return any((lane.get(k) or {}).get("kind") == "otherPool" for k in ("trigger", "trigger2"))


def run(req: dict) -> dict:
    key = req.get("pool", "eth_usdc_030")
    if key not in POOL_LABELS:
        raise ValueError(f"unknown pool {key}")
    s = load(key)
    lanes = req.get("rules") or {}
    other = load(OTHER_POOL[key]) if any(_reads_other(lanes.get(l) or {}) for l in ("down", "up")) else None
    return run_series(s, other, req)


def side_fields(d: Side) -> dict:
    """A side in the contract's field names (a pool read from another series is reported as -1)."""
    return {"checker": d.checker, "value": d.value, "checkPool": -1 if d.check_pool else 0, "actions": d.actions,
            "removeBps": d.remove_bps, "swapToToken1": d.swap_to_token1, "addMode": d.add_mode, "repeat": d.repeat,
            "shape": d.shape, "checker2": d.checker2, "value2": d.value2, "checkPool2": -1 if d.check_pool2 else 0,
            "combine": d.combine, "holdMinutes": d.hold_min, "runsLeft": d.runs_left}


def run_series(s: Series, other: Series | None, req: dict) -> dict:
    """The backtest on a loaded (or synthetic) swap series."""
    key = s.key
    lanes = req.get("rules") or {}
    reads_other = _reads_other

    t_first, t_last = float(s.ts[0]), float(s.ts[-1])
    days = float(req.get("days", 30))
    start = float(req.get("start", t_first))
    start = min(max(start, t_first), t_last - 86400)
    end = min(start + days * 86400, t_last)
    i0 = int(np.searchsorted(s.ts, start))
    i1 = int(np.searchsorted(s.ts, end))
    if i1 - i0 < 10:
        raise ValueError("window too short")

    p = Params(
        keeper_fee_bps=int(req.get("keeperFeeBps", 10)),
        slippage_steps=max(1, round(float(req.get("slippagePct", 1)) * 10)),
        delay_s=float(req.get("delaySec", 12)),
        keeper_cost_usd=float(req.get("keeperCostUsd", 0.01)),
        keeper_mode=req.get("keeperMode", "gas"),
    )
    deposit = float(req.get("depositUsd", 10_000))

    # entry: range around the price before the first swap of the window
    sp_in = float(s.sp0[i0])
    entry = float(s.price(sp_in))
    rng = req.get("range") or {"loPct": -5, "hiPct": 5}
    spc = s.spacing
    if rng.get("full"):
        tl, tu = min_usable(spc), max_usable(spc)
    else:
        a = s.tick_at_price(entry * (1 + rng["loPct"] / 100))
        b = s.tick_at_price(entry * (1 + rng["hiPct"] / 100))
        tl, tu = max(min_usable(spc), floor_to(min(a, b), spc)), min(max_usable(spc), floor_to(max(a, b), spc) + spc)
    sa, sb = sqrt_at(tl), sqrt_at(tu)

    def start_state() -> State:
        st = State(tl=tl, tu=tu)
        unit0, unit1 = amounts(1.0, sp_in, sa, sb)
        unit_usd = Sim(s, i0, i1, p, None).usd(unit0, unit1, sp_in)
        st.L = deposit / unit_usd
        return st

    # samples for the chart
    n_samples = 240
    sample_idx = sorted(set(np.linspace(i0 + 1, i1 - 1, n_samples).astype(int).tolist()))

    # strategy with rules
    st = start_state()
    a0_in, a1_in = amounts(st.L, sp_in, sa, sb)
    sides = {"lower": Side(edge=tl), "upper": Side(edge=tu)}
    other_entry = float(other.price(other.sp1[max(0, int(np.searchsorted(other.ts, start)) - 1)])) if other is not None else None
    start_tick = int(math.floor(2.0 * math.log(sp_in) / LN))
    for lane_id in ("down", "up"):
        lane = lanes.get(lane_id) or {}
        watched = other if reads_other(lane) and other is not None else s
        name, d = encode_lane(s, lane_id, lane, entry, watched, other, other_entry)
        if d.checker != CHECK_OFF:
            d.last_run = stored_time(start)
            if d.trails():
                d.best = int(other.tick[max(0, int(np.searchsorted(other.ts, start)) - 1)]) if d.trail_pool() and other is not None else start_tick
            sides[name] = d
    st.sides = sides
    st_sides = {n: replace(d) for n, d in sides.items()}  # as created, for the report
    sim = Sim(s, i0, i1, p, other)
    final = sim.run(st, sample_idx)

    # the same position without rules
    base = start_state()
    base.sides = {"lower": Side(edge=tl), "upper": Side(edge=tu)}
    plain = Sim(s, i0, i1, p, None)
    plain_final = plain.run(base, sample_idx)

    sp_end = float(s.sp1[i1 - 1])
    end_price = float(s.price(sp_end))

    def value(st_: State, sim_: Sim) -> float:
        a0, a1 = amounts(st_.L, sp_end, sqrt_at(st_.tl), sqrt_at(st_.tu)) if st_.L > 0 else (0.0, 0.0)
        return sim_.usd(st_.w0 + a0 + st_.f0, st_.w1 + a1 + st_.f1, sp_end)

    v_rules, v_plain = value(final, sim), value(plain_final, plain)
    v_hold = sim.usd(a0_in, a1_in, sp_end)
    fees_rules = final.fees_usd + sim.usd(final.f0, final.f1, sp_end)
    fees_plain = plain_final.fees_usd + plain.usd(plain_final.f0, plain_final.f1, sp_end)

    # chart series
    t, price, strat, pl, hold, lo, hi = [], [], [], [], [], [], []
    for idx in sample_idx:
        spx = float(s.sp1[idx])
        t.append(float(s.ts[idx]))
        price.append(float(s.price(spx)))
        strat.append(sim.samples.get(idx, None))
        pl.append(plain.samples.get(idx, None))
        hold.append(sim.usd(a0_in, a1_in, spx))
        r = sim.ranges.get(idx)
        if r:
            x, y = sorted((float(s.price(sqrt_at(r[0]))), float(s.price(sqrt_at(r[1])))))
            lo.append(x)
            hi.append(y)
        else:
            lo.append(None)
            hi.append(None)
    # carry the last known value forward where a sample fell after the position closed
    for arr in (strat, pl):
        last = deposit
        for n, v in enumerate(arr):
            if v is None:
                arr[n] = last
            else:
                last = v

    lo_p, hi_p = sorted((float(s.price(sa)), float(s.price(sb))))
    return {
        "pool": key,
        "poolLabel": POOL_LABELS.get(key, key),
        "ticks": [tl, tu],
        "sides": {n: side_fields(d) for n, d in st_sides.items()},
        "start": float(s.ts[i0]),
        "end": float(s.ts[i1 - 1]),
        "dataFrom": t_first,
        "dataTo": t_last,
        "swaps": i1 - i0,
        "entryPrice": entry,
        "endPrice": end_price,
        "deposit": deposit,
        "range": {"lo": lo_p, "hi": hi_p, "full": bool(rng.get("full"))},
        "rules": {
            "final": v_rules,
            "fees": fees_rules,
            "keeperPaid": final.keeper_usd,
            "runs": final.runs,
            "arms": sim.arms,
            "timeInRange": final.in_range_s / max(final.live_s, 1.0) if final.live_s else 0.0,
            "closed": not final.open,
        },
        "noRules": {"final": v_plain, "fees": fees_plain, "timeInRange": plain_final.in_range_s / max(plain_final.live_s, 1.0)},
        "hold": {"final": v_hold},
        "usdc": {"final": deposit},
        "series": {"t": t, "price": price, "rules": strat, "noRules": pl, "hold": hold, "lo": lo, "hi": hi},
        "events": sim.events[:500],
        "assumptions": {
            "keeperDelaySec": p.delay_s,
            "keeperCostUsd": p.keeper_cost_usd,
            "keeperMode": p.keeper_mode,
            "keeperFeeBps": p.keeper_fee_bps,
            "slippagePct": p.slippage_steps / 10,
        },
        "caveats": [
            "Real swaps from the recorded window; past results do not predict future ones.",
            "Your own swaps (Convert) do not move later prices in the replay, and they use the pool's liquidity at that moment.",
            "Fees assume your position is small next to the pool.",
            "A keeper runs each rule a fixed delay after its condition is met; price manipulation and MEV are not modelled.",
            "Trailing stops: the best price is updated at every swap (it assumes someone pokes each new best, as the keeper does).",
            "Chainlink price levels are tested against this pool's recorded price: no Chainlink history is loaded, and the real feed updates less often.",
        ],
    }


def run_windows(req: dict, window_days: int = 30, every_days: int = 7) -> dict:
    """The same rules over every window_days-long window starting every every_days."""
    s = load(req.get("pool", "eth_usdc_030"))
    t0, t1 = float(s.ts[0]), float(s.ts[-1])
    out = []
    start = t0
    while start + window_days * 86400 <= t1:
        r = run({**req, "start": start, "days": window_days})
        out.append({"start": r["start"], "rules": r["rules"]["final"], "noRules": r["noRules"]["final"], "hold": r["hold"]["final"], "runs": r["rules"]["runs"]})
        start += every_days * 86400
    beat_plain = sum(1 for x in out if x["rules"] > x["noRules"])
    beat_hold = sum(1 for x in out if x["rules"] > x["hold"])
    diffs = sorted(x["rules"] - x["noRules"] for x in out)
    return {
        "windows": out,
        "count": len(out),
        "beatNoRules": beat_plain,
        "beatHold": beat_hold,
        "medianVsNoRules": diffs[len(diffs) // 2] if diffs else 0.0,
        "worstVsNoRules": diffs[0] if diffs else 0.0,
        "bestVsNoRules": diffs[-1] if diffs else 0.0,
        "windowDays": window_days,
        "everyDays": every_days,
    }
