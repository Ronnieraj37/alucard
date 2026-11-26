// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";

import {EasyPosm} from "./utils/libraries/EasyPosm.sol";

import {RuleSetup} from "./utils/RuleSetup.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {PriceFeeds} from "../src/PriceFeeds.sol";
import {Rules} from "../src/Rules.sol";
import {OrderState} from "../src/libraries/OrderState.sol";

/// @dev An order owner that refuses ETH, or burns all the gas it is given.
contract EthOwner {
    bool public accept = true;
    bool public burn;

    receive() external payable {
        require(accept, "no ETH");
        if (burn) {
            while (true) {}
        }
    }

    function set(bool _accept, bool _burn) external {
        (accept, burn) = (_accept, _burn);
    }

    function create(ConditionalOrders o, ConditionalOrders.CreateParams calldata p) external payable returns (uint256) {
        return o.createOrder{value: msg.value}(p);
    }

    function approve(address token, address spender) external {
        MockERC20(token).approve(spender, type(uint256).max);
    }

    function withdraw(ConditionalOrders o, Currency c, address to) external returns (uint256) {
        return o.withdraw(c, to);
    }
}

/// @notice The keeper's fee, payouts, pools and the token list. The fee is the owner's: a set share of what each run
/// takes out, whatever the gas price. These are timed rules (CHECK_TIME), so the price does not matter.
contract KeeperFeeTest is RuleSetup {
    using EasyPosm for IPositionManager;

    PoolKey ethKey;
    Currency constant ETH = Currency.wrap(address(0));
    EthOwner owner;

    receive() external payable {} // ETH refunds from the position manager

    function setUp() public override {
        super.setUp();
        ethKey = PoolKey(ETH, currency1, 3000, 60, IHooks(hook));
        poolManager.initialize(ethKey, Constants.SQRT_PRICE_1_1);
        vm.deal(address(this), 10_000 ether);
        positionManager.mint(
            ethKey,
            TickMath.minUsableTick(60),
            TickMath.maxUsableTick(60),
            100e18,
            200 ether,
            type(uint256).max,
            address(this),
            type(uint256).max,
            Constants.ZERO_BYTES
        );
        owner = new EthOwner();
        MockERC20(Currency.unwrap(currency1)).transfer(address(owner), 1_000e18);
        owner.approve(Currency.unwrap(currency1), address(orders));
        vm.deal(address(owner), 100 ether);
        _wait(1 hours);
    }

    /// A timed exit after 1 minute.
    function _timed() internal pure returns (OrderState.Side memory) {
        return _exit(OrderState.CHECK_TIME, 1);
    }

    // ---------------------------------------------------------------- the fee

    /// The keeper gets exactly the owner's fee (1% here) of each token the run takes out; the owner gets the rest.
    function test_keeperGetsTheOwnersFee() public {
        uint256 id = _create(_off(), _timed());
        _wait(2 minutes);
        (uint256 a0, uint256 a1) = rules.orderAmounts(orders, id);
        uint256 o0 = _bal(currency0, alice);
        uint256 o1 = _bal(currency1, alice);
        _run(id, true);
        assertApproxEqAbs(_bal(currency0, keeper), a0 / 100, 2);
        assertApproxEqAbs(_bal(currency1, keeper), a1 / 100, 2);
        assertApproxEqAbs(_bal(currency0, alice) - o0, a0 - a0 / 100, 2);
        assertApproxEqAbs(_bal(currency1, alice) - o1, a1 - a1 / 100, 2);
    }

    /// The fee does not depend on the gas price: a keeper cannot raise it by paying more for gas.
    /// forge-config: default.isolate = false
    function test_theFeeIgnoresTheGasPrice() public {
        uint256 a = _create(_off(), _timed());
        uint256 b = _submit(bob, _params(_off(), _timed()));
        _wait(2 minutes);
        _run(a, true);
        uint256 cheap = _bal(currency1, keeper);
        vm.txGasPrice(500 gwei);
        _run(b, true);
        assertApproxEqAbs(_bal(currency1, keeper) - cheap, cheap, 2);
    }

    /// After a swap the fee is paid in the token the owner asked for, out of what the swap produced.
    function test_aSwapPaysTheFeeInTheTokenBought() public {
        OrderState.Side memory s = _timed();
        s.actions |= OrderState.ACT_SWAP;
        s.swapToToken1 = true;
        uint256 id = _create(_off(), s);
        _wait(2 minutes);
        _run(id, true);
        assertEq(_bal(currency0, keeper), 0);
        assertGt(_bal(currency1, keeper), 0);
    }

    /// An owner can run without paying anyone: a fee of 0 is allowed (they or a friend run it).
    function test_aZeroFeeOrderStillRuns() public {
        ConditionalOrders.CreateParams memory p = _params(_off(), _timed());
        p.keeperFeeBps = 0;
        uint256 id = _submit(alice, p);
        _wait(2 minutes);
        _run(id, true);
        assertEq(_bal(currency0, keeper) + _bal(currency1, keeper), 0);
        assertEq(orders.getOrder(id).owner, address(0));
    }

    /// In an ETH pool the fee's ETH part is paid as ETH.
    function test_ethPoolPaysTheFeeInEth() public {
        ConditionalOrders.CreateParams memory p = _params(_off(), _timed());
        p.key = ethKey;
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        uint256 id = orders.createOrder{value: 1 ether}(p);
        _wait(2 minutes);
        uint256 before = keeper.balance;
        _run(id, true);
        assertGt(keeper.balance - before, 0);
    }

    // ---------------------------------------------------------------- pools

    /// Strategies work in any pool of listed tokens: here a hookless pool of the same pair.
    function test_aHooklessPoolWorks() public {
        PoolKey memory bare = PoolKey(currency0, currency1, 500, 10, IHooks(address(0)));
        poolManager.initialize(bare, Constants.SQRT_PRICE_1_1);
        _addFullRange(bare);
        ConditionalOrders.CreateParams memory p = _params(_off(), _timed());
        p.key = bare;
        uint256 id = _submit(alice, p);
        _wait(2 minutes);
        _run(id, true);
        assertEq(orders.getOrder(id).owner, address(0));
    }

    /// A pool with some other hook is refused: its hook could take a cut of the order's swaps or block them.
    function test_aPoolWithAnotherHookIsRefused() public {
        PoolKey memory other = PoolKey(currency0, currency1, 500, 10, IHooks(address(0xBEEF)));
        vm.expectRevert(Rules.PoolNotAllowed.selector);
        rules.registerPool(other);
    }

    function test_aPoolIsRegisteredOnce() public {
        assertEq(rules.registerPool(poolKey), 1);
        assertEq(rules.poolCount(), 1);
    }

    // ---------------------------------------------------------------- payouts

    function _ethOrder() internal returns (uint256) {
        ConditionalOrders.CreateParams memory p = _params(_off(), _timed());
        p.key = ethKey;
        return owner.create{value: 1 ether}(orders, p);
    }

    /// An owner that refuses ETH: the run still completes, the ETH is kept as `owed`, and it can be withdrawn to
    /// any address.
    function test_ownerThatRefusesEthIsOwed() public {
        uint256 id = _ethOrder();
        owner.set(false, false);
        _wait(2 minutes);
        _run(id, true);
        uint256 owedEth = orders.owed(address(owner), ETH);
        assertGt(owedEth, 0);
        address to = makeAddr("elsewhere");
        owner.withdraw(orders, ETH, to);
        assertEq(to.balance, owedEth);
        assertEq(orders.owed(address(owner), ETH), 0);
    }

    /// An owner whose receive burns all the gas it gets: it gets PAYOUT_GAS, then the ETH is kept as owed. The
    /// keeper's transaction is not drained.
    function test_ownerThatBurnsGasCannotDrainTheKeeper() public {
        uint256 id = _ethOrder();
        owner.set(true, true);
        _wait(2 minutes);
        uint256 g = gasleft();
        _run(id, true);
        assertLt(g - gasleft(), 600_000);
        assertGt(orders.owed(address(owner), ETH), 0);
    }

    // ---------------------------------------------------------------- the token list

    function test_newOrdersNeedListedTokens() public {
        MockERC20 t = deployToken();
        (Currency a, Currency b) = address(t) < Currency.unwrap(currency0)
            ? (Currency.wrap(address(t)), currency0)
            : (currency0, Currency.wrap(address(t)));
        PoolKey memory k = PoolKey(a, b, 3000, 60, IHooks(address(0)));
        poolManager.initialize(k, Constants.SQRT_PRICE_1_1);
        ConditionalOrders.CreateParams memory p = _params(_off(), _timed());
        p.key = k;
        vm.prank(alice);
        vm.expectRevert(Rules.TokenNotAllowed.selector);
        orders.createOrder(p);
    }

    /// Listing a new token is immediate; changing or removing a listed one needs an announcement and two days.
    function test_feedChangesWaitTwoDays() public {
        address token = Currency.unwrap(currency0);
        address newFeed = address(feed1);
        vm.expectRevert(PriceFeeds.NotQueued.selector);
        feeds.setFeed(token, newFeed, MAX_AGE); // not announced

        feeds.queueFeed(token, newFeed, MAX_AGE);
        _wait(2 days - 1);
        vm.expectRevert(PriceFeeds.NotQueued.selector);
        feeds.setFeed(token, newFeed, MAX_AGE); // too early
        _wait(1);
        vm.expectRevert(PriceFeeds.NotQueued.selector);
        feeds.setFeed(token, newFeed, MAX_AGE + 1); // not what was announced
        feeds.setFeed(token, newFeed, MAX_AGE);
        (address agg,,,) = feeds.feeds(token);
        assertEq(agg, newFeed);
    }

    function test_removingATokenWaitsTwoDays() public {
        address token = Currency.unwrap(currency0);
        feeds.queueFeed(token, address(0), 0);
        _wait(2 days);
        feeds.setFeed(token, address(0), 0);
        assertFalse(feeds.isListed(token));
    }

    function test_onlyTheOwnerChangesTheList() public {
        vm.startPrank(alice);
        vm.expectRevert(PriceFeeds.NotOwner.selector);
        feeds.queueFeed(Currency.unwrap(currency0), address(feed1), MAX_AGE);
        vm.expectRevert(PriceFeeds.NotOwner.selector);
        feeds.setFeed(address(0xBEEF), address(feed1), MAX_AGE);
        vm.stopPrank();
    }

    /// ETH held for an owner whose payout failed is theirs: an order in an ETH pool must bring its own ETH, so nobody
    /// can open (and cancel) a position with it. (Found in review: createOrder used to settle from the vault's balance.)
    function test_heldEthCannotPayForSomeoneElsesOrder() public {
        uint256 id = _ethOrder();
        owner.set(false, false);
        _wait(2 minutes);
        _run(id, true);
        uint256 owedEth = orders.owed(address(owner), ETH);
        assertGt(owedEth, 0);

        address attacker = makeAddr("attacker");
        MockERC20(Currency.unwrap(currency1)).transfer(attacker, 1_000e18);
        vm.startPrank(attacker);
        MockERC20(Currency.unwrap(currency1)).approve(address(orders), type(uint256).max);
        ConditionalOrders.CreateParams memory p = _params(_off(), _timed());
        p.key = ethKey;
        p.liquidity = uint128(owedEth / 2);
        p.amount0Max = uint128(owedEth);
        vm.expectRevert(ConditionalOrders.BadMsgValue.selector);
        orders.createOrder{value: 0}(p);
        vm.stopPrank();

        assertEq(address(orders).balance, owedEth);
        address to = makeAddr("elsewhere");
        owner.withdraw(orders, ETH, to);
        assertEq(to.balance, owedEth);
    }
}
