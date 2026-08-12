// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {LootGridActions} from "../src/LootGridActions.sol";

/**
 * Deploys LootGridActions.
 *
 *   ACTIONS_OWNER=0xYourMultisig ACTIONS_RELAYER=0xHotWallet \
 *     ACTIONS_ATTESTOR=0xSigningKey \
 *     forge script script/DeployActions.s.sol \
 *     --rpc-url $CELO_SEPOLIA_RPC_URL \
 *     --private-key $DEPLOYER_KEY \
 *     --broadcast --verify
 *
 * Put the deployed address in the server's LOOTGRID_ACTIONS_ADDRESS.
 *
 * No proxy, deliberately — the contract holds no funds and no state, so a
 * redeploy is cheaper and safer than carrying an upgrade key. See the contract
 * header.
 *
 * The three roles are separate on purpose:
 *
 *   ACTIONS_RELAYER  the server's hot key. Lives in RELAY_PRIVATE_KEY on the
 *                    VPS, funded with a small gas float. Assume it will leak
 *                    eventually; the worst it can do is write false game logs,
 *                    and rotating it is one owner transaction.
 *
 *   ACTIONS_ATTESTOR the referee's *signing* key, in ATTESTOR_PRIVATE_KEY. It
 *                    never sends a transaction and so needs no balance, which
 *                    lets it sit somewhere colder than the relayer. A leak here
 *                    is worse: it mints entries and winning resolutions that any
 *                    address can submit. Rotate via setAttestor.
 *
 *   ACTIONS_OWNER    can rotate both keys. Should be a multisig, but the stakes
 *                    are far lower than REGISTRY_OWNER — it cannot touch funds
 *                    or identity, so an EOA is permitted without a flag.
 */
contract DeployActions is Script {
    function run() external returns (LootGridActions actions) {
        address owner = vm.envAddress("ACTIONS_OWNER");
        address relayer = vm.envAddress("ACTIONS_RELAYER");
        address attestor = vm.envAddress("ACTIONS_ATTESTOR");

        // The relayer signs every record. If it is also the owner, a leaked hot
        // key can re-point the contract at itself and rotation stops helping.
        require(owner != relayer, "ACTIONS_OWNER must differ from ACTIONS_RELAYER");
        require(owner != attestor, "ACTIONS_OWNER must differ from ACTIONS_ATTESTOR");
        // Sharing one key collapses the split that makes the attestor worth
        // having: the exposed hot wallet would also be able to mint attestations.
        require(relayer != attestor, "ACTIONS_RELAYER must differ from ACTIONS_ATTESTOR");

        vm.startBroadcast();
        actions = new LootGridActions(owner, relayer, attestor);
        vm.stopBroadcast();

        console.log("LootGridActions :", address(actions));
        console.log("owner           :", owner);
        console.log("relayer         :", relayer);
        console.log("attestor        :", attestor);
    }
}
