// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PlayerRegistry} from "../src/PlayerRegistry.sol";

/**
 * Deploys PlayerRegistry.
 *
 *   forge script script/Deploy.s.sol \
 *     --rpc-url $CELO_SEPOLIA_RPC_URL \
 *     --private-key $DEPLOYER_KEY \
 *     --broadcast --verify
 *
 * Put the resulting address in the server's PLAYER_REGISTRY_ADDRESS.
 * The contract holds no funds and has no admin, so there is nothing to
 * configure after deployment and nothing to lose if the deployer key is.
 */
contract Deploy is Script {
    function run() external returns (PlayerRegistry registry) {
        vm.startBroadcast();
        registry = new PlayerRegistry();
        vm.stopBroadcast();

        console.log("PlayerRegistry:", address(registry));
    }
}
