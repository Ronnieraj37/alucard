// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {EasyPosm} from "./libraries/EasyPosm.sol";
import {BaseTest} from "./BaseTest.sol";

import {RuleHook} from "../../src/RuleHook.sol";
import {ConditionalOrders} from "../../src/ConditionalOrders.sol";
import {Rules} from "../../src/Rules.sol";
import {PriceFeeds} from "../../src/PriceFeeds.sol";
import {OrderState} from "../../src/libraries/OrderState.sol";
import {MockAggregator} from "../../src/testnet/MockAggregator.sol";

/// @dev Deploys the token list, the hook, Rules, ConditionalOrders and one pool (fee 0.3%, spacing 60, price 1) with
/// 100e18 full-range liquidity from a normal LP, then lets an hour pass so the pool has average-price history.
/// alice and bob get tokens and approve both contracts. Both pool tokens are listed at $1 and ETH at $2,000 (mock
/// Chainlink feeds, 8 decimals, always fresh).
///
/// Rules fire on average prices, so a test that moves the price calls `_settle()` before expecting a rule to see it.
abstract contract RuleSetup is BaseTest {
    using EasyPosm for IPositionManager;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    Currency currency0;
    Currency currency1;
    PoolKey poolKey;
    PoolId poolId;
    RuleHook hook;
    Rules rules;
    ConditionalOrders orders;
    PriceFeeds feeds;
    MockAggregator feedEth;
    MockAggregator feed0;
    MockAggregator feed1;
    uint32 constant MAX_AGE = 1 days;
    uint160 constant HOOK_FLAGS = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");

    function setUp() public virtual {
        vm.warp(1_790_000_000); // Sep 2026; order times are stored relative to 2026-01-01
        // Unichain-like gas prices, so keeper and fill pay are not zero. Foundry's isolate mode (on in foundry.toml)
        // runs each call at gas price 0, so tests that check pay amounts set `isolate = false`.
        vm.fee(0.0005 gwei);
        vm.txGasPrice(0.0015 gwei);
        deployArtifactsAndLabel();
        (currency0, currency1) = deployCurrencyPair();

        feeds = new PriceFeeds(address(this));
        feedEth = new MockAggregator(8, 2000e8);
        feed0 = new MockAggregator(8, 1e8);
        feed1 = new MockAggregator(8, 1e8);
        feeds.setFeed(address(0), address(feedEth), MAX_AGE);
        feeds.setFeed(Currency.unwrap(currency0), address(feed0), MAX_AGE);
        feeds.setFeed(Currency.unwrap(currency1), address(feed1), MAX_AGE);

        address flags = address(HOOK_FLAGS ^ (0x4444 << 144));
        deployCodeTo("RuleHook.sol:RuleHook", abi.encode(poolManager, feeds), flags);
        hook = RuleHook(flags);
        rules = new Rules(poolManager, hook, feeds);
        orders = new ConditionalOrders(poolManager, hook, feeds, rules);

        poolKey = _newPool(currency0, currency1, Constants.SQRT_PRICE_1_1);
        poolId = poolKey.toId();
        _fund(alice);
        _fund(bob);
        _wait(1 hours);
    }

    /// @dev A hook pool (fee 0.3%, spacing 60) with 100e18 full-range liquidity from this contract.
    function _newPool(Currency c0, Currency c1, uint160 sqrtPrice) internal returns (PoolKey memory key) {
        key = PoolKey(c0, c1, 3000, 60, IHooks(hook));
        poolManager.initialize(key, sqrtPrice);
        _addFullRange(key);
    }

    /// @dev Liquidity `_addFullRange` adds (100e18 for every new pool; a test raises it for a deeper pool).
    uint256 internal fullRangeLiquidity = 100e18;

    /// @dev Full-range liquidity from this contract. (The amount is read from storage: one more parameter is a
    /// "stack too deep" in the coverage build.)
    function _addFullRange(PoolKey memory key) internal {
        positionManager.mint(
            key,
            TickMath.minUsableTick(60),
            TickMath.maxUsableTick(60),
            fullRangeLiquidity,
            type(uint256).max,
            type(uint256).max,
            address(this),
            block.timestamp,
            Constants.ZERO_BYTES
        );
    }

    function _fund(address who) internal {
        _fundToken(who, currency0);
        _fundToken(who, currency1);
    }

    function _fundToken(address who, Currency c) internal {
        MockERC20 t = MockERC20(Currency.unwrap(c));
        t.transfer(who, 1_000e18);
        vm.startPrank(who);
        t.approve(address(hook), type(uint256).max);
        t.approve(address(orders), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ prices

    function _swap(bool zeroForOne, uint256 amountIn) internal {
        _swapIn(poolKey, zeroForOne, amountIn);
    }

    function _swapIn(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal {
        swapRouter.swapExactTokensForTokens({
            amountIn: amountIn,
            amountOutMin: 0,
            zeroForOne: zeroForOne,
            poolKey: key,
            hookData: Constants.ZERO_BYTES,
            receiver: address(this),
            deadline: type(uint256).max
        });
    }

    /// @dev Let the price of the moment become the average: a minute for a fresh snapshot (a dust swap writes it),
    /// then the averaging window.
    function _settle() internal {
        _settleIn(poolKey);
    }

    function _settleIn(PoolKey memory key) internal {
        _wait(61);
        _swapIn(key, true, 1);
        _wait(121);
    }

    /// @dev vm.warp by `secs`. (block.timestamp can read stale after a warp in via-IR code.)
    function _wait(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _tick() internal view returns (int24 t) {
        (, t,,) = poolManager.getSlot0(poolId);
    }

    function _avg() internal view returns (int24 t) {
        (, t) = hook.averageTick(poolId, 120);
    }

    function _bal(Currency c, address who) internal view returns (uint256) {
        return c.balanceOf(who);
    }

    // ------------------------------------------------------------------ orders

    function _off() internal pure returns (OrderState.Side memory s) {}

    function _side(uint8 checker, int24 value, uint8 actions, uint16 removeBps)
        internal
        pure
        returns (OrderState.Side memory s)
    {
        s.checker = checker;
        s.value = value;
        s.actions = actions;
        s.removeBps = removeBps;
    }

    /// @dev Remove everything (fees included) when the condition is true.
    function _exit(uint8 checker, int24 value) internal pure returns (OrderState.Side memory) {
        return _side(checker, value, OrderState.ACT_REMOVE | OrderState.ACT_KEEP_FEES, 10_000);
    }

    /// @dev Move everything to the other leg (swapping first when `swapTo` is 1 = token1 or 2 = token0).
    function _moveSide(uint8 checker, int24 value, uint8 swapTo) internal pure returns (OrderState.Side memory s) {
        s = _side(checker, value, OrderState.ACT_REMOVE | OrderState.ACT_KEEP_FEES | OrderState.ACT_MOVE, 10_000);
        if (swapTo != 0) {
            s.actions |= OrderState.ACT_SWAP;
            s.swapToToken1 = swapTo == 1;
        }
        s.repeat = true;
    }

    /// @dev The move of a waiting leg: it holds tokens, not a position.
    function _moveIdle(uint8 checker, int24 value) internal pure returns (OrderState.Side memory s) {
        s = _side(checker, value, OrderState.ACT_MOVE, 0);
        s.repeat = true;
    }

    function _w(OrderState.Side memory s) internal pure returns (uint256) {
        return OrderState.encodeSide(s);
    }

    /// @dev One-leg order of alice in the main pool: range [-600, 600], 10e18 liquidity, keeper ceiling 1%, swaps
    /// at most 5% past the average price.
    function _params(OrderState.Side memory lower, OrderState.Side memory upper)
        internal
        view
        returns (ConditionalOrders.CreateParams memory p)
    {
        p.key = poolKey;
        p.tickLower = -600;
        p.tickUpper = 600;
        p.liquidity = 10e18;
        p.amount0Max = type(uint128).max;
        p.amount1Max = type(uint128).max;
        p.expiry = uint32(_now() + 30 days);
        p.maxKeeperFeeBps = 100;
        p.maxSlippage = 50;
        p.lower = _w(lower);
        p.upper = _w(upper);
    }

    function _create(OrderState.Side memory lower, OrderState.Side memory upper) internal returns (uint256) {
        return _submit(alice, _params(lower, upper));
    }

    function _submit(address who, ConditionalOrders.CreateParams memory p) internal returns (uint256 id) {
        vm.prank(who);
        id = orders.createOrder(p);
    }

    function _state(uint256 id) internal view returns (OrderState.Side memory lower, OrderState.Side memory upper) {
        ConditionalOrders.Order memory o = orders.getOrder(id);
        lower = OrderState.decodeSide(o.lowerState);
        upper = OrderState.decodeSide(o.upperState);
    }

    function _liquidity(uint256 id) internal view returns (uint128) {
        ConditionalOrders.Order memory o = orders.getOrder(id);
        (OrderState.Side memory lo, OrderState.Side memory up) = _state(id);
        PoolKey memory key = hook.poolKeyAt(o.poolIndex);
        (uint128 liq,,) = poolManager.getPositionInfo(key.toId(), address(orders), lo.edge, up.edge, bytes32(id));
        return liq;
    }

    function _run(uint256 id, bool upper) internal {
        vm.prank(keeper);
        orders.execute(id, upper);
    }
}
