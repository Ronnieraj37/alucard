// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/console.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {RuleSetup} from "./utils/RuleSetup.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {OrderState} from "../src/libraries/OrderState.sol";
import {MockAggregator} from "../src/testnet/MockAggregator.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/// @notice The contract, the app's rule editor and the backtest engine agree on every rule.
///
/// 1. Acceptance: frontend/scripts/parity.ts builds every rule the editor's blocks can make, plus thousands of other
///    encodings (mutations of real rules and random fields). The editor's own code decides which ones it can build.
///    The contract must accept exactly those and revert on all others.
/// 2. Behaviour: for a sample of those rules on four synthetic price paths, the backtest engine (frontend/api/_engine.py)
///    says at which swaps each order runs. Here the same orders are created and the same prices replayed, with a keeper
///    that pokes and executes after every swap; the runs must be the same.
///
/// Needs frontend/node_modules (npm install) and frontend/.venv (npm run setup:api); runs them through ffi.
contract EditorParityTest is RuleSetup {
    using StateLibrary for IPoolManager;

    PoolSwapTest swapper;
    MockAggregator oracle0; // token0's Chainlink price, moved together with the pool's price in the replay

    function setUp() public override {
        super.setUp();
        // 18-decimal feeds, so the Chainlink price can sit in the middle of any tick of the path
        oracle0 = new MockAggregator(18, 1e18);
        feeds.setFeed(Currency.unwrap(currency0), address(oracle0), MAX_AGE);
        feeds.setFeed(Currency.unwrap(currency1), address(new MockAggregator(18, 1e18)), MAX_AGE);
        // pool #2: a hookless pool of the same pair, as scripts/parity.ts assumes
        PoolKey memory k = PoolKey(currency0, currency1, 500, 10, IHooks(address(0)));
        poolManager.initialize(k, Constants.SQRT_PRICE_1_1);
        require(hook.registerPool(k) == 2, "pool #2");
        swapper = new PoolSwapTest(poolManager);
        MockERC20(Currency.unwrap(currency0)).approve(address(swapper), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(swapper), type(uint256).max);
    }

    function _ffi(string memory args) internal returns (bytes memory) {
        string[] memory cmd = new string[](3);
        cmd[0] = "bash";
        cmd[1] = "-c";
        cmd[2] = string.concat("cd frontend && npx tsx scripts/parity.ts ", args, " 2>/dev/null");
        return vm.ffi(cmd);
    }

    /// Solidity never frees memory; thousands of cases in one test would run out. Callers save the free-memory
    /// pointer before a case and put it back after, once nothing allocated in between is needed any more.
    function _fmp() internal pure returns (uint256 p) {
        assembly ("memory-safe") {
            p := mload(0x40)
        }
    }

    function _setFmp(uint256 p) internal pure {
        assembly ("memory-safe") {
            mstore(0x40, p)
        }
    }

    function _params(OrderState.Side memory lower, OrderState.Side memory upper, int24 tl, int24 tu, uint128 liq)
        internal
        view
        returns (ConditionalOrders.CreateParams memory)
    {
        return ConditionalOrders.CreateParams({
            key: poolKey,
            tickLower: tl,
            tickUpper: tu,
            liquidity: liq,
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max,
            swapPoolIndex: 0,
            expiry: uint32(block.timestamp + 365 days),
            maxKeeperFeeBps: 10,
            maxSlippage: 50,
            lower: lower,
            upper: upper
        });
    }

    // ---------------------------------------------------------------- 1. acceptance

    function test_contractAcceptsExactlyWhatTheEditorBuilds() public {
        vm.pauseGasMetering();
        uint256 total = abi.decode(_ffi("count"), (uint256));
        uint256 accepted;
        uint256 wrongAccept;
        uint256 wrongReject;
        uint256 chunk = 4000;
        for (uint256 from; from < total; from += chunk) {
            uint256 mem = _fmp();
            (OrderState.Side[] memory lo, OrderState.Side[] memory up, bool[] memory ok) = abi.decode(
                _ffi(string.concat("sides ", vm.toString(from), " ", vm.toString(chunk))),
                (OrderState.Side[], OrderState.Side[], bool[])
            );
            for (uint256 i; i < ok.length; ++i) {
                uint256 caseMem = _fmp();
                ConditionalOrders.CreateParams memory p = _params(lo[i], up[i], -600, 600, 1e15);
                vm.prank(alice);
                try orders.createOrder(p) {
                    accepted++;
                    if (!ok[i]) {
                        wrongAccept++;
                        if (wrongAccept <= 10) _logCase("ACCEPTED but the editor cannot build", from + i, lo[i], up[i]);
                    }
                } catch (bytes memory err) {
                    if (ok[i]) {
                        wrongReject++;
                        if (wrongReject <= 10) {
                            _logCase("REVERTED but the editor builds it", from + i, lo[i], up[i]);
                            console.logBytes(err);
                        }
                    }
                }
                _setFmp(caseMem);
            }
            _setFmp(mem);
        }
        console.log("cases", total);
        console.log("  accepted", accepted, "reverted", total - accepted);
        console.log("  accepted though the editor cannot build them", wrongAccept);
        console.log("  reverted though the editor builds them", wrongReject);
        assertEq(wrongAccept, 0, "contract accepts rules the editor cannot build");
        assertEq(wrongReject, 0, "contract refuses rules the editor builds");
        assertGt(accepted, 10_000, "too few valid cases: generator broken?");
    }

    function _logCase(string memory what, uint256 i, OrderState.Side memory lo, OrderState.Side memory up) internal pure {
        console.log(what, i);
        _logSide("  lower", lo);
        _logSide("  upper", up);
    }

    function _logSide(string memory name, OrderState.Side memory s) internal pure {
        console.log(name);
        console.log("    checker / value / pool", s.checker, uint256(int256(s.value) + 2 ** 23), s.checkPool);
        console.log("    checker2 / value2 / pool2", s.checker2, uint256(int256(s.value2) + 2 ** 23), s.checkPool2);
        console.log("    combine / hold / runsLeft", s.combine, s.holdMinutes, s.runsLeft);
        console.log("    actions / removeBps / addMode", s.actions, s.removeBps, s.addMode);
        console.log("    repeat / swapToToken1 / shape", s.repeat ? 1 : 0, s.swapToToken1 ? 1 : 0, s.shape);
        console.log("    edge / lastRun / armedAt+best", uint256(int256(s.edge) + 2 ** 23), s.lastRun, s.armedAt);
    }

    // ---------------------------------------------------------------- 2. behaviour vs the backtest engine

    struct Batch {
        uint32[][] ts;
        int24[][] ticks;
        OrderState.Side[] lower;
        OrderState.Side[] upper;
        int24[] tl;
        int24[] tu;
        uint256[] path;
        uint256[] swaps;
        uint256[][] events; // swap index << 1 | (upper side)
    }

    function _batch(bytes memory data) internal pure returns (Batch memory b) {
        (b.ts, b.ticks, b.lower, b.upper, b.tl, b.tu, b.path, b.swaps, b.events) = abi.decode(
            data,
            (uint32[][], int24[][], OrderState.Side[], OrderState.Side[], int24[], int24[], uint256[], uint256[], uint256[][])
        );
    }

    /// Move the price to a point strictly inside tick `t`, as the synthetic path does.
    function _moveTo(int24 t) internal {
        uint160 target = uint160((uint256(TickMath.getSqrtPriceAtTick(t)) + TickMath.getSqrtPriceAtTick(t + 1)) / 2);
        // the engine has no Chainlink history and reads the pool's price for a Chainlink level, so the feed follows
        // the pool here: token1 is $1 and token0 is the pool's price
        oracle0.setAnswer(int256(FullMath.mulDiv(FullMath.mulDiv(target, target, 1 << 96), 1e18, 1 << 96)));
        (bool okTick, int24 oracleTick) = feeds.pairTick(Currency.unwrap(currency0), Currency.unwrap(currency1));
        require(okTick && oracleTick == t, "Chainlink price not at the path's tick");
        (uint160 now_,,,) = poolManager.getSlot0(poolId);
        if (now_ == target) return;
        bool zeroForOne = target < now_;
        swapper.swap(
            poolKey,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -1e30, sqrtPriceLimitX96: target}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        require(_tick() == t, "price not at the path's tick");
    }

    function test_engineRunsOrdersWhereTheContractDoes() public {
        vm.pauseGasMetering();
        uint256 total = abi.decode(_ffi("engineCount"), (uint256));
        uint256 same;
        uint256 differ;
        uint256 runs;
        uint256 chunk = 400;
        for (uint256 from; from < total; from += chunk) {
            uint256 mem = _fmp();
            Batch memory b = _batch(_ffi(string.concat("engine ", vm.toString(from), " ", vm.toString(chunk))));
            for (uint256 i; i < b.lower.length; ++i) {
                uint256 caseMem = _fmp();
                uint256[] memory got = _replay(b, i);
                runs += got.length;
                if (_equal(got, b.events[i])) {
                    same++;
                } else {
                    differ++;
                    if (differ <= 10) _logDiff(from + i, b, i, got);
                }
                _setFmp(caseMem);
            }
            _setFmp(mem);
        }
        console.log("orders replayed", total);
        console.log("  same runs as the engine", same, "different", differ);
        console.log("  runs in total", runs);
        assertEq(differ, 0, "the backtest engine and the contract disagree");
        assertGt(runs, total, "too few runs: the paths do not exercise the rules");
    }

    function _replay(Batch memory b, uint256 i) internal returns (uint256[] memory got) {
        uint256 snap = vm.snapshotState();
        uint32[] memory ts = b.ts[b.path[i]];
        int24[] memory ticks = b.ticks[b.path[i]];
        vm.warp(ts[0]);
        ConditionalOrders.CreateParams memory p = _params(b.lower[i], b.upper[i], b.tl[i], b.tu[i], 1e18);
        vm.prank(alice);
        uint256 id = orders.createOrder(p);

        got = new uint256[](4 * b.swaps[i] + 8);
        uint256 n;
        for (uint256 k = 1; k < b.swaps[i]; ++k) {
            vm.warp(ts[k]);
            _moveTo(ticks[k]);
            // a keeper that looks after every swap: run what can run, poke what can be poked, until nothing changes
            for (uint256 pass; pass < 4; ++pass) {
                bool acted;
                for (uint256 s; s < 2; ++s) {
                    bool upper = s == 1;
                    (ConditionalOrders.Order memory o,) = orders.getOrder(id);
                    if (o.owner == address(0)) break;
                    if (orders.canExecute(id, upper)) {
                        vm.prank(keeper);
                        try orders.execute(id, upper) {
                            got[n++] = (k << 1) | s;
                            acted = true;
                        } catch {}
                    } else {
                        try orders.poke(id, upper) {
                            acted = true;
                        } catch {}
                    }
                }
                if (!acted) break;
            }
        }
        assembly ("memory-safe") {
            mstore(got, n)
        }
        vm.revertToState(snap);
    }

    function _equal(uint256[] memory a, uint256[] memory b) internal pure returns (bool) {
        if (a.length != b.length) return false;
        for (uint256 i; i < a.length; ++i) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }

    function _logDiff(uint256 c, Batch memory b, uint256 i, uint256[] memory got) internal pure {
        console.log("DIFFERENT case / path", c, b.path[i]);
        _logSide("  lower", b.lower[i]);
        _logSide("  upper", b.upper[i]);
        uint256[] memory want = b.events[i];
        for (uint256 j; j < want.length || j < got.length; ++j) {
            console.log("    engine / contract (swap*2 + upper)", j < want.length ? want[j] : 0, j < got.length ? got[j] : 0);
            if (j > 12) break;
        }
    }
}
