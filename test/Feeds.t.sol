// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console} from "forge-std/console.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {RuleSetup} from "./utils/RuleSetup.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {PriceFeeds} from "../src/PriceFeeds.sol";
import {MockAggregator} from "../src/testnet/MockAggregator.sol";
import {OrderState} from "../src/libraries/OrderState.sol";

/// @dev The token list, keeper pay through Chainlink prices, the Chainlink condition and executeMany.
///
/// Keeper pay is gas x gas price, and Foundry's isolate mode runs every call at gas price 0. So the pay tests run as
/// one transaction (isolate = false) with a set gas price. In one transaction the hook's "swapped in this
/// transaction" flag never clears, so those tests trigger with timers and never swap before a run.
contract FeedsTest is RuleSetup {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 constant GAS_PRICE = 0.0015 gwei;
    uint256 constant ETH_USD = 2000;

    function setUp() public override {
        super.setUp();
        vm.fee(0.0005 gwei);
        vm.txGasPrice(GAS_PRICE);
    }

    // ---------------------------------------------------------------- helpers

    function _off() internal pure returns (OrderState.Side memory s) {}

    /// @dev Fires 60 minutes after creation: withdraw everything.
    function _timedExit() internal pure returns (OrderState.Side memory d) {
        d.checker = OrderState.CHECK_TIME;
        d.value = 60;
        d.actions = OrderState.ACT_KEEP_FEES | OrderState.ACT_REMOVE;
        d.removeBps = 10_000;
    }

    /// @dev Fires on the pair's Chainlink price: withdraw everything.
    function _oracleExit(int24 level) internal pure returns (OrderState.Side memory d) {
        d.checker = OrderState.CHECK_ORACLE;
        d.value = level;
        d.actions = OrderState.ACT_KEEP_FEES | OrderState.ACT_REMOVE;
        d.removeBps = 10_000;
    }

    function _params(
        PoolKey memory key,
        int24 lo,
        int24 hi,
        uint128 liq,
        uint8 feeBps,
        OrderState.Side memory lower,
        OrderState.Side memory upper
    ) internal view returns (ConditionalOrders.CreateParams memory) {
        return ConditionalOrders.CreateParams({
            key: key,
            tickLower: lo,
            tickUpper: hi,
            liquidity: liq,
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max,
            swapPoolIndex: 0,
            expiry: uint32(block.timestamp + 30 days),
            maxKeeperFeeBps: feeBps,
            maxSlippage: 100,
            lower: lower,
            upper: upper
        });
    }

    function _order(address who, int24 lo, int24 hi, uint128 liq, uint8 feeBps, OrderState.Side memory upper)
        internal
        returns (uint256 id)
    {
        vm.prank(who);
        id = orders.createOrder(_params(poolKey, lo, hi, liq, feeBps, _off(), upper));
    }

    struct Paid {
        uint256 t0;
        uint256 t1;
        uint256 gasUsed;
    }

    function _run(uint256 id, bool upper) internal returns (Paid memory p) {
        uint256 k0 = _bal(currency0, keeper);
        uint256 k1 = _bal(currency1, keeper);
        vm.prank(keeper, keeper);
        uint256 g = gasleft();
        orders.execute(id, upper);
        p.gasUsed = g - gasleft();
        p.t0 = _bal(currency0, keeper) - k0;
        p.t1 = _bal(currency1, keeper) - k1;
    }

    /// @dev What `gasUsed` costs in a token worth $1 with 18 decimals, with the 120% token premium.
    function _gasInDollarToken(uint256 gasUsed) internal pure returns (uint256) {
        return (gasUsed * GAS_PRICE * ETH_USD * 12) / 10;
    }

    /// @dev Both measured runs of a comparison should see the same warm storage, so run one order first.
    function _warmUp() internal {
        uint256 id = _order(bob, -600, 600, 1e18, 100, _timedExit());
        vm.warp(block.timestamp + 61 minutes);
        _run(id, true);
    }

    // ---------------------------------------------------------------- token list

    function test_list_onlyListedTokensCanHaveOrders() public {
        feeds.removeFeed(Currency.unwrap(currency1));
        ConditionalOrders.CreateParams memory p = _params(poolKey, -600, 600, 1e18, 10, _off(), _timedExit());
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.TokenNotAllowed.selector);
        orders.createOrder(p);

        feeds.setFeed(Currency.unwrap(currency1), address(feed1), MAX_AGE);
        vm.prank(alice);
        assertGt(orders.createOrder(p), 0);
    }

    function test_list_openOrdersKeepRunningAfterDelisting() public {
        uint256 id = _order(alice, -600, 600, 1e18, 10, _timedExit());
        feeds.removeFeed(Currency.unwrap(currency0));
        vm.warp(block.timestamp + 61 minutes);
        uint256 a0 = _bal(currency0, alice);
        vm.prank(keeper);
        orders.execute(id, true);
        assertGt(_bal(currency0, alice), a0);
        (ConditionalOrders.Order memory o,) = orders.getOrder(id);
        assertEq(o.owner, address(0));
    }

    function test_list_adminOnly() public {
        MockAggregator f = new MockAggregator(8, 5e8);
        vm.startPrank(alice);
        vm.expectRevert(PriceFeeds.NotOwner.selector);
        feeds.setFeed(address(0xBEEF), address(f), MAX_AGE);
        vm.expectRevert(PriceFeeds.NotOwner.selector);
        feeds.removeFeed(Currency.unwrap(currency0));
        vm.expectRevert(PriceFeeds.NotOwner.selector);
        feeds.setMinOrderUsd(1);
        vm.expectRevert(PriceFeeds.NotOwner.selector);
        feeds.transferOwnership(alice);
        vm.stopPrank();

        feeds.transferOwnership(alice);
        assertEq(feeds.owner(), address(this)); // not until alice accepts
        vm.prank(bob);
        vm.expectRevert(PriceFeeds.NotOwner.selector);
        feeds.acceptOwnership();
        vm.prank(alice);
        feeds.acceptOwnership();
        assertEq(feeds.owner(), alice);
    }

    function test_list_refusesADeadFeed() public {
        address token = Currency.unwrap(currency0);
        MockAggregator zero = new MockAggregator(8, 0);
        vm.expectRevert(PriceFeeds.BadFeed.selector);
        feeds.setFeed(token, address(zero), MAX_AGE);

        MockAggregator old = new MockAggregator(8, 1e8);
        old.setUpdatedAt(block.timestamp - 2 days);
        vm.expectRevert(PriceFeeds.BadFeed.selector);
        feeds.setFeed(token, address(old), MAX_AGE);

        MockAggregator wide = new MockAggregator(19, 1e8);
        vm.expectRevert(PriceFeeds.BadFeed.selector);
        feeds.setFeed(token, address(wide), MAX_AGE);

        vm.expectRevert(PriceFeeds.BadFeed.selector);
        feeds.setFeed(token, address(0), MAX_AGE);
    }

    function test_list_tokensView() public {
        assertEq(feeds.tokens().length, 3);
        feeds.removeFeed(address(0));
        address[] memory t = feeds.tokens();
        assertEq(t.length, 2);
        for (uint256 i; i < t.length; ++i) assertTrue(t[i] != address(0));
        vm.expectRevert(PriceFeeds.NotListed.selector);
        feeds.removeFeed(address(0));
    }

    function test_minOrderSize() public {
        feeds.setMinOrderUsd(100e18); // $100
        ConditionalOrders.CreateParams memory small = _params(poolKey, -600, 600, 1e18, 10, _off(), _timedExit());
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.OrderTooSmall.selector);
        orders.createOrder(small); // about $0.06

        ConditionalOrders.CreateParams memory big = _params(poolKey, -600, 600, 5_000e18, 10, _off(), _timedExit());
        uint256 a0 = _bal(currency0, alice);
        uint256 a1 = _bal(currency1, alice);
        vm.prank(alice);
        orders.createOrder(big);
        uint256 usd = (a0 - _bal(currency0, alice)) + (a1 - _bal(currency1, alice)); // both tokens are $1
        console.log("accepted order size in USD (e18):", usd);
        assertGt(usd, 100e18);

        // the size is priced in dollars: at $0.10 a token the same order is too small
        feed0.setAnswer(0.1e8);
        feed1.setAnswer(0.1e8);
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.OrderTooSmall.selector);
        orders.createOrder(big);
        feed0.setAnswer(1e8);
        feed1.setAnswer(1e8);

        // a size cannot be checked against an old price
        feed0.setUpdatedAt(block.timestamp - 2 days);
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.OrderTooSmall.selector);
        orders.createOrder(big);
    }

    // ---------------------------------------------------------------- keeper pay

    /// forge-config: default.isolate = false
    function test_pay_isTheGasCostInTheLpToken() public {
        uint256 id = _order(alice, -600, 600, 10e18, 100, _timedExit());
        vm.warp(block.timestamp + 61 minutes);
        Paid memory p = _run(id, true);
        uint256 expected = _gasInDollarToken(p.gasUsed);
        console.log("gas used:", p.gasUsed);
        console.log("keeper got token0:", p.t0, "expected about:", expected);
        assertEq(p.t1, 0); // token0's share covered it
        assertApproxEqRel(p.t0, expected, 0.3e18); // `gasUsed` here leaves out the transaction's base cost
        // far below the 1% ceiling of roughly 0.3 token0
        assertLt(p.t0, 0.003e18);
    }

    /// forge-config: default.isolate = false
    function test_pay_doesNotGrowWithTheOrder() public {
        _warmUp();
        uint256 small = _order(alice, -600, 600, 10e18, 100, _timedExit());
        uint256 big = _order(bob, -600, 600, 1_000e18, 100, _timedExit());
        vm.warp(block.timestamp + 61 minutes);
        Paid memory a = _run(small, true);
        Paid memory b = _run(big, true);
        console.log("pay, order:", a.t0, " pay, 100x order:", b.t0);
        assertApproxEqRel(b.t0, a.t0, 0.05e18);
    }

    /// forge-config: default.isolate = false
    function test_pay_followsTheTokenAndEthPrices() public {
        _warmUp();
        uint256 a = _order(alice, -600, 600, 10e18, 100, _timedExit());
        uint256 b = _order(alice, -600, 600, 10e18, 100, _timedExit());
        uint256 c = _order(alice, -600, 600, 10e18, 100, _timedExit());
        vm.warp(block.timestamp + 61 minutes);

        uint256 base = _run(a, true).t0;
        feed0.setAnswer(4e8); // token0 is now $4: a quarter of the tokens pays the same gas
        uint256 atFour = _run(b, true).t0;
        feed0.setAnswer(1e8);
        feedEth.setAnswer(4000e8); // ETH doubles: the same gas costs twice the tokens
        uint256 ethDouble = _run(c, true).t0;
        console.log("pay at $1:", base);
        console.log("pay with token at $4:", atFour, " with ETH doubled:", ethDouble);
        assertApproxEqRel(atFour * 4, base, 0.05e18);
        assertApproxEqRel(ethDouble, base * 2, 0.05e18);
    }

    /// A position above the price holds only token0, one below it only token1: the pay comes in what there is.
    /// forge-config: default.isolate = false
    function test_pay_inWhicheverTokenThePositionHolds() public {
        uint256 only0 = _order(alice, 600, 1200, 10e18, 100, _timedExit());
        uint256 only1 = _order(alice, -1200, -600, 10e18, 100, _timedExit());
        vm.warp(block.timestamp + 61 minutes);
        Paid memory a = _run(only0, true);
        Paid memory b = _run(only1, true);
        assertGt(a.t0, 0);
        assertEq(a.t1, 0);
        assertEq(b.t0, 0);
        assertApproxEqRel(b.t1, _gasInDollarToken(b.gasUsed), 0.25e18);
    }

    /// A 6-decimal token at $1 against an 18-decimal token at $1: the pay is the same dollars either way.
    /// forge-config: default.isolate = false
    function test_pay_handlesTokenDecimals() public {
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        usdc.mint(alice, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(orders), type(uint256).max);
        feeds.setFeed(address(usdc), address(new MockAggregator(8, 1e8)), MAX_AGE);

        address other = Currency.unwrap(currency1);
        bool usdcIs0 = address(usdc) < other;
        PoolKey memory key = usdcIs0
            ? PoolKey(Currency.wrap(address(usdc)), currency1, 3000, 60, IHooks(hook))
            : PoolKey(currency1, Currency.wrap(address(usdc)), 3000, 60, IHooks(hook));
        // 1 USDC (1e6 units) = 1 token (1e18 units)
        uint160 sqrtPrice = usdcIs0 ? uint160(1e6 << 96) : uint160((uint256(1) << 96) / 1e6);
        poolManager.initialize(key, sqrtPrice);
        (, int24 tick,,) = poolManager.getSlot0(key.toId());
        int24 mid = (tick / 60) * 60;

        // one position that holds only USDC, one that holds only the 18-decimal token
        ConditionalOrders.CreateParams memory above = _params(key, mid + 600, mid + 1200, 1e15, 100, _off(), _timedExit());
        ConditionalOrders.CreateParams memory below = _params(key, mid - 1200, mid - 600, 1e15, 100, _off(), _timedExit());
        vm.startPrank(alice);
        uint256 idAbove = orders.createOrder(above); // only token0
        uint256 idBelow = orders.createOrder(below); // only token1
        vm.stopPrank();
        vm.warp(block.timestamp + 61 minutes);

        uint256 u0 = usdc.balanceOf(keeper);
        uint256 o0 = _bal(currency1, keeper);
        vm.startPrank(keeper, keeper);
        orders.execute(idAbove, true);
        orders.execute(idBelow, true);
        vm.stopPrank();
        uint256 inUsdc = usdc.balanceOf(keeper) - u0;
        uint256 inOther = _bal(currency1, keeper) - o0;
        console.log("paid in USDC (6 decimals):", inUsdc, " paid in the 18-decimal token:", inOther);
        assertGt(inUsdc, 0);
        assertGt(inOther, 0);
        // the same dollars: scale USDC up to 18 decimals (the second run is warmer, so allow some difference)
        assertApproxEqRel(inUsdc * 1e12, inOther, 0.2e18);
    }

    /// forge-config: default.isolate = false
    function test_pay_neverAboveTheCeiling() public {
        // a dust order with a 0.01% ceiling: the gas costs far more than the ceiling allows
        uint256 id = _order(alice, 600, 1200, 1e12, 1, _timedExit());
        (uint256 amount0,) = orders.orderAmounts(id);
        vm.warp(block.timestamp + 61 minutes);
        uint256 a0 = _bal(currency0, alice);
        Paid memory p = _run(id, true);
        assertLe(p.t0, amount0 / 10_000 + 1);
        assertLt(p.t0, _gasInDollarToken(p.gasUsed) / 100);
        assertGt(_bal(currency0, alice) - a0, (amount0 * 9_998) / 10_000); // the owner still gets the rest
    }

    /// An old Chainlink price still prices the gas (the ceiling limits any error). It does not hand over the ceiling.
    /// forge-config: default.isolate = false
    function test_pay_usesAnOldPriceRatherThanTheWholeCeiling() public {
        _warmUp();
        uint256 a = _order(alice, -600, 600, 10e18, 100, _timedExit());
        uint256 b = _order(alice, -600, 600, 10e18, 100, _timedExit());
        vm.warp(block.timestamp + 61 minutes);
        uint256 fresh = _run(a, true).t0;
        feed0.setUpdatedAt(block.timestamp - 30 days);
        feedEth.setUpdatedAt(block.timestamp - 30 days);
        uint256 stale = _run(b, true).t0;
        assertApproxEqRel(stale, fresh, 0.05e18);
    }

    /// One token's feed is down: its amount is worked out from the other token through the pool's price.
    /// forge-config: default.isolate = false
    function test_pay_withOneFeedDownUsesThePoolPrice() public {
        _warmUp();
        uint256 a = _order(alice, -600, 600, 10e18, 100, _timedExit());
        uint256 b = _order(alice, -600, 600, 10e18, 100, _timedExit());
        vm.warp(block.timestamp + 61 minutes);
        uint256 normal = _run(a, true).t0;
        feed0.setBroken(true);
        uint256 viaPool = _run(b, true).t0;
        console.log("pay with both feeds:", normal, " with token0's feed down:", viaPool);
        assertApproxEqRel(viaPool, normal, 0.1e18); // the pool is at 1:1 and token1 is $1
    }

    /// No usable price at all: the order still runs and the keeper gets the flat ceiling.
    /// forge-config: default.isolate = false
    function test_pay_withNoFeedsFallsBackToTheCeiling() public {
        uint256 a = _order(alice, 600, 1200, 10e18, 50, _timedExit());
        uint256 b = _order(alice, 600, 1200, 10e18, 50, _timedExit());
        (uint256 amount0,) = orders.orderAmounts(a);
        vm.warp(block.timestamp + 61 minutes);

        feed0.setBroken(true);
        feed1.setBroken(true);
        Paid memory p = _run(a, true);
        assertApproxEqAbs(p.t0, (amount0 * 50) / 10_000, 2);

        // the ETH feed alone being down has the same effect: gas cannot be priced in any token
        feed0.setBroken(false);
        feed1.setBroken(false);
        feedEth.setBroken(true);
        Paid memory q = _run(b, true);
        assertApproxEqAbs(q.t0, (amount0 * 50) / 10_000, 2);
    }

    /// A keeper cannot raise its pay by bidding a huge gas price: the price counted is capped.
    /// forge-config: default.isolate = false
    function test_pay_gasPriceIsCapped() public {
        _warmUp();
        uint256 a = _order(alice, -600, 600, 10e18, 100, _timedExit());
        uint256 b = _order(alice, -600, 600, 10e18, 100, _timedExit());
        vm.warp(block.timestamp + 61 minutes);
        Paid memory n = _run(a, true);
        vm.txGasPrice(500 gwei);
        Paid memory i = _run(b, true);
        uint256 normal = n.t0 + n.t1;
        uint256 inflated = i.t0 + i.t1; // token0's ceiling is reached, so token1 pays the rest
        // counted price = base fee + 0.01 gwei = 0.0105 gwei, 7x the normal 0.0015 gwei, not 333,000x
        assertApproxEqRel(inflated, normal * 7, 0.05e18);
    }

    /// A run that converts pays the keeper out of the bought token, so nothing of the sold token is left over.
    /// forge-config: default.isolate = false
    function test_pay_afterAConvertComesFromTheBoughtToken() public {
        OrderState.Side memory up = _timedExit();
        up.actions |= OrderState.ACT_SWAP;
        up.swapToToken1 = true;
        uint256 id = _order(alice, -600, 600, 10e18, 100, up);
        vm.warp(block.timestamp + 61 minutes);
        uint256 a0 = _bal(currency0, alice);
        uint256 a1 = _bal(currency1, alice);
        Paid memory p = _run(id, true);
        assertEq(_bal(currency0, alice), a0); // every token0 was sold
        assertGt(_bal(currency1, alice), a1);
        assertEq(p.t0, 0);
        assertApproxEqRel(p.t1, _gasInDollarToken(p.gasUsed), 0.25e18);
    }

    /// An ETH pool pays in ETH at 110%. When the position holds no ETH, the pay is token1 at the Chainlink price.
    /// forge-config: default.isolate = false
    function test_pay_ethPoolWithoutEthPaysInTheToken() public {
        PoolKey memory ethKey = PoolKey(Currency.wrap(address(0)), currency1, 3000, 60, IHooks(hook));
        poolManager.initialize(ethKey, Constants.SQRT_PRICE_1_1);
        vm.deal(alice, 10 ether);

        vm.startPrank(alice);
        uint256 onlyToken = orders.createOrder(_params(ethKey, -1200, -600, 10e18, 100, _off(), _timedExit()));
        uint256 onlyEth = orders.createOrder{value: 1 ether}(_params(ethKey, 600, 1200, 10e18, 100, _off(), _timedExit()));
        vm.stopPrank();
        vm.warp(block.timestamp + 61 minutes);

        uint256 e0 = keeper.balance;
        Paid memory a = _run(onlyToken, true);
        assertEq(keeper.balance, e0);
        assertApproxEqRel(a.t1, _gasInDollarToken(a.gasUsed), 0.25e18);

        Paid memory b = _run(onlyEth, true);
        uint256 gotEth = keeper.balance - e0;
        assertEq(b.t1, 0);
        assertApproxEqRel(gotEth, (b.gasUsed * GAS_PRICE * 11) / 10, 0.25e18);
        (bool ok, uint256 quoted) = orders.keeperGasCostIn(Currency.unwrap(currency1), 100_000);
        assertTrue(ok);
        assertEq(quoted, (orders.keeperGasCost(100_000) * ETH_USD * 12) / 11);
    }

    // ---------------------------------------------------------------- how close the pay is to the real gas

    /// @dev Make the next call see cold storage everywhere, as a keeper's own transaction would.
    function _coolAll() internal {
        vm.cool(address(orders));
        vm.cool(address(poolManager));
        vm.cool(address(hook));
        vm.cool(address(feeds));
        vm.cool(address(feedEth));
        vm.cool(address(feed0));
        vm.cool(address(feed1));
        vm.cool(Currency.unwrap(currency0));
        vm.cool(Currency.unwrap(currency1));
    }

    /// @dev Runs one side from cold storage. Returns the gas a real transaction would use (the call, plus the 21,000
    /// base cost and the calldata) and the gas the contract counted, worked back from what it paid in $1 tokens.
    function _coldRun(uint256 id, bool upper) internal returns (uint256 real, uint256 counted) {
        _coolAll();
        Paid memory p = _run(id, upper);
        real = p.gasUsed + 21_000 + 700;
        counted = ((p.t0 + p.t1) * 10) / (GAS_PRICE * ETH_USD * 12);
    }

    function _check(string memory what, uint256 real, uint256 counted) internal pure {
        console.log(what);
        console.log("   real gas:", real, " counted:", counted);
        // before the premium, the keeper is paid for 93% to 107% of the gas its transaction really uses
        assertGe(counted * 100, real * 93, what);
        assertLe(counted * 100, real * 107, what);
    }

    /// forge-config: default.isolate = false
    function test_pay_tracksRealGasAcrossRuleKinds() public {
        // the keeper already holds both tokens, as a working keeper does
        MockERC20(Currency.unwrap(currency0)).transfer(keeper, 1);
        MockERC20(Currency.unwrap(currency1)).transfer(keeper, 1);

        uint256 exitBoth = _order(alice, -600, 600, 10e18, 100, _timedExit());
        uint256 exitOne = _order(alice, 600, 1200, 10e18, 100, _timedExit());
        OrderState.Side memory conv = _timedExit();
        conv.actions |= OrderState.ACT_SWAP;
        conv.swapToToken1 = true;
        uint256 convert = _order(alice, -600, 600, 10e18, 100, conv);
        OrderState.Side memory part = _timedExit();
        part.actions = OrderState.ACT_REMOVE; // fees and a quarter out, every hour
        part.removeBps = 2_500;
        part.repeat = true;
        uint256 quarter = _order(alice, -600, 600, 10e18, 100, part);
        OrderState.Side memory orc = _oracleExit(100);
        uint256 oracle = _order(alice, -600, 600, 10e18, 100, orc);
        vm.warp(block.timestamp + 61 minutes);
        feed0.setAnswer(1.02e8);

        (uint256 real, uint256 counted) = _coldRun(exitBoth, true);
        _check("exit, both tokens", real, counted);
        (real, counted) = _coldRun(exitOne, true);
        _check("exit, one token", real, counted);
        (real, counted) = _coldRun(quarter, true);
        _check("withdraw a quarter, repeat", real, counted);
        (real, counted) = _coldRun(oracle, true);
        _check("exit on a Chainlink level", real, counted);
        (real, counted) = _coldRun(convert, true); // last: its swap sets the pool's "swapped" flag for this transaction
        _check("exit and convert", real, counted);
    }

    /// forge-config: default.isolate = false
    function test_pay_tracksRealGasInAnEthPool() public {
        PoolKey memory ethKey = PoolKey(Currency.wrap(address(0)), currency1, 3000, 60, IHooks(hook));
        poolManager.initialize(ethKey, Constants.SQRT_PRICE_1_1);
        vm.deal(alice, 10 ether);
        vm.deal(keeper, 1 ether);
        MockERC20(Currency.unwrap(currency1)).transfer(keeper, 1);
        vm.prank(alice);
        uint256 id = orders.createOrder{value: 1 ether}(_params(ethKey, -600, 600, 10e18, 100, _off(), _timedExit()));
        vm.warp(block.timestamp + 61 minutes);

        _coolAll();
        vm.cool(alice);
        vm.cool(keeper);
        uint256 e0 = keeper.balance;
        Paid memory p = _run(id, true);
        uint256 real = p.gasUsed + 21_000 + 700;
        uint256 counted = ((keeper.balance - e0) * 10) / (GAS_PRICE * 11); // ETH is paid at 110%
        assertEq(p.t1, 0);
        _check("exit from an ETH pool, paid in ETH", real, counted);
    }

    // ---------------------------------------------------------------- Chainlink condition

    function test_oracle_firesOnTheChainlinkPriceNotThePoolPrice() public {
        vm.prank(alice);
        uint256 id = orders.createOrder(_params(poolKey, -600, 600, 5e18, 10, _oracleExit(-100), _off()));

        _swap(true, 20e18); // the pool's price falls far below the level
        assertLt(_tick(), -1000);
        assertFalse(orders.canExecute(id, false)); // Chainlink has not moved
        vm.prank(keeper);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        orders.execute(id, false);

        feed0.setAnswer(0.98e8); // token0 at $0.98: about tick -202
        (bool ok, int24 t) = feeds.pairTick(Currency.unwrap(currency0), Currency.unwrap(currency1));
        assertTrue(ok);
        assertApproxEqAbs(int256(t), -202, 1);
        assertTrue(orders.canExecute(id, false));
        vm.prank(keeper);
        orders.execute(id, false);
        (ConditionalOrders.Order memory o,) = orders.getOrder(id);
        assertEq(o.owner, address(0));
    }

    function test_oracle_upperSide() public {
        vm.prank(alice);
        uint256 id = orders.createOrder(_params(poolKey, -600, 600, 5e18, 10, _off(), _oracleExit(100)));
        assertFalse(orders.canExecute(id, true));
        feed0.setAnswer(1.005e8); // about tick 49: not there yet
        assertFalse(orders.canExecute(id, true));
        feed0.setAnswer(1.02e8); // about tick 198
        assertTrue(orders.canExecute(id, true));
        feed0.setAnswer(1e8);
        feed1.setAnswer(0.98e8); // the other token falling is the same move
        assertTrue(orders.canExecute(id, true));
    }

    function test_oracle_anOldOrMissingPriceNeverFires() public {
        vm.prank(alice);
        uint256 id = orders.createOrder(_params(poolKey, -600, 600, 5e18, 10, _oracleExit(-100), _off()));
        feed0.setAnswer(0.98e8);
        assertTrue(orders.canExecute(id, false));

        feed0.setUpdatedAt(block.timestamp - MAX_AGE - 1);
        assertFalse(orders.canExecute(id, false));
        vm.prank(keeper);
        vm.expectRevert(ConditionalOrders.ConditionNotMet.selector);
        orders.execute(id, false);

        feed0.setUpdatedAt(block.timestamp - MAX_AGE); // exactly at the limit still counts
        assertTrue(orders.canExecute(id, false));

        feed0.setUpdatedAt(0);
        feed1.setBroken(true);
        assertFalse(orders.canExecute(id, false));
        feed1.setBroken(false);
        feed1.setAnswer(0);
        assertFalse(orders.canExecute(id, false));
        feed1.setAnswer(-5);
        assertFalse(orders.canExecute(id, false));
        feed1.setAnswer(1e8);
        feeds.removeFeed(Currency.unwrap(currency1));
        assertFalse(orders.canExecute(id, false));
    }

    /// The point of the condition: a pushed pool price alone cannot fire a rule that also asks Chainlink.
    function test_oracle_andWithThePoolPriceBlocksAPushedPrice() public {
        OrderState.Side memory low = _oracleExit(-100);
        low.checker = OrderState.CHECK_TICK; // A: pool price below -100
        low.checker2 = OrderState.CHECK_ORACLE; // B: Chainlink price below -100
        low.value2 = -100;
        low.combine = OrderState.COMBINE_AND;
        vm.prank(alice);
        uint256 id = orders.createOrder(_params(poolKey, -600, 600, 5e18, 10, low, _off()));

        _swap(true, 20e18); // someone pushes the pool
        assertFalse(orders.canExecute(id, false));
        feed0.setAnswer(0.98e8); // the market really moved
        assertTrue(orders.canExecute(id, false));
        vm.prank(keeper);
        orders.execute(id, false);
    }

    function test_oracle_repeatingLevelSteps() public {
        OrderState.Side memory low = _oracleExit(-100);
        low.actions = OrderState.ACT_REMOVE; // send the fees and a quarter of the liquidity out
        low.removeBps = 2_500;
        low.repeat = true;
        low.shape = 200; // the level moves 200 ticks after each run
        vm.prank(alice);
        uint256 id = orders.createOrder(_params(poolKey, -600, 600, 5e18, 10, low, _off()));

        feed0.setAnswer(0.98e8); // about -202
        vm.prank(keeper);
        orders.execute(id, false);
        (, OrderState.State memory st) = orders.getOrder(id);
        assertEq(st.lower.value, -300);
        assertFalse(orders.canExecute(id, false));

        feed0.setAnswer(0.96e8); // about -408
        assertTrue(orders.canExecute(id, false));
        vm.prank(keeper);
        orders.execute(id, false);
        (, st) = orders.getOrder(id);
        assertEq(st.lower.value, -500);
    }

    function test_oracle_swapIsProtectedAtTheLevel() public {
        // sell token0 when Chainlink falls below -100. The pool has been pushed far below that, past the slippage
        // limit, so the swap is skipped and the owner keeps token0 instead of selling at the pushed price.
        OrderState.Side memory low = _oracleExit(-100);
        low.actions |= OrderState.ACT_SWAP;
        low.swapToToken1 = true;
        ConditionalOrders.CreateParams memory p = _params(poolKey, -600, 600, 5e18, 10, low, _off());
        p.maxSlippage = 10; // 100 ticks
        vm.prank(alice);
        uint256 id = orders.createOrder(p);

        _swap(true, 20e18);
        assertLt(_tick(), -200);
        feed0.setAnswer(0.98e8);
        uint256 a0 = _bal(currency0, alice);
        uint256 a1 = _bal(currency1, alice);
        vm.prank(keeper);
        orders.execute(id, false);
        assertGt(_bal(currency0, alice), a0);
        assertEq(_bal(currency1, alice), a1);
    }

    function test_oracle_validation() public {
        OrderState.Side memory s = _oracleExit(-100);
        s.checkPool = 1; // a Chainlink level is always the order's own pair
        _expectInvalid(s);

        s = _oracleExit(TickMath.MIN_TICK);
        _expectInvalid(s);
        s = _oracleExit(TickMath.MAX_TICK);
        _expectInvalid(s);

        s = _oracleExit(-100);
        s.actions = OrderState.ACT_REMOVE;
        s.removeBps = 2_500;
        s.repeat = true; // a repeating level needs a step
        _expectInvalid(s);
        s.shape = 50;
        vm.prank(alice);
        orders.createOrder(_params(poolKey, -600, 600, 1e18, 10, s, _off()));

        s = _oracleExit(-100);
        s.shape = 50; // a step without repeat
        _expectInvalid(s);

        s = _oracleExit(-100);
        s.checker = 6; // no such condition
        _expectInvalid(s);

        // one-sided follow cannot hang on a Chainlink level alone
        s = _oracleExit(-100);
        s.actions = OrderState.ACT_KEEP_FEES | OrderState.ACT_REMOVE | OrderState.ACT_ADD;
        s.addMode = OrderState.ADD_ONE_SIDED;
        s.shape = 10 << 11;
        _expectInvalid(s);
    }

    function _expectInvalid(OrderState.Side memory lower) internal {
        ConditionalOrders.CreateParams memory p = _params(poolKey, -600, 600, 1e18, 10, lower, _off());
        vm.prank(alice);
        vm.expectRevert(ConditionalOrders.InvalidSide.selector);
        orders.createOrder(p);
    }

    /// The Chainlink tick equals the pool tick for the same price, across the tick range and token decimals.
    function testFuzz_pairTickMatchesThePoolsTick(int24 tick, bool sixDecimals) public {
        tick = int24(bound(int256(tick), -250_000, 250_000));
        address t0 = Currency.unwrap(currency0);
        address t1 = Currency.unwrap(currency1);
        if (sixDecimals) {
            // a 6-decimal token0 against the 18-decimal token1
            MockERC20 six = new MockERC20("Six", "SIX", 6);
            t0 = address(six);
        }
        MockAggregator a0 = new MockAggregator(18, 1);
        MockAggregator a1 = new MockAggregator(18, 1e18);
        feeds.setFeed(t0, address(a0), MAX_AGE);
        feeds.setFeed(t1, address(a1), MAX_AGE);

        // a price in the middle of the tick, as dollars per whole token0 with token1 at $1
        uint256 sqrtMid = (uint256(TickMath.getSqrtPriceAtTick(tick)) + TickMath.getSqrtPriceAtTick(tick + 1)) / 2;
        uint256 rawRatioX96 = FullMath.mulDiv(sqrtMid, sqrtMid, 1 << 96); // token1 units per token0 unit
        // dollars per whole token0 = raw ratio x 10^decimals0 / 10^decimals1, as an 18-decimal answer
        uint256 answer = FullMath.mulDiv(rawRatioX96, sixDecimals ? 1e6 : 1e18, 1 << 96);
        vm.assume(answer > 1e6 && answer < type(uint96).max); // enough digits for the feed to carry the price
        a0.setAnswer(int256(answer));

        (bool ok, int24 got) = feeds.pairTick(t0, t1);
        assertTrue(ok);
        assertApproxEqAbs(int256(got), int256(tick), 1);
    }

    /// Whatever a feed answers, the views report `ok = false` or a number. They never revert, so a feed cannot
    /// block a run.
    function testFuzz_feedViewsNeverRevert(
        int256 answer0,
        int256 answer1,
        int256 answerEth,
        uint8 dec0,
        uint8 dec1,
        uint256 amount,
        uint256 weiAmount,
        uint256 updatedAt
    ) public {
        address t0 = Currency.unwrap(currency0);
        address t1 = Currency.unwrap(currency1);
        MockAggregator a0 = new MockAggregator(uint8(bound(dec0, 0, 18)), 1);
        MockAggregator a1 = new MockAggregator(uint8(bound(dec1, 0, 18)), 1);
        feeds.setFeed(t0, address(a0), MAX_AGE);
        feeds.setFeed(t1, address(a1), MAX_AGE);
        a0.setAnswer(answer0);
        a1.setAnswer(answer1);
        feedEth.setAnswer(answerEth);
        a1.setUpdatedAt(updatedAt);

        feeds.priceOf(t0);
        feeds.priceOf(address(0));
        feeds.priceOf(address(0x1234));
        feeds.quote(t0, weiAmount);
        feeds.quote(t1, weiAmount);
        feeds.quote(address(0), weiAmount);
        feeds.usdValue(t0, amount);
        feeds.usdValue(t1, amount);
        feeds.pairTick(t0, t1);
        feeds.pairTick(t1, t0);
        feeds.pairTick(address(0), t1);
    }

    // ---------------------------------------------------------------- executeMany

    function test_many_runsWhatItCanAndSkipsTheRest() public {
        uint256 a = _order(alice, -600, 600, 1e18, 10, _timedExit());
        uint256 b = _order(bob, -600, 600, 2e18, 10, _timedExit());
        OrderState.Side memory later = _timedExit();
        later.value = 600; // not due for 10 hours
        uint256 c = _order(alice, -600, 600, 1e18, 10, later);
        uint256 d = _order(bob, -1200, -600, 1e18, 10, _timedExit());
        vm.warp(block.timestamp + 61 minutes);

        uint256[] memory ids = new uint256[](6);
        bool[] memory uppers = new bool[](6);
        (ids[0], ids[1], ids[2], ids[3], ids[4], ids[5]) = (a, 999, c, b, d, a); // 999 does not exist; a is listed twice
        for (uint256 i; i < 6; ++i) uppers[i] = true;
        uppers[4] = false; // d's lower side is off

        uint256 a0 = _bal(currency0, alice);
        uint256 b0 = _bal(currency0, bob);
        vm.prank(keeper);
        uint256 ran = orders.executeMany(ids, uppers);
        assertEq(ran, 2); // a and b
        assertGt(_bal(currency0, alice), a0);
        assertGt(_bal(currency0, bob), b0);
        (ConditionalOrders.Order memory oc,) = orders.getOrder(c);
        (ConditionalOrders.Order memory od,) = orders.getOrder(d);
        assertEq(oc.owner, alice); // untouched
        assertEq(od.owner, bob);
        assertGt(orders.orderLiquidity(c), 0);
    }

    function test_many_inputChecks() public {
        uint256[] memory ids = new uint256[](0);
        bool[] memory uppers = new bool[](0);
        vm.expectRevert(ConditionalOrders.InvalidOrder.selector);
        orders.executeMany(ids, uppers);
        ids = new uint256[](2);
        uppers = new bool[](1);
        vm.expectRevert(ConditionalOrders.InvalidOrder.selector);
        orders.executeMany(ids, uppers);

        vm.expectRevert(ConditionalOrders.OnlySelf.selector);
        orders.runOne(1, true, address(this), 1);
    }

    /// An order that swaps moves the pool's price, so later orders of that pool in the same transaction are refused
    /// (the same guard that stops "push the price, then execute"). They are skipped, not lost: they run next time.
    function test_many_ordersAfterASwapInTheSamePoolWait() public {
        OrderState.Side memory converting = _timedExit();
        converting.actions |= OrderState.ACT_SWAP;
        converting.swapToToken1 = true;
        uint256 conv = _order(alice, -600, 600, 1e18, 10, converting);
        uint256 plain = _order(bob, -600, 600, 1e18, 10, _timedExit());
        uint256 plain2 = _order(bob, -600, 600, 1e18, 10, _timedExit());
        vm.warp(block.timestamp + 61 minutes);

        uint256[] memory ids = new uint256[](3);
        bool[] memory uppers = new bool[](3);
        (ids[0], ids[1], ids[2]) = (plain, conv, plain2);
        (uppers[0], uppers[1], uppers[2]) = (true, true, true);
        vm.prank(keeper);
        assertEq(orders.executeMany(ids, uppers), 2); // plain, then conv; plain2 comes after the swap
        assertTrue(orders.canExecute(plain2, true));
        vm.prank(keeper);
        orders.execute(plain2, true); // a new transaction: fine
    }

    /// With too little gas for every order, the batch reverts. It must not skip the orders it could not afford: a gas
    /// estimate would then settle on an amount that runs only some of them.
    function test_many_tooLittleGasRevertsInsteadOfSkipping() public {
        uint256 n = 6;
        uint256[] memory ids = new uint256[](n);
        bool[] memory uppers = new bool[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = _order(alice, -600, 600, 1e18, 10, _timedExit());
            uppers[i] = true;
        }
        vm.warp(block.timestamp + 61 minutes);

        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        uint256 g = gasleft();
        assertEq(orders.executeMany(ids, uppers), n);
        uint256 needed = g - gasleft();
        vm.revertToState(snap);

        // from far too little up to just under what is needed: never a "success" that ran fewer than all six
        for (uint256 pct = 20; pct <= 90; pct += 10) {
            vm.prank(keeper);
            try orders.executeMany{gas: (needed * pct) / 100}(ids, uppers) returns (uint256 ran) {
                assertEq(ran, n, "a batch with too little gas ran only part of it");
            } catch {}
        }
        // (the gas used is less than the gas needed: closing orders refunds gas, and each call level holds 1/64 back)
        vm.prank(keeper);
        assertEq(orders.executeMany{gas: needed * 2}(ids, uppers), n);
    }

    /// forge-config: default.isolate = false
    function test_many_eachOrderPaysLessThanAlone() public {
        _warmUp();
        uint256 solo = _order(alice, -600, 600, 10e18, 100, _timedExit());
        uint256 n = 10;
        uint256[] memory ids = new uint256[](n);
        bool[] memory uppers = new bool[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = _order(alice, -600, 600, 10e18, 100, _timedExit());
            uppers[i] = true;
        }
        vm.warp(block.timestamp + 61 minutes);

        uint256 alone = _run(solo, true).t0;
        uint256 k0 = _bal(currency0, keeper);
        vm.prank(keeper, keeper);
        uint256 g = gasleft();
        assertEq(orders.executeMany(ids, uppers), n);
        uint256 gasAll = g - gasleft();
        uint256 each = (_bal(currency0, keeper) - k0) / n;
        console.log("pay alone:", alone, " pay per order in a batch of 10:", each);
        console.log("gas per order in the batch:", gasAll / n);
        assertLt(each, alone);
        // and the keeper is still covered: before the premium it is paid for 95% to 120% of the gas it spent
        uint256 counted = ((_bal(currency0, keeper) - k0) * 10) / (GAS_PRICE * ETH_USD * 12);
        console.log("whole batch, real gas:", gasAll + 21_000, " counted:", counted);
        assertGe(counted * 100, (gasAll + 21_000) * 95);
        assertLe(counted * 100, (gasAll + 21_000) * 120);
    }
}
