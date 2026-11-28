"""Alucard backtest engine: replays real Uniswap swaps against a position with rules.

It runs the exact order the app's editor sends to the contract (the packed words of lib/rules.ts encodeRules), the way
src/ConditionalOrders.sol and src/Rules.sol run it:
  * every pool condition reads the pool's price after each swap. The contract also requires that price to be near
    Chainlink; recorded pools are arbitraged to the market, so here that check always passes. A Chainlink price level
    (LINK) is replayed on the pool's price too: no Chainlink history is loaded
  * a swap of a step sells everything within the owner's slippage or the run reverts and waits (counted as refused)
  * a hold ("only if it lasts") needs the condition true for the whole time, from the first swap it was true at
    (a keeper pokes it there) to the run
  * TIME counts from the side's last run; FEES and APR from the fees the position earned since they were collected
  * a side runs at most once a minute (MIN_GAP); trailing stops follow the best price (keepers poke it)
  * a keeper executes `delay` seconds after the condition holds, if it still holds then (the contract re-checks)
  * remove -> keeper fee set aside -> fees kept or paid out -> optional swap (maxSlippage past the price before it)
    -> optional add (same range, or a new range around the price after swapping to its mix) -> side updated ->
    keeper paid its fee -> close if nothing is left or both sides are off
  * a move takes everything to the other leg: holding a token, or into another pool (counted as the token it goes
    in as; that pool's fees are not modelled), and back into the same range or one centred on the price, after
    swapping to the range's mix

Fees use the validated swap replay of lp_study (lp_sim.swap_shares): each swap pays a unit of liquidity
overlap_fraction / pool_liquidity of its LP fee. Valid while the position is small next to the pool.

Not modelled, stated in the output: the position's own swaps do not move later prices; price manipulation; MEV.

Only numpy. Pure functions, so tests can import this file directly.
"""
from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass, field, replace

import numpy as np

LN = math.log(1.0001)
MIN_TICK, MAX_TICK = -887272, 887272
BPS = 10_000
CHECK_OFF, CHECK_EDGE, CHECK_TICK, CHECK_TIME, CHECK_TRAIL = 0, 1, 2, 3, 4
CHECK_LINK = 5  # the pair's Chainlink price against a level (replayed on the pool's price: see the caveats)
LEVELS = (CHECK_TICK, CHECK_LINK)  # a price level: a repeating one steps
COMBINE_NONE, COMBINE_AND, COMBINE_OR = 0, 1, 2
BASE_TIME = 1_767_225_600  # OrderState.BASE_TIME: stored times round up to the minute after this
ACT_KEEP_FEES, ACT_REMOVE, ACT_SWAP, ACT_ADD = 1, 2, 4, 8
ADD_SAME, ADD_CENTERED = 0, 1
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
    # USD price of the quote token at each swap (None: the quote is USD, as in the recorded mainnet pools)
    quote_usd: np.ndarray | None = None
    # fee in the input token per unit of liquidity the swap crosses (arbitrage-only history; None: share of fee_raw)
    fee_per_l: np.ndarray | None = None
    label: str = ""
    address: str = ""  # the recorded pool's address on Ethereum mainnet
    source: str = "recorded"  # "recorded": real mainnet swaps; "chainlink": one of our pools, see chain_series
    # rows that are swaps (None: all); a path replayed in a test may stay on a price without swapping
    swapped: np.ndarray | None = None
    # when the pool's oracle started (None: the first row); its history before that is the first row's price
    oracle_start: float | None = None

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
    s.label = POOL_LABELS.get(key, "")
    s.address = m.get("address", "")
    quote = s.token1 if s.base_is0 else s.token0
    if quote in ("WETH", "ETH") and key != "eth_usdc_005":
        # values in USD: ETH's price from the ETH/USDC history at the same moments
        e = load("eth_usdc_005")
        s.quote_usd = _ffill(e.ts, e.price(e.sp1), s.ts)
    _CACHE[key] = s
    return s


# Real swaps of Ethereum mainnet Uniswap v3 pools, one or two per pair of our pools (lp_study/export_backtest.py,
# fetch_more.py). The frontend picks the one with the selected pool's tokens.
POOL_LABELS = {
    "eth_usdc_030": "ETH/USDC 0.30% (Ethereum mainnet)",
    "eth_usdc_005": "ETH/USDC 0.05% (Ethereum mainnet)",
    "wbtc_usdc_030": "WBTC/USDC 0.30% (Ethereum mainnet)",
    "wbtc_eth_005": "WBTC/WETH 0.05% (Ethereum mainnet)",
    "usdc_usdt_001": "USDC/USDT 0.01% (Ethereum mainnet)",
    "dai_usdc_001": "DAI/USDC 0.01% (Ethereum mainnet)",
    "link_eth_030": "LINK/WETH 0.30% (Ethereum mainnet)",
}
# a condition that watches another pool reads this pool's history (the same pair at another fee tier)
OTHER_POOL = {"eth_usdc_030": "eth_usdc_005", "eth_usdc_005": "eth_usdc_030"}
CHAIN_PREFIX = "sepolia:"  # "sepolia:<pool index>": one of our pools, history from Chainlink (chain_series)
_SYMBOL_DECIMALS = {"WETH": 18, "WBTC": 8, "USDC": 6, "USDT": 6, "DAI": 18, "LINK": 18, "ETH": 18}


def arb_swaps(ts, t1per0, L: float, fee_pips: int) -> dict:
    """The swaps that keep a pool on an outside price: after each new price an arbitrageur trades the pool to the edge
    of its fee band (price x (1 - fee) or price / (1 - fee)), the cheapest trade that removes the profit. Liquidity L is
    held constant. Returns the engine's swap fields; a price move that stays inside the band makes no swap."""
    f = fee_pips / 1e6
    band = math.sqrt(1.0 - f)
    out = {k: [] for k in ("ts", "sp0", "sp1", "fee", "fee_per_l", "t0in")}
    sp = math.sqrt(float(t1per0[0]))
    for t, p in zip(ts[1:], t1per0[1:]):
        se = math.sqrt(float(p))
        if se * band > sp:  # outside price above the band: buy token0 (token1 in) up to price x (1 - fee)
            tgt = se * band
            per_l = tgt - sp
            t0 = False
        elif se / band < sp:  # below: sell token0 (token0 in) down to price / (1 - fee)
            tgt = se / band
            per_l = 1.0 / tgt - 1.0 / sp
            t0 = True
        else:
            continue
        out["ts"].append(float(t))
        out["sp0"].append(sp)
        out["sp1"].append(tgt)
        out["fee_per_l"].append(per_l * f / (1.0 - f))
        out["fee"].append(L * per_l * f / (1.0 - f))
        out["t0in"].append(t0)
        sp = tgt
    return out


def _ffill(src_ts: np.ndarray, src_v: np.ndarray, at: np.ndarray) -> np.ndarray:
    i = np.searchsorted(src_ts, at, side="right") - 1
    return src_v[np.clip(i, 0, len(src_v) - 1)]


