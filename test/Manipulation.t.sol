// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";
import {RuleSetup} from "./utils/RuleSetup.sol";
import {Rules} from "../src/Rules.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {OrderState} from "../src/libraries/OrderState.sol";

/// @notice Attacks on strategies, each as a test the attacker must lose. The Chainlink band is on (2%): a pool's
/// price counts only while it is within 200 ticks of Chainlink. `_market()` is a real move: Chainlink moves to where
/// the pool's price went, as arbitrage keeps the two together.
contract ManipulationTest is RuleSetup {
    function setUp() public override {
        super.setUp();
        _band(200);
    }

    /// A stop below the range (exit and sell token0), as a victim would set it.
    function _stop() internal returns (uint256) {
        OrderState.Side memory low = _exit(OrderState.CHECK_EDGE, 0);
        low.actions |= OrderState.ACT_SWAP;
        low.swapToToken1 = true;
        return _create(low, _off());
    }

    // ---------------------------------------------------------------- forcing a trigger

    /// Push the price through the stop and execute: the price is far from Chainlink, so it does not count.
    function test_aPushedPriceDoesNotFire() public {
        uint256 id = _stop();
        _wait(2 minutes);
        _swap(true, 5e18);
        assertLt(_tick(), -600); // the pool's price is past the stop
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, false);
    }

    /// Holding the push for as long as the attacker can pay for it changes nothing: Chainlink did not move.
    function test_aPushHeldForHoursDoesNotFire() public {
        uint256 id = _stop();
        _swap(true, 5e18);
        _wait(3 hours);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, false);
    }

    /// A real move (Chainlink agrees) fires at once: no average to lag behind in a crash.
    function test_aRealMoveFiresAtOnce() public {
        uint256 id = _stop();
        _wait(2 minutes);
        _swap(true, 5e18);
        _market();
        _run(id, false);
        assertEq(orders.getOrder(id).owner, address(0)); // closed
    }

    /// No Chainlink price, no run: a step never acts on a price nothing can confirm.
    function test_noChainlinkPriceNoRun() public {
        uint256 id = _create(_exit(OrderState.CHECK_TIME, 1), _off());
        _wait(2 minutes);
        feed0.setBroken(true);
        vm.expectRevert(Rules.PriceMoved.selector);
        _run(id, false);
    }

    // ---------------------------------------------------------------- holds ("only if it lasts")

    /// A hold counts from when `poke` first saw the condition true, and the step runs only once it lasted.
    function test_aHoldWaitsUntilTheConditionHasLasted() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_EDGE, 0);
        low.holdMinutes = 30;
        uint256 id = _create(low, _off());
        _swap(true, 5e18);
        _market();
        _wait(2 minutes);
        vm.expectRevert(ConditionalOrders.NotHeldLongEnough.selector);
        _run(id, false); // nobody saw it true yet
        orders.poke(id, false);
        assertEq(orders.armedAt(id, false), _now());
        _wait(29 minutes);
        vm.expectRevert(ConditionalOrders.NotHeldLongEnough.selector);
        _run(id, false);
        _wait(1 minutes);
        _run(id, false);
        assertEq(orders.getOrder(id).owner, address(0));
    }

    /// Back in range before the hold is over: the next poke forgets it, and the hold starts again from zero.
    function test_aHoldStartsAgainWhenTheConditionStops() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_EDGE, 0);
        low.holdMinutes = 30;
        uint256 id = _create(low, _off());
        _swap(true, 5e18);
        _market();
        orders.poke(id, false);
        _wait(20 minutes);
        _swap(false, 5.2e18); // back in range
        _market();
        orders.poke(id, false); // forgets
        assertEq(orders.armedAt(id, false), 0);
        _swap(true, 5.2e18);
        _market();
        orders.poke(id, false);
        _wait(20 minutes); // 40 minutes out in all, but only 20 in a row
        vm.expectRevert(ConditionalOrders.NotHeldLongEnough.selector);
        _run(id, false);
    }

    /// A pushed price cannot start a hold: it is not a price.
    function test_aPushCannotStartAHold() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_EDGE, 0);
        low.holdMinutes = 30;
        uint256 id = _create(low, _off());
        _swap(true, 5e18);
        vm.expectRevert(ConditionalOrders.NothingToPoke.selector);
        orders.poke(id, false);
    }

    /// A push away from Chainlink cannot reset a hold either: it says nothing about the condition.
    function test_aPushCannotResetAHold() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_EDGE, 0);
        low.holdMinutes = 30;
        uint256 id = _create(low, _off());
        _swap(true, 5e18);
        _market();
        orders.poke(id, false);
        uint256 armed = orders.armedAt(id, false);
        _wait(10 minutes);
        _swap(false, 9e18); // pushed far up, away from Chainlink: "back in range" here is not a price
        vm.expectRevert(ConditionalOrders.NothingToPoke.selector);
        orders.poke(id, false);
        assertEq(orders.armedAt(id, false), armed);
    }

    // ---------------------------------------------------------------- trailing stops

    /// Push the price up to set a high "best" for the stop to trail from: a pushed price is not remembered.
    function test_pokeCannotRecordAPushedPrice() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_TRAIL, 300);
        uint256 id = _create(low, _off());
        _swap(false, 5e18);
        vm.expectRevert(ConditionalOrders.NothingToPoke.selector);
        orders.poke(id, false);
        (OrderState.Side memory lo,) = _state(id);
        assertEq(lo.best, 0);
    }

    // ---------------------------------------------------------------- sandwiching the order's swap

    /// Front-run a timed exit that swaps: pushed away from Chainlink, the run is refused instead of selling there.
    function test_frontRunMakesTheRunWait() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_TIME, 1);
        low.actions |= OrderState.ACT_SWAP;
        low.swapToToken1 = true;
        uint256 id = _create(low, _off());
        _wait(2 minutes);
        _swap(true, 5e18);
        vm.expectRevert(Rules.PriceMoved.selector);
        _run(id, false);
        assertEq(_liquidity(id), 10e18);
    }

    /// Inside the band the order's own swap still stops at its slippage limit from the price before it.
    function test_swapNeverFillsPastTheLimit() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_TIME, 1);
        low.actions |= OrderState.ACT_SWAP;
        low.swapToToken1 = true;
        uint256 id = _create(low, _off());
        _wait(2 minutes);
        _swap(true, 1e18); // down, but within the band
        int24 before = _tick();
        assertGt(before, -200);
        _run(id, false);
        assertGe(_tick(), before - 500 - 1); // the order's own swap stopped 5% past the price before it
    }

    // ---------------------------------------------------------------- pushes INSIDE the band (an external review's
    // "experiment 1": move the pool less than 2% from Chainlink and see what it can make a strategy do). A pool level
    // may fire, but the step cannot sell into the push; an owner who wants Chainlink to confirm adds its condition.

    /// @dev Push the pool's price (not Chainlink's) down or up until it is past `target`, in small swaps.
    function _pushTo(int24 target) internal {
        bool down = target < _tick();
        for (uint256 i; i < 400 && (down ? _tick() > target : _tick() < target); ++i) _swap(down, 0.02e18);
    }

    /// "The pool below the level AND Chainlink below the level": a push of 1.5% (inside the band) moves only the pool,
    /// so the side does not fire. A real move (Chainlink follows) fires it.
    function test_aChainlinkConditionIgnoresPushes() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_TICK, -100);
        low.combine = OrderState.COMBINE_AND;
        low.checker2 = OrderState.CHECK_LINK;
        low.value2 = -100;
        uint256 id = _create(low, _off());
        _wait(2 minutes);
        _pushTo(-150);
        assertLt(_tick(), -100);
        assertGt(_tick(), -200); // inside the band
        assertFalse(rules.canExecute(orders, id, false));
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, false);
        _market(); // Chainlink follows: a real move
        _run(id, false);
        assertEq(orders.getOrder(id).owner, address(0));
    }

    /// A pool level alone can be fired by a push inside the band, but a step that sells cannot sell into it: the
    /// swap must fill within the owner's slippage of Chainlink, so the run reverts and the position stays as it was.
    function test_aPushCannotMakeAStepSellCheap() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_TICK, -100);
        low.actions |= OrderState.ACT_SWAP;
        low.swapToToken1 = true;
        ConditionalOrders.CreateParams memory p = _params(low, _off());
        p.maxSlippage = 5; // 50 ticks, about 0.5%
        uint256 id = _submit(alice, p);
        _wait(2 minutes);
        _pushTo(-150);
        assertTrue(rules.canExecute(orders, id, false)); // the pool level is past
        int24 pushed = _tick();
        vm.expectRevert(ConditionalOrders.SlippageLimit.selector);
        _run(id, false);
        assertEq(_tick(), pushed); // nothing was sold into the push
        assertEq(_liquidity(id), 10e18); // the position is untouched
    }

    /// A step waits while the pool is pushed against its swap, and runs in full once the pool is back on Chainlink.
    function test_aStepWaitsForAFairPriceThenSellsEverything() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_TIME, 1);
        low.actions |= OrderState.ACT_SWAP;
        low.swapToToken1 = true;
        ConditionalOrders.CreateParams memory p = _params(low, _off());
        p.maxSlippage = 10; // 1%: the sale itself moves this pool about 0.6%
        uint256 id = _submit(alice, p);
        _wait(2 minutes);
        _pushTo(-150);
        vm.expectRevert(ConditionalOrders.SlippageLimit.selector);
        _run(id, false);
        _pushTo(0); // arbitrage brings the pool back
        uint256 t0 = _bal(currency0, alice);
        uint256 t1 = _bal(currency1, alice);
        _run(id, false);
        assertEq(_bal(currency0, alice), t0); // all of token0 was sold
        assertGt(_bal(currency1, alice), t1);
        assertEq(orders.getOrder(id).owner, address(0));
    }

    /// A sale too big for the owner's slippage (its own price impact is larger) waits rather than half-sell; the owner
    /// can raise the slippage at any time (updateOrder) and the step then runs in full.
    function test_aSaleTooBigForTheSlippageWaitsUntilTheOwnerRaisesIt() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_TIME, 1);
        low.actions |= OrderState.ACT_SWAP;
        low.swapToToken1 = true;
        ConditionalOrders.CreateParams memory p = _params(low, _off());
        p.maxSlippage = 3; // 0.3%: less than this sale's own impact
        uint256 id = _submit(alice, p);
        _wait(2 minutes);
        vm.expectRevert(ConditionalOrders.SlippageLimit.selector);
        _run(id, false);
        assertEq(_liquidity(id), 10e18);
        ConditionalOrders.UpdateParams memory u =
            ConditionalOrders.UpdateParams({expiry: p.expiry, keeperFeeBps: p.keeperFeeBps, maxSlippage: 10, lower: p.lower, upper: p.upper, condition: address(0)});
        vm.prank(alice);
        orders.updateOrder(id, u);
        _wait(2 minutes);
        _run(id, false);
        assertEq(orders.getOrder(id).owner, address(0));
    }

    /// A push inside the band can make a started hold start again, which only delays the step (for an LP, a later
    /// exit while the position may still earn). It can never make the step run before the condition has lasted for
    /// the whole hold.
    function test_aPushInsideTheBandOnlyDelaysAHold() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_TICK, -300);
        low.holdMinutes = 30;
        uint256 id = _create(low, _off());
        _pushTo(-400);
        _market();
        orders.poke(id, false);
        assertGt(orders.armedAt(id, false), 0);
        _wait(10 minutes);
        _pushTo(-250); // pool back above the level, 150 ticks from Chainlink
        orders.poke(id, false); // the hold starts again
        assertEq(orders.armedAt(id, false), 0);
        _pushTo(-400); // the push ends
        orders.poke(id, false);
        uint256 restarted = orders.armedAt(id, false);
        _wait(29 minutes); // 39 minutes since the first start, 29 since the restart
        vm.expectRevert(ConditionalOrders.NotHeldLongEnough.selector);
        _run(id, false);
        _wait(1 minutes);
        assertEq(orders.armedAt(id, false), restarted);
        _run(id, false);
        assertEq(orders.getOrder(id).owner, address(0));
    }

    /// A hold on a condition that reads ANOTHER pool: pushing that other pool far from Chainlink says nothing about
    /// the condition, so it cannot reset the hold (the vault checks the pools the side reads, not only its own).
    function test_aPushOfTheOtherPoolCannotResetAHold() public {
        PoolKey memory other = PoolKey(currency0, currency1, 500, 10, IHooks(hook));
        poolManager.initialize(other, Constants.SQRT_PRICE_1_1);
        _addFullRange(other);
        uint24 otherIndex = rules.registerPool(other);
        OrderState.Side memory low = _exit(OrderState.CHECK_TICK, -300);
        low.checkPool = otherIndex;
        low.holdMinutes = 30;
        uint256 id = _create(low, _off());
        // a real move: both pools fall, Chainlink follows
        _pushTo(-400);
        for (uint256 i; i < 400 && _tickOf(otherIndex) > -400; ++i) _swapIn(other, true, 0.02e18);
        _market();
        orders.poke(id, false);
        uint256 armed = orders.armedAt(id, false);
        assertGt(armed, 0);
        _swapIn(other, false, 9e18); // the other pool pushed far up, away from Chainlink
        vm.expectRevert(ConditionalOrders.NothingToPoke.selector);
        orders.poke(id, false);
        assertEq(orders.armedAt(id, false), armed);
    }

    function _tickOf(uint24 index) internal view returns (int24 t) {
        (, t,) = rules.poolState(index);
    }

    // ---------------------------------------------------------------- ladders after a gap

    /// The price jumps past several rungs of a ladder at once. Each run steps one rung and the next can run a minute
    /// later, until the next rung is below the price.
    function test_ladderCatchesUpAfterAGap() public {
        OrderState.Side memory low = _side(OrderState.CHECK_TICK, -300, OrderState.ACT_REMOVE, 2_500);
        low.repeat = true;
        low.shape = 200; // the level steps down 200 ticks after each run
        uint256 id = _create(low, _off());
        _swap(true, 5e18); // to about -880: past -300, -500 and -700
        _market();
        _settle();

        _run(id, false);
        vm.expectRevert(ConditionalOrders.TooSoon.selector);
        _run(id, false);
        uint256 runs = 1;
        for (_wait(2 minutes); rules.canExecute(orders, id, false); _wait(2 minutes)) {
            _run(id, false);
            ++runs;
        }
        (OrderState.Side memory lo,) = _state(id);
        assertGe(runs, 3);
        assertEq(lo.value, -300 - 200 * int24(int256(runs)));
        assertGe(_tick(), lo.value);
        assertLt(_tick(), lo.value + 200);
    }

    // ---------------------------------------------------------------- limit-order fills

    /// Small buckets are not filled inside swaps (swappers are not paid for it). Anyone can fill them and is paid
    /// 0.1% of what the bucket received.
    function test_fillRewardIsAShareOfTheProceeds() public {
        vm.prank(alice);
        uint256 epoch = hook.placeLimit(poolKey, 60, true, 0.0001e18); // below 0.1% of the pool's liquidity
        _swap(false, 2e18); // the price rises through the bucket
        assertGe(_tick(), 120);
        assertFalse(hook.isFilled(epoch));

        uint256 before = _bal(currency1, keeper);
        vm.prank(keeper);
        uint256 reward = hook.fillBucket(poolKey, 60, true);
        assertGt(reward, 0);
        assertEq(_bal(currency1, keeper) - before, reward);
        assertTrue(hook.isFilled(epoch));
        (, uint256 left1) = hook.claimable(epoch, alice);
        assertApproxEqAbs(reward * 999, left1, 1000); // 0.1% to the filler, 99.9% to the owner
    }
}
