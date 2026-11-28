// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RuleSetup} from "./utils/RuleSetup.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {OrderState} from "../src/libraries/OrderState.sol";

/// @notice The exact edges an owner relies on: the expiry second, and the keeper's fee never above what the owner set.
contract BoundariesTest is RuleSetup {
    /// Up to and including the expiry second the order runs and only the owner can close it; one second later it
    /// can no longer run, and anyone can close it (the tokens still go to the owner).
    function test_theExpirySecond() public {
        ConditionalOrders.CreateParams memory p = _params(_exit(OrderState.CHECK_TIME, 1), _off());
        uint256 id = _submit(alice, p);
        vm.warp(p.expiry);
        vm.prank(bob);
        vm.expectRevert(ConditionalOrders.NotOwner.selector);
        orders.cancel(id);
        uint256 snap = vm.snapshotState();
        _run(id, false); // at the expiry second it still runs
        vm.revertToState(snap);
        vm.warp(uint256(p.expiry) + 1);
        vm.expectRevert(ConditionalOrders.Expired.selector);
        _run(id, false);
        vm.expectRevert(ConditionalOrders.Expired.selector);
        orders.poke(id, false);
        uint256 before = _bal(currency0, alice);
        vm.prank(bob);
        orders.cancel(id);
        assertGt(_bal(currency0, alice), before);
        assertEq(_bal(currency0, bob), 1_000e18); // bob got nothing
    }

    /// Any fee from 0 to the 1% cap, any size, with or without a swap: the keeper never gets more than the owner's
    /// fee of what the step moved (each token rounded down), and the owner gets the rest.
    function testFuzz_theKeeperNeverGetsMoreThanTheOwnersFee(uint8 feeBps, uint128 liquidity, bool swap) public {
        uint256 fee = bound(feeBps, 0, 100);
        ConditionalOrders.CreateParams memory p;
        {
            OrderState.Side memory low = _exit(OrderState.CHECK_TIME, 1);
            if (swap) {
                low.actions |= OrderState.ACT_SWAP;
                low.swapToToken1 = true;
            }
            p = _params(low, _off());
        }
        p.keeperFeeBps = uint8(fee);
        p.liquidity = uint128(bound(liquidity, 1e12, 20e18));
        p.maxSlippage = 255; // the sale's own impact is not what this test is about
        uint256 id = _submit(alice, p);
        _wait(2 minutes);
        uint256[2] memory k = [_bal(currency0, keeper), _bal(currency1, keeper)];
        uint256[2] memory o = [_bal(currency0, alice), _bal(currency1, alice)];
        _run(id, false);
        uint256 k0 = _bal(currency0, keeper) - k[0];
        uint256 k1 = _bal(currency1, keeper) - k[1];
        uint256 o0 = _bal(currency0, alice) - o[0];
        uint256 o1 = _bal(currency1, alice) - o[1];
        // the keeper's share of each token is at most fee / 10,000 of what that token's total payout was
        assertLe(k0 * 10_000, (k0 + o0) * fee, "token0 fee above the owner's");
        assertLe(k1 * 10_000, (k1 + o1) * fee, "token1 fee above the owner's");
        if (fee == 0) assertEq(k0 + k1, 0);
    }
}
