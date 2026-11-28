// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {AddressConstants} from "hookmate/constants/AddressConstants.sol";

import {RuleHook} from "../../src/RuleHook.sol";
import {ConditionalOrders} from "../../src/ConditionalOrders.sol";
import {PriceFeeds} from "../../src/PriceFeeds.sol";
import {Rules} from "../../src/Rules.sol";
import {MockAggregator} from "../../src/testnet/MockAggregator.sol";
import {Net} from "./Net.sol";

/// @notice Deploys the whole core on Sepolia: the token list (PriceFeeds, with the test tokens listed on Chainlink's
/// Sepolia feeds), RuleHook (at a mined address with the right hook flags), Rules and ConditionalOrders. The hook
/// reads the token list to pay `fillBucket` callers, so the list comes first. Run 01_DeployTokens before (or keep
/// its tokens) and 03_CreatePools after: pools belong to a hook, so a new hook needs new pools.
///   forge script script/sepolia/02_DeployCore.s.sol --rpc-url sepolia --broadcast
///
/// Feed addresses: Chainlink's published list for Ethereum Sepolia. All answer in USD with 8 decimals. Chainlink has
/// no USDT / USD feed on Sepolia, so test USDT gets a fixed $1 mock feed (reused if one was deployed before).
/// OUT_DIR (default ./deployments) lets a rehearsal on a fork write somewhere else.
contract DeployCore is Script {
    uint24 constant MAX_DEVIATION_TICKS = 200;
    uint24 constant STABLE_PAIR_TICKS = 50;

    function run() external {
        string memory dir = vm.envOr("OUT_DIR", string("./deployments"));
        string memory toks = vm.readFile(Net.file(block.chainid, "./deployments", "tokens"));
        Net.Feeds memory f = Net.feeds(block.chainid);
        IPoolManager poolManager = IPoolManager(AddressConstants.getPoolManagerAddress(block.chainid));
        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);

        vm.startBroadcast();
        PriceFeeds feeds = new PriceFeeds(msg.sender);
        // a stablecoin with no Chainlink feed on this chain gets a fixed $1 mock (reused from an earlier deployment)
        address usdtUsd = f.usdt != address(0) ? f.usdt : _mockFeed(dir, ".usdtMockFeed");
        address daiUsd = f.dai != address(0) ? f.dai : _mockFeed(dir, ".daiMockFeed");
        feeds.setFeed(address(0), f.eth, f.hourlyAge); // native ETH
        feeds.setFeed(vm.parseJsonAddress(toks, ".WETH"), f.eth, f.hourlyAge);
        feeds.setFeed(vm.parseJsonAddress(toks, ".WBTC"), f.btc, f.hourlyAge);
        feeds.setFeed(vm.parseJsonAddress(toks, ".LINK"), f.link, f.hourlyAge);
        feeds.setFeed(vm.parseJsonAddress(toks, ".USDC"), f.usdc, f.dailyAge);
        feeds.setFeed(vm.parseJsonAddress(toks, ".DAI"), daiUsd, f.dailyAge);
        feeds.setFeed(vm.parseJsonAddress(toks, ".USDT"), usdtUsd, f.dailyAge);
        // a pool's price must be within ~2% of Chainlink for a strategy step to run (frontend/scripts/arb.ts keeps
        // the test pools there, as arbitrageurs do on mainnet)
        feeds.setMaxDeviationTicks(MAX_DEVIATION_TICKS);
        // two stablecoins need far less room: ~0.5% between any two of them
        address usdc = vm.parseJsonAddress(toks, ".USDC");
        address usdt = vm.parseJsonAddress(toks, ".USDT");
        address dai = vm.parseJsonAddress(toks, ".DAI");
        feeds.setPairBand(usdc, usdt, STABLE_PAIR_TICKS);
        feeds.setPairBand(usdc, dai, STABLE_PAIR_TICKS);
        feeds.setPairBand(usdt, dai, STABLE_PAIR_TICKS);
        // from here on every band change waits two days after it is announced: the admin has no instant power
        feeds.lockBands();
        vm.stopBroadcast();

        bytes memory args = abi.encode(poolManager);
        (address hookAddress, bytes32 salt) = HookMiner.find(CREATE2_FACTORY, flags, type(RuleHook).creationCode, args);

        vm.startBroadcast();
        RuleHook hook = new RuleHook{salt: salt}(poolManager);
        Rules rules = new Rules(poolManager, address(hook), feeds);
        ConditionalOrders orders = new ConditionalOrders(poolManager, rules);
        vm.stopBroadcast();
        require(address(hook) == hookAddress, "hook address mismatch");

        string memory json = vm.serializeAddress("core", "poolManager", address(poolManager));
        json = vm.serializeAddress("core", "positionManager", AddressConstants.getPositionManagerAddress(block.chainid));
        json = vm.serializeAddress("core", "swapRouter", AddressConstants.getV4SwapRouterAddress(block.chainid));
        json = vm.serializeAddress("core", "permit2", AddressConstants.getPermit2Address());
        json = vm.serializeAddress("core", "ruleHook", address(hook));
        json = vm.serializeAddress("core", "conditionalOrders", address(orders));
        json = vm.serializeAddress("core", "rules", address(rules));
        json = vm.serializeAddress("core", "priceFeeds", address(feeds));
        if (f.usdt == address(0)) json = vm.serializeAddress("core", "usdtMockFeed", usdtUsd);
        if (f.dai == address(0)) json = vm.serializeAddress("core", "daiMockFeed", daiUsd);
        json = vm.serializeUint("core", "chainId", block.chainid);
        json = vm.serializeUint("core", "deployBlock", block.number);
        vm.writeJson(json, Net.file(block.chainid, dir, "core"));
        console.log("RuleHook", address(hook));
        console.log("Rules", address(rules));
        console.log("ConditionalOrders", address(orders));
        console.log("PriceFeeds", address(feeds));
    }

    /// @dev The $1 feed of an earlier deployment if there is one (`key` in the core file), else a new one.
    function _mockFeed(string memory dir, string memory key) internal returns (address) {
        string memory path = Net.file(block.chainid, dir, "core");
        if (vm.exists(path)) {
            string memory old = vm.readFile(path);
            if (vm.keyExistsJson(old, key)) {
                address f = vm.parseJsonAddress(old, key);
                if (f.code.length > 0) return f;
            }
        }
        return address(new MockAggregator(8, 1e8));
    }
}
