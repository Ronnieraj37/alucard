// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {RuleSetup} from "./utils/RuleSetup.sol";
import {Rules} from "../src/Rules.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {OrderState} from "../src/libraries/OrderState.sol";
import {MockAggregator} from "../src/testnet/MockAggregator.sol";

/// @notice Two-leg strategies: an order that leaves its range, waits somewhere, and comes back by its own rules.
contract StrategiesTest is RuleSetup {
    using StateLibrary for IPoolManager;

    Currency currency2; // a second stablecoin
    PoolKey stable; // currency1 / currency2: shares currency1 ("USDC") with the main pool
    uint24 stableIndex;
    bool usdcIs0InStable; // where currency1 sits in the stable pool

    function setUp() public override {
        super.setUp();
        MockERC20 t = deployToken();
        currency2 = Currency.wrap(address(t));
        feeds.setFeed(address(t), address(new MockAggregator(8, 1e8)), MAX_AGE);
        usdcIs0InStable = currency1 < currency2;
        (Currency a, Currency b) = usdcIs0InStable ? (currency1, currency2) : (currency2, currency1);
        stable = _newPool(a, b, Constants.SQRT_PRICE_1_1);
        stableIndex = rules.poolIndexOf(stable.toId());
        _wait(1 hours);
    }

    function _tickOf(PoolKey memory k) internal view returns (int24 t) {
        (, t,,) = poolManager.getSlot0(k.toId());
    }

    function _kind(uint256 id) internal view returns (uint8) {
        return orders.getPlan(id).here.kind;
    }

    function _vaultHoldsNothing() internal view {
        assertEq(_bal(currency0, address(orders)), 0);
        assertEq(_bal(currency1, address(orders)), 0);
        assertEq(_bal(currency2, address(orders)), 0);
    }

    // ---------------------------------------------------------------- wait, then come back centred

    /// Below the range: sell to token1 and wait. When the price is 3% off its low, come back in a new range
    /// centred on the price. (The backtested "exit, wait, re-enter" rule.)
    function _waitAndReturn() internal returns (uint256 id) {
        ConditionalOrders.CreateParams memory p = _params(_moveSide(OrderState.CHECK_EDGE, 0, 1), _off());
        p.home = OrderState.Leg({poolIndex: 0, kind: OrderState.LEG_CENTERED, a: 600, b: 600});
        p.away = OrderState.Leg({poolIndex: 1, kind: OrderState.LEG_IDLE, a: 0, b: 0});
        p.awayUpper = _w(_moveIdle(OrderState.CHECK_TRAIL, 300)); // 300 ticks up from the lowest price seen
        id = _submit(alice, p);
    }

    function test_exitWaitAndComeBackCentred() public {
        uint256 id = _waitAndReturn();

        // 1. the price falls out of the range: everything is sold to token1 and held for the order
        _swap(true, 5e18);
        _settle();
        _run(id, false);
        assertEq(_kind(id), OrderState.LEG_IDLE);
        ConditionalOrders.Plan memory plan = orders.getPlan(id);
        assertGt(plan.held1, 0.5e18);
        assertLt(plan.held0, 1e15); // only what the swap limit left unsold
        (uint256 a0, uint256 a1) = rules.orderAmounts(orders, id);
        assertEq(a0, plan.held0);
        assertEq(a1, plan.held1);
        _vaultHoldsNothing(); // held as claims inside the PoolManager

        // 2. it does not bounce back at once
        vm.expectRevert(ConditionalOrders.TooSoon.selector);
        _run(id, true);

        // 3. the price keeps falling; the side remembers the low
        _swap(true, 3e18);
        _settle();
        orders.poke(id, true);
        (, OrderState.Side memory up) = _state(id);
        int24 low = up.best;
        assertLt(low, -1200);

        // 4. it rebounds 3%+ off the low: back into a range centred on the price
        _swap(false, 2e18);
        _settle();
        assertGe(_avg(), low + 300);
        int24 before = _tick(); // the new range is centred on the price before the run's own swap
        _run(id, true);
        assertEq(_kind(id), OrderState.LEG_CENTERED);
        (OrderState.Side memory lo2, OrderState.Side memory up2) = _state(id);
        int24 mid = before < 0 && before % 60 != 0 ? (before / 60 - 1) * 60 : (before / 60) * 60;
        assertEq(lo2.edge, mid - 600);
        assertEq(up2.edge, mid + 600);
        assertGt(_liquidity(id), 0);
        assertEq(orders.getPlan(id).held1, 0);
        _vaultHoldsNothing();

        // 5. the home leg's rules are live again: it can leave once more
        assertEq(lo2.checker, OrderState.CHECK_EDGE);
        assertTrue(lo2.actions & OrderState.ACT_MOVE != 0);
    }

    function test_cancelWhileWaitingReturnsTheHeldTokens() public {
        uint256 id = _waitAndReturn();
        _swap(true, 5e18);
        _settle();
        _run(id, false);
        uint256 held1 = orders.getPlan(id).held1;
        uint256 before = _bal(currency1, alice);

        vm.prank(alice);
        orders.cancel(id);
        assertEq(_bal(currency1, alice) - before, held1);
        assertEq(poolManager.balanceOf(address(orders), currency1.toId()), 0);
        assertEq(orders.getOrder(id).owner, address(0));
    }

    /// A move side with a run limit switches off after its last run. Back home with no rule left, the order ends.
    function test_runLimitEndsTheStrategy() public {
        OrderState.Side memory out = _moveSide(OrderState.CHECK_EDGE, 0, 1);
        out.runsLeft = 1;
        ConditionalOrders.CreateParams memory p = _params(out, _off());
        p.home = OrderState.Leg({poolIndex: 0, kind: OrderState.LEG_CENTERED, a: 600, b: 600});
        p.away = OrderState.Leg({poolIndex: 1, kind: OrderState.LEG_IDLE, a: 0, b: 0});
        p.awayUpper = _w(_moveIdle(OrderState.CHECK_TIME, 10)); // come back after 10 minutes
        uint256 id = _submit(alice, p);

        _swap(true, 5e18);
        _settle();
        _run(id, false);
        _wait(11 minutes);
        uint256 before = _bal(currency1, alice) + _bal(currency0, alice);
        _run(id, true);
        assertEq(orders.getOrder(id).owner, address(0)); // closed: nothing could ever run again
        assertGt(_bal(currency1, alice) + _bal(currency0, alice), before);
        _vaultHoldsNothing();
    }

    /// While waiting, the owner can change the waiting leg's rule (here: come back after a time instead).
    function test_updateWhileWaiting() public {
        uint256 id = _waitAndReturn();
        _swap(true, 5e18);
        _settle();
        _run(id, false);

        ConditionalOrders.UpdateParams memory u = ConditionalOrders.UpdateParams({
            expiry: uint32(_now() + 7 days),
            keeperFeeBps: 100,
            maxSlippage: 50,
            lower: 0,
            upper: _w(_exit(OrderState.CHECK_TIME, 5))
        });
        // a waiting leg can only move: an exit rule is refused
        vm.prank(alice);
        vm.expectRevert();
        orders.updateOrder(id, u);

        u.upper = _w(_moveIdle(OrderState.CHECK_TIME, 5));
        vm.prank(alice);
        orders.updateOrder(id, u);
        _wait(6 minutes);
        _run(id, true);
        assertEq(_kind(id), OrderState.LEG_CENTERED);
        assertGt(_liquidity(id), 0);
    }

    // ---------------------------------------------------------------- park in a stable pool

    /// The LP's own playbook: an ETH/USDC-like position falls out of range. Instead of a stop loss that only takes
    /// the tokens out, sell to USDC and put it in a USDC/USDT position, which keeps its value and earns fees. When
    /// the ETH/USDC price is back in the range, take it out, turn it back into USDC and re-enter the range.
    function _park() internal returns (uint256 id) {
        ConditionalOrders.CreateParams memory p = _params(_moveSide(OrderState.CHECK_EDGE, 0, 1), _off()); // sell to USDC
        p.home = OrderState.Leg({poolIndex: 0, kind: OrderState.LEG_RANGE, a: -600, b: 600});
        p.away = OrderState.Leg({poolIndex: stableIndex, kind: OrderState.LEG_RANGE, a: -60, b: 60});
        // back when the main pool's price is back at the range (tick >= -600), selling USDT back to USDC first
        OrderState.Side memory back = _moveSide(OrderState.CHECK_TICK, -600, usdcIs0InStable ? 2 : 1);
        back.checkPool = 1;
        p.awayUpper = _w(back);
        id = _submit(alice, p);
    }

    function test_parkInAStablePoolAndComeBack() public {
        uint256 id = _park();
        uint256 start0 = _bal(currency0, alice);

        // 1. the price falls out of the range: token0 is sold to USDC, which goes into the USDC/USDT range
        _swap(true, 5e18);
        _settle();
        _run(id, false);
        ConditionalOrders.Order memory o = orders.getOrder(id);
        assertEq(o.poolIndex, stableIndex);
        (OrderState.Side memory lo, OrderState.Side memory up) = _state(id);
        assertEq(lo.edge, -60);
        assertEq(up.edge, 60);
        assertGt(_liquidity(id), 0);
        (uint256 s0, uint256 s1) = rules.orderAmounts(orders, id);
        assertGt(s0, 0); // both stablecoins: the range holds the price
        assertGt(s1, 0);
        // the swap stopped where the rest fits the range: almost nothing is left over (it is paid to alice)
        uint256 leftover = _bal(currency2, alice);
        assertLt(leftover * 1000, s0 + s1); // under 0.1%
        assertLt(_bal(currency0, alice) - start0, 1e15); // token0 was sold, not sent out
        _vaultHoldsNothing();

        // 2. it waits while the main pool stays below the range
        _wait(10 minutes);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, true);

        // 3. the main pool's price comes back into the range: USDT is sold back to USDC, and the order re-enters
        _swap(false, 6e18);
        _settle();
        assertGe(_avg(), -600);
        _run(id, true);
        // all the USDT went back to USDC on the way out of the stable pool: none of it came to alice
        o = orders.getOrder(id);
        assertEq(o.poolIndex, 1);
        (lo, up) = _state(id);
        assertEq(lo.edge, -600);
        assertEq(up.edge, 600);
        assertGt(_liquidity(id), 0);
        assertEq(_bal(currency2, alice), leftover);
        _vaultHoldsNothing();

        // 4. the plan is ready for the next time
        assertEq(orders.getPlan(id).there.poolIndex, stableIndex);
        assertEq(lo.checker, OrderState.CHECK_EDGE);
    }

    /// The pool's price far from Chainlink (pushed, or a pool not yet arbitraged after a crash): the move waits, the
    /// position stays where it is, and it runs once the two agree again.
    function test_moveWaitsWhilePoolAndChainlinkDisagree() public {
        _band(200);
        uint256 id = _park();
        _swap(true, 5e18);
        _market();
        _settle();
        _swap(true, 20e18); // far past Chainlink
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, false);
        assertEq(orders.getOrder(id).poolIndex, 1);

        _market(); // the market follows
        _run(id, false);
        assertEq(orders.getOrder(id).poolIndex, stableIndex);
        assertGt(_liquidity(id), 0);
    }

    function test_parkedOrderEarnsStablePoolFees() public {
        uint256 id = _park();
        _swap(true, 5e18);
        _settle();
        _run(id, false);
        // trades in the stable pool
        for (uint256 i; i < 10; ++i) {
            _swapIn(stable, i % 2 == 0, 0.5e18);
        }
        (bool ok, uint256 bps) = rules.feeBps(address(orders), id, stableIndex, int24(-60), int24(60));
        assertTrue(ok);
        assertGt(bps, 0);
    }

    /// A move keeps the money's value: in deep pools, what arrives in the other pool (plus the little change paid
    /// back) is worth what left the range less the 0.3% swap fee (the stable pool's own swap a few bps more) and the
    /// keeper's fee (1% here), and the keeper gets exactly that fee. (In a thin pool the sale also moves the price;
    /// the order's slippage limit caps that.)
    function test_parkingKeepsTheValue() public {
        uint256 id = _park();
        _swap(true, 5e18);
        _settle();
        fullRangeLiquidity = 10_000e18; // 100x deeper: one order's sale barely moves the price
        _addFullRange(poolKey);
        _addFullRange(stable);
        _settle();
        (uint256 a0, uint256 a1) = rules.orderAmounts(orders, id);
        (uint160 sqrtP,,,) = poolManager.getSlot0(poolKey.toId());
        uint256 before = _in1(a0, sqrtP) + a1;
        uint256 w0 = _bal(currency0, alice);
        uint256 w1 = _bal(currency1, alice);
        uint256 w2 = _bal(currency2, alice);
        uint256 k1 = _bal(currency1, keeper);

        _run(id, false);
        uint256 fee = _bal(currency1, keeper) - k1; // paid in USDC, the token the sale produced
        (uint256 s0, uint256 s1) = rules.orderAmounts(orders, id);
        uint256 parked = s0 + s1; // both stablecoins are worth 1 token1
        uint256 paidBack =
            (_bal(currency1, alice) - w1) + (_bal(currency2, alice) - w2) + _in1(_bal(currency0, alice) - w0, sqrtP);
        assertApproxEqRel(fee, before / 100, 0.01e18, "the keeper's fee is 1% of what moved");
        assertGe((parked + paidBack + fee) * 10_000, before * 9_960, "lost more than the swap fees");
        assertLe(parked + paidBack + fee, before, "value from nowhere");
        assertLe(paidBack * 10_000, before * 30, "more than the swap's change left the strategy");
    }

    function _in1(uint256 amount0, uint160 sqrtP) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(amount0, sqrtP, 1 << 96), sqrtP, 1 << 96);
    }

    /// The pool a move goes into must be at a believable price too: a pushed USDC/USDT price would set the new
    /// range and the swap there.
    function test_noMoveIntoAPushedPool() public {
        _band(200);
        uint256 id = _park();
        _swap(true, 5e18);
        _market();
        _settle();
        _swapIn(stable, true, 3e18); // the stable pool pushed off its peg in this block
        vm.expectRevert(Rules.PriceMoved.selector);
        _run(id, false);
        assertEq(orders.getOrder(id).poolIndex, 1);
    }

    /// An edit cannot leave a two-pool strategy without a way to the other pool.
    function test_anEditKeepsTheWayToTheOtherPool() public {
        uint256 id = _park();
        ConditionalOrders.UpdateParams memory u;
        u.expiry = uint32(_now() + 1 days);
        u.lower = _w(_exit(OrderState.CHECK_EDGE, 0)); // withdraw instead of move
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.InvalidOrder.selector);
        orders.updateOrder(id, u);
    }
}
