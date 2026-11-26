// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";

import {RuleSetup} from "./utils/RuleSetup.sol";

/// @notice The hook's average price: what every rule reads instead of the price of the moment.
contract OracleTest is RuleSetup {
    using PoolIdLibrary for PoolKey;

    function _count(PoolId id) internal view returns (uint8 count) {
        (,,, count) = hook.oracles(id);
    }

    function test_averageIsThePriceThatHeld() public view {
        (bool ok, int24 avg) = hook.averageTick(poolId, 120);
        assertTrue(ok);
        assertEq(avg, 0);
        assertEq(_tick(), 0);
    }

    /// A swap moves the price of the moment at once; the average does not move in that block at all.
    function test_aPriceInTheCurrentBlockCountsForZero() public {
        _swap(true, 5e18);
        assertLt(_tick(), -800);
        assertEq(_avg(), 0);
    }

    /// Held into the next block (1 s on Unichain), a pushed price is 1 s of a window of at least 120 s.
    function test_aPriceHeldOneBlockBarelyMovesTheAverage() public {
        _swap(true, 5e18);
        int24 pushed = _tick();
        _wait(1);
        int24 avg = _avg();
        assertLt(avg, 0);
        assertGt(avg, pushed / 100);
    }

    function test_averageFollowsAPriceThatStays() public {
        _swap(true, 5e18);
        int24 spot = _tick();
        _settle();
        assertApproxEqAbs(_avg(), spot, 1);
    }

    /// A new pool has no average until a window has passed.
    function test_noAverageUntilTheWindowHasPassed() public {
        (currency0, currency1) = deployCurrencyPair();
        PoolKey memory key = _newPool(currency0, currency1, Constants.SQRT_PRICE_1_1);
        (bool ok,) = hook.averageTick(key.toId(), 120);
        assertFalse(ok);
        _wait(120);
        (ok,) = hook.averageTick(key.toId(), 120);
        assertTrue(ok);
    }

    /// Snapshots are written at most once a minute, whatever the number of swaps.
    function test_atMostOneSnapshotAMinute() public {
        uint8 before = _count(poolId);
        for (uint256 i; i < 30; ++i) {
            _swap(i % 2 == 0, 0.1e18);
            _wait(10);
        }
        // 300 s of swaps every 10 s: 5 snapshots
        assertEq(_count(poolId) - before, 5);
    }

    /// The ring keeps 64 snapshots: over an hour of history once it is full.
    function test_theRingKeepsAnHour() public {
        for (uint256 i; i < 70; ++i) {
            _swap(i % 2 == 0, 0.1e18);
            _wait(61);
        }
        assertEq(_count(poolId), 64);
        (bool ok,) = hook.averageTick(poolId, 3600);
        assertTrue(ok);
        (ok,) = hook.averageTick(poolId, 2 hours);
        assertFalse(ok);
    }

    /// The average over a window is the time-weighted mean of the prices in it.
    function test_averageIsTimeWeighted() public {
        _swap(true, 5e18);
        int24 low = _tick();
        _settle(); // the low price has held for a while
        _swap(false, 5e18); // back near 0
        int24 high = _tick();
        _wait(61);
        _swap(true, 1);
        _wait(60);
        // a 240 s window starts at the snapshot _settle wrote: 121 s at `low`, then 121 s at `high`
        (bool ok, int24 avg) = hook.averageTick(poolId, 240);
        assertTrue(ok);
        assertApproxEqAbs(int256(avg), (int256(low) + int256(high)) / 2, 2);
    }

    /// Pools registered for their price (no hook) have no average; rules cannot read them.
    function test_hooklessPoolHasNoAverage() public {
        PoolKey memory bare = PoolKey(currency0, currency1, 500, 10, IHooks(address(0)));
        poolManager.initialize(bare, Constants.SQRT_PRICE_1_1);
        hook.registerPool(bare);
        _wait(1 hours);
        (bool ok,) = hook.averageTick(bare.toId(), 120);
        assertFalse(ok);
    }
}
