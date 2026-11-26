// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";

import {RuleSetup} from "./utils/RuleSetup.sol";
import {RuleHook} from "../src/RuleHook.sol";

/// @notice Limit orders and the pool table, from the user's side: a limit order is only ever theirs, it is either
/// waiting (and can be taken back) or filled (and can be claimed), never both, and nonsense is refused.
contract LimitSafetyTest is RuleSetup {
    function _place(address who, int24 tickLower, bool sellToken0, uint256 amount) internal returns (uint256 id) {
        vm.prank(who);
        id = hook.placeLimit(poolKey, tickLower, sellToken0, amount);
    }

    // ---------------------------------------------------------------- waiting or filled, never both

    function test_aWaitingOrderCannotBeClaimedAndAFilledOneCannotBeTakenBack() public {
        uint256 id = _place(alice, 60, true, 1e18);
        vm.prank(alice);
        vm.expectRevert(RuleHook.NotFilled.selector);
        hook.claimLimit(id, alice);
        (uint256 c0, uint256 c1) = hook.claimable(id, alice);
        assertEq(c0 + c1, 0);

        _swap(false, 5e18); // through the bucket
        assertTrue(hook.isFilled(id));
        vm.prank(alice);
        vm.expectRevert(RuleHook.AlreadyFilled.selector);
        hook.cancelLimit(id, alice);
        (, c1) = hook.claimable(id, alice);
        assertGt(c1, 1e18);
    }

    /// Taking back an order the price never reached returns what was put in (to rounding).
    function test_takingBackAnUntouchedOrderReturnsIt() public {
        uint256 before = _bal(currency0, alice);
        uint256 id = _place(alice, 600, true, 1e18);
        vm.prank(alice);
        hook.cancelLimit(id, alice);
        assertApproxEqAbs(_bal(currency0, alice), before, 2);
        assertEq(hook.openEpoch(poolId, 600, true), 0); // the empty bucket is gone
    }

    function test_nobodyElseCanTakeOrClaimYourOrder() public {
        uint256 id = _place(alice, 60, true, 1e18);
        vm.prank(bob);
        vm.expectRevert(RuleHook.NothingToClaim.selector);
        hook.cancelLimit(id, bob);
        _swap(false, 5e18);
        vm.prank(bob);
        vm.expectRevert(RuleHook.NothingToClaim.selector);
        hook.claimLimit(id, bob);
    }

    /// Several buckets above the price, one big swap up: every one the price fully crossed is filled, the one it
    /// did not reach is still waiting.
    function test_oneSwapFillsEveryBucketItCrosses() public {
        uint256 a = _place(alice, 60, true, 0.5e18);
        uint256 b = _place(bob, 120, true, 0.5e18);
        uint256 c = _place(alice, 180, true, 0.5e18);
        uint256 far = _place(bob, 6000, true, 0.5e18);
        _swap(false, 10e18);
        assertGe(_tick(), 240);
        assertTrue(hook.isFilled(a));
        assertTrue(hook.isFilled(b));
        assertTrue(hook.isFilled(c));
        assertFalse(hook.isFilled(far));
    }

    // ---------------------------------------------------------------- refused

    function test_unknownOrdersAreRefused() public {
        vm.expectRevert(RuleHook.UnknownEpoch.selector);
        hook.cancelLimit(999, alice);
        vm.expectRevert(RuleHook.UnknownEpoch.selector);
        hook.fillBucket(poolKey, 600, true); // no bucket there
    }

    function test_aBucketIsFilledByHandOnlyOnceCrossed() public {
        _place(alice, 600, true, 1e18);
        vm.expectRevert(RuleHook.NotCrossed.selector);
        hook.fillBucket(poolKey, 600, true);
    }

    function test_limitOrdersOnlyInThisHooksPools() public {
        PoolKey memory plain = PoolKey(currency0, currency1, 500, 10, IHooks(address(0)));
        vm.prank(alice);
        vm.expectRevert(RuleHook.PoolNotAllowed.selector);
        hook.placeLimit(plain, 60, true, 1e18);
        vm.expectRevert(RuleHook.PoolNotAllowed.selector);
        hook.fillBucket(plain, 60, true);

        PoolKey memory notMade = PoolKey(currency0, currency1, 500, 10, IHooks(hook)); // never initialized
        vm.prank(alice);
        vm.expectRevert(RuleHook.UnknownPool.selector);
        hook.placeLimit(notMade, 60, true, 1e18);
    }

    function test_nothingToSellIsRefused() public {
        vm.prank(alice);
        vm.expectRevert(RuleHook.ZeroLiquidity.selector);
        hook.placeLimit(poolKey, 60, true, 0);
    }

    function test_ethWithATokenOrderIsRefused() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(RuleHook.BadMsgValue.selector);
        hook.placeLimit{value: 1 ether}(poolKey, 60, true, 1e18);
    }

    // ---------------------------------------------------------------- the pool table

    /// Outside pools (to watch or park in) can be added by anyone, but only hookless ones or this hook's, only
    /// once they exist, and each gets one number for good.
    function test_registeringOutsidePools() public {
        PoolKey memory plain = PoolKey(currency0, currency1, 500, 10, IHooks(address(0)));
        vm.expectRevert(RuleHook.UnknownPool.selector);
        hook.registerPool(plain); // not initialized yet
        poolManager.initialize(plain, Constants.SQRT_PRICE_1_1);
        uint24 index = hook.registerPool(plain);
        assertGt(index, 0);
        assertEq(hook.registerPool(plain), index); // again: same number

        PoolKey memory other = PoolKey(currency0, currency1, 500, 10, IHooks(address(0xBEEF)));
        vm.expectRevert(RuleHook.PoolNotAllowed.selector);
        hook.registerPool(other);
    }

    /// A window of zero is read as one second, not a division by zero.
    function test_averageOverZeroSecondsIsThePrice() public view {
        (bool ok, int24 t) = hook.averageTick(poolId, 0);
        assertTrue(ok);
        assertEq(t, _tick());
    }
}