def chain_series(pool_index: int, since: float) -> Series:
    """One of our Sepolia pools, from the chain only: the pair's price is its two tokens' Chainlink USD prices (every
    round of the feeds, read through PriceFeeds, the contract's own token list), the pool's fee tier and tick spacing
    are its own, and its liquidity today sets the price impact of your own swaps. The pool itself has almost no swaps
    on a testnet, so the swaps are the arbitrage trades that would have kept it on the Chainlink price (arb_swaps):
    fees are only those trades' fees, a lower bound for a pool that also has ordinary traders. Every unit of liquidity
    in range earns the same fee per price move, so fees do not depend on how much the testnet pool holds."""
    import _chain  # noqa: PLC0415  (only needed for these pools)

    dep = _chain.deployment()
    core = dep["core"]
    pools = [(k, v) for k, v in dep["pools"].items() if int(v.get("poolIndex", -1)) == pool_index]
    if not pools:
        raise ValueError(f"unknown pool index {pool_index}")
    name, pk = pools[0]
    sym = {a.lower(): s for s, a in dep["tokens"].items()}
    sym["0x0000000000000000000000000000000000000000"] = "ETH"
    t0, t1 = pk["currency0"], pk["currency1"]
    s0, s1 = sym.get(t0.lower(), t0), sym.get(t1.lower(), t1)

    def usd_series(token: str):
        agg, fdec, tdec = _chain.feed_of(core["priceFeeds"], token)
        h = _chain.feed_history(agg, since)
        if not h:
            raise ValueError(f"no Chainlink price for {sym.get(token.lower(), token)}")
        if len(h) == 1:  # a feed that never changed (the testnet USDT feed is a fixed $1): flat since `since`
            h = [(int(min(since, h[0][0])), h[0][1]), (int(time.time()), h[0][1])]
        return np.array([x[0] for x in h], dtype=np.float64), np.array([x[1] for x in h], dtype=np.float64) / 10**fdec, tdec

    ts0, p0, dec0 = usd_series(t0)
    ts1, p1, dec1 = usd_series(t1)
    start = max(ts0[0], ts1[0])
    ts = np.unique(np.concatenate([ts0, ts1]))
    ts = ts[ts >= start]
    u0, u1 = _ffill(ts0, p0, ts), _ffill(ts1, p1, ts)
    t1per0 = u0 / u1 * 10.0 ** (dec1 - dec0)  # raw units, like the pool's price

    L = float(_chain.pool_liquidity(core["rules"], pool_index))
    sw = arb_swaps(ts, t1per0, L, int(pk["fee"]))
    if len(sw["ts"]) < 2:
        raise ValueError("the Chainlink price of this pair has not moved enough to trade")
    sts = np.array(sw["ts"])
    sp1 = np.array(sw["sp1"])
    s = Series(
        key=f"{CHAIN_PREFIX}{pool_index}", dec0=dec0, dec1=dec1, fee=int(pk["fee"]) / 1e6, spacing=int(pk["tickSpacing"]),
        token0=s0, token1=s1, ts=sts, sp0=np.array(sw["sp0"]), sp1=sp1, lpre=np.full(len(sts), L),
        lpost=np.full(len(sts), L), fee_raw=np.array(sw["fee"]), t0in=np.array(sw["t0in"], dtype=bool),
        fee_per_l=np.array(sw["fee_per_l"]),
        tick=np.floor(2.0 * np.log(sp1) / LN).astype(np.int64),
        source="chainlink",
    )
    base, quote = (s0, s1) if s.base_is0 else (s1, s0)
    s.label = f"{base}/{quote} {int(pk['fee']) / 1e4:g}% (our {'Unichain Sepolia' if dep.get('chainId') == 1301 else 'Sepolia'} pool, Chainlink prices)"
    q_ts, q_p = (ts1, p1) if s.base_is0 else (ts0, p0)
    s.quote_usd = _ffill(q_ts, q_p, sts)
    return s


def series_for(req: dict, since: float | None = None) -> Series:
    key = str(req.get("pool", "eth_usdc_030"))
    if key.startswith(CHAIN_PREFIX):
        import _chain  # noqa: PLC0415

        _chain.use(req.get("chainId"))
        days = float(req.get("days", 30))
        start = float(req.get("start", 0)) or (time.time() - days * 86400)
        return chain_series(int(key[len(CHAIN_PREFIX):]), since if since is not None else start - 86400)
    if key not in POOL_LABELS:
        raise ValueError(f"unknown pool {key}")
    return load(key)


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


# ---------------------------------------------------------------- the order: packed words (src/libraries/OrderState.sol)
#
# The engine runs the exact words the editor sends to the contract (lib/rules.ts encodeRules), so the editor's encoding
# is written once. Absolute price levels are moved to the backtest window: a level x ticks from today's price is set
# x ticks from the window's first price (a log-price shift, so "5% below today" stays "5% below the window's start").

CHECK_FEES, CHECK_APR = 6, 7
CHECK_EXTERNAL = 8  # a "when" card (a contract): it cannot be replayed on history, so it never fires here
ACT_MOVE = 16
LEG_IDLE, LEG_RANGE, LEG_CENTERED = 1, 2, 3
MIN_GAP = 60  # ConditionalOrders.MIN_GAP: a side runs at most once in this many seconds after its last run
MIN_APR_TIME = 3600  # Rules.MIN_APR_TIME


def _s24(x: int) -> int:
    x &= 0xFFFFFF
    return x - 0x1000000 if x >= 0x800000 else x


@dataclass
class Side:
    edge: int = 0
    checker: int = 0
    value: int = 0
    check_pool: str = "own"  # "own": the leg's pool, "home": the position's pool, "other": the other recorded pool
    actions: int = 0
    remove_bps: int = 0
    swap_to_token1: bool = False
    add_mode: int = 0
    repeat: bool = False
    shape: int = 0
    last_run: float = 0.0
    checker2: int = 0
    value2: int = 0
    check_pool2: str = "own"
    combine: int = 0
    hold_min: int = 0
    best: int = 0  # TRAIL: the best tick seen
    runs_left: int = 0
    armed: float = 0.0  # a side with a hold: when its condition was first seen true (0 = not now)

    def conds(self):
        """(checker, value, pool) of condition A and, if any, condition B."""
        out = [(self.checker, self.value, self.check_pool)]
        if self.combine != COMBINE_NONE and self.checker2 != CHECK_OFF:
            out.append((self.checker2, self.value2, self.check_pool2))
        return out

    def trail_pool(self) -> str | None:
        return next((p for c, _, p in self.conds() if c == CHECK_TRAIL), None)



def decode_word(w: int, home_index: int) -> Side:
    """OrderState.decodeSide, with pool indexes named by role."""
    def pool(i: int) -> str:
        return "own" if i == 0 else "home" if i == home_index else "other"
    m = (w >> 150) & 0xFFFFFF
    return Side(
        edge=_s24(w), checker=(w >> 24) & 0x3F, value=_s24(w >> 30), check_pool=pool((w >> 54) & 0xFFFFFF),
        checker2=(w >> 78) & 0x3F, value2=_s24(w >> 84), check_pool2=pool((w >> 108) & 0xFFFFFF), combine=(w >> 132) & 3,
        hold_min=(w >> 134) & 0xFFFF, last_run=0.0 if m == 0 else BASE_TIME + m * 60.0, best=_s24(w >> 174),
        actions=(w >> 198) & 0x1F, remove_bps=(w >> 206) & 0x3FFF, swap_to_token1=bool((w >> 220) & 1),
        add_mode=(w >> 221) & 7, repeat=bool((w >> 224) & 1), runs_left=(w >> 225) & 0x7F, shape=(w >> 232) & 0x3FFFFF,
    )


