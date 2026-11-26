// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {RuleSetup} from "./utils/RuleSetup.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {Rules} from "../src/Rules.sol";
import {OrderState} from "../src/libraries/OrderState.sol";
import {MockAggregator} from "../src/testnet/MockAggregator.sol";

/// @notice Which rules an order may have. Everything here is refused at createOrder, before any token moves.
contract RulesTest is RuleSetup {
    function _refuse(OrderState.Side memory lower, OrderState.Side memory upper) internal {
        ConditionalOrders.CreateParams memory p = _params(lower, upper);
        vm.prank(alice);
        vm.expectRevert(Rules.InvalidSide.selector);
        orders.createOrder(p);
    }

    // ---------------------------------------------------------------- repeat

    /// Repeating a side that takes everything out and adds nothing back means nothing: after the first run there is
    /// no position left to run on. Withdraw-all and withdraw-and-convert sides cannot repeat.
    function test_repeatOnAFullWithdrawIsRefused() public {
        OrderState.Side memory s = _exit(OrderState.CHECK_TICK, -300);
        s.repeat = true;
        s.shape = 60;
        _refuse(s, _off());

        s.actions |= OrderState.ACT_SWAP; // withdraw and convert
        s.swapToToken1 = true;
        _refuse(s, _off());

        s.runsLeft = 3;
        _refuse(s, _off());
    }

    /// A ladder (part of the position each time) can repeat: something is left for the next rung.
    function test_repeatOnAPartialWithdrawIsAllowed() public {
        OrderState.Side memory s = _side(OrderState.CHECK_TICK, -300, OrderState.ACT_REMOVE, 2_500);
        s.repeat = true;
        s.shape = 60;
        _create(s, _off());
    }

    function test_runLimitNeedsRepeat() public {
        OrderState.Side memory s = _side(OrderState.CHECK_TICK, -300, OrderState.ACT_REMOVE, 2_500);
        s.runsLeft = 2;
        _refuse(s, _off());
    }

    // ---------------------------------------------------------------- conditions

    /// APR is a reason to leave: only on the lower side ("earns less than"), and only on a side that exits or moves
    /// (otherwise it would stay true and fire again and again).
    function test_aprOnlyToLeaveOnTheLowerSide() public {
        OrderState.Side memory leave = _exit(OrderState.CHECK_APR, 1_000);
        _refuse(_off(), leave); // upper side
        OrderState.Side memory stay = _side(OrderState.CHECK_APR, 1_000, OrderState.ACT_REMOVE, 0);
        _refuse(stay, _off()); // sends fees out and stays
        _create(leave, _off());
    }

    function test_feesConditionNeedsAPositiveShare() public {
        _refuse(_off(), _side(OrderState.CHECK_FEES, 0, OrderState.ACT_KEEP_FEES | OrderState.ACT_ADD, 0));
        _refuse(_off(), _side(OrderState.CHECK_FEES, 10_001, OrderState.ACT_KEEP_FEES | OrderState.ACT_ADD, 0));
    }

    /// A hold is at most a day.
    function test_holdIsAtMostADay() public {
        OrderState.Side memory s = _exit(OrderState.CHECK_EDGE, 0);
        s.holdMinutes = 1441;
        _refuse(s, _off());
        s.holdMinutes = 1440;
        _create(s, _off());
    }

    /// A trailing stop and a hold now go together (the hold no longer needs the side's memory).
    function test_trailWithAHold() public {
        OrderState.Side memory s = _exit(OrderState.CHECK_TRAIL, 300);
        s.holdMinutes = 15;
        _create(s, _off());
    }

    function test_twoTrailsOnOneSideRefused() public {
        OrderState.Side memory s = _exit(OrderState.CHECK_TRAIL, 300);
        s.combine = OrderState.COMBINE_AND;
        s.checker2 = OrderState.CHECK_TRAIL;
        s.value2 = 600;
        _refuse(s, _off());
    }

    /// A condition can read any registered pool, with or without a hook; not one nobody registered.
    function test_conditionsReadAnyRegisteredPool() public {
        PoolKey memory bare = PoolKey(currency0, currency1, 500, 10, IHooks(address(0)));
        poolManager.initialize(bare, Constants.SQRT_PRICE_1_1);
        OrderState.Side memory s = _exit(OrderState.CHECK_TICK, -300);
        s.checkPool = 2;
        _refuse(s, _off()); // not registered yet
        assertEq(rules.registerPool(bare), 2);
        _create(s, _off());
    }

    function test_conditionCannotNameItsOwnPool() public {
        OrderState.Side memory s = _exit(OrderState.CHECK_TICK, -300);
        s.checkPool = 1; // the order's own pool is named 0
        _refuse(s, _off());
    }

    // ---------------------------------------------------------------- moves

    function test_moveNeedsASecondLeg() public {
        _refuse(_moveSide(OrderState.CHECK_EDGE, 0, 1), _off());
    }

    function test_offSideMustBeEmpty() public {
        OrderState.Side memory s;
        s.value = 1;
        _refuse(s, _exit(OrderState.CHECK_EDGE, 0));
    }

    /// The fields the contract keeps (range edge, last run, trailing best) are never taken from the caller.
    function test_keptFieldsMustBeZero() public {
        OrderState.Side memory s = _exit(OrderState.CHECK_TRAIL, 300);
        s.best = 5;
        _refuse(s, _off());
        s.best = 0;
        s.lastRun = uint32(_now());
        _refuse(s, _off());
    }

    // ---------------------------------------------------------------- packing helpers

    function test_encodeAndDecodeHelpers() public view {
        OrderState.Side memory s = _moveSide(OrderState.CHECK_TRAIL, 1_200, 2);
        s.holdMinutes = 30;
        s.runsLeft = 4;
        uint256 w = rules.encode(s);
        assertEq(w, OrderState.encodeSide(s));
        assertEq(abi.encode(rules.decode(w)), abi.encode(s));
    }
}

