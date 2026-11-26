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

/// @notice Keeper pay, payouts, and the token list. Pay depends on the gas price, and Foundry's isolate mode runs
/// calls at gas price 0, so the pay tests run as one transaction (isolate = false). Rules read averages, so they are
/// timed rules (CHECK_TIME) here where the price does not matter.
contract KeeperPayTest is RuleSetup {
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

    /// A timed exit after 1 minute, ceiling 1%.
    function _timed() internal pure returns (OrderState.Side memory) {
        return _exit(OrderState.CHECK_TIME, 1);
    }

    // ---------------------------------------------------------------- pay

    /// The keeper is paid its gas (at a capped gas price, plus a premium) in the order's tokens, at most the
    /// ceiling. In a token pool that is token units at the Chainlink price: 1 ETH = 2,000 tokens here.
    /// forge-config: default.isolate = false
    function test_payIsTheGasCostInTheOrdersTokens() public {
        uint256 id = _create(_off(), _timed());
        _wait(2 minutes);
        uint256 g = gasleft();
        _run(id, true);
        uint256 used = g - gasleft();
        uint256 paid = _bal(currency0, keeper) + _bal(currency1, keeper);
        uint256 costInTokens = rules.gasWei(used) * 2000; // ETH at $2,000, tokens at $1
        assertGt(paid, (costInTokens * 80) / 100);
        assertLt(paid, (costInTokens * 150) / 100);
    }

    /// The order's ceiling caps the pay, however high the gas.
    /// forge-config: default.isolate = false
    function test_payNeverAboveTheCeiling() public {
        ConditionalOrders.CreateParams memory p = _params(_off(), _timed());
        p.maxKeeperFeeBps = 1; // 0.01%
        p.liquidity = 0.001e18; // a tiny order
        feeds.setMinOrderUsd(0);
        uint256 id = _submit(alice, p);
        _wait(2 minutes);
        _run(id, true);
        // the tiny position holds ~0.00003 of each token: 0.01% of that
        assertLe(_bal(currency0, keeper) + _bal(currency1, keeper), 1e10);
    }

    /// The gas price counted is capped at base fee + 0.01 gwei, so a keeper gains nothing by bidding high.
    /// forge-config: default.isolate = false
    function test_gasPriceIsCapped() public {
        uint256 id = _create(_off(), _timed());
        _wait(2 minutes);
        vm.txGasPrice(500 gwei);
        assertEq(rules.gasWei(1), 0.0005 gwei + 0.01 gwei);
        _run(id, true);
        assertLt(_bal(currency0, keeper) + _bal(currency1, keeper), 1e16);
    }

    /// Without a price for both tokens the keeper gets the ceiling: a broken feed never strands an order.
    /// forge-config: default.isolate = false
    function test_brokenFeedPaysTheCeiling() public {
        uint256 id = _create(_off(), _timed());
        _wait(2 minutes);
        feed0.setBroken(true);
        _run(id, true);
        uint256 paid = _bal(currency0, keeper) + _bal(currency1, keeper);
        assertGt(paid, 0.5e16); // ~1% of ~0.6 tokens
    }

    /// In an ETH pool the part paid in ETH is the gas cost itself.
    /// forge-config: default.isolate = false
    function test_ethPoolPaysGasInEth() public {
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
        PoolKey memory k = _newPool(a, b, Constants.SQRT_PRICE_1_1);
        ConditionalOrders.CreateParams memory p = _params(_off(), _timed());
        p.key = k;
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.TokenNotAllowed.selector);
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

    function test_minimumOrderSize() public {
        feeds.setMinOrderUsd(100e18);
        ConditionalOrders.CreateParams memory p = _params(_off(), _timed()); // ~$0.6
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.OrderTooSmall.selector);
        orders.createOrder(p);
    }
}
