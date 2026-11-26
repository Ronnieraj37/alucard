"""Reads the price history of our own testnet pools (Sepolia, Unichain Sepolia) from the chain: Chainlink rounds, the pool's liquidity, and the
token list (PriceFeeds). Standard library only; every read is an eth_call (batched through Multicall3), so it works
with any RPC, including free plans that limit eth_getLogs.

RPC: per chain. Sepolia: RPC_URL, else NEXT_PUBLIC_RPC_URL, else a public node. Unichain Sepolia: UNICHAIN_RPC_URL,
else the Sepolia Alchemy URL with the network swapped (one Alchemy key serves both), else the public node.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEPLOYMENT = os.path.join(HERE, "_data", "deployment.json")  # written by npm run sync, bundled with the function
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
PUBLIC_RPC = "https://ethereum-sepolia-rpc.publicnode.com"

SEL_LATEST = "feaf968c"  # latestRoundData()
SEL_ROUND = "9a6fc8f5"  # getRoundData(uint80)
SEL_AGG3 = "82ad56cb"  # aggregate3((address,bool,bytes)[])
SEL_FEEDS = "2fba4aa9"  # PriceFeeds.feeds(address)
SEL_POOL_STATE = "26479bd6"  # Rules.poolState(uint24)
PUBLIC = {11155111: "https://ethereum-sepolia-rpc.publicnode.com", 1301: "https://sepolia.unichain.org"}
CHAIN = 11155111  # the chain this request reads (use())

BATCH = 300  # rounds per eth_call
MAX_ROUNDS = 8000  # ~11 months of an hourly feed
CACHE_S = 600  # a feed's history is refetched at most every 10 minutes per instance

_feed_cache: dict[str, tuple[float, list[tuple[int, int]]]] = {}


def use(chain_id: int | None) -> None:
    """Read this chain from now on (one request at a time per instance)."""
    global CHAIN
    CHAIN = int(chain_id or 11155111)


def rpc_url() -> str:
    sep = os.environ.get("RPC_URL") or os.environ.get("NEXT_PUBLIC_RPC_URL")
    if CHAIN == 1301:
        uni = os.environ.get("UNICHAIN_RPC_URL") or os.environ.get("NEXT_PUBLIC_UNICHAIN_RPC_URL")
        if uni:
            return uni
        if sep and "eth-sepolia.g.alchemy.com" in sep:
            return sep.replace("eth-sepolia", "unichain-sepolia")
        return PUBLIC[1301]
    return sep or PUBLIC_RPC


def deployment() -> dict:
    """This chain's deployment (core, tokens, pools), from the file npm run sync writes."""
    with open(DEPLOYMENT) as f:
        d = json.load(f)
    chains = d.get("chains")
    if chains is None:
        return d  # an older single-chain file
    if str(CHAIN) not in chains:
        raise ValueError(f"not deployed on chain {CHAIN}")
    return chains[str(CHAIN)]


def _rpc(method: str, params: list):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(rpc_url(), body, {"content-type": "application/json", "user-agent": "alucard-backtest"})
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                res = json.load(r)
            if "error" in res:
                raise RuntimeError(f"rpc {method}: {res['error'].get('message', res['error'])}")
            return res["result"]
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"rpc {method} failed: {last}")


def call(to: str, data: str) -> bytes:
    return bytes.fromhex(_rpc("eth_call", [{"to": to, "data": "0x" + data}, "latest"])[2:])


# ---------------------------------------------------------------- ABI helpers (only what we need)

def _word(x: int) -> str:
    return format(x % (1 << 256), "064x")


def _addr(a: str) -> str:
    return a.lower().replace("0x", "").rjust(64, "0")


def _words(b: bytes) -> list[int]:
    return [int.from_bytes(b[i:i + 32], "big") for i in range(0, len(b) - len(b) % 32, 32)]


def _signed(x: int) -> int:
    return x - (1 << 256) if x >= 1 << 255 else x


def aggregate3(calls: list[tuple[str, str]]) -> list[tuple[bool, bytes]]:
    """Multicall3.aggregate3 with allowFailure = true for every call: (success, return data) per call."""
    n = len(calls)
    heads, tails, off = [], [], 32 * n
    for to, data in calls:
        b = bytes.fromhex(data)
        pad = (32 - len(b) % 32) % 32
        enc = _addr(to) + _word(1) + _word(96) + _word(len(b)) + b.hex() + "00" * pad
        heads.append(_word(off))
        tails.append(enc)
        off += len(enc) // 2
    out = call(MULTICALL3, SEL_AGG3 + _word(32) + _word(n) + "".join(heads) + "".join(tails))
    # returns (bool success, bytes returnData)[]
    base = int.from_bytes(out[0:32], "big")
    count = int.from_bytes(out[base:base + 32], "big")
    res = []
    for i in range(count):
        p = base + 32 + int.from_bytes(out[base + 32 + 32 * i:base + 64 + 32 * i], "big")
        ok = int.from_bytes(out[p:p + 32], "big") == 1
        q = p + int.from_bytes(out[p + 32:p + 64], "big")
        ln = int.from_bytes(out[q:q + 32], "big")
        res.append((ok, out[q + 32:q + 32 + ln]))
    return res


# ---------------------------------------------------------------- reads

def feed_of(price_feeds: str, token: str) -> tuple[str, int, int]:
    """(aggregator, feed decimals, token decimals) of a listed token. Raises if the token is not listed."""
    w = _words(call(price_feeds, SEL_FEEDS + _addr(token)))
    agg = "0x" + format(w[0], "040x")
    if w[0] == 0:
        raise ValueError(f"token {token} is not on the token list")
    return agg, w[2], w[3]


def pool_liquidity(rules: str, pool_index: int) -> int:
    w = _words(call(rules, SEL_POOL_STATE + _word(pool_index)))
    return w[2]


def feed_history(aggregator: str, since: float) -> list[tuple[int, int]]:
    """(updatedAt, answer) of every round of the feed's current phase back to `since`, oldest first."""
    key = aggregator.lower()
    hit = _feed_cache.get(key)
    if hit and time.time() - hit[0] < CACHE_S and (not hit[1] or hit[1][0][0] <= since):
        return [r for r in hit[1] if r[0] >= since - 7 * 86400]

    w = _words(call(aggregator, SEL_LATEST))
    latest = w[0]
    phase_base = latest & ~((1 << 64) - 1)
    agg_round = latest & ((1 << 64) - 1)
    rounds: list[tuple[int, int]] = [(w[3], _signed(w[1]))]
    r = agg_round - 1
    while r >= 1 and len(rounds) < MAX_ROUNDS:
        ids = list(range(r, max(0, r - BATCH), -1))
        res = aggregate3([(aggregator, SEL_ROUND + _word(phase_base | i)) for i in ids])
        oldest = None
        for ok, data in res:
            if not ok or len(data) < 160:
                continue
            ww = _words(data)
            upd, ans = ww[3], _signed(ww[1])
            if upd and ans > 0:
                rounds.append((upd, ans))
                oldest = upd if oldest is None else min(oldest, upd)
        r = ids[-1] - 1
        if oldest is not None and oldest < since:
            break
    rounds = sorted(set(rounds))
    _feed_cache[key] = (time.time(), rounds)
    return [x for x in rounds if x[0] >= since - 7 * 86400]
