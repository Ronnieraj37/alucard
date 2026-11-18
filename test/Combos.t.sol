// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IUniswapV4Router04} from "hookmate/interfaces/router/IUniswapV4Router04.sol";

import {RuleSetup} from "./utils/RuleSetup.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {OrderState} from "../src/libraries/OrderState.sol";

/// @dev Pushes the price and pokes in one transaction (a flash-loan style attempt to arm or move a side).
contract PushAndPoke {
    function attack(IUniswapV4Router04 router, PoolKey calldata key, ConditionalOrders orders, uint256 id) external {
        MockERC20(Currency.unwrap(key.currency0)).approve(address(router), type(uint256).max);
        router.swapExactTokensForTokens({
            amountIn: 30e18,
            amountOutMin: 0,
            zeroForOne: true,
            poolKey: key,
            hookData: "",
            receiver: address(this),
            deadline: block.timestamp + 1
        });
        orders.poke(id, false);
    }
}

/// @notice Rules that need the full-slot side: two conditions (AND / OR), hold, trailing stop, run limits.
contract CombosTest is RuleSetup {
    using StateLibrary for IPoolManager;

    int24 constant TL = -600;
    int24 constant TU = 600;
    uint128 constant LIQ = 10e18;
    uint8 constant EXIT = OrderState.ACT_REMOVE; // remove, fees go out with it

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

    function _withB(OrderState.Side memory s, uint8 combine, uint8 checker, int24 value)
        internal
        pure
        returns (OrderState.Side memory)
    {
        s.combine = combine;
        s.checker2 = checker;
        s.value2 = value;
        return s;
    }

    function _params(OrderState.Side memory lower, OrderState.Side memory upper, uint8 slippage)
        internal
        view
        returns (ConditionalOrders.CreateParams memory)
    {
        return ConditionalOrders.CreateParams({
            key: poolKey,
            tickLower: TL,
            tickUpper: TU,
            liquidity: LIQ,
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max,
            swapPoolIndex: 0,
            expiry: uint32(block.timestamp + 30 days),
            maxKeeperFeeBps: 10,
            maxSlippage: slippage,
            lower: lower,
            upper: upper
        });
    }

    function _create(OrderState.Side memory lower, OrderState.Side memory upper) internal returns (uint256 id) {
        vm.prank(alice);
        id = orders.createOrder(_params(lower, upper, 50));
    }

    function _expectCreateRevert(OrderState.Side memory lower, OrderState.Side memory upper, bytes4 err) internal {
        ConditionalOrders.CreateParams memory p = _params(lower, upper, 50);
        vm.prank(alice);
        vm.expectRevert(err);
        orders.createOrder(p);
    }

    function _open(uint256 id) internal view returns (bool) {
        (ConditionalOrders.Order memory o,) = orders.getOrder(id);
        return o.owner != address(0);
    }

    function _pushBelow(int24 t) internal {
        while (_tick() >= t) _swap(true, 2e18);
    }

    // ------------------------------------------------------------------ two conditions

    /// "Out of range below AND an hour has passed": the price alone or the time alone is not enough.
    function test_and_needsBoth() public {
        OrderState.Side memory lo =
            _withB(_side(OrderState.CHECK_EDGE, 0, EXIT, 10_000), OrderState.COMBINE_AND, OrderState.CHECK_TIME, 60);
        uint256 id = _create(lo, _off());

        // time alone
        vm.warp(block.timestamp + 2 hours);
        assertFalse(orders.canExecute(id, false));

        // fresh order, price alone
        uint256 id2 = _create(lo, _off());
        _pushBelow(TL);
        assertTrue(orders.canExecute(id, false)); // the first order now has both
        assertFalse(orders.canExecute(id2, false)); // its hour has not passed
        vm.prank(keeper);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        orders.execute(id2, false);

        vm.warp(block.timestamp + 61 minutes);
        vm.prank(keeper);
        orders.execute(id2, false);
        assertFalse(_open(id2));
    }

    /// "Price rises above 300 OR a day passes": either one alone runs it.
    function test_or_eitherOne() public {
        OrderState.Side memory up =
            _withB(_side(OrderState.CHECK_TICK, 300, EXIT, 10_000), OrderState.COMBINE_OR, OrderState.CHECK_TIME, 1440);
        uint256 byTime = _create(_off(), up);
        uint256 byPrice = _create(_off(), up);
        assertFalse(orders.canExecute(byTime, true));

        while (_tick() < 300) _swap(false, 2e18);
        vm.prank(keeper);
        orders.execute(byPrice, true);
        assertFalse(_open(byPrice));

        while (_tick() > 0) _swap(true, 2e18); // back below 300: only the timer can fire now
        assertFalse(orders.canExecute(byTime, true));
        vm.warp(block.timestamp + 1 days + 60); // times round up to the minute
        vm.prank(keeper);
        orders.execute(byTime, true);
        assertFalse(_open(byTime));
    }

    /// With OR, if the timer fired and not the price, the swap is protected from the current price, not from a far
    /// away price level that was never reached.
    function test_or_swapProtectedFromThePriceThatFired() public {
        OrderState.Side memory lo = _withB(
            _side(OrderState.CHECK_TICK, -3000, EXIT | OrderState.ACT_SWAP, 10_000),
            OrderState.COMBINE_OR,
            OrderState.CHECK_TIME,
            60
        );
        lo.swapToToken1 = true;
        vm.prank(alice);
        uint256 id = orders.createOrder(_params(lo, _off(), 1)); // slippage 10 ticks
        vm.warp(block.timestamp + 61 minutes);
        vm.prank(keeper);
        orders.execute(id, false);
        assertGe(_tick(), -11, "swap went further than 10 ticks from the price at execution");
    }

    /// A repeating side steps every price level it has, so neither fires again straight away.
    function test_or_repeatStepsBothLevels() public {
        OrderState.Side memory lo =
            _withB(_side(OrderState.CHECK_TICK, -300, EXIT, 2500), OrderState.COMBINE_OR, OrderState.CHECK_TICK, -200);
        lo.repeat = true;
        lo.shape = 600;
        uint256 id = _create(lo, _off());
        _pushBelow(-200);
        vm.prank(keeper);
        orders.execute(id, false);
        (, OrderState.State memory st) = orders.getOrder(id);
        assertEq(st.lower.value, -900);
        assertEq(st.lower.value2, -800);
        assertEq(st.lower.combine, OrderState.COMBINE_OR);
    }

    /// Condition B may read another pool's price. The own pool is 0, never its own index; unknown pools revert.
    function test_conditionBReadsAnotherPool_pastIndexRefused() public {
        OrderState.Side memory lo = _withB(
            _side(OrderState.CHECK_EDGE, 0, EXIT, 10_000), OrderState.COMBINE_AND, OrderState.CHECK_TICK, -100
        );
        lo.checkPool2 = 2; // only one pool exists
        _expectCreateRevert(lo, _off(), ConditionalOrders.UnknownPool.selector);
        lo.checkPool2 = 1; // the order's own pool by index: the editor writes 0
        _expectCreateRevert(lo, _off(), ConditionalOrders.InvalidSide.selector);
        PoolKey memory k = PoolKey(currency0, currency1, 500, 10, IHooks(address(0)));
        poolManager.initialize(k, Constants.SQRT_PRICE_1_1);
        lo.checkPool2 = hook.registerPool(k);
        assertTrue(_open(_create(lo, _off())));
    }

    function test_invalidCombinationsRefused() public {
        bytes4 bad = ConditionalOrders.InvalidSide.selector;
        OrderState.Side memory base = _side(OrderState.CHECK_EDGE, 0, EXIT, 10_000);

        OrderState.Side memory s = _withB(base, OrderState.COMBINE_AND, OrderState.CHECK_OFF, 0);
        _expectCreateRevert(s, _off(), bad); // AND with nothing

        s = _withB(base, OrderState.COMBINE_NONE, OrderState.CHECK_TIME, 60);
        _expectCreateRevert(s, _off(), bad); // B without a combine

        s = _withB(base, 3, OrderState.CHECK_TIME, 60);
        _expectCreateRevert(s, _off(), bad); // unknown combine

        s = _withB(base, OrderState.COMBINE_AND, OrderState.CHECK_TIME, 0);
        _expectCreateRevert(s, _off(), bad); // zero timer

        s = _withB(base, OrderState.COMBINE_AND, 9, 60);
        _expectCreateRevert(s, _off(), bad); // unknown checker

        s = _withB(_side(OrderState.CHECK_TIME, 60, EXIT, 2500), OrderState.COMBINE_OR, OrderState.CHECK_EDGE, 0);
        s.repeat = true;
        _expectCreateRevert(s, _off(), bad); // OR + repeat + edge that does not move: fires again at once

        s = _side(OrderState.CHECK_TIME, 60, EXIT, 2500);
        s.checkPool = 1;
        _expectCreateRevert(s, _off(), bad); // a timer reads no pool

        s = _withB(_side(OrderState.CHECK_TIME, 60, EXIT, 2500), OrderState.COMBINE_AND, OrderState.CHECK_TICK, -100);
        s.repeat = true;
        _expectCreateRevert(s, _off(), bad); // repeating price level without a step

        OrderState.Side memory off = _off();
        off.checker2 = OrderState.CHECK_TIME;
        _expectCreateRevert(_side(OrderState.CHECK_EDGE, 0, EXIT, 10_000), off, bad); // an off side carries nothing
    }

    // ------------------------------------------------------------------ hold

    function _holdStop(uint16 minutes_) internal returns (uint256 id) {
        OrderState.Side memory lo = _side(OrderState.CHECK_EDGE, 0, EXIT, 10_000);
        lo.holdMinutes = minutes_;
        id = _create(lo, _off());
    }

    /// The price must be out of range when the side is armed and still be out 30 minutes later.
    function test_hold_armThenWait() public {
        uint256 id = _holdStop(30);
        _pushBelow(TL);
        vm.prank(keeper);
        vm.expectRevert(ConditionalOrders.NotHeld.selector);
        orders.execute(id, false); // not armed
        assertFalse(orders.canExecute(id, false));

        vm.prank(keeper);
        orders.poke(id, false); // armed now
        (, OrderState.State memory st) = orders.getOrder(id);
        assertGe(st.lower.armedAt, block.timestamp);

        vm.warp(block.timestamp + 29 minutes);
        vm.prank(keeper);
        vm.expectRevert(ConditionalOrders.NotHeld.selector);
        orders.execute(id, false);

        vm.warp(block.timestamp + 2 minutes); // 31 minutes (the stored time rounds up by under a minute)
        assertTrue(orders.canExecute(id, false));
        vm.prank(keeper);
        orders.execute(id, false);
        assertFalse(_open(id));
    }

    /// Nobody can disarm. An old arming expires after 2 x hold, so a dip long ago does not count for a dip now.
    function test_hold_noDisarm_staleArmingExpires() public {
        uint256 id = _holdStop(30);
        _pushBelow(TL);
        orders.poke(id, false);
        while (_tick() < 0) _swap(false, 2e18); // back in range
        vm.expectRevert(ConditionalOrders.NothingToPoke.selector);
        orders.poke(id, false); // cannot disarm

        vm.warp(block.timestamp + 61 minutes); // past the 30..60 minute window
        _pushBelow(TL);
        vm.prank(keeper);
        vm.expectRevert(ConditionalOrders.NotHeld.selector);
        orders.execute(id, false); // the old arming has expired

        orders.poke(id, false); // armed again
        vm.warp(block.timestamp + 31 minutes);
        vm.prank(keeper);
        orders.execute(id, false);
        assertFalse(_open(id));
    }

    /// A poke that changes nothing reverts, so keepers do not waste gas.
    function test_hold_pokeWithNothingToDoReverts() public {
        uint256 id = _holdStop(30);
        vm.expectRevert(ConditionalOrders.NothingToPoke.selector);
        orders.poke(id, false); // condition false and not armed

        uint256 plain = _create(_side(OrderState.CHECK_EDGE, 0, EXIT, 10_000), _off());
        _pushBelow(TL);
        vm.expectRevert(ConditionalOrders.NothingToPoke.selector);
        orders.poke(plain, false); // no hold, nothing to remember

        orders.poke(id, false);
        vm.expectRevert(ConditionalOrders.NothingToPoke.selector);
        orders.poke(id, false); // already armed
    }

    /// Arming needs a real price: a push and a poke in the same transaction are refused.
    function test_hold_pushAndPokeInOneTransactionReverts() public {
        uint256 id = _holdStop(30);
        PushAndPoke attacker = new PushAndPoke();
        MockERC20(Currency.unwrap(currency0)).transfer(address(attacker), 30e18);
        vm.expectRevert(ConditionalOrders.SwappedThisTx.selector);
        attacker.attack(swapRouter, poolKey, orders, id);
    }

    /// A repeating side with a hold needs a new arming after each run.
    function test_hold_repeatNeedsNewArming() public {
        OrderState.Side memory lo = _side(OrderState.CHECK_TICK, -100, EXIT, 2500);
        lo.holdMinutes = 10;
        lo.repeat = true;
        lo.shape = 200;
        uint256 id = _create(lo, _off());
        _pushBelow(-700);
        orders.poke(id, false);
        vm.warp(block.timestamp + 11 minutes);
        vm.prank(keeper);
        orders.execute(id, false); // level moves to -300; price -700 is still below it
        (, OrderState.State memory st) = orders.getOrder(id);
        assertEq(st.lower.armedAt, 0);
        assertEq(st.lower.value, -300);
        vm.prank(keeper);
        vm.expectRevert(ConditionalOrders.NotHeld.selector);
        orders.execute(id, false);
    }

    /// The contract keeps the memo itself: a caller cannot start already armed (or with any stored state).
    function test_hold_callerCannotPreArm() public {
        OrderState.Side memory lo = _side(OrderState.CHECK_EDGE, 0, EXIT, 10_000);
        lo.holdMinutes = 30;
        lo.armedAt = uint32(block.timestamp - 1 hours);
        _expectCreateRevert(lo, _off(), ConditionalOrders.InvalidSide.selector);
        lo.armedAt = 0;
        lo.lastRun = uint32(block.timestamp);
        _expectCreateRevert(lo, _off(), ConditionalOrders.InvalidSide.selector);
        lo.lastRun = 0;
        lo.edge = 5;
        _expectCreateRevert(lo, _off(), ConditionalOrders.InvalidSide.selector);
        lo.edge = 0;
        uint256 id = _create(lo, _off());
        (, OrderState.State memory st) = orders.getOrder(id);
        assertEq(st.lower.armedAt, 0);
    }

    // ------------------------------------------------------------------ trailing stop

    function _pushAbove(int24 t) internal {
        while (_tick() < t) _swap(false, 0.1e18);
    }

    /// Small steps, so the price lands just past `t` (about 6 ticks per step here).
    function _stepBelow(int24 t) internal {
        while (_tick() >= t) _swap(true, 0.1e18);
    }

    function _best(uint256 id, bool upper) internal view returns (int24) {
        (, OrderState.State memory st) = orders.getOrder(id);
        return upper ? st.upper.best : st.lower.best;
    }

    /// Sell if the price falls 300 ticks (~3%) from the highest price seen.
    function test_trail_followsTheHighAndFiresOnTheDrop() public {
        uint256 id = _create(_side(OrderState.CHECK_TRAIL, 300, EXIT, 10_000), _off());
        assertEq(_best(id, false), _tick()); // starts at the price at creation

        _pushAbove(450);
        int24 high = _tick();
        orders.poke(id, false);
        assertEq(_best(id, false), high);

        _stepBelow(high - 200); // a 200-tick dip is not enough
        assertFalse(orders.canExecute(id, false));
        vm.expectRevert(ConditionalOrders.NothingToPoke.selector);
        orders.poke(id, false); // a lower price never lowers the high

        _stepBelow(high - 300);
        assertTrue(orders.canExecute(id, false));
        vm.prank(keeper);
        orders.execute(id, false);
        assertFalse(_open(id));
    }

    /// Upper side: buy back / re-enter once the price rises 300 ticks from the lowest price seen.
    function test_trail_upperSideFollowsTheLow() public {
        uint256 id = _create(_off(), _side(OrderState.CHECK_TRAIL, 300, EXIT, 10_000));
        _pushBelow(-400);
        int24 low = _tick();
        orders.poke(id, true);
        assertEq(_best(id, true), low);
        _pushAbove(low + 300);
        vm.prank(keeper);
        orders.execute(id, true);
        assertFalse(_open(id));
    }

    /// A trailing stop with a convert protects the swap from the stop level, not from the far-away start.
    function test_trail_swapProtectedFromTheStopLevel() public {
        OrderState.Side memory lo = _side(OrderState.CHECK_TRAIL, 300, EXIT | OrderState.ACT_SWAP, 10_000);
        lo.swapToToken1 = true;
        vm.prank(alice);
        uint256 id = orders.createOrder(_params(lo, _off(), 5)); // 50 ticks slippage
        _pushAbove(450);
        int24 high = _tick();
        orders.poke(id, false);
        _stepBelow(high - 300);
        assertGt(_tick(), high - 300 - 50, "test setup: price must still be inside the slippage band");
        vm.prank(keeper);
        orders.execute(id, false);
        assertGe(_tick(), high - 300 - 50 - 1, "swap went past the stop level minus slippage");
        assertLt(_tick(), high - 300 - 40, "swap should run down to the limit");
    }

    /// Repeating: after a partial exit the trail restarts from the price after the run.
    function test_trail_repeatRestartsFromCurrentPrice() public {
        OrderState.Side memory lo = _side(OrderState.CHECK_TRAIL, 200, EXIT, 2500);
        lo.repeat = true;
        uint256 id = _create(lo, _off());
        _pushBelow(-200);
        vm.prank(keeper);
        orders.execute(id, false);
        assertTrue(_open(id));
        assertEq(_best(id, false), _tick());
        assertFalse(orders.canExecute(id, false));
    }

    /// A trailing condition can be condition B: "trail 300 AND at least a day since the last run".
    function test_trail_asConditionB() public {
        OrderState.Side memory lo = _withB(
            _side(OrderState.CHECK_TIME, 1440, EXIT, 10_000), OrderState.COMBINE_AND, OrderState.CHECK_TRAIL, 300
        );
        uint256 id = _create(lo, _off());
        assertEq(_best(id, false), _tick());
        _pushBelow(-300);
        assertFalse(orders.canExecute(id, false)); // the day has not passed
        vm.warp(block.timestamp + 1 days + 60);
        vm.prank(keeper);
        orders.execute(id, false);
        assertFalse(_open(id));
    }

    function test_trail_invalidRefused() public {
        bytes4 bad = ConditionalOrders.InvalidSide.selector;
        _expectCreateRevert(_side(OrderState.CHECK_TRAIL, 0, EXIT, 10_000), _off(), bad); // zero distance

        OrderState.Side memory s = _side(OrderState.CHECK_TRAIL, 300, EXIT, 10_000);
        s.holdMinutes = 10;
        _expectCreateRevert(s, _off(), bad); // trail and hold share the memo

        s = _withB(_side(OrderState.CHECK_TRAIL, 300, EXIT, 10_000), OrderState.COMBINE_OR, OrderState.CHECK_TRAIL, 100);
        _expectCreateRevert(s, _off(), bad); // two trails on one side

        s = _side(OrderState.CHECK_TRAIL, 300, EXIT, 10_000);
        s.checkPool = 2;
        _expectCreateRevert(s, _off(), bad); // a trailing stop reads its own pool only

        s = _side(OrderState.CHECK_TRAIL, OrderState.MAX_TRAIL + 1, EXIT, 10_000);
        _expectCreateRevert(s, _off(), bad); // more than a 99.99% fall
    }

    /// A trailing stop may not read another pool (a hookless one least of all: there a flash loan could raise the
    /// high for good).
    function test_trail_hooklessPoolRefused() public {
        PoolKey memory k = PoolKey(currency0, currency1, 500, 10, IHooks(address(0)));
        poolManager.initialize(k, Constants.SQRT_PRICE_1_1);
        uint24 index = hook.registerPool(k);
        OrderState.Side memory s = _side(OrderState.CHECK_TRAIL, 300, EXIT, 10_000);
        s.checkPool = index;
        _expectCreateRevert(s, _off(), ConditionalOrders.InvalidSide.selector);
        // a plain price level in that pool is still allowed
        s = _side(OrderState.CHECK_TICK, -300, EXIT, 10_000);
        s.checkPool = index;
        assertTrue(_open(_create(s, _off())));
    }

    /// Raising the high needs a real price: a push and a poke in one transaction are refused.
    function test_trail_pushAndPokeInOneTransactionReverts() public {
        uint256 id = _create(_side(OrderState.CHECK_TRAIL, 300, EXIT, 10_000), _off());
        PushAndPoke attacker = new PushAndPoke();
        MockERC20(Currency.unwrap(currency0)).transfer(address(attacker), 30e18);
        vm.expectRevert(ConditionalOrders.SwappedThisTx.selector);
        attacker.attack(swapRouter, poolKey, orders, id);
    }

    // ------------------------------------------------------------------ run limit

    /// "Take 20% profit every 100 ticks up, at most 3 times": after the third run the side switches off.
    function test_runsLeft_stopsAfterTheLastRun() public {
        OrderState.Side memory up = _side(OrderState.CHECK_TICK, 100, EXIT, 2000);
        up.repeat = true;
        up.shape = 100;
        up.runsLeft = 3;
        uint256 id = _create(_side(OrderState.CHECK_EDGE, 0, EXIT, 10_000), up); // a stop-loss keeps the order open

        for (uint256 i; i < 3; ++i) {
            _pushAbove(int24(int256(100 * (i + 1))));
            vm.prank(keeper);
            orders.execute(id, true);
            (, OrderState.State memory st) = orders.getOrder(id);
            if (i < 2) {
                assertEq(st.upper.runsLeft, 2 - i);
                assertEq(st.upper.checker, OrderState.CHECK_TICK);
            } else {
                assertEq(st.upper.checker, OrderState.CHECK_OFF, "switched off after the last run");
                assertEq(st.lower.checker, OrderState.CHECK_EDGE, "the other side is untouched");
            }
        }
        _pushAbove(400);
        assertFalse(orders.canExecute(id, true));
        assertTrue(_open(id));
    }

    /// No limit (0) keeps repeating; a limit without repeat is refused.
    function test_runsLeft_zeroMeansNoLimit_needsRepeat() public {
        OrderState.Side memory up = _side(OrderState.CHECK_TICK, 100, EXIT, 1000);
        up.runsLeft = 2;
        _expectCreateRevert(_off(), up, ConditionalOrders.InvalidSide.selector);

        up.runsLeft = 0;
        up.repeat = true;
        up.shape = 100;
        uint256 id = _create(_off(), up);
        for (uint256 i; i < 4; ++i) {
            _pushAbove(int24(int256(100 * (i + 1))));
            vm.prank(keeper);
            orders.execute(id, true);
        }
        (, OrderState.State memory st) = orders.getOrder(id);
        assertEq(st.upper.checker, OrderState.CHECK_TICK);
        assertEq(st.upper.value, 500);
    }

    // ------------------------------------------------------------------ combinations the editor never builds

    /// "Price reaches a level, compound, repeat": the level steps after each run (it used to stay put and the order
    /// could never run again).
    function test_compoundOnARepeatingPriceLevelSteps() public {
        OrderState.Side memory up = _side(OrderState.CHECK_TICK, 120, OrderState.ACT_KEEP_FEES | OrderState.ACT_ADD, 0);
        up.repeat = true;
        up.shape = 120;
        uint256 id = _create(_off(), up);
        _pushAbove(120);
        vm.prank(keeper);
        orders.execute(id, true);
        (, OrderState.State memory st) = orders.getOrder(id);
        assertEq(st.upper.value, 240);
        _pushAbove(240);
        vm.prank(keeper);
        orders.execute(id, true); // runs again at the next level
        (, st) = orders.getOrder(id);
        assertEq(st.upper.value, 360);
    }

    function test_combinationsTheEditorNeverBuildsRevert() public {
        bytes4 bad = ConditionalOrders.InvalidSide.selector;
        uint8 keepRemove = OrderState.ACT_KEEP_FEES | OrderState.ACT_REMOVE;

        // Follow with OR: condition B alone would re-range while the price is still in range
        OrderState.Side memory s = _withB(
            _side(OrderState.CHECK_EDGE, 60, keepRemove | OrderState.ACT_ADD, 10_000),
            OrderState.COMBINE_OR,
            OrderState.CHECK_TIME,
            60
        );
        s.addMode = OrderState.ADD_ONE_SIDED;
        s.shape = uint24(5) << 11;
        _expectCreateRevert(s, _off(), bad);
        s.combine = OrderState.COMBINE_AND; // with AND it is fine
        assertTrue(_open(_create(s, _off())));

        // Follow writes only the width its side uses
        s = _side(OrderState.CHECK_EDGE, 60, keepRemove | OrderState.ACT_ADD, 10_000);
        s.addMode = OrderState.ADD_ONE_SIDED;
        s.shape = 5 | (uint24(5) << 11);
        _expectCreateRevert(s, _off(), bad);

        // convert and put back in (needs swap-to-ratio, not built)
        _expectCreateRevert(_side(OrderState.CHECK_EDGE, 0, keepRemove | OrderState.ACT_SWAP | OrderState.ACT_ADD, 10_000), _off(), bad);
        // convert with nothing withdrawn
        _expectCreateRevert(_side(OrderState.CHECK_EDGE, 0, OrderState.ACT_REMOVE | OrderState.ACT_SWAP, 0), _off(), bad);
        // "keep fees" alone (the editor writes "send fees out" as remove 0%)
        _expectCreateRevert(_side(OrderState.CHECK_EDGE, 0, OrderState.ACT_KEEP_FEES, 0), _off(), bad);
        // a remove amount without remove
        _expectCreateRevert(_side(OrderState.CHECK_EDGE, 0, OrderState.ACT_KEEP_FEES | OrderState.ACT_ADD, 5000), _off(), bad);
        // a swap direction without a swap
        s = _side(OrderState.CHECK_EDGE, 0, keepRemove, 10_000);
        s.swapToToken1 = true;
        _expectCreateRevert(s, _off(), bad);
        // a step when nothing steps
        s = _side(OrderState.CHECK_EDGE, 0, keepRemove, 10_000);
        s.shape = 100;
        _expectCreateRevert(s, _off(), bad);
        // an off side with anything in it
        OrderState.Side memory off = _off();
        off.actions = OrderState.ACT_REMOVE;
        _expectCreateRevert(_side(OrderState.CHECK_EDGE, 0, keepRemove, 10_000), off, bad);
    }
}
