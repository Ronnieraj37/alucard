// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {RuleSetup} from "./utils/RuleSetup.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {OrderState} from "../src/libraries/OrderState.sol";

/// @notice The attacks the review found, each as a test the attacker must lose. Calls in the same test step run at
/// the same timestamp, like calls in one transaction or one block.
contract ManipulationTest is RuleSetup {
    /// A stop below the range (exit and sell token0), as a victim would set it.
    function _stop() internal returns (uint256) {
        OrderState.Side memory low = _exit(OrderState.CHECK_EDGE, 0);
        low.actions |= OrderState.ACT_SWAP;
        low.swapToToken1 = true;
        return _create(low, _off());
    }

    // ---------------------------------------------------------------- forcing a trigger

    /// Push the price through the stop and execute in the same block (then swap back): the average has not moved.
    function test_pushAndExecuteInOneBlockDoesNotFire() public {
        uint256 id = _stop();
        _wait(2 minutes);
        _swap(true, 5e18);
        assertLt(_tick(), -600); // the price of the moment is past the stop
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, false);
    }

    /// Push at the end of one block and execute first thing in the next: one block of a two-minute average.
    function test_pushHeldIntoTheNextBlockDoesNotFire() public {
        uint256 id = _stop();
        _wait(2 minutes);
        _swap(true, 5e18);
        _wait(1);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, false);
    }

    /// A real move, held for the window, fires.
    function test_aMoveThatHoldsFires() public {
        uint256 id = _stop();
        _swap(true, 5e18);
        _settle();
        _run(id, false);
        assertEq(orders.getOrder(id).owner, address(0)); // closed
    }

    // ---------------------------------------------------------------- holds ("time skip")

    /// The old hold checked the price twice (when armed, and when it ran), so two short pushes N minutes apart
    /// fired it. Now a hold is the average over the whole time: two short pushes barely move it.
    function test_holdCannotBeSkippedWithTwoShortPushes() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_EDGE, 0);
        low.holdMinutes = 30;
        uint256 id = _create(low, _off());

        _wait(31 minutes);
        _swap(true, 5e18); // push 1
        _wait(61);
        _swap(false, 5.2e18); // back in range
        _wait(29 minutes);
        _swap(true, 5.2e18); // push 2
        _wait(61);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, false);
    }

    function test_holdFiresWhenThePriceStaysOutForTheWholeTime() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_EDGE, 0);
        low.holdMinutes = 30;
        uint256 id = _create(low, _off());

        _swap(true, 5e18);
        _wait(10 minutes);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, false); // not yet: most of the 30 minutes was in range

        _wait(25 minutes);
        _swap(true, 1); // any swap keeps the history going
        _wait(2 minutes);
        _run(id, false);
        assertEq(orders.getOrder(id).owner, address(0));
    }

    // ---------------------------------------------------------------- trailing stops

    /// Push the price up and poke in the same block, to set a high "best" the stop then trails from: the poke reads
    /// the average, which has not moved.
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

    /// The swap of a run that fires on time (no price level) used to be limited around the price of the moment, so
    /// a front-run set its own limit. Now the limit is maxSlippage past the average: pushing the price further only
    /// makes the run skip the swap.
    function test_frontRunCannotMoveTheSwapLimit() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_TIME, 1);
        low.actions |= OrderState.ACT_SWAP;
        low.swapToToken1 = true;
        uint256 id = _create(low, _off());
        _wait(2 minutes);

        _swap(true, 5e18); // front-run: far below the average (0), past the 5% limit (-500)
        uint256 before0 = _bal(currency0, alice);
        uint256 before1 = _bal(currency1, alice);
        _run(id, false);
        // the swap was skipped: alice got her token0 back unsold instead of selling it at the pushed price
        assertGt(_bal(currency0, alice) - before0, 4e17);
        assertLt(_bal(currency1, alice) - before1, 6e17); // only her token1 side
    }

    function test_swapNeverFillsPastTheLimit() public {
        OrderState.Side memory low = _exit(OrderState.CHECK_TIME, 1);
        low.actions |= OrderState.ACT_SWAP;
        low.swapToToken1 = true;
        uint256 id = _create(low, _off());
        _wait(2 minutes);

        _swap(true, 1e18); // front-run: down, but not past the limit
        _run(id, false);
        assertGe(_tick(), -500 - 1); // the order's own swap stopped at the limit
    }

    // ---------------------------------------------------------------- batches

    /// The old same-transaction guard let only one swapping order per pool run in a batch. Now they all run.
    function test_batchRunsEveryOrderThatSwapsInOnePool() public {
        uint256 a = _stop();
        uint256 b = _stop();
        _swap(true, 5e18);
        _settle();
        uint256[] memory ids = new uint256[](2);
        bool[] memory uppers = new bool[](2);
        (ids[0], ids[1]) = (a, b);
        vm.prank(keeper);
        assertEq(orders.executeMany(ids, uppers), 2);
    }

    /// At any gas limit a batch either runs every order that can run, or reverts. It never skips one for lack of gas
    /// (a gas estimate would settle on that too-small limit, and the real transaction would then fail or skip).
    function test_batchNeverSkipsAnOrderForLackOfGas() public {
        uint256 a = _stop();
        uint256 b = _stop();
        _swap(true, 5e18);
        _settle();
        uint256[] memory ids = new uint256[](2);
        bool[] memory uppers = new bool[](2);
        (ids[0], ids[1]) = (a, b);
        for (uint256 g = 100_000; g <= 2_000_000; g += 20_000) {
            uint256 snap = vm.snapshotState();
            vm.prank(keeper);
            try orders.executeMany{gas: g}(ids, uppers) returns (uint256 ran) {
                assertEq(ran, 2, "skipped an order for lack of gas");
            } catch {}
            vm.revertToState(snap);
        }
    }

    // ---------------------------------------------------------------- ladders after a gap

    /// The price jumps past several rungs of a ladder at once. The old contract refused any run that left the
    /// condition true, so the ladder froze. Now each run steps one rung and the next can run a minute later.
    function test_ladderCatchesUpAfterAGap() public {
        OrderState.Side memory low = _side(OrderState.CHECK_TICK, -300, OrderState.ACT_REMOVE, 2_500);
        low.repeat = true;
        low.shape = 200; // the level steps down 200 ticks after each run
        uint256 id = _create(low, _off());
        _swap(true, 5e18); // to about -880: past -300, -500 and -700
        _settle();

        _run(id, false);
        vm.expectRevert(ConditionalOrders.TooSoon.selector);
        _run(id, false);
        uint256 runs = 1;
        for (_wait(2 minutes); rules.canExecute(orders, id, false); _wait(2 minutes)) {
            _run(id, false);
            ++runs;
        }
        // never stuck: it ran every rung the price is past, and the next rung is below the price
        (OrderState.Side memory lo,) = _state(id);
        assertGe(runs, 3);
        assertEq(lo.value, -300 - 200 * int24(int256(runs)));
        assertGe(_avg(), lo.value);
        assertLt(_avg(), lo.value + 200);
    }

    // ---------------------------------------------------------------- limit-order fills

    /// Small buckets are not filled inside swaps (swappers are not paid for it). Anyone can fill them and is paid
    /// from the bucket in the token it received, priced by Chainlink: here a pool with no ETH in it.
    /// (Foundry's isolate mode runs calls at gas price 0, so this pay test runs as one transaction.)
    /// forge-config: default.isolate = false
    function test_fillRewardPaidInTheBucketsToken() public {
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
    }
}
