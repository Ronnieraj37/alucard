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
    address constant ETH_USD = 0x694AA1769357215DE4FAC081bf1f309aDC325306;
    address constant BTC_USD = 0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43;
    address constant LINK_USD = 0xc59E3633BAAC79493d908e63626716e204A45EdF;
    address constant USDC_USD = 0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E;
    address constant DAI_USD = 0x14866185B1962B63C3Ea9E03Bc1da838bab34C19;
    // how old an answer may be: the heartbeat plus slack (testnet feeds are sometimes late)
    uint32 constant HOURLY = 3 hours;
    uint32 constant DAILY = 26 hours;

    function run() external {
        string memory dir = vm.envOr("OUT_DIR", string("./deployments"));
        string memory toks = vm.readFile("./deployments/sepolia-tokens.json");
        IPoolManager poolManager = IPoolManager(AddressConstants.getPoolManagerAddress(block.chainid));
        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);

        vm.startBroadcast();
        PriceFeeds feeds = new PriceFeeds(msg.sender);
        address usdtUsd = _usdtFeed();
        feeds.setFeed(address(0), ETH_USD, HOURLY); // native ETH: gas is priced through it
        feeds.setFeed(vm.parseJsonAddress(toks, ".WETH"), ETH_USD, HOURLY);
        feeds.setFeed(vm.parseJsonAddress(toks, ".WBTC"), BTC_USD, HOURLY);
        feeds.setFeed(vm.parseJsonAddress(toks, ".LINK"), LINK_USD, HOURLY);
        feeds.setFeed(vm.parseJsonAddress(toks, ".USDC"), USDC_USD, DAILY);
        feeds.setFeed(vm.parseJsonAddress(toks, ".DAI"), DAI_USD, DAILY);
        feeds.setFeed(vm.parseJsonAddress(toks, ".USDT"), usdtUsd, DAILY);
        vm.stopBroadcast();

        bytes memory args = abi.encode(poolManager, feeds);
        (address hookAddress, bytes32 salt) = HookMiner.find(CREATE2_FACTORY, flags, type(RuleHook).creationCode, args);

        vm.startBroadcast();
        RuleHook hook = new RuleHook{salt: salt}(poolManager, feeds);
        Rules rules = new Rules(poolManager, hook, feeds);
        ConditionalOrders orders = new ConditionalOrders(poolManager, hook, feeds, rules);
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
        json = vm.serializeAddress("core", "usdtMockFeed", usdtUsd);
        json = vm.serializeUint("core", "deployBlock", block.number);
        vm.writeJson(json, string.concat(dir, "/sepolia-core.json"));
        console.log("RuleHook", address(hook));
        console.log("Rules", address(rules));
        console.log("ConditionalOrders", address(orders));
        console.log("PriceFeeds", address(feeds));
    }

    /// @dev The $1 USDT feed of an earlier deployment if there is one, else a new one.
    function _usdtFeed() internal returns (address) {
        string memory old = vm.readFile("./deployments/sepolia-core.json");
        if (vm.keyExistsJson(old, ".usdtMockFeed")) {
            address f = vm.parseJsonAddress(old, ".usdtMockFeed");
            if (f.code.length > 0) return f;
        }
        return address(new MockAggregator(8, 1e8));
    }
}
