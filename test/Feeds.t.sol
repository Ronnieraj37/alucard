// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {PriceFeeds} from "../src/PriceFeeds.sol";
import {MockAggregator} from "../src/testnet/MockAggregator.sol";

/// @notice The price list: a price is used only when it is believable. A missing, broken, negative or old price is
/// "no price", never a wrong one, and listing a token needs a working feed.
contract FeedsTest is Test {
    PriceFeeds feeds;
    MockAggregator eth;
    MockAggregator usdc;
    MockERC20 usdcToken;
    MockERC20 wbtcToken;

    function setUp() public {
        vm.warp(1_790_000_000);
        feeds = new PriceFeeds(address(this));
        eth = new MockAggregator(8, 2000e8);
        usdc = new MockAggregator(8, 1e8);
        usdcToken = new MockERC20("USDC", "USDC", 6);
        wbtcToken = new MockERC20("WBTC", "WBTC", 8);
        feeds.setFeed(address(0), address(eth), 1 hours);
        feeds.setFeed(address(usdcToken), address(usdc), 1 days);
    }

    // ---------------------------------------------------------------- what counts as a price

    function test_aFreshPositivePriceIsUsed() public view {
        (bool ok, uint256 p, uint8 d) = feeds.priceOf(address(0));
        assertTrue(ok);
        assertEq(p, 2000e8);
        assertEq(d, 8);
    }

    function test_anOldPriceIsNoPrice() public {
        eth.setUpdatedAt(block.timestamp);
        vm.warp(block.timestamp + 1 hours);
        (bool fresh,,) = feeds.priceOf(address(0));
        assertTrue(fresh); // exactly maxAge old is still fine
        vm.warp(block.timestamp + 1);
        (bool ok,,) = feeds.priceOf(address(0));
        assertFalse(ok);
    }

    function test_aPriceFromTheFutureIsNoPrice() public {
        eth.setUpdatedAt(block.timestamp + 1);
        (bool ok,,) = feeds.priceOf(address(0));
        assertFalse(ok);
    }

    function test_zeroOrNegativeIsNoPrice() public {
        eth.setAnswer(0);
        (bool ok,,) = feeds.priceOf(address(0));
        assertFalse(ok);
        eth.setAnswer(-1);
        (ok,,) = feeds.priceOf(address(0));
        assertFalse(ok);
    }

    function test_aFeedThatRevertsIsNoPriceAndNeverBlocks() public {
        eth.setBroken(true);
        (bool ok,,) = feeds.priceOf(address(0));
        assertFalse(ok);
        (ok,) = feeds.pairTick(address(0), address(usdcToken));
        assertFalse(ok);
    }

    function test_anUnlistedTokenHasNoPrice() public view {
        (bool ok,,) = feeds.priceOf(address(wbtcToken));
        assertFalse(ok);
        (ok,) = feeds.pairTick(address(wbtcToken), address(usdcToken));
        assertFalse(ok);
        assertFalse(feeds.isListed(address(wbtcToken)));
    }

    // ---------------------------------------------------------------- the numbers

    /// ETH (18 decimals) against USDC (6): 2,000 USDC per ETH is 2000e6 / 1e18 raw, which is tick -198_082ish, the
    /// tick of a real ETH/USDC pool at that price.
    function test_pairTickMatchesAPoolAtThatPrice() public view {
        (bool ok, int24 tick) = feeds.pairTick(address(0), address(usdcToken));
        assertTrue(ok);
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        // 2000e6 / 1e18 = 2e-9 raw: sqrt = 4.4721e-5, times 2^96
        uint256 expected = 3_543_191_142_285_914_205_922_034; // sqrt(2e-9) * 2^96
        assertApproxEqRel(sqrtP, expected, 1e14); // within one tick (0.005% of sqrt)
        // and the other way round is the opposite tick (to one tick of rounding)
        (, int24 back) = feeds.pairTick(address(usdcToken), address(0));
        assertApproxEqAbs(int256(back), -int256(tick), 1);
    }

    // ---------------------------------------------------------------- listing

    function test_listingNeedsAWorkingFeed() public {
        MockAggregator bad = new MockAggregator(8, 0);
        vm.expectRevert(PriceFeeds.BadFeed.selector);
        feeds.setFeed(address(wbtcToken), address(bad), 1 hours);
        vm.expectRevert(PriceFeeds.BadFeed.selector);
        feeds.setFeed(address(wbtcToken), address(0), 1 hours);
        MockAggregator good = new MockAggregator(8, 60_000e8);
        vm.expectRevert(PriceFeeds.BadFeed.selector);
        feeds.setFeed(address(wbtcToken), address(good), 0);
        MockAggregator tooPrecise = new MockAggregator(19, 1e19);
        vm.expectRevert(PriceFeeds.BadFeed.selector);
        feeds.setFeed(address(wbtcToken), address(tooPrecise), 1 hours);
    }

    function test_aNewTokenIsListedAtOnceAndAppearsOnce() public {
        uint256 n = feeds.tokens().length;
        feeds.setFeed(address(wbtcToken), address(new MockAggregator(8, 60_000e8)), 1 hours);
        assertTrue(feeds.isListed(address(wbtcToken)));
        assertEq(feeds.tokens().length, n + 1);
        // changing its feed later (queued) does not list it twice
        MockAggregator next = new MockAggregator(8, 61_000e8);
        feeds.queueFeed(address(wbtcToken), address(next), 1 hours);
        vm.warp(block.timestamp + 2 days);
        next.setUpdatedAt(block.timestamp);
        feeds.setFeed(address(wbtcToken), address(next), 1 hours);
        assertEq(feeds.tokens().length, n + 1);
    }

    /// A change must be exactly what was announced: another feed, or another maxAge, is refused.
    function test_onlyTheAnnouncedChangeCanBeApplied() public {
        MockAggregator next = new MockAggregator(8, 2100e8);
        feeds.queueFeed(address(0), address(next), 1 hours);
        vm.warp(block.timestamp + 2 days);
        next.setUpdatedAt(block.timestamp);
        eth.setUpdatedAt(block.timestamp);
        vm.expectRevert(PriceFeeds.NotQueued.selector);
        feeds.setFeed(address(0), address(next), 2 hours);
        vm.expectRevert(PriceFeeds.NotQueued.selector);
        feeds.setFeed(address(0), address(usdc), 1 hours);
        feeds.setFeed(address(0), address(next), 1 hours);
        (, uint256 p,) = feeds.priceOf(address(0));
        assertEq(p, 2100e8);
    }

    function test_onlyListedTokensCanBeQueued() public {
        vm.expectRevert(PriceFeeds.NotListed.selector);
        feeds.queueFeed(address(wbtcToken), address(eth), 1 hours);
    }

    function test_strangersCannotChangeTheList() public {
        vm.startPrank(address(0xBAD));
        vm.expectRevert(PriceFeeds.NotOwner.selector);
        feeds.setFeed(address(wbtcToken), address(eth), 1 hours);
        vm.expectRevert(PriceFeeds.NotOwner.selector);
        feeds.queueFeed(address(0), address(0), 1 hours);
        vm.expectRevert(PriceFeeds.NotOwner.selector);
        feeds.setMaxDeviationTicks(1);
        vm.expectRevert(PriceFeeds.NotOwner.selector);
        feeds.transferOwnership(address(0xBAD));
        vm.stopPrank();
    }
}
