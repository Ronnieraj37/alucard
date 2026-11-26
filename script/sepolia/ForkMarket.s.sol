// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";

import {PriceFeeds} from "../../src/PriceFeeds.sol";
import {MockAggregator} from "../../src/testnet/MockAggregator.sol";

/// @notice LOCAL FORK ONLY: give every listed token a mock Chainlink feed the deployer can move, so a test (or a demo)
/// can move "the market" and watch arbitrage and strategies follow. Two runs, because a listed feed changes only after
/// the 2-day timelock (anvil can skip it):
///   FORK=1 PHASE=queue forge script script/sepolia/ForkMarket.s.sol --rpc-url http://127.0.0.1:8546 --broadcast ...
///   cast rpc evm_increaseTime 172800; cast rpc evm_mine
///   FORK=1 PHASE=set   forge script ... (same)
/// Each mock starts at the real feed's last answer, with the same decimals. Refuses to run without FORK=1.
contract ForkMarket is Script {
    uint32 constant MAX_AGE = 30 days; // a mock's answer is always fresh

    function run() external {
        require(vm.envOr("FORK", false), "local fork only: set FORK=1");
        string memory core = vm.readFile("./deployments/fork/sepolia-core.json");
        PriceFeeds feeds = PriceFeeds(vm.parseJsonAddress(core, ".priceFeeds"));
        address[] memory toks = feeds.tokens();
        string memory file = "./deployments/fork/mock-feeds.json";
        bool queue = keccak256(bytes(vm.envString("PHASE"))) == keccak256("queue");

        vm.startBroadcast();
        string memory json;
        for (uint256 i; i < toks.length; ++i) {
            address token = toks[i];
            address mock;
            if (queue) {
                (bool ok, uint256 price, uint8 decimals) = feeds.priceOf(token);
                require(ok, "a listed feed has no price");
                mock = address(new MockAggregator(decimals, int256(price)));
                feeds.queueFeed(token, mock, MAX_AGE);
                json = vm.serializeAddress("mocks", vm.toString(token), mock);
            } else {
                mock = vm.parseJsonAddress(vm.readFile(file), string.concat(".", vm.toString(token)));
                feeds.setFeed(token, mock, MAX_AGE);
            }
            console.log(token, mock);
        }
        vm.stopBroadcast();
        if (queue) vm.writeJson(json, file);
    }
}
