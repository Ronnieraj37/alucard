// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {OrderState} from "./libraries/OrderState.sol";
import {PriceMath} from "./libraries/PriceMath.sol";
import {RuleHook} from "./RuleHook.sol";
import {PriceFeeds} from "./PriceFeeds.sol";
import {ConditionalOrders} from "./ConditionalOrders.sol";

/// @title Rules: when a rule fires, which rules are allowed, and the price math
/// @notice Read-only. ConditionalOrders asks it whether a side's condition is true now (`met`), what price a trailing
/// side should remember (`trailTick`), whether a new rule is valid (`checkSide`, `checkLegs`), and for the numbers
/// of a run: swap limits, the range a leg enters, how much to swap before adding, and liquidity for amounts. The
/// vault itself only moves tokens and keeps state.
///
/// Every pool price a condition reads is the hook's average over at least MIN_WINDOW, or over the side's hold time
/// when that is longer. Nothing here reads the price of the moment, so moving the price in a block cannot fire a
/// rule. Conditions only read pools of RuleHook, which keep that average.
contract Rules {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    error InvalidSide();
    error InvalidLeg();
    error UnknownPool();
    error NoPrice();

    uint256 internal constant BPS = 10_000;
    uint256 internal constant Q128 = 1 << 128;

    /// @notice Shortest average a pool condition reads, in seconds.
    uint32 public constant MIN_WINDOW = 120;
    /// @notice Longest hold, in minutes: the hook keeps about an hour of prices.
    uint16 public constant MAX_HOLD_MINUTES = 60;
    /// @notice The APR condition needs at least this much time since the fees were last collected.
    uint256 public constant MIN_APR_TIME = 1 hours;

    /// @notice Keeper pay: gas x gas price x a premium. 110% for the part paid in ETH, 120% for the part paid in a
    /// token (the keeper still has to sell it for ETH). The gas price counted is capped so a keeper cannot inflate it.
    uint256 public constant KEEPER_PREMIUM_BPS = 11_000;
    uint256 public constant KEEPER_TOKEN_PREMIUM_BPS = 12_000;
    uint256 public constant MAX_PRIORITY_FEE_WEI = 0.01 gwei;
    /// @dev Gas of the call into keeperPay that its own measurement cannot see.
    uint256 internal constant PAY_CALL_GAS = 2_000;

    IPoolManager public immutable poolManager;
    RuleHook public immutable hook;
    PriceFeeds public immutable feeds;

    /// @dev What a condition needs to know about the order.
    struct Ctx {
        address vault; // owner of the position in the PoolManager
        uint256 orderId; // its salt
        uint24 poolIndex;
        int24 lower; // the range
        int24 upper;
        bool isUpper; // which side is checked
        uint32 window; // seconds of average price
        uint32 feeClock; // when the position's fees were last collected
        OrderState.Side sd;
    }

    constructor(IPoolManager _poolManager, RuleHook _hook, PriceFeeds _feeds) {
        poolManager = _poolManager;
        hook = _hook;
        feeds = _feeds;
    }

    // ---------------------------------------------------------------
    // Conditions
    // ---------------------------------------------------------------

    /// @notice Whether a side's condition is true now.
    /// @param vault the contract that owns the position (ConditionalOrders)
    /// @param lowerWord the order's lower side (its edge is the range's tickLower)
    /// @param upperWord the order's upper side (its edge is the range's tickUpper)
    function met(address vault, uint256 orderId, uint24 poolIndex, uint256 lowerWord, uint256 upperWord, bool upper)
        external
        view
        returns (bool)
    {
        OrderState.Side memory lo = OrderState.decodeSide(lowerWord);
        OrderState.Side memory up = OrderState.decodeSide(upperWord);
        OrderState.Side memory sd = upper ? up : lo;
        Ctx memory c = Ctx({
            vault: vault,
            orderId: orderId,
            poolIndex: poolIndex,
            lower: lo.edge,
            upper: up.edge,
            isUpper: upper,
            window: _window(sd),
            feeClock: lo.lastRun > up.lastRun ? lo.lastRun : up.lastRun,
            sd: sd
        });
        bool a = _cond(c, sd.checker, sd.value, sd.checkPool);
        if (sd.combine == OrderState.COMBINE_AND) return a && _cond(c, sd.checker2, sd.value2, sd.checkPool2);
        if (sd.combine == OrderState.COMBINE_OR) return a || _cond(c, sd.checker2, sd.value2, sd.checkPool2);
        return a;
    }

    /// @notice The average price a side's trailing condition reads now. `trails` is false for a side without one;
    /// `ok` is false while that pool has too little history.
    function trailTick(uint24 poolIndex, uint256 word) external view returns (bool trails, bool ok, int24 tick) {
        OrderState.Side memory sd = OrderState.decodeSide(word);
        uint24 pool;
        if (sd.checker == OrderState.CHECK_TRAIL) {
            (trails, pool) = (true, sd.checkPool);
        } else if (sd.combine != OrderState.COMBINE_NONE && sd.checker2 == OrderState.CHECK_TRAIL) {
            (trails, pool) = (true, sd.checkPool2);
        }
        if (trails) (ok, tick) = averageTick(pool == 0 ? poolIndex : pool, _window(sd));
    }

    /// @notice Average tick of a pool in the hook's table over at least `window` seconds.
    function averageTick(uint24 poolIndex, uint32 window) public view returns (bool ok, int24 tick) {
        return hook.averageTick(hook.poolKeyAt(poolIndex).toId(), window);
    }

    /// @notice Fees the order's position has earned since they were last collected, in bps of the position's value,
    /// both valued at the average price. `ok` is false without a position or a price.
    function feeBps(address vault, uint256 orderId, uint24 poolIndex, int24 lower, int24 upper)
        public
        view
        returns (bool ok, uint256 bps)
    {
        PoolId id = hook.poolKeyAt(poolIndex).toId();
        (uint128 liq, uint256 g0Last, uint256 g1Last) =
            poolManager.getPositionInfo(id, vault, lower, upper, bytes32(orderId));
        if (liq == 0) return (false, 0);
        (uint256 g0, uint256 g1) = poolManager.getFeeGrowthInside(id, lower, upper);
        uint256 f0;
        uint256 f1;
        unchecked {
            // fee growth counters wrap, like in Uniswap
            f0 = FullMath.mulDiv(g0 - g0Last, liq, Q128);
            f1 = FullMath.mulDiv(g1 - g1Last, liq, Q128);
        }
        int24 t;
        (ok, t) = averageTick(poolIndex, MIN_WINDOW);
        if (!ok) return (false, 0);
        uint160 p = TickMath.getSqrtPriceAtTick(t);
        (uint256 a0, uint256 a1) =
            PriceMath.amountsFor(p, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), liq);
        uint256 base = PriceMath.in1(a0, p) + a1;
        if (base == 0) return (false, 0);
        return (true, FullMath.mulDiv(PriceMath.in1(f0, p) + f1, BPS, base));
    }

    /// @dev One condition (A or B) of a side.
    function _cond(Ctx memory c, uint8 checker, int24 value, uint24 pool) internal view returns (bool) {
        if (checker == OrderState.CHECK_TIME) {
            return block.timestamp >= uint256(c.sd.lastRun) + uint256(uint24(value)) * 60;
        }
        if (checker == OrderState.CHECK_ORACLE) {
            // the pair's Chainlink price, as a tick. A missing or stale price never fires the condition.
            PoolKey memory key = hook.poolKeyAt(c.poolIndex);
            (bool live, int24 t) = feeds.pairTick(Currency.unwrap(key.currency0), Currency.unwrap(key.currency1));
            return live && (c.isUpper ? t >= value : t < value);
        }
        if (checker == OrderState.CHECK_FEES || checker == OrderState.CHECK_APR) {
            (bool ok, uint256 bps) = feeBps(c.vault, c.orderId, c.poolIndex, c.lower, c.upper);
            if (!ok) return false;
            if (checker == OrderState.CHECK_FEES) return bps >= uint256(uint24(value));
            // APR, lower side only: the fees as a yearly rate are below `value` bps
            uint256 elapsed = block.timestamp - c.feeClock;
            return elapsed >= MIN_APR_TIME && (bps * 365 days) / elapsed < uint256(uint24(value));
        }
        // the pool price conditions: EDGE, TICK, TRAIL
        (bool live2, int24 avg) = averageTick(pool == 0 ? c.poolIndex : pool, c.window);
        if (!live2) return false;
        int256 t2 = avg;
        if (checker == OrderState.CHECK_EDGE) {
            return c.isUpper ? t2 >= int256(c.upper) + value : t2 < int256(c.lower) - value;
        }
        if (checker == OrderState.CHECK_TICK) return c.isUpper ? t2 >= value : t2 < value;
        if (checker == OrderState.CHECK_TRAIL) {
            return c.isUpper ? t2 >= int256(c.sd.best) + value : t2 < int256(c.sd.best) - value;
        }
        return false;
    }

    /// @dev Seconds of average price a side reads: its hold, but never less than MIN_WINDOW.
    function _window(OrderState.Side memory sd) internal pure returns (uint32) {
        uint32 hold = uint32(sd.holdMinutes) * 60;
        return hold > MIN_WINDOW ? hold : MIN_WINDOW;
    }

    // ---------------------------------------------------------------
    // Views for apps and keepers
    // ---------------------------------------------------------------

    /// @notice Pack a side into the word ConditionalOrders takes and stores.
    function encode(OrderState.Side calldata side) external pure returns (uint256) {
        return OrderState.encodeSide(side);
    }

    /// @notice Unpack a stored side.
    function decode(uint256 word) external pure returns (OrderState.Side memory) {
        return OrderState.decodeSide(word);
    }

    /// @notice Current price and active liquidity of a pool in the table.
    function poolState(uint24 poolIndex) external view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity) {
        PoolId id = hook.poolKeyAt(poolIndex).toId();
        (sqrtPriceX96, tick,,) = poolManager.getSlot0(id);
        liquidity = poolManager.getLiquidity(id);
    }

    /// @notice Tokens an order holds right now: its position at the current price (fees not included), or what it
    /// holds while it waits.
    function orderAmounts(ConditionalOrders vault, uint256 orderId) external view returns (uint256, uint256) {
        ConditionalOrders.Order memory o = vault.getOrder(orderId);
        if (o.owner == address(0)) return (0, 0);
        ConditionalOrders.Plan memory plan = vault.getPlan(orderId);
        if (plan.here.kind == OrderState.LEG_IDLE) return (plan.held0, plan.held1);
        int24 lower = OrderState.decodeSide(o.lowerState).edge;
        int24 upper = OrderState.decodeSide(o.upperState).edge;
        PoolKey memory key = hook.poolKeyAt(o.poolIndex);
        (uint128 liq,,) = poolManager.getPositionInfo(key.toId(), address(vault), lower, upper, bytes32(orderId));
        (uint160 p,,,) = poolManager.getSlot0(key.toId());
        return PriceMath.amountsFor(p, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), liq);
    }

    /// @notice Whether `vault.execute(orderId, upper)` would pass its checks now (for keepers).
    function canExecute(ConditionalOrders vault, uint256 orderId, bool upper) external view returns (bool) {
        ConditionalOrders.Order memory o = vault.getOrder(orderId);
        if (o.owner == address(0) || block.timestamp > o.expiry) return false;
        OrderState.Side memory sd = OrderState.decodeSide(upper ? o.upperState : o.lowerState);
        if (sd.checker == OrderState.CHECK_OFF || block.timestamp < uint256(sd.lastRun) + vault.MIN_GAP()) {
            return false;
        }
        return this.met(address(vault), orderId, o.poolIndex, o.lowerState, o.upperState, upper);
    }

    // ---------------------------------------------------------------
    // Price math for runs (all on the average price; reverts NoPrice without one)
    // ---------------------------------------------------------------

    /// @notice Average tick of `key`'s pool over MIN_WINDOW.
    function price(PoolKey memory key) public view returns (int24 tick) {
        bool ok;
        (ok, tick) = hook.averageTick(key.toId(), MIN_WINDOW);
        if (!ok) revert NoPrice();
    }

    /// @notice Price limit for a swap: `slippage` steps of 10 ticks past the average price.
    function swapLimit(PoolKey calldata key, bool zeroForOne, uint8 slippage) external view returns (uint160) {
        int256 ref = price(key);
        int256 slip = int256(uint256(slippage)) * 10;
        int256 t = zeroForOne ? ref - slip : ref + slip;
        if (t <= TickMath.MIN_TICK) t = TickMath.MIN_TICK + 1;
        if (t >= TickMath.MAX_TICK) t = TickMath.MAX_TICK - 1;
        return TickMath.getSqrtPriceAtTick(int24(t));
    }

    /// @notice The range a leg enters: its fixed range, or `a` ticks below to `b` ticks above the average price
    /// (rounded down to the spacing, kept inside the usable ticks).
    function rangeOf(PoolKey calldata key, OrderState.Leg calldata leg) external view returns (int24, int24) {
        if (leg.kind == OrderState.LEG_RANGE) return (leg.a, leg.b);
        int256 mid = _floor(price(key), key.tickSpacing);
        return (_usable(mid - leg.a, key.tickSpacing), _usable(mid + leg.b, key.tickSpacing));
    }

    /// @notice A one-sided range of `width` spacings next to the average price: below it for the upper side (which
    /// holds token1 after the price rose out), above it for the lower side. `ok` is false without room for it.
    function besidePrice(PoolKey calldata key, bool upper, uint24 width)
        external
        view
        returns (bool ok, int24 tickLower, int24 tickUpper)
    {
        int256 s = key.tickSpacing;
        int256 floorTick = _floor(price(key), key.tickSpacing);
        int256 lo = upper ? floorTick - int256(uint256(width)) * s : floorTick + s;
        int256 hi = upper ? floorTick : lo + int256(uint256(width)) * s;
        if (lo < TickMath.minUsableTick(key.tickSpacing) || hi > TickMath.maxUsableTick(key.tickSpacing)) {
            return (false, 0, 0);
        }
        return (true, int24(lo), int24(hi));
    }

    /// @notice The swap that turns holdings (h0, h1) into the mix the range needs: which token to sell, how much at
    /// most, and the price to stop at (0 = no stop of its own). For a range around the price, the stop is the price
    /// at which what is left after the swap fits the range, found by halving: as the price moves, the pool's active
    /// liquidity sets how much was sold, and the range's own mix changes with it. The vault sells up to all of the
    /// token and lets the pool stop there, so the pool's fee and real liquidity are accounted for.
    function mixFor(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint256 h0, uint256 h1)
        external
        view
        returns (bool zeroForOne, uint256 amountIn, uint160 stopAt)
    {
        PoolId id = key.toId();
        (uint160 p,,,) = poolManager.getSlot0(id);
        Mix memory m = Mix({
            p: p,
            a: TickMath.getSqrtPriceAtTick(tickLower),
            b: TickMath.getSqrtPriceAtTick(tickUpper),
            liquidity: poolManager.getLiquidity(id),
            h0: h0,
            h1: h1
        });
        (zeroForOne, amountIn) = PriceMath.sellForRange(p, m.a, m.b, h0, h1);
        if (amountIn == 0 || p <= m.a || p >= m.b || m.liquidity == 0) return (zeroForOne, amountIn, 0);
        // selling token0 moves the price down towards a, selling token1 up towards b
        uint160 lo = zeroForOne ? m.a : p;
        uint160 hi = zeroForOne ? p : m.b;
        for (uint256 i; i < 48 && hi - lo > 1; ++i) {
            uint160 q = lo + (hi - lo) / 2;
            if (_tooMuchToken1(m, q)) lo = q; // the price has to go higher still
            else hi = q;
        }
        return (zeroForOne, zeroForOne ? h0 : h1, zeroForOne ? hi : lo);
    }

    /// @dev Inputs of mixFor: the price, the range, the pool's active liquidity, the holdings.
    struct Mix {
        uint160 p;
        uint160 a;
        uint160 b;
        uint128 liquidity;
        uint256 h0;
        uint256 h1;
    }

    /// @dev If the pool's price moved from m.p to q, would what is left hold more token1 than the range needs at q?
    function _tooMuchToken1(Mix memory m, uint160 q) internal pure returns (bool) {
        uint256 have0 = m.h0;
        uint256 have1 = m.h1;
        if (q >= m.p) {
            // token1 sold for token0
            uint256 spent = SqrtPriceMath.getAmount1Delta(m.p, q, m.liquidity, true);
            if (spent > have1) return false; // more than we hold: the price cannot get this far
            have1 -= spent;
            have0 += SqrtPriceMath.getAmount0Delta(m.p, q, m.liquidity, false);
        } else {
            // token0 sold for token1
            uint256 spent = SqrtPriceMath.getAmount0Delta(q, m.p, m.liquidity, true);
            if (spent > have0) return true;
            have0 -= spent;
            have1 += SqrtPriceMath.getAmount1Delta(q, m.p, m.liquidity, false);
        }
        (uint256 need0, uint256 need1) = PriceMath.amountsFor(q, m.a, m.b, 1e18);
        return FullMath.mulDiv(have1, need0, 1) > FullMath.mulDiv(have0, need1, 1);
    }

    /// @notice Liquidity amounts (a0, a1) buy in the range at the pool's current price, keeping 1 wei of each back
    /// (the PoolManager rounds the amounts it asks for up).
    function liquidityFor(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint256 a0, uint256 a1)
        external
        view
        returns (uint128)
    {
        (uint160 p,,,) = poolManager.getSlot0(key.toId());
        return LiquidityAmounts.getLiquidityForAmounts(
            p,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            a0 > 0 ? a0 - 1 : 0,
            a1 > 0 ? a1 - 1 : 0
        );
    }

    /// @notice What a keeper is paid for a run that used `gasUsed` (measured by the vault, plus its allowances): the
    /// cost in wei with the premium, paid from reserve0 in token0 first and from reserve1 in token1 for what token0
    /// did not cover, never more than either reserve. ETH is paid as it is; a token amount comes from the Chainlink
    /// feeds (wei -> USD -> token), read here with their gas counted. Without a price for both tokens the keeper
    /// gets both reserves (the owner's ceiling), so a broken feed never leaves an order without a keeper.
    function keeperPay(PoolKey calldata key, uint256 gasUsed, uint256 reserve0, uint256 reserve1)
        external
        view
        returns (uint256 pay0, uint256 pay1)
    {
        uint256 start = gasleft();
        address t0 = Currency.unwrap(key.currency0);
        address t1 = Currency.unwrap(key.currency1);
        (bool ok0, uint256 per0) = feeds.quote(t0, 1 ether); // token units per 1 ETH
        (bool ok1, uint256 per1) = feeds.quote(t1, 1 ether);
        if (!ok0 || !ok1) return (reserve0, reserve1);
        uint256 cost = gasWei(gasUsed + start - gasleft() + PAY_CALL_GAS);
        uint256 want0 = (FullMath.mulDiv(cost, per0, 1 ether) * _premium(t0)) / BPS;
        pay0 = want0 < reserve0 ? want0 : reserve0;
        // the share of the cost token0 did not cover, paid in token1
        uint256 rest = want0 == 0 ? cost : cost - FullMath.mulDiv(cost, pay0, want0);
        uint256 want1 = (FullMath.mulDiv(rest, per1, 1 ether) * _premium(t1)) / BPS;
        pay1 = want1 < reserve1 ? want1 : reserve1;
    }

    /// @notice Cost in wei of `gasUsed` at this transaction's gas price, capped at base fee + MAX_PRIORITY_FEE_WEI.
    function gasWei(uint256 gasUsed) public view returns (uint256) {
        uint256 maxPrice = block.basefee + MAX_PRIORITY_FEE_WEI;
        return gasUsed * (tx.gasprice < maxPrice ? tx.gasprice : maxPrice);
    }

    function _premium(address token) internal pure returns (uint256) {
        return token == address(0) ? KEEPER_PREMIUM_BPS : KEEPER_TOKEN_PREMIUM_BPS;
    }

    function _floor(int24 tick, int24 spacing) internal pure returns (int256) {
        int256 c = int256(tick) / spacing;
        if (tick < 0 && int256(tick) % spacing != 0) c--;
        return c * spacing;
    }

    /// @dev A range edge kept inside the usable ticks of the spacing.
    function _usable(int256 t, int24 spacing) internal pure returns (int24) {
        int256 lo = TickMath.minUsableTick(spacing);
        int256 hi = TickMath.maxUsableTick(spacing);
        return int24(t < lo ? lo : t > hi ? hi : t);
    }

    // ---------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------

    /// @notice Reverts (InvalidSide) unless `word` (a side packed by OrderState) is a rule the app's editor can build. The rules:
    ///  - off side: every field zero. Fields the contract keeps itself (edge, lastRun, best) must be zero too.
    ///  - move (to the order's other leg): needs a second leg, takes everything (remove 100% with the fees, or all
    ///    held tokens), may swap first, never adds, and repeats: it is used again whenever the order comes back.
    ///    A waiting leg (LEG_IDLE) only moves.
    ///  - otherwise: without remove only "compound" (keep fees + add); remove 0% means "send fees out" (no keep, no
    ///    swap); swap needs a real withdrawal and no add; swapToToken1 only with swap; addMode only with add.
    ///  - repeat needs something left to run on: a side that removes everything and adds nothing cannot repeat.
    ///  - one-sided re-range ("follow"): condition A leaves the range (B only with AND), removes 100%, and `shape`
    ///    holds the one width that side uses (upper: below the price, lower: above it).
    ///  - `shape` is otherwise the step of a repeating price level, and zero when nothing steps.
    ///  - a repeating side must stop being true after a run, or it would fire again and again.
    ///  - APR only on the lower side ("earns less than"), and only to leave: move, or remove everything.
    /// @param poolIndex the pool of the leg the side belongs to
    /// @param legKind that leg's kind (LEG_IDLE has no position)
    /// @param twoLegs whether the order has a second leg to move to
    function checkSide(uint256 word, bool upper, uint24 poolIndex, uint8 legKind, bool twoLegs) external view {
        OrderState.Side memory d = OrderState.decodeSide(word);
        if (d.edge != 0 || d.lastRun != 0 || d.best != 0) revert InvalidSide();
        if (d.checker == OrderState.CHECK_OFF) {
            if (
                d.value != 0 || d.checkPool != 0 || d.checker2 != 0 || d.value2 != 0 || d.checkPool2 != 0
                    || d.combine != 0 || d.holdMinutes != 0 || d.actions != 0 || d.removeBps != 0 || d.swapToToken1
                    || d.addMode != 0 || d.repeat || d.runsLeft != 0 || d.shape != 0
            ) revert InvalidSide();
            return;
        }
        bool idle = legKind == OrderState.LEG_IDLE;

        // ---- actions
        if (d.actions == 0 || d.actions > OrderState.MAX_ACTIONS || d.removeBps > BPS) revert InvalidSide();
        bool remove = d.actions & OrderState.ACT_REMOVE != 0;
        bool keep = d.actions & OrderState.ACT_KEEP_FEES != 0;
        bool swap = d.actions & OrderState.ACT_SWAP != 0;
        bool add = d.actions & OrderState.ACT_ADD != 0;
        bool move = d.actions & OrderState.ACT_MOVE != 0;
        bool leaves = move || (remove && d.removeBps == BPS && !add); // the side ends this leg
        if (move) {
            if (!twoLegs || add || !d.repeat || d.shape != 0) revert InvalidSide();
            if (idle ? d.actions != OrderState.ACT_MOVE || d.removeBps != 0 : !remove || !keep || d.removeBps != BPS) {
                revert InvalidSide();
            }
        } else {
            if (idle) revert InvalidSide();
            if (!remove) {
                if (d.actions != (OrderState.ACT_KEEP_FEES | OrderState.ACT_ADD) || d.removeBps != 0) {
                    revert InvalidSide();
                }
            } else if (d.removeBps == 0 && (keep || swap)) {
                revert InvalidSide(); // removing nothing only sends the fees out
            }
            if (swap && add) revert InvalidSide(); // swap-to-ratio is only done when moving
            if (d.repeat && leaves) revert InvalidSide(); // nothing would be left to run again
        }
        if (d.swapToToken1 && !swap) revert InvalidSide();
        if (d.addMode > (add ? OrderState.ADD_ONE_SIDED : 0)) revert InvalidSide();
        bool oneSided = add && d.addMode == OrderState.ADD_ONE_SIDED; // the range moves after a run

        // ---- conditions
        _checkCond(d.checker, d.value, d.checkPool, poolIndex, upper, idle, leaves);
        bool hasB = d.combine != OrderState.COMBINE_NONE;
        if (!hasB) {
            if (d.checker2 != 0 || d.value2 != 0 || d.checkPool2 != 0) revert InvalidSide();
        } else {
            if (d.combine > OrderState.COMBINE_OR || d.checker2 == OrderState.CHECK_OFF) revert InvalidSide();
            _checkCond(d.checker2, d.value2, d.checkPool2, poolIndex, upper, idle, leaves);
        }
        // one remembered best price per side
        if (d.checker == OrderState.CHECK_TRAIL && hasB && d.checker2 == OrderState.CHECK_TRAIL) revert InvalidSide();
        if (d.holdMinutes > MAX_HOLD_MINUTES) revert InvalidSide();
        if (d.runsLeft != 0 && !d.repeat) revert InvalidSide(); // a run limit only means something with repeat

        // ---- shape
        if (oneSided) {
            if (d.checker != OrderState.CHECK_EDGE || d.removeBps != BPS) revert InvalidSide();
            // the new range goes next to the price on this side's side, so the price must have left the range that
            // way: with OR, condition B alone could fire it while the price is still in range or past the other edge
            if (d.combine == OrderState.COMBINE_OR) revert InvalidSide();
            uint24 used = upper ? d.shape & OrderState.MAX_WIDTH : (d.shape >> 11) & OrderState.MAX_WIDTH;
            uint24 unused = upper ? (d.shape >> 11) & OrderState.MAX_WIDTH : d.shape & OrderState.MAX_WIDTH;
            if (used == 0 || unused != 0 || d.shape > OrderState.MAX_SHAPE) revert InvalidSide();
            // the new range sits next to the price, so a repeating trigger needs at least one spacing of room
            if (d.repeat && d.value < hook.poolKeyAt(poolIndex).tickSpacing) revert InvalidSide();
        } else if (!move) {
            bool steps = d.repeat && (_isLevel(d.checker) || (hasB && _isLevel(d.checker2)));
            if (steps ? (d.shape == 0 || d.shape > OrderState.MAX_SHAPE) : d.shape != 0) revert InvalidSide();
        }

        // ---- a repeating side must stop being true after it runs (a move side leaves the leg, so it stops)
        if (d.repeat && !move) {
            if (d.checker == OrderState.CHECK_EDGE && !oneSided) revert InvalidSide(); // the range does not move
            if (d.combine == OrderState.COMBINE_OR) {
                // either condition alone fires, so B must stop being true as well
                if (d.checker2 == OrderState.CHECK_EDGE && !oneSided) revert InvalidSide();
                if (_isLevel(d.checker2) && oneSided) revert InvalidSide(); // its level cannot step
            }
        }
    }

    /// @notice Reverts (InvalidLeg) unless an order can move between a leg in pool `from` and the leg `to`.
    /// A range leg needs a RuleHook pool (its prices are averaged) of listed tokens, with a valid range. A waiting leg
    /// names the pool it came from and keeps that pair's tokens. Two pools must share a token; when they differ in the other one,
    /// every move side leaving each leg must first swap into the shared token, so no token is carried into a pool
    /// that cannot take it.
    /// @param sides the packed sides of the leg in `from` (lower, upper), then those of `to`
    function checkLegs(uint24 from, OrderState.Leg calldata to, uint256[4] calldata sides) external view {
        if (to.kind == OrderState.LEG_IDLE) {
            // waiting: the tokens stay in the pair they are in, and the leg reads that pool's price
            if (to.poolIndex != from || to.a != 0 || to.b != 0) revert InvalidLeg();
            return;
        }
        if (to.kind != OrderState.LEG_RANGE && to.kind != OrderState.LEG_CENTERED) revert InvalidLeg();
        if (!_hookPool(to.poolIndex)) revert UnknownPool();
        PoolKey memory a = hook.poolKeyAt(from);
        PoolKey memory b = hook.poolKeyAt(to.poolIndex);
        if (!feeds.isListed(Currency.unwrap(b.currency0)) || !feeds.isListed(Currency.unwrap(b.currency1))) {
            revert InvalidLeg();
        }
        checkRange(to, b.tickSpacing);

        bool same0 = a.currency0 == b.currency0 || a.currency0 == b.currency1;
        bool same1 = a.currency1 == b.currency0 || a.currency1 == b.currency1;
        if (!same0 && !same1) revert InvalidLeg(); // nothing to carry across
        if (same0 && same1) return; // the same pair
        // a's shared token is token1 when same1; b's is token1 when b.currency1 is the shared one
        bool aShared1 = same1;
        bool bShared1 = b.currency1 == (same1 ? a.currency1 : a.currency0);
        _checkSwapsInto(sides[0], aShared1);
        _checkSwapsInto(sides[1], aShared1);
        _checkSwapsInto(sides[2], bShared1);
        _checkSwapsInto(sides[3], bShared1);
    }

    /// @notice Reverts (InvalidLeg) unless a range leg's numbers fit its pool's tick spacing.
    function checkRange(OrderState.Leg memory l, int24 spacing) public pure {
        if (l.a % spacing != 0 || l.b % spacing != 0) revert InvalidLeg();
        if (l.kind == OrderState.LEG_RANGE) {
            if (l.a >= l.b || l.a < TickMath.minUsableTick(spacing) || l.b > TickMath.maxUsableTick(spacing)) {
                revert InvalidLeg();
            }
        } else if (l.a <= 0 || l.b <= 0 || l.a > OrderState.MAX_TRAIL || l.b > OrderState.MAX_TRAIL) {
            revert InvalidLeg();
        }
    }

    /// @dev A move side leaving a leg of a different pair must swap everything into the shared token.
    function _checkSwapsInto(uint256 word, bool token1) internal pure {
        OrderState.Side memory d = OrderState.decodeSide(word);
        if (d.actions & OrderState.ACT_MOVE == 0) return;
        if (d.actions & OrderState.ACT_SWAP == 0 || d.swapToToken1 != token1) revert InvalidLeg();
    }

    /// @dev Checks shared by condition A and condition B.
    function _checkCond(uint8 checker, int24 value, uint24 pool, uint24 own, bool upper, bool idle, bool leaves)
        internal
        view
    {
        if (checker == OrderState.CHECK_OFF || checker > OrderState.CHECK_APR) revert InvalidSide();
        if (_isLevel(checker) && (value <= TickMath.MIN_TICK || value >= TickMath.MAX_TICK)) revert InvalidSide();
        if (checker == OrderState.CHECK_TIME && value <= 0) revert InvalidSide();
        // a trailing distance is a fall of less than 99.99% (or the same number of ticks up)
        if (checker == OrderState.CHECK_TRAIL && (value <= 0 || value > OrderState.MAX_TRAIL)) revert InvalidSide();
        // conditions on the position itself: a waiting leg has none
        if (checker == OrderState.CHECK_EDGE && (value < 0 || idle)) revert InvalidSide();
        if (checker == OrderState.CHECK_FEES && (value <= 0 || uint24(value) > BPS || idle)) revert InvalidSide();
        if (checker == OrderState.CHECK_APR && (value <= 0 || idle || upper || !leaves)) revert InvalidSide();

        if (checker == OrderState.CHECK_TICK || checker == OrderState.CHECK_TRAIL) {
            // 0 = the leg's own pool; another pool is named by its index, never by the own pool's index, and must
            // be a pool of the hook (only those have an average price)
            if (pool == own || (pool != 0 && !_hookPool(pool))) revert InvalidSide();
        } else if (pool != 0) {
            revert InvalidSide(); // the other conditions read the leg's own pool or pair
        }
    }

    /// @dev A price level: the pool's price or the Chainlink price against a fixed tick. A repeating level steps.
    function _isLevel(uint8 checker) internal pure returns (bool) {
        return checker == OrderState.CHECK_TICK || checker == OrderState.CHECK_ORACLE;
    }

    /// @dev A pool of RuleHook (it keeps an average price), not an outside pool registered for swaps.
    function _hookPool(uint24 index) internal view returns (bool) {
        if (index == 0 || index > hook.poolCount()) return false;
        (,,, uint8 count) = hook.oracles(hook.poolKeyAt(index).toId());
        return count != 0;
    }
}
