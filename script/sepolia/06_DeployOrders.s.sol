// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import {RuleHook} from "../../src/RuleHook.sol";
import {ConditionalOrders} from "../../src/ConditionalOrders.sol";
import {PriceFeeds} from "../../src/PriceFeeds.sol";
import {MockAggregator} from "../../src/testnet/MockAggregator.sol";

/// @notice Deploys the token list (PriceFeeds) and a new ConditionalOrders that points at the RuleHook already on
/// Sepolia, and lists the test tokens with Chainlink's Sepolia price feeds. The hook, its pools and its limit orders
/// stay as they are. Rewrites deployments/sepolia-core.json with the two new addresses.
///
///   forge script script/sepolia/06_DeployOrders.s.sol --rpc-url $SEPOLIA_RPC --broadcast
///
/// Feed addresses: Chainlink's published list for Ethereum Sepolia (docs.chain.link/data-feeds/price-feeds/addresses,
/// the data behind it is reference-data-directory.vercel.app/feeds-ethereum-testnet-sepolia.json). All answer in USD
/// with 8 decimals. Chainlink has no USDT / USD feed on Sepolia, so test USDT gets a fixed $1 mock feed.
contract DeployOrders is Script {
    string constant CORE = "./deployments/sepolia-core.json";

    // heartbeat 1 hour
    address constant ETH_USD = 0x694AA1769357215DE4FAC081bf1f309aDC325306;
    address constant BTC_USD = 0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43;
    address constant LINK_USD = 0xc59E3633BAAC79493d908e63626716e204A45EdF;
    // heartbeat 24 hours
    address constant USDC_USD = 0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E;
    address constant DAI_USD = 0x14866185B1962B63C3Ea9E03Bc1da838bab34C19;

    // how old an answer may be: the heartbeat plus slack (testnet feeds are sometimes late)
    uint32 constant HOURLY = 3 hours;
    uint32 constant DAILY = 26 hours;

    function run() external {
        string memory core = vm.readFile(CORE);
        string memory toks = vm.readFile("./deployments/sepolia-tokens.json");
        IPoolManager poolManager = IPoolManager(vm.parseJsonAddress(core, ".poolManager"));
        RuleHook hook = RuleHook(vm.parseJsonAddress(core, ".ruleHook"));

        vm.startBroadcast();
        PriceFeeds feeds = new PriceFeeds(msg.sender);
        MockAggregator usdtUsd = new MockAggregator(8, 1e8);

        feeds.setFeed(address(0), ETH_USD, HOURLY); // native ETH: gas is priced through it
        feeds.setFeed(vm.parseJsonAddress(toks, ".WETH"), ETH_USD, HOURLY);
        feeds.setFeed(vm.parseJsonAddress(toks, ".WBTC"), BTC_USD, HOURLY);
        feeds.setFeed(vm.parseJsonAddress(toks, ".LINK"), LINK_USD, HOURLY);
        feeds.setFeed(vm.parseJsonAddress(toks, ".USDC"), USDC_USD, DAILY);
        feeds.setFeed(vm.parseJsonAddress(toks, ".DAI"), DAI_USD, DAILY);
        feeds.setFeed(vm.parseJsonAddress(toks, ".USDT"), address(usdtUsd), DAILY);

        ConditionalOrders orders = new ConditionalOrders(poolManager, hook, feeds);
        vm.stopBroadcast();

        // deployBlock stays the hook's block: the app reads the hook's events from there too
        string memory json = vm.serializeAddress("core", "poolManager", address(poolManager));
        json = vm.serializeAddress("core", "positionManager", vm.parseJsonAddress(core, ".positionManager"));
        json = vm.serializeAddress("core", "swapRouter", vm.parseJsonAddress(core, ".swapRouter"));
        json = vm.serializeAddress("core", "permit2", vm.parseJsonAddress(core, ".permit2"));
        json = vm.serializeAddress("core", "ruleHook", address(hook));
        json = vm.serializeAddress("core", "conditionalOrders", address(orders));
        json = vm.serializeAddress("core", "priceFeeds", address(feeds));
        json = vm.serializeAddress("core", "usdtMockFeed", address(usdtUsd));
        json = vm.serializeUint("core", "deployBlock", vm.parseJsonUint(core, ".deployBlock"));
        vm.writeJson(json, CORE);
        console.log("PriceFeeds", address(feeds));
        console.log("ConditionalOrders", address(orders));
        console.log("USDT mock feed", address(usdtUsd));
    }
}
