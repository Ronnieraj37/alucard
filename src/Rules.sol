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
import {PriceFeeds} from "./PriceFeeds.sol";
import {ConditionalOrders} from "./ConditionalOrders.sol";
import {IAlucardCondition} from "./interfaces/IAlucardCondition.sol";

/// @title Rules: the pools strategies can use, when a condition is true, which strategies are allowed, and the math
/// @notice ConditionalOrders asks it whether a side's condition is true now (`met`), whether a pool's price can be
/// acted on (`checkPrice`), whether a new strategy is valid (`checkSide`, `checkLegs`), and for the numbers of a run:
/// swap limits, the range a leg enters, how much to swap before adding, and liquidity for amounts. The vault itself
/// only moves tokens and keeps state.
///
/// Prices: pool conditions read a pool's price of the moment, but only while it is within the pair's band of its
/// Chainlink price (`PriceFeeds.bandOf`: ~2%, ~0.5% for two stablecoins). A price pushed further never makes a
/// condition true and never lets a step run. An owner who wants Chainlink itself to confirm a level adds the Chainlink
/// price condition (CHECK_LINK), alone or with "and". A step's swaps stop at the owner's slippage from the better of the
/// pool's and Chainlink's price, and a step that cannot sell within it waits: it never sells into a push. No price
/// history is kept, so swaps pay nothing for strategies, and strategies work on any pool of listed tokens.
///
/// Pools: a 24-bit table (a side names the pools its conditions read in 24 bits). Anyone can add a pool whose two
/// tokens are listed, hookless or using the limit-order hook (a pool with another hook could take a cut of swaps).
contract Rules {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    error InvalidSide();
    error InvalidLeg();
    error UnknownPool();
    error PoolNotAllowed();
    error TokenNotAllowed();
    error NoPrice();
    error PriceMoved();
    error NotAContract();
    error LowGas();

    uint256 internal constant BPS = 10_000;
    uint256 internal constant Q128 = 1 << 128;

    /// @notice Longest hold ("only if it lasts"), in minutes: a day.
    uint16 public constant MAX_HOLD_MINUTES = 1440;
    /// @notice The APR condition needs at least this much time since the fees were last collected.
    uint256 public constant MIN_APR_TIME = 1 hours;
    /// @notice Gas a "when" card (IAlucardCondition) may use per answer.
    uint256 public constant CONDITION_GAS = 200_000;

    IPoolManager public immutable poolManager;
    /// @notice The limit-order hook: the one hook a pool here may use.
    address public immutable hook;
    PriceFeeds public immutable feeds;

    uint24 public poolCount;
    mapping(uint24 index => PoolKey) internal _pools;
    mapping(PoolId poolId => uint24 index) public poolIndexOf;

    event PoolRegistered(uint24 indexed index, PoolId indexed poolId);

    /// @notice "When" cards: condition contracts anyone registered, by card number (from 1). Append-only.
    uint24 public conditionCount;
    mapping(uint24 id => address) public conditionAt;
    mapping(address card => uint24 id) public conditionIdOf;

    event ConditionRegistered(uint24 indexed id, address indexed card);

    /// @dev What a condition needs to know about the order.
    struct Ctx {
        address vault; // owner of the position in the PoolManager
        uint256 orderId; // its salt
        uint24 poolIndex;
        int24 lower; // the range
        int24 upper;
        bool isUpper; // which side is checked
        uint32 feeClock; // when the position's fees were last collected
        OrderState.Side sd;
    }

    constructor(IPoolManager _poolManager, address _hook, PriceFeeds _feeds) {
        poolManager = _poolManager;
        hook = _hook;
        feeds = _feeds;
    }

    // ---------------------------------------------------------------
    // Pools
    // ---------------------------------------------------------------

    /// @notice Add a pool strategies can use (or return its index if it is in already). Anyone can.
    function registerPool(PoolKey calldata key) public returns (uint24 index) {
        PoolId id = key.toId();
        index = poolIndexOf[id];
        if (index != 0) return index;
        if (address(key.hooks) != address(0) && address(key.hooks) != hook) revert PoolNotAllowed();
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
        if (sqrtPriceX96 == 0) revert UnknownPool();
        if (!feeds.isListed(Currency.unwrap(key.currency0)) || !feeds.isListed(Currency.unwrap(key.currency1))) {
            revert TokenNotAllowed();
        }
        index = ++poolCount;
        _pools[index] = key;
        poolIndexOf[id] = index;
        emit PoolRegistered(index, id);
    }

    /// @notice Give a condition contract (IAlucardCondition) a card number, or return the one it has. Anyone can.
    function registerCondition(address card) external returns (uint24 id) {
        id = conditionIdOf[card];
        if (id != 0) return id;
        if (card.code.length == 0) revert NotAContract();
        id = ++conditionCount;
        conditionAt[id] = card;
        conditionIdOf[card] = id;
        emit ConditionRegistered(id, card);
    }

    function poolKeyAt(uint24 index) external view returns (PoolKey memory) {
        return _pools[index];
    }

    // ---------------------------------------------------------------
    // Prices
    // ---------------------------------------------------------------

    /// @notice A pool's tick now, and whether it can be believed: within the pair's band of Chainlink.
    function tickOf(uint24 poolIndex) public view returns (bool ok, int24 tick) {
        (ok, tick,,) = _prices(_pools[poolIndex]);
    }

    /// @notice Reverts (PriceMoved) unless `key`'s price is within the pair's band of its Chainlink price (no
    /// Chainlink price counts as too far). Runs swap and deposit at this price: this keeps them from running at a
    /// price someone pushed.
    function checkPrice(PoolKey calldata key) external view {
        (bool near,,,) = _prices(key);
        if (!near) revert PriceMoved();
    }

    /// @dev A pool's tick; the pair's Chainlink tick (`linked` false when the band is off, in tests, or when Chainlink
    /// has no fresh price); whether the pool is within the band of it.
    function _prices(PoolKey memory key) internal view returns (bool near, int24 tick, bool linked, int24 link) {
        (, tick,,) = poolManager.getSlot0(key.toId());
        address t0 = Currency.unwrap(key.currency0);
        address t1 = Currency.unwrap(key.currency1);
        uint24 band = feeds.bandOf(t0, t1);
        if (band == 0) return (true, tick, false, 0); // not checked (tests)
        (linked, link) = feeds.pairTick(t0, t1);
        if (!linked) return (false, tick, false, 0);
        near = (tick > link ? uint256(int256(tick) - link) : uint256(int256(link) - tick)) <= band;
    }

    // ---------------------------------------------------------------
    // Conditions
    // ---------------------------------------------------------------

    /// @notice Whether a side's condition is true now. A hold ("only if it lasts") is checked by the vault, which
    /// knows when the condition was first seen true.
    /// @param vault the contract that owns the position (ConditionalOrders)
    /// @param lowerWord the order's lower side (its edge is the range's tickLower)
    /// @param upperWord the order's upper side (its edge is the range's tickUpper)
    function met(address vault, uint256 orderId, uint24 poolIndex, uint256 lowerWord, uint256 upperWord, bool upper)
        public
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
            feeClock: lo.lastRun > up.lastRun ? lo.lastRun : up.lastRun,
            sd: sd
        });
        bool a = _cond(c, sd.checker, sd.value, sd.checkPool);
        if (sd.combine == OrderState.COMBINE_AND) return a && _cond(c, sd.checker2, sd.value2, sd.checkPool2);
        if (sd.combine == OrderState.COMBINE_OR) return a || _cond(c, sd.checker2, sd.value2, sd.checkPool2);
        return a;
    }

    /// @notice The price a side's trailing condition reads now. `trails` is false for a side without one; `ok` is
    /// false while that pool's price is too far from Chainlink to be remembered.
    function trailTick(uint24 poolIndex, uint256 word) external view returns (bool trails, bool ok, int24 tick) {
        OrderState.Side memory sd = OrderState.decodeSide(word);
        uint24 pool;
        if (sd.checker == OrderState.CHECK_TRAIL) {
            (trails, pool) = (true, sd.checkPool);
        } else if (sd.combine != OrderState.COMBINE_NONE && sd.checker2 == OrderState.CHECK_TRAIL) {
            (trails, pool) = (true, sd.checkPool2);
        }
        if (trails) (ok, tick) = tickOf(pool == 0 ? poolIndex : pool);
    }

    /// @notice Whether every condition of a side can be judged now (see _judgeable). The vault forgets a hold only
    /// then: a price pushed away from Chainlink, in any pool the side reads, says nothing about the condition.
    function canJudge(uint24 poolIndex, uint256 word) external view returns (bool) {
        OrderState.Side memory d = OrderState.decodeSide(word);
        if (!_judgeable(d.checker, d.checkPool, poolIndex)) return false;
        return d.combine == OrderState.COMBINE_NONE || _judgeable(d.checker2, d.checkPool2, poolIndex);
    }

    /// @notice Fees the order's position has earned since they were last collected, in bps of the position's value,
    /// both valued at the pool's price. `ok` is false without a position, or with a price too far from Chainlink.
    function feeBps(address vault, uint256 orderId, uint24 poolIndex, int24 lower, int24 upper)
        public
        view
        returns (bool ok, uint256 bps)
    {
        (bool has, uint256 fees, uint256 base) = _fees(vault, orderId, poolIndex, lower, upper);
        if (!has) return (false, 0);
        return (true, FullMath.mulDiv(fees, BPS, base));
    }

    /// @dev The position's uncollected fees and its value, both in token1 at the pool's price.
    function _fees(address vault, uint256 orderId, uint24 poolIndex, int24 lower, int24 upper)
        internal
        view
        returns (bool ok, uint256 fees, uint256 base)
    {
        PoolId id = _pools[poolIndex].toId();
        (uint128 liq, uint256 g0Last, uint256 g1Last) =
            poolManager.getPositionInfo(id, vault, lower, upper, bytes32(orderId));
        if (liq == 0) return (false, 0, 0);
        (uint256 g0, uint256 g1) = poolManager.getFeeGrowthInside(id, lower, upper);
        uint256 f0;
        uint256 f1;
        unchecked {
            // fee growth counters wrap, like in Uniswap
            f0 = FullMath.mulDiv(g0 - g0Last, liq, Q128);
            f1 = FullMath.mulDiv(g1 - g1Last, liq, Q128);
        }
        int24 t;
        (ok, t) = tickOf(poolIndex);
        if (!ok) return (false, 0, 0);
        uint160 p = TickMath.getSqrtPriceAtTick(t);
        (uint256 a0, uint256 a1) =
            PriceMath.amountsFor(p, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), liq);
        base = PriceMath.in1(a0, p) + a1;
        if (base == 0) return (false, 0, 0);
        return (true, PriceMath.in1(f0, p) + f1, base);
    }

    /// @dev One condition (A or B) of a side.
    function _cond(Ctx memory c, uint8 checker, int24 value, uint24 pool) internal view returns (bool) {
        if (checker == OrderState.CHECK_TIME) {
            return block.timestamp >= uint256(c.sd.lastRun) + uint256(uint24(value)) * 60;
        }
        if (checker == OrderState.CHECK_FEES || checker == OrderState.CHECK_APR) {
            (bool ok, uint256 fees, uint256 base) = _fees(c.vault, c.orderId, c.poolIndex, c.lower, c.upper);
            if (!ok) return false;
            // fees / base >= value bps, compared without rounding
            if (checker == OrderState.CHECK_FEES) return fees * BPS >= base * uint256(uint24(value));
            // APR, lower side only: the fees as a yearly rate are below `value` bps. Compared exactly: rounding the
            // fees to whole bps first would read a young position as earning nothing.
            uint256 elapsed = block.timestamp - c.feeClock;
            return
                elapsed >= MIN_APR_TIME
                    && FullMath.mulDiv(fees, BPS * 365 days, elapsed) < base * uint256(uint24(value));
        }
        if (checker == OrderState.CHECK_EXTERNAL) return _askCard(c, uint24(value));
        uint24 p = pool == 0 ? c.poolIndex : pool;
        // the pair's Chainlink price against a level: no pool price involved
        if (checker == OrderState.CHECK_LINK) {
            (bool ok, int24 link) = _link(p);
            return ok && (c.isUpper ? link >= value : link < value);
        }
        // the pool price conditions: EDGE, TICK, TRAIL. A price too far from Chainlink never makes them true.
        (bool live, int24 tick) = tickOf(p);
        if (!live) return false;
        int256 t = tick;
        if (checker == OrderState.CHECK_EDGE) {
            return c.isUpper ? t >= int256(c.upper) + value : t < int256(c.lower) - value;
        }
        if (checker == OrderState.CHECK_TICK) return c.isUpper ? t >= value : t < value;
        if (checker == OrderState.CHECK_TRAIL) {
            return c.isUpper ? t >= int256(c.sd.best) + value : t < int256(c.sd.best) - value;
        }
        return false;
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
        PoolId id = _pools[poolIndex].toId();
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
        PoolKey memory key = _pools[o.poolIndex];
        (uint128 liq,,) = poolManager.getPositionInfo(key.toId(), address(vault), lower, upper, bytes32(orderId));
        (uint160 p,,,) = poolManager.getSlot0(key.toId());
        return PriceMath.amountsFor(p, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), liq);
    }

    /// @notice Whether `vault.execute(orderId, upper)` would pass its checks now (for keepers). A side with a hold
    /// needs `poke` first, then the hold to pass.
    function canExecute(ConditionalOrders vault, uint256 orderId, bool upper) external view returns (bool) {
        ConditionalOrders.Order memory o = vault.getOrder(orderId);
        if (o.owner == address(0) || block.timestamp > o.expiry) return false;
        OrderState.Side memory sd = OrderState.decodeSide(upper ? o.upperState : o.lowerState);
        if (sd.checker == OrderState.CHECK_OFF || block.timestamp < uint256(sd.lastRun) + vault.MIN_GAP()) {
            return false;
        }
        if (sd.holdMinutes != 0) {
            uint32 armed = vault.armedAt(orderId, upper);
            if (armed == 0 || block.timestamp < uint256(armed) + uint256(sd.holdMinutes) * 60) return false;
        }
        (bool ok,) = tickOf(o.poolIndex);
        return ok && met(address(vault), orderId, o.poolIndex, o.lowerState, o.upperState, upper);
    }

    // ---------------------------------------------------------------
    // Price math for runs (the price of the moment: the vault checks it is near Chainlink first)
    // ---------------------------------------------------------------

    /// @notice Price limit for a swap: `slippage` steps of 10 ticks past the better of the pool's price and
    /// Chainlink's (for the seller). A pool pushed against the swap leaves it unsold rather than sold below Chainlink.
    function swapLimit(PoolKey calldata key, bool zeroForOne, uint8 slippage) external view returns (uint160) {
        (, int24 tick, bool linked, int24 link) = _prices(key);
        if (linked && (zeroForOne ? link > tick : link < tick)) tick = link;
        int256 slip = int256(uint256(slippage)) * 10;
        int256 t = zeroForOne ? int256(tick) - slip : int256(tick) + slip;
        if (t <= TickMath.MIN_TICK) t = TickMath.MIN_TICK + 1;
        if (t >= TickMath.MAX_TICK) t = TickMath.MAX_TICK - 1;
        return TickMath.getSqrtPriceAtTick(int24(t));
    }

    /// @notice The range a leg enters: its fixed range, or `a` ticks below to `b` ticks above the price (rounded down
    /// to the spacing, kept inside the usable ticks).
    function rangeOf(PoolKey calldata key, OrderState.Leg calldata leg) external view returns (int24, int24) {
        if (leg.kind == OrderState.LEG_RANGE) return (leg.a, leg.b);
        return _around(key, leg.a, leg.b);
    }

    /// @notice A re-centred range: `below` spacings under the price to `above` spacings over it.
    function centeredRange(PoolKey calldata key, uint24 below, uint24 above) external view returns (int24, int24) {
        int256 s = key.tickSpacing;
        return _around(key, int256(uint256(below)) * s, int256(uint256(above)) * s);
    }

    function _around(PoolKey calldata key, int256 below, int256 above) internal view returns (int24, int24) {
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        int256 mid = _floor(tick, key.tickSpacing);
        return (_usable(mid - below, key.tickSpacing), _usable(mid + above, key.tickSpacing));
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
    ///  - re-centre ("follow the price"): removes 100% and adds into a new range around the price; `shape` holds its
    ///    width below and above the price, in tick spacings (both at least one).
    ///  - `shape` is otherwise the step of a repeating price level, and zero when nothing steps.
    ///  - a repeating side must stop being true after a run, or it would fire again and again.
    ///  - APR only on the lower side ("earns less than"), and only to leave: move, or remove everything.
    /// @param poolIndex the pool of the leg the side belongs to
    /// @param legKind that leg's kind (LEG_IDLE has no position)
    /// @param twoLegs whether the order has a second leg to move to
    function checkSide(uint256 word, bool upper, uint24 poolIndex, uint8 legKind, bool twoLegs) public view {
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
        if (d.addMode > (add ? OrderState.ADD_CENTERED : 0)) revert InvalidSide();
        bool recentre = add && d.addMode == OrderState.ADD_CENTERED; // the range moves after a run

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
        if (recentre) {
            // the whole position moves into a new range around the price: both widths, in spacings
            if (
                d.removeBps != BPS || d.shape & OrderState.MAX_WIDTH == 0 || (d.shape >> 11) & OrderState.MAX_WIDTH == 0
            ) {
                revert InvalidSide();
            }
        } else if (!move) {
            bool steps = d.repeat && (_isLevel(d.checker) || (hasB && _isLevel(d.checker2)));
            if (steps ? (d.shape == 0 || d.shape > OrderState.MAX_SHAPE) : d.shape != 0) revert InvalidSide();
        }

        // ---- a repeating side must stop being true after it runs (a move side leaves the leg, so it stops)
        if (d.repeat && !move) {
            if (d.checker == OrderState.CHECK_EDGE && !recentre) revert InvalidSide(); // the range does not move
            if (_isLevel(d.checker) && recentre) revert InvalidSide(); // its level cannot step (shape holds widths)
            if (d.combine == OrderState.COMBINE_OR) {
                // either condition alone fires, so B must stop being true as well
                if (d.checker2 == OrderState.CHECK_EDGE && !recentre) revert InvalidSide();
                if (_isLevel(d.checker2) && recentre) revert InvalidSide();
            }
        }
    }

    /// @notice Reverts (InvalidLeg) unless an order can move between a leg in pool `from` and the leg `to`.
    /// A range leg needs a registered pool (both tokens listed), with a valid range. A waiting leg
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
        if (!_known(to.poolIndex)) revert UnknownPool();
        PoolKey memory a = _pools[from];
        PoolKey memory b = _pools[to.poolIndex];
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
        if (checker == OrderState.CHECK_OFF || checker > OrderState.CHECK_EXTERNAL) revert InvalidSide();
        // a "when" card: a registered card number, nothing else
        if (checker == OrderState.CHECK_EXTERNAL) {
            if (value <= 0 || uint24(value) > conditionCount || pool != 0) revert InvalidSide();
            return;
        }
        if (_isLevel(checker) && (value <= TickMath.MIN_TICK || value >= TickMath.MAX_TICK)) revert InvalidSide();
        if (checker == OrderState.CHECK_TIME && value <= 0) revert InvalidSide();
        // a trailing distance is a fall of less than 99.99% (or the same number of ticks up)
        if (checker == OrderState.CHECK_TRAIL && (value <= 0 || value > OrderState.MAX_TRAIL)) revert InvalidSide();
        // conditions on the position itself: a waiting leg has none
        if (checker == OrderState.CHECK_EDGE && (value < 0 || idle)) revert InvalidSide();
        if (checker == OrderState.CHECK_FEES && (value <= 0 || uint24(value) > BPS || idle)) revert InvalidSide();
        if (checker == OrderState.CHECK_APR && (value <= 0 || idle || upper || !leaves)) revert InvalidSide();

        if (_isLevel(checker) || checker == OrderState.CHECK_TRAIL) {
            // 0 = the leg's own pool; another pool is named by its index (never by the own pool's index)
            if (pool == own || (pool != 0 && !_known(pool))) revert InvalidSide();
        } else if (pool != 0) {
            revert InvalidSide(); // the other conditions read the leg's own pool
        }
    }

    /// @dev Ask a "when" card, read-only and with CONDITION_GAS at most. Only a clean `true` (exactly one word, 1) counts;
    /// a revert, running out of gas or any other answer is "not now". At most 32 bytes of the answer are copied. The
    /// caller must leave enough gas for the card's whole allowance, or a keeper could starve a card into "false".
    function _askCard(Ctx memory c, uint24 id) internal view returns (bool) {
        if (gasleft() < CONDITION_GAS + CONDITION_GAS / 63 + 10_000) revert LowGas();
        address card = conditionAt[id];
        bytes memory data = abi.encodeCall(IAlucardCondition.isMet, (c.vault, c.orderId, c.isUpper));
        bool ok;
        uint256 size;
        uint256 answer;
        assembly ("memory-safe") {
            ok := staticcall(CONDITION_GAS, card, add(data, 32), mload(data), 0, 32)
            size := returndatasize()
            answer := mload(0)
        }
        return ok && size == 32 && answer == 1;
    }

    /// @dev A price level: the pool's or Chainlink's price against a fixed tick. A repeating level steps.
    function _isLevel(uint8 checker) internal pure returns (bool) {
        return checker == OrderState.CHECK_TICK || checker == OrderState.CHECK_LINK;
    }

    /// @dev The Chainlink price of a pool's pair, as a tick of that pool.
    function _link(uint24 poolIndex) internal view returns (bool, int24) {
        PoolKey memory k = _pools[poolIndex];
        return feeds.pairTick(Currency.unwrap(k.currency0), Currency.unwrap(k.currency1));
    }

    /// @dev Whether one condition can be judged now: its price is one to believe (a pool near Chainlink, or a fresh
    /// Chainlink price). Fees are valued at the own pool's price. A timer always can.
    function _judgeable(uint8 checker, uint24 pool, uint24 own) internal view returns (bool ok) {
        uint24 p = pool == 0 ? own : pool;
        if (checker == OrderState.CHECK_LINK) (ok,) = _link(p);
        else if (checker == OrderState.CHECK_TIME || checker == OrderState.CHECK_EXTERNAL) ok = true;
        else if (checker == OrderState.CHECK_FEES || checker == OrderState.CHECK_APR) (ok,) = tickOf(own);
        else (ok,) = tickOf(p);
    }

    /// @dev A pool in the table.
    function _known(uint24 index) internal view returns (bool) {
        return index != 0 && index <= poolCount;
    }
}
