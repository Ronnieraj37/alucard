// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev The part of a Chainlink price feed this contract reads.
interface IAggregator {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface ITokenDecimals {
    function decimals() external view returns (uint8);
}

/// @title PriceFeeds: the token list of ConditionalOrders
/// @notice A token is allowed in an order only when the admin has given it a Chainlink USD price feed here (native
/// ETH is the zero address). ConditionalOrders uses it for one thing: the Chainlink price of a pair as a tick, which a
/// pool's price must be near for a strategy step to run (Rules.checkPrice). That is what makes the pool's price safe
/// to act on: pushing it to fire someone's strategy means pushing it away from Chainlink, and then nothing runs.
///
/// No view here reverts on a broken feed: each returns `ok = false`.
///
/// Open orders depend on the feeds, so a listed token's feed can only be changed or removed FEED_DELAY after the change
/// was announced with `queueFeed`. Listing a new token takes effect at once: no open order uses it yet.
contract PriceFeeds {
    error NotOwner();
    error BadFeed();
    error NotListed();
    error NotQueued();

    uint256 public constant FEED_DELAY = 2 days;

    struct Feed {
        address aggregator;
        uint32 maxAge; // seconds a price stays fresh
        uint8 feedDecimals;
        uint8 tokenDecimals;
    }

    address public owner;
    address public pendingOwner;
    /// @notice How far (in ticks) a pool's price may be from the pair's Chainlink price for a strategy step to run
    /// (Rules.checkPrice). About 100 ticks is 1%. 0 = not checked (tests only).
    uint24 public maxDeviationTicks;

    mapping(address token => Feed) public feeds;
    address[] internal _tokens;

    /// @notice An announced change of a listed token's feed: hash of (aggregator, maxAge), and when it may be applied.
    struct Queued {
        bytes32 change;
        uint64 readyAt;
    }

    mapping(address token => Queued) public queued;

    event FeedSet(address indexed token, address indexed aggregator, uint32 maxAge);
    event FeedRemoved(address indexed token);
    event FeedQueued(address indexed token, address aggregator, uint32 maxAge, uint64 readyAt);
    event MaxDeviationSet(uint24 ticks);
    event MaxDeviationQueued(uint24 ticks, uint64 readyAt);
    event OwnerChanged(address indexed owner);

    constructor(address _owner) {
        owner = _owner;
        emit OwnerChanged(_owner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    /// @notice Announce a change of a listed token's feed (aggregator = 0 removes the token). It can be applied with
    /// `setFeed` FEED_DELAY from now.
    function queueFeed(address token, address aggregator, uint32 maxAge) external onlyOwner {
        if (feeds[token].aggregator == address(0)) revert NotListed();
        uint64 readyAt = uint64(block.timestamp + FEED_DELAY);
        queued[token] = Queued(keccak256(abi.encode(aggregator, maxAge)), readyAt);
        emit FeedQueued(token, aggregator, maxAge, readyAt);
    }

    /// @notice List a token, or apply a queued change of a listed one. The feed must answer with a positive, fresh
    /// price right now.
    /// @param token the token, or the zero address for native ETH
    /// @param aggregator its Chainlink TOKEN / USD feed (0 removes a listed token)
    /// @param maxAge how old an answer may be, in seconds (the feed's heartbeat plus some slack)
    function setFeed(address token, address aggregator, uint32 maxAge) external onlyOwner {
        if (feeds[token].aggregator != address(0)) {
            Queued memory q = queued[token];
            if (q.change != keccak256(abi.encode(aggregator, maxAge)) || block.timestamp < q.readyAt) {
                revert NotQueued();
            }
            delete queued[token];
            if (aggregator == address(0)) return _remove(token);
        }
        if (aggregator == address(0) || maxAge == 0) revert BadFeed();
        uint8 feedDecimals = IAggregator(aggregator).decimals();
        uint8 tokenDecimals = token == address(0) ? 18 : ITokenDecimals(token).decimals();
        if (feedDecimals > 18 || tokenDecimals > 18) revert BadFeed();

        if (feeds[token].aggregator == address(0)) _tokens.push(token);
        feeds[token] = Feed(aggregator, maxAge, feedDecimals, tokenDecimals);
        (bool ok,) = _price(feeds[token]);
        if (!ok) revert BadFeed();
        emit FeedSet(token, aggregator, maxAge);
    }

    /// @dev Take a token off the list. Open orders with it can no longer run a step (no Chainlink price, so every step
    /// waits) but can always be cancelled; new orders with it are refused.
    function _remove(address token) internal {
        delete feeds[token];
        uint256 n = _tokens.length;
        for (uint256 i; i < n; ++i) {
            if (_tokens[i] == token) {
                _tokens[i] = _tokens[n - 1];
                _tokens.pop();
                break;
            }
        }
        emit FeedRemoved(token);
    }

    /// @notice Set the band. The first setting (at deployment) and tightening it apply at once: a tighter band can only
    /// make steps wait, never fire one. Loosening or switching it off waits FEED_DELAY after `queueMaxDeviation`.
    function setMaxDeviationTicks(uint24 ticks) external onlyOwner {
        uint24 cur = maxDeviationTicks;
        if (cur != 0 && (ticks == 0 || ticks > cur)) {
            Queued memory q = queued[address(0)];
            if (q.readyAt == 0 || block.timestamp < q.readyAt || q.change != keccak256(abi.encode(ticks))) revert NotQueued();
            delete queued[address(0)];
        }
        maxDeviationTicks = ticks;
        emit MaxDeviationSet(ticks);
    }

    /// @notice Announce a looser band (or switching it off); `setMaxDeviationTicks` can apply it FEED_DELAY from now.
    function queueMaxDeviation(uint24 ticks) external onlyOwner {
        uint64 readyAt = uint64(block.timestamp + FEED_DELAY);
        queued[address(0)] = Queued(keccak256(abi.encode(ticks)), readyAt);
        emit MaxDeviationQueued(ticks, readyAt);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnerChanged(msg.sender);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function isListed(address token) external view returns (bool) {
        return feeds[token].aggregator != address(0);
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    /// @notice USD price of one whole token, with the feed's decimals. `ok` is false when the token is not listed,
    /// the feed fails, the answer is not positive, or it is older than the feed's maxAge.
    function priceOf(address token) external view returns (bool ok, uint256 price, uint8 decimals) {
        Feed memory f = feeds[token];
        (ok, price) = _price(f);
        decimals = f.feedDecimals;
    }

    /// @notice The Chainlink price of token1 per token0 as a Uniswap tick (raw units, like a pool of the two).
    /// `ok` is false when either price is missing or stale, or the ratio is outside what a tick can express.
    function pairTick(address token0, address token1) external view returns (bool ok, int24 tick) {
        Feed memory f0 = feeds[token0];
        Feed memory f1 = feeds[token1];
        (bool ok0, uint256 p0) = _price(f0);
        (bool ok1, uint256 p1) = _price(f1);
        if (!ok0 || !ok1) return (false, 0);

        // token1 per token0 in raw units = (p0 / p1) x 10^(decimals1 - decimals0), each price scaled by its feed
        uint256 num = p0 * 10 ** (uint256(f1.feedDecimals) + f1.tokenDecimals);
        uint256 den = p1 * 10 ** (uint256(f0.feedDecimals) + f0.tokenDecimals);
        if (num / den >= 1 << 128) return (false, 0);
        uint256 ratioX96 = FullMath.mulDiv(num, 1 << 96, den);
        uint256 sqrtPriceX96 = ratioX96 <= type(uint160).max ? Math.sqrt(ratioX96 << 96) : Math.sqrt(ratioX96) << 48;
        if (sqrtPriceX96 < TickMath.MIN_SQRT_PRICE || sqrtPriceX96 >= TickMath.MAX_SQRT_PRICE) return (false, 0);
        return (true, TickMath.getTickAtSqrtPrice(uint160(sqrtPriceX96)));
    }

    /// @dev Last answer of a feed, if positive and within maxAge. Never reverts. Answers of
    /// 2^96 or more are refused so the arithmetic above cannot overflow.
    function _price(Feed memory f) internal view returns (bool ok, uint256 price) {
        if (f.aggregator == address(0)) return (false, 0);
        try IAggregator(f.aggregator).latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            if (answer <= 0 || uint256(answer) > type(uint96).max) return (false, 0);
            if (updatedAt > block.timestamp || block.timestamp - updatedAt > f.maxAge) return (false, 0);
            return (true, uint256(answer));
        } catch {
            return (false, 0);
        }
    }
}