/// @notice Which two-leg strategies are allowed.
contract LegRulesTest is RuleSetup {
    Currency currency2;
    PoolKey other; // currency1 with currency2 (shares currency1 with the main pool)
    uint24 otherIndex;

    function setUp() public override {
        super.setUp();
        MockERC20 t = deployToken();
        currency2 = Currency.wrap(address(t));
        MockAggregator f = new MockAggregator(8, 1e8);
        feeds.setFeed(address(t), address(f), MAX_AGE);
        (Currency a, Currency b) = currency1 < currency2 ? (currency1, currency2) : (currency2, currency1);
        other = _newPool(a, b, Constants.SQRT_PRICE_1_1);
        otherIndex = rules.poolIndexOf(other.toId());
        _wait(1 hours);
    }

    function _twoLegs(OrderState.Side memory homeLower, OrderState.Leg memory away, OrderState.Side memory awayUpper)
        internal
        view
        returns (ConditionalOrders.CreateParams memory p)
    {
        p = _params(homeLower, _off());
        p.home = OrderState.Leg({poolIndex: 0, kind: OrderState.LEG_RANGE, a: -600, b: 600});
        p.away = away;
        p.awayUpper = _w(awayUpper);
    }

    /// Moving from (token0, token1) to (token1, token2): token0 has no place in the other pool, so the move must
    /// sell it for the shared token first. Without the swap, or swapping the wrong way, it is refused.
    function test_crossPairMoveMustSwapIntoTheSharedToken() public {
        OrderState.Leg memory park = OrderState.Leg({poolIndex: otherIndex, kind: OrderState.LEG_RANGE, a: -60, b: 60});
        bool sharedIs0 = currency1 < currency2; // where currency1 sits in the other pool
        OrderState.Side memory back = _moveSide(OrderState.CHECK_TICK, -600, sharedIs0 ? 2 : 1);
        back.checkPool = 1; // reads the main pool

        ConditionalOrders.CreateParams memory p = _twoLegs(_moveSide(OrderState.CHECK_EDGE, 0, 0), park, back);
        vm.prank(alice);
        vm.expectRevert(Rules.InvalidLeg.selector);
        orders.createOrder(p); // no swap on the way out

        p = _twoLegs(_moveSide(OrderState.CHECK_EDGE, 0, 2), park, back);
        vm.prank(alice);
        vm.expectRevert(Rules.InvalidLeg.selector);
        orders.createOrder(p); // swaps into token0, which the other pool does not have

        p = _twoLegs(_moveSide(OrderState.CHECK_EDGE, 0, 1), park, _moveSide(OrderState.CHECK_TICK, -600, 0));
        p.awayUpper = _w(_withPool(_moveSide(OrderState.CHECK_TICK, -600, 0), 1));
        vm.prank(alice);
        vm.expectRevert(Rules.InvalidLeg.selector);
        orders.createOrder(p); // no swap on the way back

        p = _twoLegs(_moveSide(OrderState.CHECK_EDGE, 0, 1), park, back);
        vm.prank(alice);
        orders.createOrder(p);
    }

    function _withPool(OrderState.Side memory s, uint24 pool) internal pure returns (OrderState.Side memory) {
        s.checkPool = pool;
        return s;
    }

    /// A waiting leg only moves on: it has no position to exit, compound or measure fees on.
    function test_waitingLegOnlyMoves() public {
        OrderState.Leg memory wait = OrderState.Leg({poolIndex: 1, kind: OrderState.LEG_IDLE, a: 0, b: 0});
        ConditionalOrders.CreateParams memory p =
            _twoLegs(_moveSide(OrderState.CHECK_EDGE, 0, 1), wait, _exit(OrderState.CHECK_TRAIL, 300));
        vm.prank(alice);
        vm.expectRevert(Rules.InvalidSide.selector);
        orders.createOrder(p);

        p = _twoLegs(_moveSide(OrderState.CHECK_EDGE, 0, 1), wait, _moveIdle(OrderState.CHECK_EDGE, 0));
        vm.prank(alice);
        vm.expectRevert(Rules.InvalidSide.selector);
        orders.createOrder(p); // no range edge while waiting

        p = _twoLegs(_moveSide(OrderState.CHECK_EDGE, 0, 1), wait, _moveIdle(OrderState.CHECK_TRAIL, 300));
        vm.prank(alice);
        orders.createOrder(p);
    }

    /// A waiting leg keeps the tokens in the pair they are in: it names the pool it came from.
    function test_waitingLegIsInTheHomePool() public {
        OrderState.Leg memory wait = OrderState.Leg({poolIndex: otherIndex, kind: OrderState.LEG_IDLE, a: 0, b: 0});
        ConditionalOrders.CreateParams memory p =
            _twoLegs(_moveSide(OrderState.CHECK_EDGE, 0, 1), wait, _moveIdle(OrderState.CHECK_TRAIL, 300));
        vm.prank(alice);
        vm.expectRevert(Rules.InvalidLeg.selector);
        orders.createOrder(p);
    }

    /// Each leg needs a way out, or the strategy could sit in one leg forever.
    function test_eachLegNeedsAMove() public {
        OrderState.Leg memory wait = OrderState.Leg({poolIndex: 1, kind: OrderState.LEG_IDLE, a: 0, b: 0});
        ConditionalOrders.CreateParams memory p =
            _twoLegs(_exit(OrderState.CHECK_EDGE, 0), wait, _moveIdle(OrderState.CHECK_TRAIL, 300));
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.InvalidOrder.selector);
        orders.createOrder(p);
    }

    /// Re-entering "this range" must name this order's range; a centred range must fit the spacing.
    function test_homeLegMatchesTheRange() public {
        OrderState.Leg memory wait = OrderState.Leg({poolIndex: 1, kind: OrderState.LEG_IDLE, a: 0, b: 0});
        ConditionalOrders.CreateParams memory p =
            _twoLegs(_moveSide(OrderState.CHECK_EDGE, 0, 1), wait, _moveIdle(OrderState.CHECK_TRAIL, 300));
        p.home.b = 660;
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.InvalidOrder.selector);
        orders.createOrder(p);

        p.home = OrderState.Leg({poolIndex: 0, kind: OrderState.LEG_CENTERED, a: 600, b: 650});
        vm.prank(alice);
        vm.expectRevert(Rules.InvalidLeg.selector);
        orders.createOrder(p);
    }
}
