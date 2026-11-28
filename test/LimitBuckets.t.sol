// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {RuleSetup} from "./utils/RuleSetup.sol";
import {RuleHook} from "../src/RuleHook.sol";

/// @notice Limit-order buckets under random use by several owners (an external review's "experiment 2"): orders join and
/// leave a bucket, the price wanders into it and back (a partial fill that reverses, earning fees), buckets fill, the
/// same tick opens a new bucket, owners claim. After every step, everything the hook owes (all claimable shares of
/// filled buckets) is covered by what it holds; a share pays once; a filled bucket cannot be cancelled; at the end only
/// rounding dust is left. And an owner who joins later never gets fees earned before they joined.
contract LimitBucketsTest is RuleSetup {
    using StateLibrary for IPoolManager;

    int24 constant T = 60; // one bucket tick: sells token0 as the price rises through [60, 120]

    address carol = makeAddr("carol");
    address[3] users;
    uint256[] epochsSeen;

    function setUp() public override {
        super.setUp();
        _fund(carol);
        users = [alice, bob, carol];
    }

    function _open() internal view returns (uint256) {
        return hook.openEpoch(poolId, T, true);
    }

    function _seen(uint256 e) internal {
        for (uint256 i; i < epochsSeen.length; ++i) if (epochsSeen[i] == e) return;
        epochsSeen.push(e);
    }

    /// Everything claimable from filled buckets is covered by the hook's claims in the PoolManager.
    function _assertCovered() internal view {
        uint256 owed0;
        uint256 owed1;
        for (uint256 i; i < epochsSeen.length; ++i) {
            for (uint256 u; u < 3; ++u) {
                (uint256 a0, uint256 a1) = hook.claimable(epochsSeen[i], users[u]);
                owed0 += a0;
                owed1 += a1;
            }
        }
        assertLe(owed0, poolManager.balanceOf(address(hook), currency0.toId()), "owes more token0 than it holds");
        assertLe(owed1, poolManager.balanceOf(address(hook), currency1.toId()), "owes more token1 than it holds");
    }

    /// Move the price fully past the bucket, or back below it.
    function _above() internal {
        for (uint256 i; i < 200 && _tick() < T + 120; ++i) _swap(false, 1e18);
    }

    function _below() internal {
        for (uint256 i; i < 200 && _tick() >= 0; ++i) _swap(true, 1e18);
    }

    /// A bucket below 0.1% of the pool's liquidity is not filled inside swaps; anyone fills it once crossed.
    function _fillIfSmall(uint256 e) internal {
        if (e == 0 || hook.isFilled(e)) return;
        vm.prank(keeper);
        hook.fillBucket(poolKey, T, true);
    }

    function testFuzz_bucketsStayFullyBacked(uint256 seed) public {
        for (uint256 step; step < 28; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 op = seed % 6;
            address who = users[(seed >> 8) % 3];
            uint256 amt = bound(seed >> 16, 1e16, 20e18);
            uint256 open = _open();

            if (op <= 1) {
                // join the open bucket (or open a new one), if the price is below it
                if (_tick() < T) {
                    vm.prank(who);
                    _seen(hook.placeLimit(poolKey, T, true, amt));
                }
            } else if (op == 2) {
                // leave it, if this owner is in it
                (uint128 liq,,) = hook.shares(open, who);
                if (open != 0 && liq > 0) {
                    vm.prank(who);
                    hook.cancelLimit(open, who);
                }
            } else if (op == 3) {
                // the price wanders into the bucket and back out: part sells, then buys back, earning fees
                uint256 w = bound(seed >> 32, 0.05e18, 0.6e18);
                _swap(false, w);
                if (_tick() >= T) _swap(true, w + 0.2e18);
            } else if (op == 4) {
                // a real cross: the bucket fills; then the price comes back so the tick can be used again
                _above();
                _fillIfSmall(open);
                if (open != 0) assertTrue(hook.isFilled(open));
                _below();
            } else {
                // claim a filled bucket; a second claim of the same share pays nothing
                for (uint256 i; i < epochsSeen.length; ++i) {
                    uint256 e = epochsSeen[i];
                    (uint128 liq,,) = hook.shares(e, who);
                    if (!hook.isFilled(e) || liq == 0) continue;
                    vm.prank(who);
                    hook.claimLimit(e, who);
                    vm.prank(who);
                    vm.expectRevert(RuleHook.NothingToClaim.selector);
                    hook.claimLimit(e, who);
                    vm.prank(who);
                    vm.expectRevert(RuleHook.AlreadyFilled.selector);
                    hook.cancelLimit(e, who);
                    break;
                }
            }
            _assertCovered();
        }

        // close everything: fill the open bucket, everyone claims everything
        uint256 last = _open();
        _above();
        _fillIfSmall(last);
        for (uint256 i; i < epochsSeen.length; ++i) {
            for (uint256 u; u < 3; ++u) {
                (uint128 liq,,) = hook.shares(epochsSeen[i], users[u]);
                if (liq == 0 || !hook.isFilled(epochsSeen[i])) continue;
                vm.prank(users[u]);
                hook.claimLimit(epochsSeen[i], users[u]);
            }
        }
        assertLt(poolManager.balanceOf(address(hook), currency0.toId()), 10 * epochsSeen.length + 10, "token0 left");
        assertLt(poolManager.balanceOf(address(hook), currency1.toId()), 10 * epochsSeen.length + 10, "token1 left");
    }

    /// Alice is in the bucket while the price wanders through it (earning fees); Bob joins after with the same amount.
    /// Both get the same share of the fill, and only Alice gets the earlier fees.
    function test_aLateJoinerGetsNoEarlierFees() public {
        vm.prank(alice);
        uint256 e = hook.placeLimit(poolKey, T, true, 5e18);
        for (uint256 i; i < 4; ++i) {
            _swap(false, 0.4e18);
            _swap(true, 0.6e18);
        }
        assertLt(_tick(), T);
        vm.prank(bob);
        hook.placeLimit(poolKey, T, true, 5e18);
        _swap(false, 40e18);
        assertTrue(hook.isFilled(e));
        (uint256 a0, uint256 a1) = hook.claimable(e, alice);
        (uint256 b0, uint256 b1) = hook.claimable(e, bob);
        assertGe(a0, b0);
        assertGt(a1, b1); // the wanders paid fees in token1 (price rising) and token0 (falling): Alice's alone
        assertApproxEqRel(b1, a1, 0.05e18); // the fill itself is shared evenly
    }
}