def encode_word(d: Side, home_index: int = 0, other_index: int = 2) -> int:
    """OrderState.encodeSide, for tests (the app sends words made by lib/rules.ts)."""
    def pool(p: str) -> int:
        return 0 if p == "own" else home_index if p == "home" else other_index
    def u24(x: int) -> int:
        return x & 0xFFFFFF
    m = 0 if d.last_run == 0 else max(1, math.ceil((d.last_run - BASE_TIME) / 60))
    return (u24(d.edge) | (d.checker << 24) | (u24(d.value) << 30) | (pool(d.check_pool) << 54) | (d.checker2 << 78)
            | (u24(d.value2) << 84) | (pool(d.check_pool2) << 108) | (d.combine << 132) | (d.hold_min << 134) | (m << 150)
            | (u24(d.best) << 174) | (d.actions << 198) | (d.remove_bps << 206) | (int(d.swap_to_token1) << 220)
            | (d.add_mode << 221) | (int(d.repeat) << 224) | (d.runs_left << 225) | (d.shape << 232))


@dataclass
class Placement:
    """How the words' absolute ticks map onto the series: tick = entry + sign x (word tick - ref)."""
    flip: bool  # the series lists the pair's tokens the other way round
    own_ref: int
    own_entry: int
    other_ref: int = 0
    other_entry: int = 0
    spacing_ratio: float = 1.0  # tick spacing of the pool the words were made for / the series' spacing

    def level(self, v: int, pool: str) -> int:
        ref, entry = (self.other_ref, self.other_entry) if pool == "other" else (self.own_ref, self.own_entry)
        return entry + (-(v - ref) if self.flip else v - ref)


def place_side(d: Side, pl: Placement) -> Side:
    """A side made for today's pool, moved to the series: price levels shifted (and mirrored if the series quotes the
    pair the other way round: ticks change sign, a swap goes to the other token, a one-sided range's widths swap)."""
    e = replace(d)
    if e.checker in LEVELS:
        e.value = pl.level(e.value, e.check_pool)
    if e.combine != COMBINE_NONE and e.checker2 in LEVELS:
        e.value2 = pl.level(e.value2, e.check_pool2)
    if e.actions & ACT_ADD and e.add_mode == ADD_CENTERED and pl.spacing_ratio != 1.0:
        # widths are counted in tick spacings: keep the same width in price on a pool of another spacing
        def scale(w: int) -> int:
            return min(2047, max(1, round(w * pl.spacing_ratio))) if w else 0
        e.shape = scale(e.shape & 2047) | (scale((e.shape >> 11) & 2047) << 11)
    if pl.flip:
        if e.actions & ACT_SWAP:
            e.swap_to_token1 = not e.swap_to_token1
        if e.actions & ACT_ADD and e.add_mode == ADD_CENTERED:
            e.shape = ((e.shape & 2047) << 11) | ((e.shape >> 11) & 2047)
    return e


# ---------------------------------------------------------------- simulation


@dataclass
class Params:
    keeper_fee_bps: int = 10
    slippage_steps: int = 10  # x10 ticks, like Order.maxSlippage
    delay_s: float = 12.0


@dataclass
class Plan:
    """The second leg: where the money waits (held tokens) and how it comes back."""
    home_kind: int  # LEG_RANGE or LEG_CENTERED
    home_a: int
    home_b: int
    away_kind: int  # LEG_IDLE, or a range in another pool (parked: modelled as holding the shared token)
    shared: str | None  # "token0" / "token1" / "both": the token of this pool the parking pool also has


@dataclass
class State:
    L: float = 0.0
    tl: int = 0
    tu: int = 0
    f0: float = 0.0  # uncollected fees of the position, raw
    f1: float = 0.0
    w0: float = 0.0  # owner's wallet (everything paid out), raw
    w1: float = 0.0
    sides: dict = field(default_factory=dict)  # the live leg's sides
    open: bool = True
    keeper_usd: float = 0.0
    fees_usd: float = 0.0  # fees earned, valued when collected
    runs: int = 0
    in_range_s: float = 0.0
    live_s: float = 0.0
    home: bool = True  # the live leg is the position
    other_sides: dict = field(default_factory=dict)  # the other leg's sides, kept for the way back
    held0: float = 0.0  # held while away, raw
    held1: float = 0.0
    moves: int = 0


def _copy(st: State) -> State:
    return replace(st, sides={n: replace(x) for n, x in st.sides.items()}, other_sides={n: replace(x) for n, x in st.other_sides.items()})


