// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";

import {RuleSetup} from "./utils/RuleSetup.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {PriceFeeds} from "../src/PriceFeeds.sol";
import {OrderState} from "../src/libraries/OrderState.sol";
import {Rules} from "../src/Rules.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @notice What an LP should be able to take for granted, whatever the strategy: their money stays theirs, nobody
/// else can change or take it, and a call that makes no sense is refused instead of doing something odd.
contract SafetyTest is RuleSetup {
    // ---------------------------------------------------------------- money stays with its owner

    /// Two LPs in the exact same range share one PoolManager position key only if the vault mixes them up.
    /// Each order is its own position: closing one leaves the other untouched, and each gets back what it put in.
    function test_twoOwnersInTheSameRangeAreKeptApart() public {
        uint256 a0 = _bal(currency0, alice);
        uint256 a1 = _bal(currency1, alice);
        uint256 b0 = _bal(currency0, bob);
        uint256 b1 = _bal(currency1, bob);
        uint256 a = _create(_exit(OrderState.CHECK_EDGE, 0), _off());
        uint256 b = _submit(bob, _params(_exit(OrderState.CHECK_EDGE, 0), _off()));

        vm.prank(alice);
        orders.cancel(a);
        assertEq(_liquidity(b), 10e18);
        assertApproxEqAbs(_bal(currency0, alice), a0, 2);
        assertApproxEqAbs(_bal(currency1, alice), a1, 2);

        vm.prank(bob);
        orders.cancel(b);
        assertApproxEqAbs(_bal(currency0, bob), b0, 2);
        assertApproxEqAbs(_bal(currency1, bob), b1, 2);
        assertEq(_bal(currency0, address(orders)), 0);
        assertEq(_bal(currency1, address(orders)), 0);
    }

    /// Any range and any size: putting money in and taking it straight out gives it back (to rounding).
    function testFuzz_createThenCancelGivesTheMoneyBack(int24 lower, uint24 width, uint128 liquidity) public {
        lower = int24(bound(lower, -6000, 5940)) / 60 * 60;
        int24 upper = lower + int24(uint24(bound(width, 1, 100))) * 60;
        liquidity = uint128(bound(liquidity, 1e15, 50e18));
        uint256 b0 = _bal(currency0, alice);
        uint256 b1 = _bal(currency1, alice);

        ConditionalOrders.CreateParams memory p = _params(_exit(OrderState.CHECK_TIME, 60), _off());
        p.tickLower = lower;
        p.tickUpper = upper;
        p.liquidity = liquidity;
        vm.prank(alice);
        try orders.createOrder(p) returns (uint256 id) {
            vm.prank(alice);
            orders.cancel(id);
        } catch (bytes memory reason) {
            // the only acceptable refusal is a position worth less than the minimum order size
            assertEq(bytes4(reason), ConditionalOrders.OrderTooSmall.selector);
        }
        assertApproxEqAbs(_bal(currency0, alice), b0, 2);
        assertApproxEqAbs(_bal(currency1, alice), b1, 2);
    }

    /// The deposit never takes more than the LP allowed.
    function test_createNeverTakesMoreThanTheMaximum() public {
        ConditionalOrders.CreateParams memory p = _params(_exit(OrderState.CHECK_EDGE, 0), _off());
        p.amount0Max = 1e15; // far less than 10e18 liquidity in [-600, 600] needs
        vm.prank(alice);
        vm.expectRevert();
        orders.createOrder(p);
    }

    // ---------------------------------------------------------------- nobody else can change it

    function test_onlyTheOwnerChangesTheRules() public {
        uint256 id = _create(_exit(OrderState.CHECK_EDGE, 0), _off());
        ConditionalOrders.UpdateParams memory u;
        u.lower = _w(_exit(OrderState.CHECK_EDGE, 0));
        u.expiry = uint32(_now() + 1 days);
        vm.prank(bob);
        vm.expectRevert(ConditionalOrders.NotOwner.selector);
        orders.updateOrder(id, u);
    }

    function test_aRuleRunsOnlyWhenItsConditionIsMet() public {
        uint256 id = _create(_exit(OrderState.CHECK_EDGE, 0), _off());
        vm.expectRevert(ConditionalOrders.TooSoon.selector);
        _run(id, false); // never in the block it was made: a price pushed there cannot fire it
        _wait(2 minutes);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, false); // the price is still in the range
        assertEq(_liquidity(id), 10e18);
    }

    /// The batch helper is only for the batch itself: nobody can call it to skip the checks around it.
    function test_runOneIsOnlyForTheBatch() public {
        uint256 id = _create(_exit(OrderState.CHECK_EDGE, 0), _off());
        vm.expectRevert(ConditionalOrders.OnlySelf.selector);
        orders.runOne(id, false, keeper, 1);
    }

    function test_onlyThePoolManagerCallsBack() public {
        vm.expectRevert();
        orders.unlockCallback(abi.encode(uint8(0), uint256(1), bytes("")));
    }

    // ---------------------------------------------------------------- closed means closed

    function test_aClosedOrderCannotBeRunOrClosedAgain() public {
        uint256 id = _create(_exit(OrderState.CHECK_EDGE, 0), _off());
        vm.prank(alice);
        orders.cancel(id);
        vm.expectRevert(ConditionalOrders.UnknownOrder.selector);
        _run(id, false);
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.UnknownOrder.selector);
        orders.cancel(id);
        vm.expectRevert(ConditionalOrders.UnknownOrder.selector);
        orders.poke(id, false);
    }

    /// A rule that withdraws everything closes the order: there is nothing left for a keeper to run again.
    function test_aFullExitClosesTheOrder() public {
        uint256 id = _create(_off(), _exit(OrderState.CHECK_EDGE, 0));
        _swap(false, 5e18);
        _settle();
        _run(id, true);
        assertEq(orders.getOrder(id).owner, address(0));
        vm.expectRevert(ConditionalOrders.UnknownOrder.selector);
        _run(id, true);
    }

    // ---------------------------------------------------------------- the batch

    /// A batch with one order that is ready, one that is not, and one that is closed runs the ready one and leaves
    /// the others exactly as they were.
    function test_batchRunsWhatIsReadyAndLeavesTheRest() public {
        uint256 ready = _create(_off(), _exit(OrderState.CHECK_EDGE, 0));
        uint256 waiting = _create(_exit(OrderState.CHECK_EDGE, 0), _off());
        uint256 closed = _create(_exit(OrderState.CHECK_EDGE, 0), _off());
        vm.prank(alice);
        orders.cancel(closed);
        _swap(false, 5e18);
        _settle();

        uint256[] memory ids = new uint256[](3);
        bool[] memory uppers = new bool[](3);
        (ids[0], ids[1], ids[2]) = (ready, waiting, closed);
        (uppers[0], uppers[1], uppers[2]) = (true, false, false);
        vm.prank(keeper);
        uint256 ran = orders.executeMany(ids, uppers);
        assertEq(ran, 1);
        assertEq(orders.getOrder(ready).owner, address(0));
        assertEq(_liquidity(waiting), 10e18);
    }

    function test_aBatchMustBeWellFormed() public {
        vm.expectRevert(ConditionalOrders.InvalidOrder.selector);
        orders.executeMany(new uint256[](0), new bool[](0));
        vm.expectRevert(ConditionalOrders.InvalidOrder.selector);
        orders.executeMany(new uint256[](2), new bool[](1));
    }

    // ---------------------------------------------------------------- refused inputs

    function test_ethSentWithATokenPoolIsRefused() public {
        ConditionalOrders.CreateParams memory p = _params(_exit(OrderState.CHECK_EDGE, 0), _off());
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.BadMsgValue.selector);
        orders.createOrder{value: 1 ether}(p);
    }

    function test_anOrderMustDoSomething() public {
        ConditionalOrders.CreateParams memory p = _params(_off(), _off());
        vm.prank(alice);
        vm.expectRevert();
        orders.createOrder(p);
    }

    function test_anExpiryInThePastIsRefused() public {
        ConditionalOrders.CreateParams memory p = _params(_exit(OrderState.CHECK_EDGE, 0), _off());
        p.expiry = uint32(_now());
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.InvalidOrder.selector);
        orders.createOrder(p);

        uint256 id = _create(_exit(OrderState.CHECK_EDGE, 0), _off());
        ConditionalOrders.UpdateParams memory u;
        u.lower = _w(_exit(OrderState.CHECK_EDGE, 0));
        u.expiry = uint32(_now());
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.InvalidOrder.selector);
        orders.updateOrder(id, u);
    }

    function test_theKeeperCeilingIsCapped() public {
        ConditionalOrders.CreateParams memory p = _params(_exit(OrderState.CHECK_EDGE, 0), _off());
        p.maxKeeperFeeBps = orders.MAX_KEEPER_FEE_BPS() + 1;
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.InvalidOrder.selector);
        orders.createOrder(p);
    }

    /// Only pools that use this hook: a plain pool of the same pair cannot hold rules (nothing would watch its price).
    function test_rulesOnlyInHookPools() public {
        PoolKey memory plain = PoolKey(currency0, currency1, 500, 10, IHooks(address(0)));
        poolManager.initialize(plain, Constants.SQRT_PRICE_1_1);
        ConditionalOrders.CreateParams memory p = _params(_exit(OrderState.CHECK_EDGE, 0), _off());
        p.key = plain;
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.PoolNotAllowed.selector);
        orders.createOrder(p);
    }

    function test_nothingOwedNothingToWithdraw() public {
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.NothingOwed.selector);
        orders.withdraw(currency0, alice);
    }

    // ---------------------------------------------------------------- the price list's owner

    function test_ownershipMovesOnlyWhenTheNewOwnerAccepts() public {
        feeds.transferOwnership(bob);
        assertEq(feeds.owner(), address(this)); // not yet
        vm.prank(alice);
        vm.expectRevert(PriceFeeds.NotOwner.selector);
        feeds.acceptOwnership();
        vm.prank(bob);
        feeds.acceptOwnership();
        assertEq(feeds.owner(), bob);
        vm.expectRevert(PriceFeeds.NotOwner.selector);
        feeds.setMinOrderUsd(1);
    }

    function test_rangeEdgesAtTheLimitsWork() public {
        ConditionalOrders.CreateParams memory p = _params(_exit(OrderState.CHECK_TIME, 60), _off());
        p.tickLower = TickMath.minUsableTick(60);
        p.tickUpper = TickMath.maxUsableTick(60);
        p.liquidity = 1e18;
        uint256 id = _submit(alice, p);
        assertEq(_liquidity(id), 1e18);
    }

    // ---------------------------------------------------------------- runs happen at believable prices

    /// A rule that deposits (compound) never does it at a price someone just pushed: the deposit would be traded
    /// back through at the LP's expense.
    function test_noDepositAtAPushedPrice() public {
        OrderState.Side memory c = _side(OrderState.CHECK_TIME, 1, OrderState.ACT_KEEP_FEES | OrderState.ACT_ADD, 0);
        c.repeat = true;
        uint256 id = _create(c, _off());
        _wait(2 minutes);
        _swap(true, 3e18); // pushed in this block, far from the average
        vm.expectRevert(Rules.PriceMoved.selector);
        _run(id, false);
        _settle(); // once the price has held, it runs
        _run(id, false);
    }

    /// With the list's band set, a pool price held away from Chainlink for minutes cannot run a rule either; when
    /// the market really moved (Chainlink agrees), it runs.
    function test_aPoolHeldAwayFromChainlinkCannotRunARule() public {
        feeds.setMaxDeviationTicks(200); // about 2%
        uint256 id = _create(_exit(OrderState.CHECK_TIME, 1), _off());
        _swap(false, 3e18); // the pool's price up about 6%, held
        _settle();
        _wait(2 minutes);
        _swap(true, 1);
        _wait(2 minutes);
        vm.expectRevert(Rules.PriceMoved.selector);
        _run(id, false);

        feed0.setAnswer(1.06e8); // the market agrees: token0 is worth 6% more
        (bool ok, int24 link) = feeds.pairTick(Currency.unwrap(currency0), Currency.unwrap(currency1));
        assertTrue(ok);
        assertLt(_dist(link, _avg()), 200);
        _run(id, false);
        assertEq(orders.getOrder(id).owner, address(0));
    }

    /// "Leave when fees earn less than 5% a year" must not fire on a young position earning more than that, just
    /// because its fees are still below one basis point.
    function test_aYoungPositionEarningWellIsNotLowAPR() public {
        uint256 id = _create(_exit(OrderState.CHECK_APR, 500), _off());
        _swap(true, 0.05e18);
        _swap(false, 0.05e18); // a little trading: well above 5% a year, but under 1 bp of the position
        _wait(1 hours + 1);
        (, uint256 bps) = rules.feeBps(address(orders), id, 1, -600, 600);
        assertEq(bps, 0);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        _run(id, false);
    }

    /// Following the price never ends the order by itself: even when the price of the moment dipped back under
    /// the average, the new range is placed where the held token fills it.
    function test_followingThePriceNeverEndsTheOrder() public {
        OrderState.Side memory f = _exit(OrderState.CHECK_EDGE, 60);
        f.actions |= OrderState.ACT_ADD;
        f.addMode = OrderState.ADD_ONE_SIDED;
        f.shape = 5;
        f.repeat = true;
        uint256 id = _create(_off(), f);
        _swap(false, 5e18);
        _settle();
        _swap(true, 0.05e18); // the price of the moment dips just under the average
        assertLt(_tick(), _avg());
        _run(id, true);
        assertTrue(orders.getOrder(id).owner != address(0));
        assertGt(_liquidity(id), 0);
        (, OrderState.Side memory up) = _state(id);
        assertLe(up.edge, _tick()); // entirely below the price: all token1
    }

    function _dist(int24 a, int24 b) internal pure returns (uint256) {
        return a > b ? uint256(int256(a) - b) : uint256(int256(b) - a);
    }
}
