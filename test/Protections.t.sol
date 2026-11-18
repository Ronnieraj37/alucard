// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/console.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IUniswapV4Router04} from "hookmate/interfaces/router/IUniswapV4Router04.sol";

import {EasyPosm} from "./utils/libraries/EasyPosm.sol";
import {RuleSetup} from "./utils/RuleSetup.sol";
import {RuleHook} from "../src/RuleHook.sol";

/// @notice Anti-dust (minimum size, per-swap cap, backlog) on the ERC20 pool.
contract AntiDustTest is RuleSetup {
    using StateLibrary for IPoolManager;
    using EasyPosm for IPositionManager;

    function _place(address who, int24 tl, uint256 amount) internal returns (uint256 id) {
        vm.prank(who);
        id = hook.placeLimit(poolKey, tl, true, amount);
    }

    function _backlogUp() internal view returns (bool on, int24 lo, int24 hi) {
        (lo, hi,,, on,) = hook.backlog(poolId);
    }

    /// 0.01% of the pool's 100e18 active liquidity is 1e16. A 1e13 token bucket is ~3.3e15 liquidity: too small.
    function test_bucketBelowMinimumIsNotFilledBySwaps() public {
        uint256 small = _place(alice, 60, 1e13);
        (uint128 smallLiq,,,,,,,,,) = hook.epochs(small);
        assertLt(uint256(smallLiq) * 10_000, uint256(poolManager.getLiquidity(poolId)) * hook.MIN_FILL_BPS());
        uint256 big = _place(bob, 120, 1e18);

        _swap(false, 5e18);
        assertGe(_tick(), 180);
        assertFalse(hook.isFilled(small), "dust bucket must not cost swappers gas");
        assertTrue(hook.isFilled(big));

        vm.prank(keeper);
        uint256 reward = hook.fillBucket(poolKey, 60, true);
        assertTrue(hook.isFilled(small));
        assertEq(reward, 0, "no reward outside native-ETH pools yet");

        uint256 before = _bal(currency1, alice);
        vm.prank(alice);
        hook.claimLimit(small, alice);
        assertGt(_bal(currency1, alice), before);
    }

    /// A small join does not make a big bucket ineligible; a cancel that leaves dust removes it from swap fills.
    function test_cancelDownToDustRemovesBucketFromSwapFills() public {
        uint256 id = _place(alice, 60, 1e18); // eligible
        _place(bob, 60, 1e13); // tiny join into the same bucket
        vm.prank(alice);
        hook.cancelLimit(id, alice); // only bob's dust is left

        _swap(false, 5e18);
        assertGe(_tick(), 120);
        assertFalse(hook.isFilled(id), "a bucket left as dust is not filled inside swaps");
    }

    /// 200 dust buckets crossed by one swap: the hook adds almost nothing. Uniswap itself still pays to cross the
    /// 200 initialized ticks, exactly as it would for 200 tiny normal LP positions (that cost exists in every v4
    /// pool, with or without this hook), so the test compares against that.
    function test_dustAttackAddsAlmostNothingFromTheHook() public {
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < 200; ++i) {
            int24 tl = int24(int256(60 * (i + 1)));
            positionManager.mint(
                poolKey, tl, tl + 60, 3e12, type(uint256).max, type(uint256).max, address(this), block.timestamp, Constants.ZERO_BYTES
            );
        }
        uint256 gPlain = _swapGas(false, 120e18);
        int24 tPlain = _tick();
        vm.revertToState(snap);

        for (uint256 i; i < 200; ++i) {
            _place(alice, int24(int256(60 * (i + 1))), 1e10);
        }
        uint256 gDust = _swapGas(false, 120e18);
        assertGe(_tick(), 60 * 201);
        assertApproxEqAbs(_tick(), tPlain, 1);
        console.log("swap gas, 200 tiny normal LP positions:", gPlain);
        console.log("swap gas, 200 dust limit buckets:", gDust);
        assertLt(gDust, gPlain + 50_000, "the hook adds almost nothing for dust buckets");
    }

    function _swapGas(bool zeroForOne, uint256 amount) internal returns (uint256 used) {
        uint256 g = gasleft();
        _swap(zeroForOne, amount);
        used = g - gasleft();
    }

    /// 60 real buckets crossed in one swap: 50 are filled, 10 wait in the backlog, the next swap fills them.
    function test_capFillsFiftyAndBacklogFinishesTheRest() public {
        uint256[60] memory ids;
        for (uint256 i; i < 60; ++i) {
            ids[i] = _place(alice, int24(int256(60 * (i + 1))), 0.1e18);
        }
        uint256 g = gasleft();
        _swap(false, 60e18);
        uint256 used = g - gasleft();
        assertGe(_tick(), 60 * 61, "all 60 buckets fully crossed");
        console.log("swap crossing 60 buckets, gas:", used);

        for (uint256 i; i < 60; ++i) {
            assertEq(hook.isFilled(ids[i]), i < 50, "lowest 50 filled, rest waiting");
        }
        (bool on, int24 lo,) = _backlogUp();
        assertTrue(on);
        assertEq(lo, 60 * 50, "backlog starts after the last filled bucket");

        _swap(false, 0.01e18); // any later swap finishes the backlog first
        for (uint256 i; i < 60; ++i) {
            assertTrue(hook.isFilled(ids[i]));
        }
        (on,,) = _backlogUp();
        assertFalse(on, "backlog cleared");
    }

    /// Backlog buckets can also be filled by anyone with fillBucket.
    function test_backlogBucketFillableByAnyone() public {
        uint256[55] memory ids;
        for (uint256 i; i < 55; ++i) {
            ids[i] = _place(alice, int24(int256(60 * (i + 1))), 0.1e18);
        }
        _swap(false, 60e18);
        assertFalse(hook.isFilled(ids[54]));
        vm.prank(keeper);
        hook.fillBucket(poolKey, 60 * 55, true);
        assertTrue(hook.isFilled(ids[54]));

        _swap(false, 0.01e18); // the rest of the backlog; the already-filled one is skipped
        for (uint256 i; i < 55; ++i) {
            assertTrue(hook.isFilled(ids[i]));
        }
    }

    /// If the price comes back before the backlog is filled, buckets no longer fully crossed become live orders
    /// again (nothing lost); they fill the next time the price crosses them.
    function test_priceReturnsBeforeBacklog_bucketsStayLive() public {
        uint256[60] memory ids;
        for (uint256 i; i < 60; ++i) {
            ids[i] = _place(alice, int24(int256(60 * (i + 1))), 0.1e18);
        }
        _swap(false, 60e18);
        _swap(true, 3e18); // back down a little
        int24 t = _tick();
        for (uint256 i; i < 60; ++i) {
            int24 tl = int24(int256(60 * (i + 1)));
            if (tl + 60 <= t) assertTrue(hook.isFilled(ids[i]), "still fully crossed: filled");
        }
        (bool on,,) = _backlogUp();
        assertFalse(on);

        _swap(false, 20e18); // up again past everything
        for (uint256 i; i < 60; ++i) {
            assertTrue(hook.isFilled(ids[i]));
        }
        // and every user payout still adds up
        for (uint256 i; i < 60; ++i) {
            vm.prank(alice);
            hook.claimLimit(ids[i], alice);
        }
        assertLt(poolManager.balanceOf(address(hook), currency0.toId()), 100);
        assertLt(poolManager.balanceOf(address(hook), currency1.toId()), 100);
    }

    function test_claimToAnotherAddress() public {
        uint256 id = _place(alice, 60, 1e18);
        _swap(false, 5e18);
        uint256 before = _bal(currency1, bob);
        vm.prank(alice);
        (, uint256 got1) = hook.claimLimit(id, bob);
        assertEq(_bal(currency1, bob) - before, got1);
    }
}
