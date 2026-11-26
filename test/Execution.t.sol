// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RuleSetup} from "./utils/RuleSetup.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {OrderState} from "../src/libraries/OrderState.sol";

/// @notice Each condition and action of a one-leg order, run by a keeper.
contract ExecutionTest is RuleSetup {
    function _closed(uint256 id) internal view returns (bool) {
        return orders.getOrder(id).owner == address(0);
    }

    /// Trades back and forth through the order's range, so the position earns fees, ending near the start.
    function _trade(uint256 rounds) internal {
        for (uint256 i; i < rounds; ++i) {
            _swap(true, 0.3e18);
            _swap(false, 0.3e18);
        }
    }

    // ---------------------------------------------------------------- create, cancel, update

    function test_createHoldsThePositionAndCancelReturnsIt() public {
        uint256 b0 = _bal(currency0, alice);
        uint256 b1 = _bal(currency1, alice);
        uint256 id = _create(_exit(OrderState.CHECK_EDGE, 0), _off());
        assertEq(_liquidity(id), 10e18);
        assertEq(orders.ordersOf(alice)[0], id);

        vm.expectRevert(ConditionalOrders.NotOwner.selector);
        orders.cancel(id); // only the owner, before expiry
        vm.prank(alice);
        orders.cancel(id);
        assertTrue(_closed(id));
        assertApproxEqAbs(_bal(currency0, alice), b0, 2);
        assertApproxEqAbs(_bal(currency1, alice), b1, 2);
    }

    /// An update changes the rule; the range and the time each side last ran stay.
    function test_updateKeepsTheRangeAndTheClock() public {
        uint256 id = _create(_exit(OrderState.CHECK_EDGE, 0), _off());
        (OrderState.Side memory before,) = _state(id);
        _wait(1 hours);
        ConditionalOrders.UpdateParams memory u = ConditionalOrders.UpdateParams({
            expiry: uint32(_now() + 7 days),
            maxKeeperFeeBps: 50,
            maxSlippage: 20,
            lower: _w(_exit(OrderState.CHECK_TICK, -900)),
            upper: _w(_exit(OrderState.CHECK_EDGE, 0))
        });
        vm.prank(alice);
        orders.updateOrder(id, u);
        (OrderState.Side memory lo, OrderState.Side memory up) = _state(id);
        assertEq(lo.checker, OrderState.CHECK_TICK);
        assertEq(lo.edge, -600);
        assertEq(up.edge, 600);
        assertEq(lo.lastRun, before.lastRun);
        assertEq(orders.getOrder(id).maxKeeperFeeBps, 50);

        vm.expectRevert(ConditionalOrders.NotOwner.selector);
        orders.updateOrder(id, u);
    }

    // ---------------------------------------------------------------- exits

    function test_takeProfitWhenThePriceLeavesTheTop() public {
        uint256 id = _create(_off(), _exit(OrderState.CHECK_EDGE, 0));
        vm.expectRevert(ConditionalOrders.TooSoon.selector); // a side waits a minute or two after it starts
        _run(id, true);
        _wait(2 minutes);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, true);

        _swap(false, 5e18);
        _settle();
        uint256 b1 = _bal(currency1, alice);
        _run(id, true);
        assertTrue(_closed(id));
        assertGt(_bal(currency1, alice) - b1, 0.5e18); // above the range the position is all token1
    }

    function test_stopLossSellsIntoToken1() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_EDGE, 0);
        low.actions |= OrderState.ACT_SWAP;
        low.swapToToken1 = true;
        uint256 id = _create(low, _off());
        _swap(true, 5e18);
        _settle();
        uint256 b0 = _bal(currency0, alice);
        uint256 b1 = _bal(currency1, alice);
        _run(id, false);
        assertTrue(_closed(id));
        assertLt(_bal(currency0, alice) - b0, 1e15); // all sold
        assertGt(_bal(currency1, alice) - b1, 0.5e18);
    }

    /// A partial exit: the rest of the position stays and the side switches off (no repeat). The other side keeps
    /// the order open (with both sides off it would close: nothing could run again).
    function test_partialExitKeepsTheRest() public {
        uint256 id =
            _create(_side(OrderState.CHECK_TICK, -300, OrderState.ACT_REMOVE, 4_000), _exit(OrderState.CHECK_EDGE, 0));
        _swap(true, 2e18);
        _settle();
        _run(id, false);
        assertEq(_liquidity(id), 6e18);
        (OrderState.Side memory lo,) = _state(id);
        assertEq(lo.checker, OrderState.CHECK_OFF);
        assertEq(lo.edge, -600); // the range stays
    }

    // ---------------------------------------------------------------- staying in

    function test_compoundOnATimer() public {
        OrderState.Side memory c = _side(OrderState.CHECK_TIME, 60, OrderState.ACT_KEEP_FEES | OrderState.ACT_ADD, 0);
        c.repeat = true;
        uint256 id = _create(_off(), c);
        _trade(5);
        _wait(2 minutes);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, true);
        _wait(61 minutes);
        _run(id, true);
        assertGt(_liquidity(id), 10e18); // fees added back
        vm.expectRevert(ConditionalOrders.TooSoon.selector);
        _run(id, true);
    }

    /// FEES: compound once the fees earned reach a share of the position (here 0.1%).
    function test_compoundWhenFeesReachAShare() public {
        OrderState.Side memory c = _side(OrderState.CHECK_FEES, 10, OrderState.ACT_KEEP_FEES | OrderState.ACT_ADD, 0);
        c.repeat = true;
        uint256 id = _create(_off(), c);
        _wait(2 minutes);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, true);

        _trade(10);
        _settle();
        (bool ok, uint256 bps) = rules.feeBps(address(orders), id, 1, -600, 600);
        assertTrue(ok);
        assertGe(bps, 10);
        _run(id, true);
        assertGt(_liquidity(id), 10e18);
        (, bps) = rules.feeBps(address(orders), id, 1, -600, 600);
        assertEq(bps, 0); // collected
    }

    /// APR: leave a position whose fees, as a yearly rate, fall below a floor.
    function test_exitWhenTheFeeRateIsLow() public {
        uint256 id = _create(_exit(OrderState.CHECK_APR, 500), _off()); // below 5% a year
        _trade(10); // busy for a while: a high rate
        _wait(1 hours);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, false);

        _wait(25 days); // then nothing trades for weeks: the rate since the fees were last collected falls
        _swap(true, 1);
        _wait(2 minutes);
        _run(id, false);
        assertTrue(_closed(id));
    }

    /// The position follows the price up: each time it leaves the top, it is put back just below the new price.
    function test_followThePriceUp() public {
        OrderState.Side memory f = _exit(OrderState.CHECK_EDGE, 60);
        f.actions |= OrderState.ACT_ADD;
        f.addMode = OrderState.ADD_ONE_SIDED;
        f.shape = 5; // 5 spacings below the price
        f.repeat = true;
        uint256 id = _create(_off(), f);

        _swap(false, 5e18);
        _settle();
        _run(id, true);
        (OrderState.Side memory lo, OrderState.Side memory up) = _state(id);
        int24 avg = _avg();
        assertEq(up.edge, (avg / 60) * 60);
        assertEq(lo.edge, up.edge - 300);
        assertGt(_liquidity(id), 0);

        _swap(false, 3e18);
        _settle();
        _run(id, true);
        (, OrderState.Side memory up2) = _state(id);
        assertGt(up2.edge, up.edge);
    }

    /// A trailing stop: the remembered high follows the price (poke), and the side fires 3% below it.
    function test_trailingStop() public {
        uint256 id = _create(_exit(OrderState.CHECK_TRAIL, 300), _off());
        _swap(false, 1e18);
        _settle();
        orders.poke(id, false);
        (OrderState.Side memory lo,) = _state(id);
        int24 high = lo.best;
        assertGt(high, 100);

        _swap(true, 1e18);
        _settle();
        assertLt(_avg(), high - 300 + 200); // not yet 300 below
        if (_avg() >= high - 300) {
            vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
            _run(id, false);
            _swap(true, 1e18);
            _settle();
        }
        _run(id, false);
        assertTrue(_closed(id));
    }

    /// Chainlink condition: fires on the feed's price of the pair, whatever the pool says.
    function test_chainlinkLevel() public {
        uint256 id = _create(_exit(OrderState.CHECK_ORACLE, -500), _off());
        _wait(2 minutes);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, false);
        feed0.setAnswer(0.9e8); // token0 falls 10% on Chainlink: about -1054 ticks
        _run(id, false);
        assertTrue(_closed(id));
    }

    // ---------------------------------------------------------------- general

    function test_expiredOrderCannotRunAndAnyoneCanClose() public {
        uint256 id = _create(_exit(OrderState.CHECK_EDGE, 0), _off());
        _wait(31 days);
        vm.expectRevert(ConditionalOrders.Expired.selector);
        _run(id, false);
        uint256 b0 = _bal(currency0, alice);
        vm.prank(bob);
        orders.cancel(id); // after expiry anyone may close it; the tokens still go to alice
        assertGt(_bal(currency0, alice), b0);
    }

    function test_offSideCannotRun() public {
        uint256 id = _create(_exit(OrderState.CHECK_EDGE, 0), _off());
        vm.expectRevert(ConditionalOrders.SideOff.selector);
        _run(id, true);
    }

    function test_canExecuteMatchesExecute() public {
        uint256 id = _create(_exit(OrderState.CHECK_EDGE, 0), _off());
        _wait(2 minutes);
        assertFalse(rules.canExecute(orders, id, false));
        _swap(true, 5e18);
        assertFalse(rules.canExecute(orders, id, false)); // the price of the moment is not enough
        _settle();
        assertTrue(rules.canExecute(orders, id, false));
        _run(id, false);
        assertFalse(rules.canExecute(orders, id, false));
    }

    /// Every contract deploys on chains with the 24,576-byte code limit (EIP-170), Unichain included.
    function test_contractsFitTheSizeLimit() public view {
        assertLt(address(orders).code.length, 24_576);
        assertLt(address(rules).code.length, 24_576);
        assertLt(address(hook).code.length, 24_576);
        assertLt(address(feeds).code.length, 24_576);
    }
}
