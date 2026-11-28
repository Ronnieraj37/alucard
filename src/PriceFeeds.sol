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
///
/// The band (how far a pool may be from Chainlink) has a default and an optional tighter value per pair (two
/// stablecoins need far less room than ETH and a stablecoin). Both are set while deploying; once `lockBands` is called,
/// every change of either, tighter or looser, waits FEED_DELAY after it is announced, and the default can no longer be
/// switched off. The admin has no instant power over open orders.
contract PriceFeeds {
    error NotOwner();
    error BadFeed();
    error NotListed();
    error NotQueued();
    error BandOff();

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

    /// @notice A pair's own band in ticks (0 = the default `maxDeviationTicks`), by `pairId`.
    mapping(bytes32 pair => uint24) public pairBand;
    /// @notice Announced band changes, by `pairId` (bytes32(0) = the default band). Kept apart from feed changes.
    mapping(bytes32 pair => Queued) public queuedBand;
    /// @notice Once true, every band change waits FEED_DELAY after `queueBand`.
    bool public bandsLocked;
    /// @notice On an L2, Chainlink's sequencer uptime feed (0 = none). While the sequencer is down, and for
    /// SEQUENCER_GRACE after it comes back, no price is given: prices from before the outage are not acted on.
    address public sequencer;
    uint256 public constant SEQUENCER_GRACE = 1 hours;
    /// @dev The queue slot of a sequencer change (no pair hashes to it).
    bytes32 internal constant SEQUENCER_SLOT = keccak256("sequencer");

    event FeedSet(address indexed token, address indexed aggregator, uint32 maxAge);
    event FeedRemoved(address indexed token);
    event FeedQueued(address indexed token, address aggregator, uint32 maxAge, uint64 readyAt);
    event MaxDeviationSet(uint24 ticks);
    event MaxDeviationQueued(uint24 ticks, uint64 readyAt);
    event PairBandSet(address indexed tokenA, address indexed tokenB, uint24 ticks);
    event BandQueued(bytes32 indexed pair, uint24 ticks, uint64 readyAt);
    event BandsLocked();
    event SequencerSet(address feed);
    event SequencerQueued(address feed, uint64 readyAt);
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

    /// @notice Set the default band. Before `lockBands` it applies at once; after, only a change announced with
    /// `queueBand(0, 0, ticks)` FEED_DELAY earlier, and never 0 (off).
    function setMaxDeviationTicks(uint24 ticks) external onlyOwner {
        if (bandsLocked && ticks == 0) revert BandOff();
        _takeQueued(bytes32(0), ticks);
        maxDeviationTicks = ticks;
        emit MaxDeviationSet(ticks);
    }

    /// @notice Set a pair's own band (0 = back to the default). Same rules as the default band.
    function setPairBand(address tokenA, address tokenB, uint24 ticks) external onlyOwner {
        bytes32 id = pairId(tokenA, tokenB);
        _takeQueued(id, ticks);
        pairBand[id] = ticks;
        emit PairBandSet(tokenA, tokenB, ticks);
    }

    /// @notice Announce a band change: the default with tokenA = tokenB = 0, otherwise that pair's.
    function queueBand(address tokenA, address tokenB, uint24 ticks) external onlyOwner {
        bytes32 id = tokenA == address(0) && tokenB == address(0) ? bytes32(0) : pairId(tokenA, tokenB);
        uint64 readyAt = uint64(block.timestamp + FEED_DELAY);
        queuedBand[id] = Queued(keccak256(abi.encode(ticks)), readyAt);
        emit BandQueued(id, ticks, readyAt);
    }

    /// @notice Set (or clear, with 0) the L2 sequencer uptime feed. Before `lockBands` at once; after, only a change
    /// announced with `queueSequencer` FEED_DELAY earlier.
    function setSequencer(address feed) external onlyOwner {
        if (bandsLocked) {
            Queued memory q = queuedBand[SEQUENCER_SLOT];
            if (q.readyAt == 0 || block.timestamp < q.readyAt || q.change != keccak256(abi.encode(feed))) {
                revert NotQueued();
            }
            delete queuedBand[SEQUENCER_SLOT];
        }
        sequencer = feed;
        emit SequencerSet(feed);
    }

    /// @notice Announce a sequencer feed change; `setSequencer` can apply it FEED_DELAY from now.
    function queueSequencer(address feed) external onlyOwner {
        uint64 readyAt = uint64(block.timestamp + FEED_DELAY);
        queuedBand[SEQUENCER_SLOT] = Queued(keccak256(abi.encode(feed)), readyAt);
        emit SequencerQueued(feed, readyAt);
    }

    /// @notice End deployment: from now on every band change waits FEED_DELAY. Cannot be undone.
    function lockBands() external onlyOwner {
        if (maxDeviationTicks == 0) revert BandOff();
        bandsLocked = true;
        emit BandsLocked();
    }

    function _takeQueued(bytes32 id, uint24 ticks) internal {
        if (!bandsLocked) return;
        Queued memory q = queuedBand[id];
        if (q.readyAt == 0 || block.timestamp < q.readyAt || q.change != keccak256(abi.encode(ticks))) revert NotQueued();
        delete queuedBand[id];
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

    /// @notice The key of a pair, whichever order its tokens are given in.
    function pairId(address tokenA, address tokenB) public pure returns (bytes32) {
        (tokenA, tokenB) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(tokenA, tokenB));
    }

    /// @notice How far (in ticks) a pool of the two tokens may be from their Chainlink price. 0 = not checked (tests).
    function bandOf(address tokenA, address tokenB) external view returns (uint24) {
        uint24 b = pairBand[pairId(tokenA, tokenB)];
        return b != 0 ? b : maxDeviationTicks;
    }

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
        if (!_sequencerUp()) ok = false;
        decimals = f.feedDecimals;
    }

    /// @notice The Chainlink price of token1 per token0 as a Uniswap tick (raw units, like a pool of the two).
    /// `ok` is false when either price is missing or stale, or the ratio is outside what a tick can express.
    function pairTick(address token0, address token1) external view returns (bool ok, int24 tick) {
        if (!_sequencerUp()) return (false, 0);
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

    /// @dev True without a sequencer feed; otherwise the sequencer is up (answer 0) and has been for SEQUENCER_GRACE.
    function _sequencerUp() internal view returns (bool) {
        if (sequencer == address(0)) return true;
        try IAggregator(sequencer).latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            return answer == 0 && startedAt != 0 && block.timestamp >= startedAt + SEQUENCER_GRACE;
        } catch {
            return false;
        }
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
