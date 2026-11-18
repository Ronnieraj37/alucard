// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/console.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";

import {EasyPosm} from "./utils/libraries/EasyPosm.sol";
import {RuleSetup} from "./utils/RuleSetup.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {OrderState} from "../src/libraries/OrderState.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @dev Load tests: many limit orders, many rule orders, big price moves. Run with -vv to see the numbers.
contract StressTest is RuleSetup {
    using EasyPosm for IPositionManager;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function _swapKey(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal returns (uint256 used) {
        uint256 g = gasleft();
        swapRouter.swapExactTokensForTokens({
            amountIn: amountIn,
            amountOutMin: 0,
            zeroForOne: zeroForOne,
            poolKey: key,
            hookData: Constants.ZERO_BYTES,
            receiver: address(this),
            deadline: block.timestamp + 1
        });
        used = g - gasleft();
    }

    function _tickOf(PoolKey memory key) internal view returns (int24 t) {
        (, t,,) = poolManager.getSlot0(key.toId());
    }

    // ------------------------------------------------------------ limit orders

    /// Swap gas when one swap crosses many limit buckets (cap is 50 fills per swap).
    function test_stress_manyBuckets() public {
        uint256[5] memory ns = [uint256(0), 10, 50, 100, 200];
        for (uint256 k; k < ns.length; ++k) {
            uint256 snap = vm.snapshotState();
            for (uint256 i; i < ns[k]; ++i) {
                vm.prank(alice);
                hook.placeLimit(poolKey, int24(int256(60 * (i + 1))), true, 0.5e18);
            }
            uint256 used = _swapKey(poolKey, false, 60e18);
            (bool up,,,,) = _backlog();
            console.log("buckets", ns[k]);
            console.log("  swap gas", used, "tick after", uint256(int256(_tick())));
            console.log("  backlog left", up ? 1 : 0);
            // the next ordinary swaps pay for the backlog
            uint256 next = _swapKey(poolKey, false, 0.01e18);
            console.log("  next small swap gas", next);
            vm.revertToState(snap);
        }
    }

    function _backlog() internal view returns (bool up, bool down, int24 upLo, int24 upHi, int24 unused) {
        int24 dl;
        int24 dh;
        (upLo, upHi, dl, dh, up, down) = hook.backlog(poolId);
        unused = dl;
    }

    /// Swap gas with NO limit orders at all, in a tick-spacing-1 pool, for growing price moves.
    /// The hook walks the bucket bitmap over every tick the price crossed, even when it is empty.
    function test_stress_emptyWalkSpacing1() public {
        PoolKey memory k1 = PoolKey(currency0, currency1, 100, 1, IHooks(hook));
        poolManager.initialize(k1, Constants.SQRT_PRICE_1_1);
        positionManager.mint(
            k1, TickMath.minUsableTick(1), TickMath.maxUsableTick(1), 100e18, type(uint256).max,
            type(uint256).max, address(this), block.timestamp, Constants.ZERO_BYTES
        );
        // the same pool without the hook, for comparison
        PoolKey memory k0 = PoolKey(currency0, currency1, 100, 1, IHooks(address(0)));
        poolManager.initialize(k0, Constants.SQRT_PRICE_1_1);
        positionManager.mint(
            k0, TickMath.minUsableTick(1), TickMath.maxUsableTick(1), 100e18, type(uint256).max,
            type(uint256).max, address(this), block.timestamp, Constants.ZERO_BYTES
        );

        uint256[4] memory amts = [uint256(1e18), 20e18, 200e18, 5000e18];
        for (uint256 i; i < amts.length; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 withHook = _swapKey(k1, false, amts[i]);
            uint256 noHook = _swapKey(k0, false, amts[i]);
            console.log("amount in (e18)", amts[i] / 1e18);
            console.log("  ticks moved", uint256(int256(_tickOf(k1))));
            console.log("  gas with hook", withHook, "without hook", noHook);
            vm.revertToState(snap);
        }
    }

    // ------------------------------------------------------------ rule orders

    function _stopLoss(int24 lo, int24 hi, uint8 slip) internal view returns (ConditionalOrders.CreateParams memory p) {
        OrderState.Side memory low;
        low.checker = OrderState.CHECK_EDGE;
        low.actions = OrderState.ACT_KEEP_FEES | OrderState.ACT_REMOVE | OrderState.ACT_SWAP;
        low.removeBps = 10_000;
        low.swapToToken1 = true;
        OrderState.Side memory off;
        p = ConditionalOrders.CreateParams({
            key: poolKey,
            tickLower: lo,
            tickUpper: hi,
            liquidity: 5e18,
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max,
            swapPoolIndex: 0,
            expiry: uint32(block.timestamp + 30 days),
            maxKeeperFeeBps: 10,
            maxSlippage: slip,
            lower: low,
            upper: off
        });
    }

    /// 60 stop-loss orders on the same range all trigger together. Each exit sells into the pool and pushes the price
    /// further down. How many convert, at what price, and does the per-execute gas grow with the number of orders?
    function test_stress_stopLossCascade() public {
        uint256 n = 60;
        uint256[] memory ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            address u = address(uint160(0x1000 + i));
            _fund(u);
            vm.prank(u);
            ids[i] = orders.createOrder(_stopLoss(-600, 600, 50)); // 500-tick slippage limit
        }
        while (_tick() > -620) _swap(true, 2e18); // push below -600
        console.log("tick after trigger swap", uint256(-int256(_tick())), "(negative)");

        uint256 swapped;
        uint256 skipped;
        uint256 firstGas;
        uint256 lastGas;
        for (uint256 i; i < n; ++i) {
            address u = address(uint160(0x1000 + i));
            uint256 b1 = _bal(currency1, u);
            uint256 b0 = _bal(currency0, u);
            vm.roll(block.number + 1);
            vm.prank(keeper);
            uint256 g = gasleft();
            orders.execute(ids[i], false);
            uint256 used = g - gasleft();
            if (i == 0) firstGas = used;
            lastGas = used;
            bool gotOnly1 = _bal(currency0, u) == b0 && _bal(currency1, u) > b1;
            if (gotOnly1) ++swapped;
            else ++skipped;
        }
        console.log("orders", n);
        console.log("  fully converted", swapped, "left partly unconverted", skipped);
        console.log("  execute gas first / last", firstGas, lastGas);
        console.log("  tick after all exits (negative)", uint256(-int256(_tick())));
    }

    /// Keeper pay in an ERC20 pool (prints 0 here: Foundry's isolate mode runs calls at gas price 0; Feeds.t.sol
    /// checks the amounts).
    function test_stress_keeperPayErc20() public {
        ConditionalOrders.CreateParams memory p = _stopLoss(-600, 600, 100);
        p.liquidity = 50e18;
        p.maxKeeperFeeBps = 50; // 0.5%
        vm.prank(alice);
        uint256 id = orders.createOrder(p);
        _swap(true, 9e18);
        uint256 k0 = _bal(currency0, keeper);
        uint256 k1 = _bal(currency1, keeper);
        vm.prank(keeper);
        uint256 g = gasleft();
        orders.execute(id, false);
        uint256 used = g - gasleft();
        console.log("execute gas", used);
        console.log("keeper got token0", _bal(currency0, keeper) - k0);
        console.log("keeper got token1", _bal(currency1, keeper) - k1);
    }

    /// Collect-only / compound runs remove nothing, so the keeper's reserve is a share of the fees only.
    function test_stress_compoundKeeperPay() public {
        OrderState.Side memory up;
        up.checker = OrderState.CHECK_TIME;
        up.value = 1; // 1 minute
        up.actions = OrderState.ACT_KEEP_FEES | OrderState.ACT_ADD;
        up.repeat = true;
        OrderState.Side memory off;
        ConditionalOrders.CreateParams memory p = ConditionalOrders.CreateParams({
            key: poolKey,
            tickLower: -600,
            tickUpper: 600,
            liquidity: 50e18,
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max,
            swapPoolIndex: 0,
            expiry: uint32(block.timestamp + 30 days),
            maxKeeperFeeBps: 100,
            maxSlippage: 100,
            lower: off,
            upper: up
        });
        vm.prank(alice);
        uint256 id = orders.createOrder(p);
        for (uint256 i; i < 10; ++i) {
            _swap(i % 2 == 0, 2e18);
        }
        vm.warp(block.timestamp + 2 hours);
        uint256 k0 = _bal(currency0, keeper);
        uint256 k1 = _bal(currency1, keeper);
        vm.prank(keeper);
        uint256 g = gasleft();
        try orders.execute(id, true) {
            console.log("compound execute gas", g - gasleft());
            console.log("keeper got token0", _bal(currency0, keeper) - k0);
            console.log("keeper got token1", _bal(currency1, keeper) - k1);
        } catch (bytes memory err) {
            console.log("compound execute reverted");
            console.logBytes(err);
        }
    }

    /// The owner's order list only grows; the app reads it in one call.
    function test_stress_ordersOfGrowth() public {
        for (uint256 i; i < 300; ++i) {
            vm.prank(alice);
            orders.createOrder(_stopLoss(-600, 600, 50));
        }
        uint256 g = gasleft();
        uint256 len = orders.ordersOf(alice).length;
        console.log("ordersOf length", len, "gas", g - gasleft());
    }

    // ------------------------------------------------------------ batches, Chainlink prices

    function _rule(uint8 checker, int24 value, uint8 actions, uint16 bps) internal pure returns (OrderState.Side memory d) {
        d.checker = checker;
        d.value = value;
        d.actions = actions;
        d.removeBps = bps;
    }

    function _open(address who, int24 lo, int24 hi, uint128 liq, OrderState.Side memory lower, OrderState.Side memory upper)
        internal
        returns (uint256 id)
    {
        ConditionalOrders.CreateParams memory p = ConditionalOrders.CreateParams({
            key: poolKey,
            tickLower: lo,
            tickUpper: hi,
            liquidity: liq,
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max,
            swapPoolIndex: 0,
            expiry: uint32(block.timestamp + 30 days),
            maxKeeperFeeBps: 50,
            maxSlippage: 100,
            lower: lower,
            upper: upper
        });
        vm.prank(who);
        id = orders.createOrder(p);
    }

    function _user(uint256 i) internal pure returns (address) {
        return address(uint160(0x5000 + i));
    }

    /// 300 timed exits from 30 owners, run in batches of 50 at a real gas price, with the Chainlink prices changed
    /// between batches. Every token must be accounted for: what the owners paid in is what the owners and the keeper
    /// got back, the keeper never gets more than the ceiling, and nothing stays in the contract.
    /// forge-config: default.isolate = false
    function test_stress_batchedExitsAccountForEveryToken() public {
        vm.fee(0.0005 gwei);
        vm.txGasPrice(0.0015 gwei);
        uint256 n = 300;
        uint256 owners = 30;
        for (uint256 u; u < owners; ++u) _fund(_user(u));

        uint256[] memory ids = new uint256[](n);
        uint256 in0;
        uint256 in1;
        OrderState.Side memory off;
        for (uint256 i; i < n; ++i) {
            address who = _user(i % owners);
            int24 lo = int24(int256(-1200 + 60 * int256(i % 25))); // ranges below, around and above the price
            uint128 liq = uint128(2e19 * (1 + (i % 7)) * (1 + (i % 3)));
            uint256 b0 = _bal(currency0, who);
            uint256 b1 = _bal(currency1, who);
            ids[i] = _open(
                who, lo, lo + 600, liq, off,
                _rule(OrderState.CHECK_TIME, 60, OrderState.ACT_KEEP_FEES | OrderState.ACT_REMOVE, 10_000)
            );
            in0 += b0 - _bal(currency0, who);
            in1 += b1 - _bal(currency1, who);
        }
        vm.warp(block.timestamp + 61 minutes);

        uint256 before0;
        uint256 before1;
        for (uint256 u; u < owners; ++u) {
            before0 += _bal(currency0, _user(u));
            before1 += _bal(currency1, _user(u));
        }
        uint256 ranAll;
        uint256 worstGas;
        for (uint256 from; from < n; from += 50) {
            // a different market for every batch: token prices and ETH move, one batch sees an old price
            feed0.setAnswer(int256(0.5e8 + 0.25e8 * (from / 50)));
            feedEth.setAnswer(int256(1000e8 + 500e8 * (from / 50)));
            feed1.setUpdatedAt(from == 100 ? block.timestamp - 3 days : 0);
            uint256[] memory batch = new uint256[](50);
            bool[] memory uppers = new bool[](50);
            for (uint256 j; j < 50; ++j) {
                batch[j] = ids[from + j];
                uppers[j] = true;
            }
            vm.prank(keeper, keeper);
            uint256 g = gasleft();
            ranAll += orders.executeMany(batch, uppers);
            uint256 used = g - gasleft();
            if (used > worstGas) worstGas = used;
        }
        assertEq(ranAll, n);

        uint256 out0;
        uint256 out1;
        for (uint256 u; u < owners; ++u) {
            out0 += _bal(currency0, _user(u));
            out1 += _bal(currency1, _user(u));
        }
        out0 -= before0;
        out1 -= before1;
        uint256 k0 = _bal(currency0, keeper);
        uint256 k1 = _bal(currency1, keeper);
        console.log("orders run", ranAll, "most gas for a batch of 50", worstGas);
        console.log("  about this many orders fit a 30M-gas block", (30_000_000 * 50) / worstGas);
        console.log("  paid in token0 / token1", in0, in1);
        console.log("  keeper got token0 / token1", k0, k1);
        // the pool rounds every withdrawal down by at most a unit per token
        assertApproxEqAbs(out0 + k0, in0, 2 * n);
        assertApproxEqAbs(out1 + k1, in1, 2 * n);
        assertLe(out0 + k0, in0);
        assertLe(out1 + k1, in1);
        // never above the 0.5% ceiling
        assertLe(k0, (in0 * 50) / 10_000);
        assertLe(k1, (in1 * 50) / 10_000);
        assertGt(k0 + k1, 0);
        // and far below it here: the pay is the gas, not a share of these large orders
        assertLt(k0 + k1, ((in0 + in1) * 50) / 10_000 / 4);
        assertEq(_bal(currency0, address(orders)), 0);
        assertEq(_bal(currency1, address(orders)), 0);
    }

    /// 200 orders of six kinds, twelve rounds of random swaps, random Chainlink prices (sometimes old, sometimes
    /// down), time passing, and a keeper that sends everything it knows in batches. Nothing may revert, and when the
    /// owners finally close what is left, the contract holds no tokens.
    function test_stress_randomMarketWithFeeds() public {
        uint256 n = 200;
        uint256 owners = 20;
        for (uint256 u; u < owners; ++u) _fund(_user(u));
        uint256[] memory ids = new uint256[](n);
        OrderState.Side memory off;
        uint8 exit = OrderState.ACT_KEEP_FEES | OrderState.ACT_REMOVE;
        for (uint256 i; i < n; ++i) {
            address who = _user(i % owners);
            uint128 liq = uint128(2e17 * (1 + (i % 5)));
            uint256 kind = i % 6;
            if (kind == 0) {
                ids[i] = _open(who, -600, 600, liq, off, _rule(OrderState.CHECK_TIME, 45, exit, 10_000));
            } else if (kind == 1) {
                // Chainlink stop below, Chainlink take-profit above
                ids[i] = _open(
                    who, -600, 600, liq, _rule(OrderState.CHECK_ORACLE, -300, exit, 10_000),
                    _rule(OrderState.CHECK_ORACLE, 300, exit, 10_000)
                );
            } else if (kind == 2) {
                // sell a quarter each time Chainlink falls another 200 ticks, at most 3 times
                OrderState.Side memory d = _rule(OrderState.CHECK_ORACLE, -150, OrderState.ACT_REMOVE, 2_500);
                d.repeat = true;
                d.shape = 200;
                d.runsLeft = 3;
                ids[i] = _open(who, -600, 600, liq, d, off);
            } else if (kind == 3) {
                // compound every 30 minutes
                OrderState.Side memory d = _rule(OrderState.CHECK_TIME, 30, OrderState.ACT_KEEP_FEES | OrderState.ACT_ADD, 0);
                d.repeat = true;
                ids[i] = _open(who, -600, 600, liq, off, d);
            } else if (kind == 4) {
                // stop loss that converts, only when the pool AND Chainlink agree the price left the range
                OrderState.Side memory d = _rule(OrderState.CHECK_EDGE, 0, exit | OrderState.ACT_SWAP, 10_000);
                d.swapToToken1 = true;
                d.checker2 = OrderState.CHECK_ORACLE;
                d.value2 = -600;
                d.combine = OrderState.COMBINE_AND;
                ids[i] = _open(who, -600, 600, liq, d, off);
            } else {
                // follow the price up, one-sided, repeating
                OrderState.Side memory d = _rule(OrderState.CHECK_EDGE, 60, exit | OrderState.ACT_ADD, 10_000);
                d.addMode = OrderState.ADD_ONE_SIDED;
                d.shape = 10;
                d.repeat = true;
                ids[i] = _open(who, -600, 600, liq, off, d);
            }
        }

        uint256[] memory all = new uint256[](2 * n);
        bool[] memory sides = new bool[](2 * n);
        for (uint256 i; i < n; ++i) {
            (all[2 * i], sides[2 * i]) = (ids[i], false);
            (all[2 * i + 1], sides[2 * i + 1]) = (ids[i], true);
        }

        uint256 ran;
        uint256 seed = 0xA11CE;
        uint256 time = block.timestamp; // kept here: the compiler may reuse an earlier block.timestamp after a warp
        for (uint256 round; round < 12; ++round) {
            seed = uint256(keccak256(abi.encode(seed)));
            swapRouter.swapExactTokensForTokens({
                amountIn: 1e18 + (seed >> 8) % 12e18, // the pool moves
                amountOutMin: 0,
                zeroForOne: seed % 2 == 0,
                poolKey: poolKey,
                hookData: Constants.ZERO_BYTES,
                receiver: address(this),
                deadline: type(uint256).max
            });
            feed0.setAnswer(int256(0.90e8 + (seed >> 40) % 0.20e8)); // Chainlink: $0.90 to $1.10
            feed0.setUpdatedAt((seed >> 80) % 5 == 0 ? time - 2 days : 0); // sometimes an old price
            feed1.setBroken((seed >> 96) % 7 == 0); // sometimes a feed is down
            time += 20 minutes + (seed >> 120) % 60 minutes;
            vm.warp(time);
            // a run that converts stops later orders of the pool in that transaction, so the keeper sends twice
            for (uint256 pass; pass < 3; ++pass) {
                vm.roll(block.number + 1);
                vm.prank(keeper);
                ran += orders.executeMany(all, sides);
            }
        }
        feed1.setBroken(false);
        feed0.setUpdatedAt(0);

        uint256 open;
        for (uint256 i; i < n; ++i) {
            (ConditionalOrders.Order memory o,) = orders.getOrder(ids[i]);
            if (o.owner == address(0)) continue;
            ++open;
            vm.prank(o.owner);
            orders.cancel(ids[i]);
            assertEq(orders.orderLiquidity(ids[i]), 0);
        }
        console.log("runs over 12 rounds", ran, "orders still open at the end", open);
        assertGt(ran, n / 4);
        assertEq(_bal(currency0, address(orders)), 0);
        assertEq(_bal(currency1, address(orders)), 0);
        for (uint256 u; u < owners; ++u) {
            assertEq(orders.owed(_user(u), currency0), 0);
            assertEq(orders.owed(_user(u), currency1), 0);
        }
    }
}