class Sim:
    def __init__(self, s: Series, i0: int, i1: int, p: Params, other: Series | None, plan: Plan | None = None):
        self.s, self.i0, self.i1, self.p, self.other, self.plan = s, i0, i1, p, other, plan
        self.events: list[dict] = []
        self.samples: dict[int, float] = {}
        self.ranges: dict[int, tuple[float, float]] = {}
        # the other pool's row at each of our swaps
        if other is not None:
            self.other_row = np.clip(np.searchsorted(other.ts, s.ts, side="right") - 1, 0, len(other.ts) - 1)
        self._avg_cache: dict[tuple, tuple] = {}
        self.failed = 0

    def usd(self, a0: float, a1: float, sp: float, k: int | None = None) -> float:
        """Value in USD at swap row k: the quote token's USD price of that moment (the window's start when k is None)."""
        s = self.s
        price = float(s.price(sp))
        h0, h1 = a0 / 10**s.dec0, a1 / 10**s.dec1
        v = h0 + h1 * price if not s.base_is0 else h0 * price + h1  # in quote units
        q = s.quote_usd
        return v * (1.0 if q is None else float(q[self.i0 if k is None else k]))

    @property
    def quote_usd(self) -> float:
        q = self.s.quote_usd
        return 1.0 if q is None else float(q[self.i0])

    # ---- prices
    def px(self, pool: str, i: int, j: int) -> tuple[np.ndarray, np.ndarray]:
        """(ok, tick) of a pool's price right after each of our rows i..j-1."""
        if pool == "other":
            if self.other is None:
                raise ValueError("a condition reads another pool, but no other pool's history is loaded")
            t = self.other.tick[self.other_row[i:j]]
        else:
            t = self.s.tick[i:j]
        return np.ones(j - i, dtype=bool), t.astype(np.int64)

    def _pool_of(self, st: State, pool: str) -> str:
        """A condition's pool by role: the leg's own pool is the position's pool, unless the money is parked elsewhere."""
        if pool == "own" and not st.home and self.plan and self.plan.away_kind != LEG_IDLE:
            raise ValueError("a condition reads the parking pool's price, which this backtest does not have")
        return "other" if pool == "other" else "own"

    # ---- fees of the live position, for FEES and APR (Rules.feeBps)
    def _earned(self, st: State, i: int, j: int) -> tuple[np.ndarray, np.ndarray]:
        """Fees of the position at rows i..j-1: what it holds now plus what swaps i+1.. add."""
        s = self.s
        n = j - i
        if st.L <= 0 or n <= 0:
            return np.full(n, st.f0), np.full(n, st.f1)
        sl = slice(i + 1, j)
        sa, sb = sqrt_at(st.tl), sqrt_at(st.tu)
        frac = overlap_frac(s.sp0[sl], s.sp1[sl], sa, sb)
        if s.fee_per_l is not None:
            earned = st.L * frac * s.fee_per_l[sl]
        else:
            start_in = (s.sp0[sl] >= sa) & (s.sp0[sl] <= sb)
            earned = st.L * frac / (np.where(start_in, s.lpre[sl], s.lpost[sl]) + st.L) * s.fee_raw[sl]
        t0 = s.t0in[sl]
        c0 = np.concatenate([[0.0], np.cumsum(np.where(t0, earned, 0.0))])
        c1 = np.concatenate([[0.0], np.cumsum(np.where(t0, 0.0, earned))])
        return st.f0 + c0, st.f1 + c1

    def fee_bps(self, st: State, i: int, j: int) -> tuple[np.ndarray, np.ndarray]:
        n = j - i
        if st.L <= 0 or not st.home:
            return np.zeros(n, dtype=bool), np.zeros(n)
        ok, a = self.px("own", i, j)
        f0, f1 = self._earned(st, i, j)
        sp = np.power(1.0001, a / 2.0)
        sa, sb = sqrt_at(st.tl), sqrt_at(st.tu)
        spc = np.clip(sp, sa, sb)
        p0, p1 = st.L * (1.0 / spc - 1.0 / sb), st.L * (spc - sa)
        base = p0 * sp * sp + p1
        val = f0 * sp * sp + f1
        with np.errstate(divide="ignore", invalid="ignore"):
            bps = np.where(base > 0, val * BPS / base, 0.0)  # exact, like Rules (no rounding to whole bps)
        return ok & (base > 0), bps

    # ---- conditions
    def _cond_mask(self, st: State, slot: str, d: Side, cond: tuple, i: int, j: int, best: np.ndarray | None) -> np.ndarray:
        checker, value, pool = cond
        ts = self.s.ts[i:j]
        if checker == CHECK_TIME:
            return ts >= d.last_run + value * 60
        if checker == CHECK_EXTERNAL:
            return np.zeros(j - i, dtype=bool)
        if checker in (CHECK_FEES, CHECK_APR):
            ok, bps = self.fee_bps(st, i, j)
            if checker == CHECK_FEES:
                return ok & (bps >= value)
            clock = max(x.last_run for x in st.sides.values())
            elapsed = ts - clock
            with np.errstate(divide="ignore", invalid="ignore"):
                rate = np.where(elapsed > 0, bps * 365 * 86400 / np.maximum(elapsed, 1), 0.0)
            return ok & (elapsed >= MIN_APR_TIME) & (rate < value)
        ok, t = self.px(self._pool_of(st, pool), i, j)
        if checker == CHECK_EDGE:
            return ok & ((t >= st.tu + value) if slot == "upper" else (t < st.tl - value))
        if checker in (CHECK_TICK, CHECK_LINK):
            return ok & ((t >= value) if slot == "upper" else (t < value))
        if checker == CHECK_TRAIL:
            b = best if best is not None else np.full(j - i, d.best)
            return ok & ((t >= b + value) if slot == "upper" else (t < b - value))
        return np.zeros(j - i, dtype=bool)

    def _best(self, st: State, slot: str, d: Side, i: int, j: int) -> np.ndarray | None:
        """A trailing side's best tick at rows i..j-1: someone pokes each new best (the keeper does)."""
        pool = d.trail_pool()
        if pool is None:
            return None
        ok, t = self.px(self._pool_of(st, pool), i, j)
        if slot == "upper":
            return np.minimum(d.best, np.minimum.accumulate(np.where(ok, t, d.best)))
        return np.maximum(d.best, np.maximum.accumulate(np.where(ok, t, d.best)))

    def met(self, st: State, slot: str, d: Side, i: int, j: int) -> np.ndarray:
        """Rules.met at rows i..j-1: the side's conditions (no hold, no MIN_GAP)."""
        best = self._best(st, slot, d, i, j)
        cs = d.conds()
        m = self._cond_mask(st, slot, d, cs[0], i, j, best)
        if len(cs) == 2:
            m2 = self._cond_mask(st, slot, d, cs[1], i, j, best)
            m = (m & m2) if d.combine == COMBINE_AND else (m | m2)
        return m

    def _armed(self, m: np.ndarray, d: Side, i: int) -> np.ndarray:
        """When each row's run of true conditions began (poke arms at its first row; 0 where it is false). A run
        that began before row i carries d.armed."""
        ts = self.s.ts[i : i + len(m)]
        prev = np.concatenate([[d.armed > 0], m[:-1]])
        starts = m & ~prev
        last = np.maximum.accumulate(np.where(starts, np.arange(len(m)), -1))
        at = np.where(last >= 0, ts[np.maximum(last, 0)], d.armed)
        return np.where(m, at, 0.0)

    def mask(self, st: State, slot: str, d: Side, i: int, j: int) -> np.ndarray:
        m = self.met(st, slot, d, i, j)
        ts = self.s.ts[i:j]
        if d.hold_min:
            m = m & (ts >= self._armed(m, d, i) + d.hold_min * 60)
        # ConditionalOrders.MIN_GAP: at most once a minute after the side's last run (kept to the minute)
        return m & (ts >= d.last_run + MIN_GAP)

    def cond_at(self, st: State, slot: str, d: Side, k: int) -> bool:
        return bool(self.mask(st, slot, d, k, k + 1)[0])

    def _carry(self, st: State, slot: str, d: Side, i: int, j: int) -> None:
        """What pokes at rows i..j-1 leave in a side: the best price of a trailing side, the arming of a hold."""
        if j <= i:
            return
        if d.hold_min:
            d.armed = float(self._armed(self.met(st, slot, d, i, j), d, i)[-1])
        b = self._best(st, slot, d, i, j)
        if b is not None:
            d.best = int(b[-1])

    def move_best(self, st: State, i: int, k: int) -> None:
        """Keepers poke every side at each swap of rows i+1..k."""
        for slot, d in st.sides.items():
            if d.checker != CHECK_OFF:
                self._carry(st, slot, d, i + 1, k + 1)

    def rearm(self, st: State, k: int, ran: str | None) -> None:
        """After a run at row k the keeper pokes again: a hold whose condition is still true stays armed (the side
        that ran, or sides that just entered play, from now), one that is false is forgotten."""
        for slot, d in st.sides.items():
            if d.checker == CHECK_OFF or not d.hold_min:
                continue
            true_now = bool(self.met(st, slot, d, k, k + 1)[0])
            d.armed = (d.armed if (d.armed and slot != ran) else float(self.s.ts[k])) if true_now else 0.0

    def first_true(self, st: State, slot: str, d: Side, i: int) -> int | None:
        """First row >= i where the side can run (searches in growing chunks)."""
        end = self.i1
        step = 4096
        d = replace(d)  # trailing best moves while scanning; keep the side itself unchanged
        while i < end:
            j = min(end, i + step)
            hit = np.flatnonzero(self.mask(st, slot, d, i, j))
            if len(hit):
                return i + int(hit[0])
            self._carry(st, slot, d, i, j)
            i = j
            step *= 4
        return None

    def _after_delay(self, j: int) -> int:
        k = int(np.searchsorted(self.s.ts, self.s.ts[j] + self.p.delay_s, side="left"))
        return max(k, j)

    def next_event(self, st: State, slot: str, d: Side, start: int) -> int | None:
        j = self.first_true(st, slot, d, start)
        return None if j is None else self._after_delay(j)

    # ---- fees and time in range for swaps (i, k]
    def accrue(self, st: State, i: int, k: int) -> None:
        if k <= i:
            return
        s = self.s
        if st.L > 0:
            f0, f1 = self._earned(st, i, k + 1)
            sa, sb = sqrt_at(st.tl), sqrt_at(st.tu)
            for idx in [x for x in self.samples_wanted if i < x <= k]:
                r = idx - i
                a0, a1 = amounts(st.L, s.sp1[idx], sa, sb)
                self.samples[idx] = self.usd(st.w0 + a0 + f0[r], st.w1 + a1 + f1[r], s.sp1[idx], idx)
                self.ranges[idx] = (st.tl, st.tu)
            st.f0, st.f1 = float(f0[-1]), float(f1[-1])
            dur = np.diff(s.ts[i : k + 1])
            inr = (s.sp1[i + 1 : k + 1] >= sa) & (s.sp1[i + 1 : k + 1] <= sb)
            st.in_range_s += float(np.sum(dur * inr))
            st.live_s += float(np.sum(dur))
        else:
            for idx in [x for x in self.samples_wanted if i < x <= k]:
                self.samples[idx] = self.usd(st.w0 + st.held0, st.w1 + st.held1, s.sp1[idx], idx)

    # ---- swaps
    def swap(self, w0: float, w1: float, zero_for_one: bool, k: int, stop: float | None = None):
        """Sell all of one token at the pool's liquidity at that moment, within maxSlippage of the price before it, or
        stop earlier at `stop` (a sqrt price: the mix a range needs). As in the contract, a swap the slippage limit would
        cut short makes the whole run revert and wait: None."""
        s, p = self.s, self.p
        amount_in = w0 if zero_for_one else w1
        if amount_in <= 0:
            return w0, w1, "nothing to convert"
        ref = int(s.tick[k])
        slip = p.slippage_steps * 10
        sl = sqrt_at(max(MIN_TICK + 1, min(MAX_TICK - 1, ref - slip if zero_for_one else ref + slip)))
        to_mix = stop is not None and (stop > sl if zero_for_one else stop < sl)
        if to_mix:
            sl = stop
        sp = float(s.sp1[k])
        if (zero_for_one and sl >= sp) or (not zero_for_one and sl <= sp):
            return (w0, w1, "") if to_mix else None
        L = float(s.lpost[k])
        net = amount_in * (1 - s.fee)
        used = min(net, L * (1 / sl - 1 / sp)) if zero_for_one else min(net, L * (sl - sp))
        if used < net and not to_mix:
            return None  # SlippageLimit: the run waits
        if zero_for_one:  # token0 in, price falls
            sp_new = L * sp / (L + used * sp)
            return w0 - used / (1 - s.fee), w1 + L * (sp - sp_new), "converted"
        sp_new = sp + used / L
        return w0 + L * (1 / sp - 1 / sp_new), w1 - used / (1 - s.fee), "converted"

    def zap(self, w0: float, w1: float, tl: int, tu: int, k: int):
        """Rules.mixFor + the vault's swap: sell towards the range's mix, stopping where what is left fits it."""
        s = self.s
        sp, sa, sb, L = float(s.sp1[k]), sqrt_at(tl), sqrt_at(tu), float(s.lpost[k])
        if sp <= sa:
            return self.swap(w0, w1, False, k) if w1 > 0 else (w0, w1, "")
        if sp >= sb:
            return self.swap(w0, w1, True, k) if w0 > 0 else (w0, w1, "")
        n0, n1 = amounts(1.0, sp, sa, sb)
        want1 = (w0 * sp * sp + w1) * n1 / (n0 * sp * sp + n1)
        if abs(w1 - want1) < 1e-12 * max(w1, 1.0):
            return w0, w1, ""
        zero_for_one = w1 < want1

        def too_much1(q: float) -> bool:
            h0, h1 = w0, w1
            if q >= sp:
                spent = L * (q - sp)
                if spent > h1:
                    return False
                h1, h0 = h1 - spent, h0 + L * (1 / sp - 1 / q)
            else:
                spent = L * (1 / q - 1 / sp)
                if spent > h0:
                    return True
                h0, h1 = h0 - spent, h1 + L * (sp - q)
            m0, m1 = amounts(1.0, q, sa, sb)
            return h1 * m0 > h0 * m1

        lo, hi = (sa, sp) if zero_for_one else (sp, sb)
        for _ in range(60):
            q = (lo + hi) / 2
            if too_much1(q):
                lo = q
            else:
                hi = q
        return self.swap(w0, w1, zero_for_one, k, stop=hi if zero_for_one else lo)

    # ---- taking tokens out (shared by runs and moves)
    def _take(self, st: State, d: Side, k: int):
        """Remove (removeBps) and collect, set the keeper's fee aside, set aside fees not kept. Returns (new
        state, w0, w1, res0, res1, pay0, pay1, note)."""
        s, p = self.s, self.p
        sp = float(s.sp1[k])
        new = _copy(st)
        cap = p.keeper_fee_bps / BPS
        if new.home:
            sa, sb = sqrt_at(st.tl), sqrt_at(st.tu)
            remove_l = (new.L if d.remove_bps >= BPS else new.L * d.remove_bps / BPS) if d.actions & ACT_REMOVE else 0.0
            a0, a1 = amounts(remove_l, sp, sa, sb)
            f0, f1 = new.f0, new.f1  # every modifyLiquidity collects all fees
            new.fees_usd += self.usd(f0, f1, sp, k)
            out0, out1 = a0 + f0, a1 + f1
            new.L -= remove_l
            new.f0 = new.f1 = 0.0
        else:  # leaving a waiting leg: the held tokens
            out0, out1, f0, f1 = new.held0, new.held1, 0.0, 0.0
            new.held0 = new.held1 = 0.0
        # a parked leg's swap (into the shared token) is in the parking pool: the money is already counted as that token
        swaps = bool(d.actions & ACT_SWAP) and st.home
        res0, res1 = out0 * cap, out1 * cap
        if swaps:  # a run that swaps takes the keeper's fee after the swap
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
            r = self.swap(w0, w1, d.swap_to_token1, k)
            if r is None:
                return None
            b0, b1 = w0, w1
            w0, w1, said = r
            note.append(said)
            if d.swap_to_token1:
                r_sold, r_bought = w0 * cap, max(0.0, w1 - b1) * cap
                res0, res1, w0, w1 = r_sold, res1 + r_bought, w0 - r_sold, w1 - r_bought
            else:
                r_sold, r_bought = w1 * cap, max(0.0, w0 - b0) * cap
                res1, res0, w1, w0 = r_sold, res0 + r_bought, w1 - r_sold, w0 - r_bought
        return new, w0, w1, res0, res1, pay0, pay1, note

    def _pay_keeper(self, new: State, res0: float, res1: float, sp: float, k: int | None = None) -> tuple[float, float]:
        """The keeper takes its whole fee: nothing of it comes back to the owner."""
        new.keeper_usd += self.usd(res0, res1, sp, k)
        return 0.0, 0.0

    def _start_side(self, d: Side, k: int) -> Side:
        """A side entering play at row k: it starts its clock now, and a trailing side its best price."""
        e = replace(d)
        e.last_run = stored_time(float(self.s.ts[k]))
        e.armed = 0.0
        if e.trail_pool() is not None:
            ok, t = self.px("other" if e.trail_pool() == "other" else "own", k, k + 1)
            e.best = int(t[0]) if ok[0] else 0
        return e

    def _close(self, new: State, sp: float, note: list) -> None:
        nsa, nsb = sqrt_at(new.tl), sqrt_at(new.tu)
        r0, r1 = amounts(new.L, sp, nsa, nsb) if new.L > 0 else (0.0, 0.0)
        new.w0 += r0 + new.held0
        new.w1 += r1 + new.held1
        new.L = new.held0 = new.held1 = 0.0
        new.open = False
        note.append("closed")

    # ---- one run of one side at row k (None: the contract would revert, a keeper tries again later)
    def execute(self, st: State, slot: str, k: int) -> State | None:
        d = st.sides[slot]
        if d.actions & ACT_MOVE:
            return self.move(st, slot, k)
        s = self.s
        sp = float(s.sp1[k])
        taken = self._take(st, d, k)
        if taken is None:
            return None
        new, w0, w1, res0, res1, pay0, pay1, note = taken
        nd = new.sides[slot]
        if d.actions & ACT_ADD:
            s_ = s.spacing
            if d.add_mode == ADD_CENTERED:
                # Rules.centeredRange around the price, then the vault swaps to that range's mix (like a move)
                mid = floor_to(int(s.tick[k]), s_)
                ntl = max(min_usable(s_), mid - (d.shape & 2047) * s_)
                ntu = min(max_usable(s_), mid + ((d.shape >> 11) & 2047) * s_)
                z = self.zap(w0, w1, ntl, ntu, k)
                if z is None:
                    return None
                w0, w1, _ = z
                nsa, nsb = sqrt_at(ntl), sqrt_at(ntu)
                la = liquidity_for(sp, nsa, nsb, max(w0, 0.0), max(w1, 0.0)) * 0.9999
                if la > 0:
                    c0, c1 = amounts(la, sp, nsa, nsb)
                    w0, w1 = w0 - c0, w1 - c1
                    new.L, new.tl, new.tu = new.L + la, ntl, ntu
                    lo_, hi_ = sorted((float(s.price(nsa)), float(s.price(nsb))))
                    note.append(f"new range {fmt(lo_)}-{fmt(hi_)}")
            else:
                sa, sb = sqrt_at(st.tl), sqrt_at(st.tu)
                la = liquidity_for(sp, sa, sb, w0, w1) * 0.9999 if (w0 > 0 or w1 > 0) else 0.0
                if la > 0:
                    c0, c1 = amounts(la, sp, sa, sb)
                    w0, w1 = w0 - c0, w1 - c1
                    new.L += la
                    note.append(f"re-added {fmt(self.usd(c0, c1, sp, k))} USD")

        nd.last_run = stored_time(float(s.ts[k]))
        again = d.repeat
        if again and d.runs_left:
            nd.runs_left = d.runs_left - 1  # a limited side switches off after its last run
            again = nd.runs_left != 0
        if again:
            if nd.trail_pool() is not None:
                ok, t = self.px("other" if nd.trail_pool() == "other" else "own", k, k + 1)
                nd.best = int(t[0]) if ok[0] else nd.best  # starts again from the price after the run
            if not (d.actions & ACT_ADD and d.add_mode == ADD_CENTERED):
                step = d.shape if slot == "upper" else -d.shape
                if d.checker in LEVELS:
                    nd.value = d.value + step
                if d.combine != COMBINE_NONE and d.checker2 in LEVELS:
                    nd.value2 = d.value2 + step
        else:
            new.sides[slot] = Side(edge=d.edge, last_run=nd.last_run)  # cleared: the run time stays (the fee clock)

        back0, back1 = self._pay_keeper(new, res0, res1, sp, k)
        new.w0 += w0 + pay0 + back0
        new.w1 += w1 + pay1 + back1
        new.runs += 1
        if new.L <= 0 or all(x.checker == CHECK_OFF for x in new.sides.values()):
            self._close(new, sp, note)
        self.events.append({"t": float(s.ts[k]), "price": float(s.price(sp)), "side": slot, "note": note})
        return new

    def move(self, st: State, slot: str, k: int) -> State | None:
        """ConditionalOrders._move: everything out of the live leg (swapping first if the side says so) and into the
        other one, which becomes the live leg; the leg that is left keeps its sides for the way back."""
        s, plan = self.s, self.plan
        sp = float(s.sp1[k])
        d = st.sides[slot]
        taken = self._take(st, d, k)
        if taken is None:
            return None
        new, w0, w1, res0, res1, pay0, pay1, note = taken
        nd = new.sides[slot]
        nd.last_run = stored_time(float(s.ts[k]))
        if nd.runs_left:
            nd.runs_left -= 1
            if nd.runs_left == 0:
                new.sides[slot] = Side(edge=d.edge, last_run=nd.last_run)
        left_sides, next_sides = new.sides, new.other_sides
        to_home = not new.home
        if to_home:
            ref = int(s.tick[k])
            if plan.home_kind == LEG_RANGE:
                tl, tu = plan.home_a, plan.home_b
            else:
                mid = floor_to(ref, s.spacing)
                tl = max(min_usable(s.spacing), mid - plan.home_a)
                tu = min(max_usable(s.spacing), mid + plan.home_b)
            z = self.zap(w0, w1, tl, tu, k)
            if z is None:
                return None
            w0, w1, said = z
            sa, sb = sqrt_at(tl), sqrt_at(tu)
            la = liquidity_for(sp, sa, sb, max(w0, 0.0), max(w1, 0.0)) * 0.9999
            if la <= 0:
                return None  # NothingToEnter: the move waits
            c0, c1 = amounts(la, sp, sa, sb)
            w0, w1 = w0 - c0, w1 - c1
            new.L, new.tl, new.tu = la, tl, tu
            lo_, hi_ = sorted((float(s.price(sa)), float(s.price(sb))))
            note.append(f"back in {fmt(lo_)}-{fmt(hi_)}")
            edges = (tl, tu)
        else:
            # waiting (or parked: modelled as holding the token the parking pool shares)
            if plan.away_kind != LEG_IDLE and plan.shared in ("token0", "token1"):
                if plan.shared == "token0":
                    new.held0, w0 = w0, 0.0
                else:
                    new.held1, w1 = w1, 0.0
                note.append("parked")
            else:
                new.held0, new.held1, w0, w1 = w0, w1, 0.0, 0.0
                note.append("waiting")
            new.tl = new.tu = 0
            edges = (0, 0)
        new.home = to_home
        new.other_sides = left_sides
        new.sides = {n: self._start_side(replace(x, edge=edges[0] if n == "lower" else edges[1]), k) for n, x in next_sides.items()}
        back0, back1 = self._pay_keeper(new, res0, res1, sp, k)
        new.w0 += w0 + pay0 + back0
        new.w1 += w1 + pay1 + back1
        new.runs += 1
        new.moves += 1
        if all(x.checker == CHECK_OFF for x in new.sides.values()):
            self._close(new, sp, note)
        self.events.append({"t": float(s.ts[k]), "price": float(s.price(sp)), "side": slot, "note": note})
        return new

    # ---- whole run
    def run(self, st: State, sample_idx: list[int]) -> State:
        """Like a keeper that looks after every swap: at each swap, every side that can run does, lower side first.
        A run the contract would refuse is tried again at the next swaps."""
        self.samples_wanted = sample_idx
        i = self.i0
        done: set[str] = {"lower", "upper"}  # nothing at the first row: the order was just created there
        guard = 4 * (self.i1 - self.i0) + 10_000
        while st.open and st.runs < MAX_RUNS and guard > 0:
            guard -= 1
            best = None
            for slot, d in st.sides.items():
                if d.checker == CHECK_OFF:
                    continue
                k = self.next_event(st, slot, d, i + (1 if slot in done else 0))
                if k is not None and (best is None or k < best[0]):
                    best = (k, slot)
            if best is None:
                break
            k, slot = best
            if k >= self.i1:
                break
            if k != i:
                done = set()
            self.accrue(st, i, k)
            self.move_best(st, i, k)
            i = k
            done.add(slot)
            d = st.sides[slot]
            if not self.cond_at(st, slot, d, k):
                continue  # the price moved back before the keeper's transaction
            nxt = self.execute(st, slot, k)
            if nxt is None:
                self.failed += 1  # the contract reverts; the keeper tries again later
                continue
            st = nxt
            self.rearm(st, k, slot)
        self.accrue(st, i, self.i1 - 1)
        return st


