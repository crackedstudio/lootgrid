// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PlayerRegistry} from "../src/PlayerRegistry.sol";

/**
 * Deploys PlayerRegistry behind a UUPS proxy.
 *
 *   REGISTRY_OWNER=0xYourMultisig forge script script/Deploy.s.sol \
 *     --rpc-url $CELO_SEPOLIA_RPC_URL \
 *     --private-key $DEPLOYER_KEY \
 *     --broadcast --verify
 *
 * Put the **proxy** address in the server's PLAYER_REGISTRY_ADDRESS — the
 * implementation address is only needed for verification.
 *
 * ⚠️ REGISTRY_OWNER holds upgrade authority over every player's identity. It
 * must be a multisig. A single EOA here is a single key that can impersonate
 * the entire player base, and the 48h timelock only buys time to notice.
 */
contract Deploy is Script {
    function run() external returns (PlayerRegistry registry, address implementation) {
        address owner = vm.envAddress("REGISTRY_OWNER");
        // The multisig requirement is documented in three places; enforce it here
        // so it is a precondition rather than a hope. `ALLOW_EOA_OWNER=true`
        // exists for local and testnet runs only.
        if (!vm.envOr("ALLOW_EOA_OWNER", false)) {
            require(owner.code.length > 0, "REGISTRY_OWNER must be a contract (multisig)");
        }

        vm.startBroadcast();

        PlayerRegistry impl = new PlayerRegistry();
        // Initialization happens in the same transaction as proxy deployment, so
        // there is no window in which an attacker can call initialize() first.
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(impl), abi.encodeCall(PlayerRegistry.initialize, (owner)));

        vm.stopBroadcast();

        registry = PlayerRegistry(address(proxy));
        implementation = address(impl);

        console.log("PlayerRegistry (proxy)  :", address(proxy));
        console.log("implementation          :", address(impl));
        console.log("owner                   :", owner);
        console.log("upgrade delay (seconds) :", registry.UPGRADE_DELAY());
    }
}
