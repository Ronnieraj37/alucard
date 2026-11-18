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
/// @notice A token is allowed in an order only when the admin has given it a Chainlink USD price feed here. Native
/// ETH is the zero address and must be listed too: gas is priced through it. ConditionalOrders reads this contract
/// for three things: turning a gas cost in wei into a token amount (keeper pay), the USD value of a new order (the
/// minimum order size), and the Chainlink price of a pair as a tick (the Chainlink condition).
///
/// No view here reverts on a broken feed: each returns `ok = false`, so an order can never be stuck by a feed.
contract PriceFeeds {
    error NotOwner();
    error BadFeed();
    error NotListed();

    struct Feed {
        address aggregator;
        uint32 maxAge; // seconds a price stays fresh
        uint8 feedDecimals;
        uint8 tokenDecimals;
    }

    address public owner;
    address public pendingOwner;
    /// @notice Smallest order createOrder accepts, in USD with 18 decimals. 0 = no minimum.
    uint256 public minOrderUsd;

    mapping(address token => Feed) public feeds;
    address[] internal _tokens;

    event FeedSet(address indexed token, address indexed aggregator, uint32 maxAge);
    event FeedRemoved(address indexed token);
    event MinOrderUsdSet(uint256 minOrderUsd);
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

    /// @notice List a token (or change its feed). The feed must answer with a positive, fresh price right now.
    /// @param token the token, or the zero address for native ETH
    /// @param aggregator its Chainlink TOKEN / USD feed
    /// @param maxAge how old an answer may be, in seconds (the feed's heartbeat plus some slack)
    function setFeed(address token, address aggregator, uint32 maxAge) external onlyOwner {
        if (aggregator == address(0) || maxAge == 0) revert BadFeed();
        uint8 feedDecimals = IAggregator(aggregator).decimals();
        uint8 tokenDecimals = token == address(0) ? 18 : ITokenDecimals(token).decimals();
        if (feedDecimals > 18 || tokenDecimals > 18) revert BadFeed();

        if (feeds[token].aggregator == address(0)) _tokens.push(token);
        feeds[token] = Feed(aggregator, maxAge, feedDecimals, tokenDecimals);
        (bool ok,) = _price(feeds[token], true);
        if (!ok) revert BadFeed();
        emit FeedSet(token, aggregator, maxAge);
    }

    /// @notice Take a token off the list. Open orders keep running; new orders with it are refused.
    function removeFeed(address token) external onlyOwner {
        if (feeds[token].aggregator == address(0)) revert NotListed();
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

    function setMinOrderUsd(uint256 usd) external onlyOwner {
        minOrderUsd = usd;
        emit MinOrderUsdSet(usd);
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
        (ok, price) = _price(f, true);
        decimals = f.feedDecimals;
    }

    /// @notice `weiAmount` of native ETH expressed in `token` (raw units), at the feeds' last prices. Used for keeper
    /// pay, which is capped by the order anyway, so an old price is still used: it is closer to the gas cost than
    /// no price at all. `ok` is false only when one of the two feeds has no positive answer.
    function quote(address token, uint256 weiAmount) external view returns (bool ok, uint256 amount) {
        if (token == address(0)) return (true, weiAmount);
        Feed memory ft = feeds[token];
        Feed memory fe = feeds[address(0)];
        (bool okT, uint256 pT) = _price(ft, false);
        (bool okE, uint256 pE) = _price(fe, false);
        if (!okT || !okE || weiAmount > type(uint96).max) return (false, 0);
        // wei x (USD per ETH) / (USD per token), then from 18 decimals to the token's. Prices and the amount are
        // below 2^96, so neither step can overflow.
        uint256 inToken18 = FullMath.mulDiv(weiAmount, pE * 10 ** ft.feedDecimals, pT * 10 ** fe.feedDecimals);
        return (true, FullMath.mulDiv(inToken18, 10 ** ft.tokenDecimals, 1e18));
    }

    /// @notice USD value (18 decimals) of `amount` raw units of `token`, from a fresh price.
    function usdValue(address token, uint256 amount) external view returns (bool ok, uint256 usd) {
        Feed memory f = feeds[token];
        (bool okP, uint256 p) = _price(f, true);
        if (!okP) return (false, 0);
        uint256 scale = p * 1e18;
        uint256 div = 10 ** (uint256(f.feedDecimals) + f.tokenDecimals);
        if (amount / div >= type(uint256).max / scale) return (false, 0); // too large to express
        return (true, FullMath.mulDiv(amount, scale, div));
    }

    /// @notice The Chainlink price of token1 per token0 as a Uniswap tick (raw units, like a pool of the two).
    /// `ok` is false when either price is missing or stale, or the ratio is outside what a tick can express.
    function pairTick(address token0, address token1) external view returns (bool ok, int24 tick) {
        Feed memory f0 = feeds[token0];
        Feed memory f1 = feeds[token1];
        (bool ok0, uint256 p0) = _price(f0, true);
        (bool ok1, uint256 p1) = _price(f1, true);
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

    /// @dev Last answer of a feed. Never reverts. `fresh` also requires the answer to be within maxAge. Answers of
    /// 2^96 or more are refused so the arithmetic above cannot overflow.
    function _price(Feed memory f, bool fresh) internal view returns (bool ok, uint256 price) {
        if (f.aggregator == address(0)) return (false, 0);
        try IAggregator(f.aggregator).latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            if (answer <= 0 || uint256(answer) > type(uint96).max) return (false, 0);
            if (fresh && (updatedAt > block.timestamp || block.timestamp - updatedAt > f.maxAge)) return (false, 0);
            return (true, uint256(answer));
        } catch {
            return (false, 0);
        }
    }
}
