// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/console.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {RuleSetup} from "./utils/RuleSetup.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {OrderState} from "../src/libraries/OrderState.sol";
import {MockAggregator} from "../src/testnet/MockAggregator.sol";

/// @notice The contract, the app's rule editor and the backtest engine agree on every order.
///
/// 1. Acceptance: frontend/scripts/parity.ts builds every strategy the editor's cards can make (moves included),
///    plus thousands of other encodings (mutations of real orders: their sides and their legs). The editor's own code
///    decides which ones it can build. The contract must accept exactly those and revert on all others.
/// 2. Behaviour: for a sample of those orders on four synthetic price paths, the backtest engine
///    (frontend/api/_engine.py) says at which swaps each order runs. Here the same orders are created and the same
///    prices replayed, with a keeper that runs or pokes after every swap; the runs must be the same.
///
/// Needs frontend/node_modules (npm install) and frontend/.venv (npm run setup:api); runs them through ffi.
contract EditorParityTest is RuleSetup {
    using StateLibrary for IPoolManager;

    PoolSwapTest swapper;
    MockAggregator oracle0; // token0's Chainlink price: it follows the pool's price in the replay, as arbitrage would

    function setUp() public override {
        super.setUp();
        // 18-decimal feeds, so the Chainlink price can sit in the middle of any tick of the path
        oracle0 = new MockAggregator(18, 1e18);
        feeds.queueFeed(Currency.unwrap(currency0), address(oracle0), MAX_AGE);
        MockAggregator one = new MockAggregator(18, 1e18);
        feeds.queueFeed(Currency.unwrap(currency1), address(one), MAX_AGE);
        _wait(2 days); // listed feeds change only after the timelock
        feeds.setFeed(Currency.unwrap(currency0), address(oracle0), MAX_AGE);
        feeds.setFeed(Currency.unwrap(currency1), address(one), MAX_AGE);
        swapper = new PoolSwapTest(poolManager);
        MockERC20(Currency.unwrap(currency0)).approve(address(swapper), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(swapper), type(uint256).max);
        // the pools scripts/parity.ts assumes:
        // #2 a hook pool of the same pair, #3 a hookless pool of the same pair, #4 a hook pool of token1 and token2
        PoolKey memory two = PoolKey(currency0, currency1, 500, 10, IHooks(hook));
        poolManager.initialize(two, Constants.SQRT_PRICE_1_1);
        require(rules.registerPool(two) == 2, "pool #2");
        PoolKey memory bare = PoolKey(currency0, currency1, 100, 1, IHooks(address(0)));
        poolManager.initialize(bare, Constants.SQRT_PRICE_1_1);
        require(rules.registerPool(bare) == 3, "pool #3");
        MockERC20 t2 = deployToken();
        while (address(t2) < Currency.unwrap(currency1)) t2 = deployToken(); // above token1, as the script assumes
        feeds.setFeed(address(t2), address(new MockAggregator(8, 1e8)), MAX_AGE);
        PoolKey memory four = PoolKey(currency1, Currency.wrap(address(t2)), 100, 1, IHooks(hook));
        poolManager.initialize(four, Constants.SQRT_PRICE_1_1);
        require(rules.registerPool(four) == 4, "pool #4");
        rules.registerCondition(address(oracle0)); // "when" card #1 (any contract: the acceptance test only names it)
        // the Chainlink band stays off here (conditions also read pools #2-#4, whose feeds do not follow the replay);
        // test/PriceGuard.t.sol tests the band
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

    struct Cases {
        uint256[] lower;
        uint256[] upper;
        OrderState.Leg[] home;
        OrderState.Leg[] away;
        uint256[] awayLower;
        uint256[] awayUpper;
        bool[] ok;
    }

    function _cases(bytes memory data) internal pure returns (Cases memory c) {
        (c.lower, c.upper, c.home, c.away, c.awayLower, c.awayUpper, c.ok) =
            abi.decode(data, (uint256[], uint256[], OrderState.Leg[], OrderState.Leg[], uint256[], uint256[], bool[]));
    }

    function _paramsOf(Cases memory c, uint256 i) internal view returns (ConditionalOrders.CreateParams memory p) {
        p.key = poolKey;
        p.tickLower = -600;
        p.tickUpper = 600;
        p.liquidity = 1e15;
        p.amount0Max = type(uint128).max;
        p.amount1Max = type(uint128).max;
        p.expiry = uint32(_now() + 365 days);
        p.keeperFeeBps = 10;
        p.maxSlippage = 50;
        p.lower = c.lower[i];
        p.upper = c.upper[i];
        p.home = c.home[i];
        p.away = c.away[i];
        p.awayLower = c.awayLower[i];
        p.awayUpper = c.awayUpper[i];
    }

    function test_contractAcceptsExactlyWhatTheEditorBuilds() public {
        vm.pauseGasMetering();
        uint256 total = abi.decode(_ffi("count"), (uint256));
        uint256 accepted;
        uint256 wrongAccept;
        uint256 wrongReject;
        uint256 chunk = 5000;
        for (uint256 from; from < total; from += chunk) {
            uint256 mem = _fmp();
            Cases memory c = _cases(_ffi(string.concat("cases ", vm.toString(from), " ", vm.toString(chunk))));
            for (uint256 i; i < c.ok.length; ++i) {
                uint256 caseMem = _fmp();
                ConditionalOrders.CreateParams memory p = _paramsOf(c, i);
                vm.prank(alice);
                try orders.createOrder(p) {
                    accepted++;
                    if (!c.ok[i]) {
                        wrongAccept++;
                        if (wrongAccept <= 10) {
                            console.log(
                                "ACCEPTED but the editor cannot build it: npx tsx scripts/parity.ts show", from + i
                            );
                        }
                    }
                } catch (bytes memory err) {
                    if (c.ok[i]) {
                        wrongReject++;
                        if (wrongReject <= 10) {
                            console.log("REVERTED but the editor builds it: npx tsx scripts/parity.ts show", from + i);
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
        assertEq(wrongAccept, 0, "contract accepts orders the editor cannot build");
        assertEq(wrongReject, 0, "contract refuses orders the editor builds");
        assertGt(accepted, 10_000, "too few valid cases: generator broken?");
    }

    // ---------------------------------------------------------------- 2. behaviour vs the backtest engine

    struct Batch {
        uint32[][] ts;
        int24[][] ticks;
        uint256[] lower;
        uint256[] upper;
        OrderState.Leg[] home;
        OrderState.Leg[] away;
        uint256[] awayLower;
        uint256[] awayUpper;
        uint256[] path;
        uint256[] swaps;
        uint256[][] events; // swap index << 1 | (upper side)
        uint256[] ratio; // engine: final value / value of just holding the deposit, x1e18
    }

    function _batch(bytes memory data) internal pure returns (Batch memory b) {
        (b.ts, b.ticks, b.lower, b.upper, b.home, b.away, b.awayLower, b.awayUpper, b.path, b.swaps, b.events, b.ratio) =
            abi.decode(
                data,
                (
                    uint32[][],
                    int24[][],
                    uint256[],
                    uint256[],
                    OrderState.Leg[],
                    OrderState.Leg[],
                    uint256[],
                    uint256[],
                    uint256[],
                    uint256[],
                    uint256[][],
                    uint256[]
                )
            );
    }

    /// Move the price to a point strictly inside tick `t`, as the synthetic path does (no swap if it is already there).
    function _moveTo(int24 t) internal {
        uint160 target = uint160((uint256(TickMath.getSqrtPriceAtTick(t)) + TickMath.getSqrtPriceAtTick(t + 1)) / 2);
        // arbitrage keeps the pool on the Chainlink price: here the feed follows the pool (token1 is $1, token0 the
        // pool's price), so the band check runs on every step and always passes
        oracle0.setAnswer(int256(FullMath.mulDiv(FullMath.mulDiv(target, target, 1 << 96), 1e18, 1 << 96)));
        (uint160 now_,,,) = poolManager.getSlot0(poolId);
        if (now_ == target) return;
        swapper.swap(
            poolKey,
            SwapParams({zeroForOne: target < now_, amountSpecified: -1e30, sqrtPriceLimitX96: target}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        require(_tick() == t, "price not at the path's tick");
    }

    /// Money: besides when each order runs, how much the owner ends with. For each order, the value of what the owner
    /// gets back (cancelling at the end of the path) over the value of just holding the deposited tokens, both at the
    /// last price, from the engine and from the contract. Differences are reported in basis points of that value.
    struct Money {
        uint256 compared;
        uint256 within1;
        uint256 within10;
        uint256 worst;
        uint256 worstCase;
        uint256 sum;
    }

    function test_engineRunsOrdersWhereTheContractDoes() public {
        vm.pauseGasMetering();
        uint256 total = abi.decode(_ffi("engineCount"), (uint256));
        uint256 same;
        uint256 differ;
        uint256 runs;
        Money memory m;
        uint256 chunk = 400;
        for (uint256 from; from < total; from += chunk) {
            uint256 mem = _fmp();
            Batch memory b = _batch(_ffi(string.concat("engine ", vm.toString(from), " ", vm.toString(chunk))));
            for (uint256 i; i < b.lower.length; ++i) {
                uint256 caseMem = _fmp();
                (uint256[] memory got, uint256 ratio) = _replay(b, i);
                runs += got.length;
                if (_equal(got, b.events[i])) {
                    same++;
                    _tally(m, ratio, b.ratio[i], from + i);
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
        console.log("money, orders compared", m.compared);
        console.log("  within 0.01% of the engine", m.within1);
        console.log("  within 0.1% of the engine", m.within10);
        console.log("  mean difference, millionths", m.compared == 0 ? 0 : m.sum / m.compared);
        console.log("  largest difference, millionths", m.worst, "case", m.worstCase);
        assertEq(differ, 0, "the backtest engine and the contract disagree");
        assertGt(runs, total, "too few runs: the paths do not exercise the rules");
        assertEq(m.within10, m.compared, "the engine's money is more than 0.1% from the contract's");
    }

    function _tally(Money memory m, uint256 contractRatio, uint256 engineRatio, uint256 c) internal view {
        uint256 d = contractRatio > engineRatio ? contractRatio - engineRatio : engineRatio - contractRatio;
        uint256 ppm = FullMath.mulDiv(d, 1e6, engineRatio); // millionths of the engine's value
        m.compared++;
        m.sum += ppm;
        if (ppm <= 100) m.within1++;
        if (ppm <= 1000) m.within10++;
        if (ppm > m.worst) (m.worst, m.worstCase) = (ppm, c);
        if (ppm > 1000) console.log("  MONEY: case, millionths", c, ppm);
    }

    function _replay(Batch memory b, uint256 i) internal returns (uint256[] memory got, uint256 ratio) {
        uint256 snap = vm.snapshotState();
        uint32[] memory ts = b.ts[b.path[i]];
        int24[] memory ticks = b.ticks[b.path[i]];
        vm.warp(ts[0]);
        ConditionalOrders.CreateParams memory p;
        p.key = poolKey;
        p.tickLower = -600;
        p.tickUpper = 600;
        p.liquidity = 1e15; // small next to the pool: the order's own swaps do not move its tick
        p.amount0Max = type(uint128).max;
        p.amount1Max = type(uint128).max;
        p.expiry = uint32(ts[0] + 365 days);
        p.keeperFeeBps = 10;
        p.maxSlippage = 50;
        p.lower = b.lower[i];
        p.upper = b.upper[i];
        p.home = b.home[i];
        p.away = b.away[i];
        p.awayLower = b.awayLower[i];
        p.awayUpper = b.awayUpper[i];
        uint256[2] memory before = [_bal(currency0, alice), _bal(currency1, alice)];
        vm.prank(alice);
        uint256 id = orders.createOrder(p);
        uint256[2] memory paid = [before[0] - _bal(currency0, alice), before[1] - _bal(currency1, alice)];

        got = new uint256[](4 * b.swaps[i] + 8);
        uint256 n;
        for (uint256 k = 1; k < b.swaps[i]; ++k) {
            vm.warp(ts[k]);
            _moveTo(ticks[k]);
            n = _keep(id, k, got, n);
        }
        assembly ("memory-safe") {
            mstore(got, n)
        }
        ratio = _ratioAtEnd(id, before, paid);
        vm.revertToState(snap);
    }

    /// @dev A keeper that looks after every swap: run what can run, poke what can be poked, until nothing changes.
    /// Runs are written to `got` from `n`; returns the new count.
    function _keep(uint256 id, uint256 k, uint256[] memory got, uint256 n) internal returns (uint256) {
        for (uint256 pass; pass < 4; ++pass) {
            bool acted;
            for (uint256 s; s < 2; ++s) {
                bool upper = s == 1;
                if (orders.getOrder(id).owner == address(0)) break;
                if (rules.canExecute(orders, id, upper)) {
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
        return n;
    }

    /// @dev The owner closes the order (if it is still open); what they got back over what they paid in, both valued
    /// in token1 at the pool's last price.
    function _ratioAtEnd(uint256 id, uint256[2] memory before, uint256[2] memory paid) internal returns (uint256) {
        if (orders.getOrder(id).owner != address(0)) {
            vm.prank(alice);
            orders.cancel(id);
        }
        uint256 back0 = _bal(currency0, alice) - (before[0] - paid[0]);
        uint256 back1 = _bal(currency1, alice) - (before[1] - paid[1]);
        (uint160 sp,,,) = poolManager.getSlot0(poolId);
        uint256 px = FullMath.mulDiv(FullMath.mulDiv(sp, sp, 1 << 96), 1e18, 1 << 96); // token1 per token0, x1e18
        uint256 hold = FullMath.mulDiv(paid[0], px, 1e18) + paid[1];
        return FullMath.mulDiv(FullMath.mulDiv(back0, px, 1e18) + back1, 1e18, hold);
    }

    function _equal(uint256[] memory a, uint256[] memory b) internal pure returns (bool) {
        if (a.length != b.length) return false;
        for (uint256 i; i < a.length; ++i) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }

    function _logDiff(uint256 c, Batch memory b, uint256 i, uint256[] memory got) internal pure {
        console.log("DIFFERENT: npx tsx scripts/parity.ts engineJob", c);
        uint256[] memory want = b.events[i];
        for (uint256 j; j < want.length || j < got.length; ++j) {
            console.log(
                "    engine / contract (swap*2 + upper)", j < want.length ? want[j] : 0, j < got.length ? got[j] : 0
            );
            if (j > 12) break;
        }
    }
}