def fmt(x: float) -> str:
    return f"{x:,.0f}" if abs(x) >= 100 else f"{x:,.4g}"


# ---------------------------------------------------------------- entry point


def _reads_other(order: dict) -> bool:
    home = int(order.get("homeIndex", 0))
    for k in ("lower", "upper", "awayLower", "awayUpper"):
        d = decode_word(int(order.get(k, "0") or 0), home)
        if any(p == "other" for c, _, p in d.conds() if c != CHECK_OFF):
            return True
    return False


def run(req: dict, s: Series | None = None) -> dict:
    s = s if s is not None else series_for(req)
    order = req.get("order") or {}
    reads = _reads_other({**order, "homeIndex": req.get("homeIndex", 0)})
    if reads and s.source != "recorded":
        raise ValueError("rules that watch another pool can be backtested on the recorded ETH/USDC history only")
    if reads and s.key not in OTHER_POOL:
        raise ValueError("rules that watch another pool can be backtested on the ETH/USDC histories only")
    other = load(OTHER_POOL[s.key]) if reads else None
    return run_series(s, other, req)


def side_fields(d: Side) -> dict:
    return {"checker": d.checker, "value": d.value, "checkPool": d.check_pool, "actions": d.actions, "removeBps": d.remove_bps,
            "swapToToken1": d.swap_to_token1, "addMode": d.add_mode, "repeat": d.repeat, "shape": d.shape, "checker2": d.checker2,
            "value2": d.value2, "checkPool2": d.check_pool2, "combine": d.combine, "holdMinutes": d.hold_min, "runsLeft": d.runs_left}


