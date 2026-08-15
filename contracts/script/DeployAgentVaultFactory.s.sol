// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentVaultFactory} from "../src/AgentVaultFactory.sol";

/**
 * Deploys AgentVaultFactory.
 *
 *   forge script script/DeployAgentVaultFactory.s.sol \
 *     --rpc-url $CELO_SEPOLIA_RPC_URL --private-key $DEPLOYER_KEY --broadcast --verify
 *
 * ─────────────────────────── no arguments, on purpose ───────────────────────
 *
 * The factory takes no constructor parameters and holds no privileges: it does
 * not own the vaults it creates, cannot spend from them, cannot pause them and
 * cannot be upgraded. Every vault's owner is whoever called `create`, which is
 * the property that makes it safe for the house to publish this address and
 * tell players to use it.
 *
 * The token is chosen per vault rather than fixed here, so the same factory
 * serves however many stablecoins the game later settles in.
 *
 * Put the deployed address in the server's AGENT_VAULT_FACTORY_ADDRESS. It is
 * the only agent-side address the server needs to know: vault addresses are
 * read back from `vaultOf`, so the server's own database is never the authority
 * on whose money is where.
 */
contract DeployAgentVaultFactory is Script {
    function run() external returns (AgentVaultFactory factory) {
        vm.startBroadcast();
        factory = new AgentVaultFactory();
        vm.stopBroadcast();

        console.log("AgentVaultFactory:", address(factory));
        console.log("");
        console.log("Set AGENT_VAULT_FACTORY_ADDRESS to this. It owns nothing and");
        console.log("cannot spend: every vault belongs to whoever called create().");
    }
}
