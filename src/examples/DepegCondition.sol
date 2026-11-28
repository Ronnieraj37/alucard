// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IAlucardCondition} from "../interfaces/IAlucardCondition.sol";

interface IFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title An example "when" card: a stablecoin loses its peg
/// @notice True while a Chainlink USD feed reads below `threshold` (in the feed's decimals) with a fresh answer, e.g.
/// "USDC below $0.99: leave the pool". It ignores which order asks, so one card serves everyone. Copy it to write your
/// own: any view logic that returns a bool.
contract DepegCondition is IAlucardCondition {
    IFeed public immutable feed;
    int256 public immutable threshold;
    uint256 public immutable maxAge;

    constructor(address _feed, int256 _threshold, uint256 _maxAge) {
        feed = IFeed(_feed);
        threshold = _threshold;
        maxAge = _maxAge;
    }

    function isMet(address, uint256, bool) external view returns (bool) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        return answer > 0 && answer < threshold && block.timestamp - updatedAt <= maxAge;
    }
}
