// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice A stand-in for a Chainlink price feed, for tests and for test tokens that have no real feed.
/// It reports its answer as updated now, unless `setUpdatedAt` pinned a time (to test old prices).
contract MockAggregator {
    uint8 public immutable decimals;
    address public immutable owner;
    int256 public answer;
    uint256 public pinnedAt; // 0 = always fresh
    bool public broken; // latestRoundData reverts

    constructor(uint8 _decimals, int256 _answer) {
        decimals = _decimals;
        answer = _answer;
        owner = msg.sender;
    }

    function setAnswer(int256 _answer) external {
        require(msg.sender == owner, "not owner");
        answer = _answer;
    }

    function setUpdatedAt(uint256 t) external {
        require(msg.sender == owner, "not owner");
        pinnedAt = t;
    }

    function setBroken(bool b) external {
        require(msg.sender == owner, "not owner");
        broken = b;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed down");
        uint256 t = pinnedAt == 0 ? block.timestamp : pinnedAt;
        return (1, answer, t, t, 1);
    }
}