def run_series(s: Series, other: Series | None, req: dict) -> dict:
    """The backtest on a loaded (or synthetic) swap series.

    req["order"]: the words the editor would send ({lower, upper, home: {kind, a, b}, away: {kind, a, b, shared},
    awayLower, awayUpper}, words as decimal strings), made at today's price: req["refTick"] (this pool's tick then),
    req["otherRefTick"] (a watched other pool's), req["homeIndex"] (this pool's index in the hook's table) and
    req["baseIs0"] (whether this pool's token0 is the base token, to mirror the words onto a series quoted the other
    way round)."""
    key = s.key
    t_first, t_last = float(s.ts[0]), float(s.ts[-1])
    days = float(req.get("days", 30))
    start = float(req.get("start", t_first))
    start = min(max(start, t_first), t_last - 86400) if t_last - t_first > 86400 else t_first
    end = min(start + days * 86400, t_last)
    i0 = int(np.searchsorted(s.ts, start))
    i1 = int(np.searchsorted(s.ts, end, side="right"))
    if i1 - i0 < 10:
        raise ValueError("window too short")

    p = Params(
        keeper_fee_bps=int(req.get("keeperFeeBps", 10)),
        slippage_steps=max(1, round(float(req.get("slippagePct", 1)) * 10)),
        delay_s=float(req.get("delaySec", 12)),
    )
    deposit = float(req.get("depositUsd", 10_000))

    # entry: range around the price before the first swap of the window
    sp_in = float(s.sp0[i0])
    entry = float(s.price(sp_in))
    entry_tick = int(math.floor(2.0 * math.log(sp_in) / LN))
    rng = req.get("range") or {"loPct": -5, "hiPct": 5}
    spc = s.spacing
    if req.get("ticks"):
        tl, tu = int(req["ticks"][0]), int(req["ticks"][1])
    elif rng.get("full"):
        tl, tu = min_usable(spc), max_usable(spc)
    else:
        a = s.tick_at_price(entry * (1 + rng["loPct"] / 100))
        b = s.tick_at_price(entry * (1 + rng["hiPct"] / 100))
        tl, tu = max(min_usable(spc), floor_to(min(a, b), spc)), min(max_usable(spc), floor_to(max(a, b), spc) + spc)
    sa, sb = sqrt_at(tl), sqrt_at(tu)

    # the order: the editor's words, placed on this series
    order = req.get("order") or {}
    home_index = int(req.get("homeIndex", 0))
    flip = bool(req.get("baseIs0", s.base_is0)) != s.base_is0
    other_entry = int(other.tick[max(0, int(np.searchsorted(other.ts, start)) - 1)]) if other is not None else 0
    pl = Placement(flip=flip, own_ref=int(req.get("refTick", entry_tick)), own_entry=entry_tick,
                   other_ref=int(req.get("otherRefTick", other_entry)), other_entry=other_entry,
                   spacing_ratio=float(req.get("spacing", s.spacing)) / s.spacing)

    def sides_of(lo_key: str, up_key: str) -> dict:
        lo = place_side(decode_word(int(order.get(lo_key, "0") or 0), home_index), pl)
        up = place_side(decode_word(int(order.get(up_key, "0") or 0), home_index), pl)
        return {"lower": up, "upper": lo} if flip else {"lower": lo, "upper": up}

    home_sides = sides_of("lower", "upper")
    away = order.get("away") or {}
    plan = None
    if int(away.get("kind", 0)):
        home = order.get("home") or {}
        shared = away.get("shared")
        if flip and shared in ("token0", "token1"):
            shared = "token1" if shared == "token0" else "token0"
        ha, hb = int(home.get("a", 0)), int(home.get("b", 0))
        if int(home.get("kind", 0)) == LEG_RANGE:
            ha, hb = tl, tu  # "the same range": this backtest's range
        elif flip:
            ha, hb = hb, ha
        plan = Plan(home_kind=int(home.get("kind", LEG_RANGE)), home_a=ha, home_b=hb, away_kind=int(away["kind"]), shared=shared)

    def start_state() -> State:
        st = State(tl=tl, tu=tu)
        unit0, unit1 = amounts(1.0, sp_in, sa, sb)
        st.L = deposit / Sim(s, i0, i1, p, None).usd(unit0, unit1, sp_in)
        if req.get("liquidity"):  # an exact position size (scripts/parity_engine.py: the contract test's order)
            st.L = float(req["liquidity"])
        return st

    n_samples = 240
    sample_idx = sorted(set(np.linspace(i0 + 1, i1 - 1, n_samples).astype(int).tolist()))

    st = start_state()
    a0_in, a1_in = amounts(st.L, sp_in, sa, sb)
    sim = Sim(s, i0, i1, p, other, plan)
    sides = {n: sim._start_side(replace(d, edge=tl if n == "lower" else tu), i0) if d.checker != CHECK_OFF else Side(edge=tl if n == "lower" else tu, last_run=stored_time(float(s.ts[i0])))
             for n, d in home_sides.items()}
    st.sides = sides
    if plan:
        st.other_sides = sides_of("awayLower", "awayUpper")
    created = {n: replace(d) for n, d in sides.items()}
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
        return sim_.usd(st_.w0 + a0 + st_.f0 + st_.held0, st_.w1 + a1 + st_.f1 + st_.held1, sp_end, i1 - 1)

    # every value is in USD of its own moment (an ETH-quoted pair at that moment's ETH price)
    v_rules, v_plain = value(final, sim), value(plain_final, plain)
    v_hold = sim.usd(a0_in, a1_in, sp_end, i1 - 1)
    fees_rules = final.fees_usd + sim.usd(final.f0, final.f1, sp_end, i1 - 1)
    fees_plain = plain_final.fees_usd + plain.usd(plain_final.f0, plain_final.f1, sp_end, i1 - 1)

    t, price, strat, pl_, hold, lo, hi = [], [], [], [], [], [], []
    for idx in sample_idx:
        spx = float(s.sp1[idx])
        t.append(float(s.ts[idx]))
        price.append(float(s.price(spx)))
        strat.append(sim.samples.get(idx, None))
        pl_.append(plain.samples.get(idx, None))
        hold.append(sim.usd(a0_in, a1_in, spx, idx))
        r = sim.ranges.get(idx)
        if r:
            x, y = sorted((float(s.price(sqrt_at(r[0]))), float(s.price(sqrt_at(r[1])))))
            lo.append(x)
            hi.append(y)
        else:
            lo.append(None)
            hi.append(None)
    for arr in (strat, pl_):
        last = deposit
        for n, v in enumerate(arr):
            if v is None:
                arr[n] = last
            else:
                last = v

    lo_p, hi_p = sorted((float(s.price(sa)), float(s.price(sb))))
    parked = plan is not None and plan.away_kind != LEG_IDLE
    return {
        "pool": key,
        "poolLabel": s.label or POOL_LABELS.get(key, key),
        "source": s.source,
        "base": (s.token0 if s.base_is0 else s.token1).replace("WETH", "ETH"),
        "quote": (s.token1 if s.base_is0 else s.token0).replace("WETH", "ETH"),
        "address": s.address or None,
        "quoteUsd": sim.quote_usd,
        "ticks": [tl, tu],
        "sides": {n: side_fields(d) for n, d in created.items()},
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
            "moves": final.moves,
            "refused": sim.failed,
            "timeInRange": final.in_range_s / max(final.live_s, 1.0) if final.live_s else 0.0,
            "closed": not final.open,
            "away": not final.home,
        },
        "noRules": {"final": v_plain, "fees": fees_plain, "timeInRange": plain_final.in_range_s / max(plain_final.live_s, 1.0)},
        "hold": {"final": v_hold},
        "usdc": {"final": deposit},
        "series": {"t": t, "price": price, "rules": strat, "noRules": pl_, "hold": hold, "lo": lo, "hi": hi},
        "events": sim.events[:500],
        "assumptions": {
            "keeperDelaySec": p.delay_s,
            "keeperFeeBps": p.keeper_fee_bps,
            "slippagePct": p.slippage_steps / 10,
        },
        "caveats": ([
            "Prices: every round of the two tokens' Chainlink USD feeds on Sepolia, read from the chain.",
            "Swaps: only the arbitrage trades that keep the pool on the Chainlink price (to the edge of its fee band). "
            "Real pools also have ordinary traders, so fees here are a lower bound.",
        ] if s.source == "chainlink" else []) + ([
            "Values are in USD at each moment's price of the quote token (an ETH-quoted pair at that moment's ETH price).",
        ] if s.quote_usd is not None else []) + [
            "Real swaps from the recorded window; past results do not predict future ones." if s.source == "recorded"
            else "Past results do not predict future ones.",
            "Conditions read the pool's price after each swap. On chain a step also needs that price within about 2% of Chainlink; "
            "the replay assumes it is (arbitrage keeps deep pools there).",
            "A step whose swap cannot sell everything within your slippage waits and is tried again (shown as refused): "
            "if that happens often, your position is large next to the pool, so raise the slippage.",
            "Your own swaps do not move later prices in the replay, and they use the pool's liquidity at that moment.",
        ] + ([
            "A side that uses your own condition contract is not replayed: the replay cannot run its code on history, so "
            "that condition is never true here.",
        ] if any(x.checker == CHECK_EXTERNAL or x.checker2 == CHECK_EXTERNAL for x in list(created.values())) else []) + [
            "Fees assume your position is small next to the pool.",
            "A keeper runs each rule a fixed delay after its condition is met; price manipulation and MEV are not modelled.",
            "Trailing stops: the best price is updated at every swap (it assumes someone pokes each new best, as the keeper does).",
            "Chainlink price levels are tested against this pool's price: no Chainlink history is loaded for them, and the real feed updates less often."
            if s.source == "recorded" else
            "Chainlink price levels are tested against the pool's price, which stays within its fee band of Chainlink here.",
        ] + (["Moves into another pool: that pool's fees are not modelled; while moved, the money is counted as the token it holds there (moved = held)."] if parked else []),
    }


def run_windows(req: dict, window_days: int = 30, every_days: int = 7) -> dict:
    """The same rules over every window_days-long window starting every every_days."""
    s = series_for(req, since=time.time() - 200 * 86400)
    t0, t1 = float(s.ts[0]), float(s.ts[-1])
    out = []
    start = t0
    caveats: list[str] = []
    while start + window_days * 86400 <= t1:
        r = run({**req, "start": start, "days": window_days}, s)
        caveats = r.get("caveats", caveats)
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
        # windows start every few days, so they overlap: this many share no days
        "independent": max(1, int((t1 - t0) // (window_days * 86400))),
        "caveats": caveats,
    }
