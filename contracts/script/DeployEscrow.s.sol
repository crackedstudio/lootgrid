// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {LootGridEscrow} from "../src/LootGridEscrow.sol";

/**
 * Deploys LootGridEscrow.
 *
 *   ESCROW_TOKEN=0x765DE816845861e75A25fCA122bb6898B8B1282a \
 *   ESCROW_OWNER=0xYourMultisig ESCROW_TREASURY=0xTreasury \
 *   ESCROW_ATTESTOR=0xPayoutSigner ESCROW_GUARDIAN=0xOncall \
 *   ESCROW_PER_HUNT_CAP=5000000000000000000 \
 *   ESCROW_PER_DAY_CAP=100000000000000000000 \
 *   ESCROW_CHALLENGE_WINDOW=3600 \
 *     forge script script/DeployEscrow.s.sol \
 *     --rpc-url $CELO_SEPOLIA_RPC_URL --private-key $DEPLOYER_KEY --broadcast --verify
 *
 * Caps are in the token's own units — cUSD and USDm are 18dp, USDC and USDT are
 * 6dp. Getting that wrong by twelve orders of magnitude is the easiest way to
 * make the caps meaningless, so the script prints them back for a human to read
 * before anything is funded.
 *
 * ─────────────────────────── the four roles ───────────────────────────
 *
 *   ESCROW_ATTESTOR  signs payouts. **This is the crown jewel.** A leak here pays
 *                    attested winners up to the caps; unlike the relayer key, the
 *                    damage is financial rather than cosmetic. It should be a
 *                    multisig or threshold signer before real money is escrowed,
 *                    and it should NOT be the same key as ACTIONS_ATTESTOR — that
 *                    separation is the entire reason this contract has its own
 *                    EIP-712 domain.
 *
 *   ESCROW_TREASURY  funds pots and receives refunds. Holds the float, so it is
 *                    the balance an attacker would most like to reach — but it
 *                    can only ever move money *into* escrow.
 *
 *   ESCROW_GUARDIAN  can pause claims and withdrawals during an incident. Never
 *                    blocks refunds. Should be reachable at 3am, which usually
 *                    means a different key from the multisig.
 *
 *   ESCROW_OWNER     rotates the other three and sets caps. Should be a multisig.
 */
contract DeployEscrow is Script {
    function run() external returns (LootGridEscrow escrow) {
        address token = vm.envAddress("ESCROW_TOKEN");
        address owner = vm.envAddress("ESCROW_OWNER");
        address treasury = vm.envAddress("ESCROW_TREASURY");
        address attestor = vm.envAddress("ESCROW_ATTESTOR");
        address guardian = vm.envAddress("ESCROW_GUARDIAN");
        uint256 perHuntCap = vm.envUint("ESCROW_PER_HUNT_CAP");
        uint256 perDayCap = vm.envUint("ESCROW_PER_DAY_CAP");
        uint64 challengeWindow = uint64(vm.envUint("ESCROW_CHALLENGE_WINDOW"));

        // Sharing a key collapses a separation that exists precisely so one
        // compromise does not become another.
        require(owner != attestor, "ESCROW_OWNER must differ from ESCROW_ATTESTOR");
        require(treasury != attestor, "ESCROW_TREASURY must differ from ESCROW_ATTESTOR");
        require(guardian != attestor, "ESCROW_GUARDIAN must differ from ESCROW_ATTESTOR");

        // A day cap below a single hunt cap can never bind, which reads as a cap
        // while being none.
        require(perDayCap >= perHuntCap, "ESCROW_PER_DAY_CAP must be >= ESCROW_PER_HUNT_CAP");

        // Zero means a payout is withdrawable in the same block it is claimed,
        // leaving nobody any time to notice a compromised signer. Permitted for
        // local and testnet runs; make it deliberate anywhere else.
        if (challengeWindow == 0) {
            require(
                vm.envOr("ALLOW_ZERO_CHALLENGE_WINDOW", false),
                "ESCROW_CHALLENGE_WINDOW=0 leaves no time to halt a bad payout"
            );
        }

        vm.startBroadcast();
        escrow = new LootGridEscrow(
            token, owner, treasury, attestor, guardian, perHuntCap, perDayCap, challengeWindow
        );
        vm.stopBroadcast();

        console.log("LootGridEscrow   :", address(escrow));
        console.log("token            :", token);
        console.log("owner            :", owner);
        console.log("treasury         :", treasury);
        console.log("attestor         :", attestor);
        console.log("guardian         :", guardian);
        console.log("perHuntCap (raw) :", perHuntCap);
        console.log("perDayCap  (raw) :", perDayCap);
        console.log("challengeWindow  :", challengeWindow);
        console.log("");
        console.log("Caps are in the TOKEN's units. Check the decimals before funding.");
        console.log("Treasury must approve() this address before the first fundHunt.");
    }
}
