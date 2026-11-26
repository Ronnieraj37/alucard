// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";

import {BaseScript} from "./base/BaseScript.sol";

import {RuleHook} from "../src/RuleHook.sol";
import {ConditionalOrders} from "../src/ConditionalOrders.sol";
import {PriceFeeds} from "../src/PriceFeeds.sol";
import {Rules} from "../src/Rules.sol";

/// @notice Deploys the token list, mines the hook address and deploys RuleHook, then Rules and ConditionalOrders.
contract DeployHookScript is BaseScript {
    function run() public {
        // hook contracts must have specific flags encoded in the address
        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG);

        vm.startBroadcast();
        // the deployer owns the token list and must list tokens (PriceFeeds.setFeed) before orders can be created
        PriceFeeds feeds = new PriceFeeds(msg.sender);
        vm.stopBroadcast();

        // Mine a salt that will produce a hook address with the correct flags
        bytes memory constructorArgs = abi.encode(poolManager, feeds);
        (address hookAddress, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, flags, type(RuleHook).creationCode, constructorArgs);

        vm.startBroadcast();
        RuleHook hook = new RuleHook{salt: salt}(poolManager, feeds);
        Rules rules = new Rules(poolManager, hook, feeds);
        new ConditionalOrders(poolManager, hook, feeds, rules);
        vm.stopBroadcast();

        require(address(hook) == hookAddress, "DeployHookScript: Hook Address Mismatch");
    }
}
