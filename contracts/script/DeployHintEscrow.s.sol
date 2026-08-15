// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {HintEscrow} from "../src/HintEscrow.sol";

/**
 * Deploys HintEscrow.
 *
 *   HINT_TOKEN=0x765DE816845861e75A25fCA122bb6898B8B1282a \
 *   HINT_OWNER=0xYourMultisig HINT_TREASURY=0xTreasury \
 *   HINT_VOUCH_ATTESTOR=0xRecordsSigner HINT_RELEASE_ATTESTOR=0xPayoutSigner \
 *   HINT_GUARDIAN=0xOncall \
 *   HINT_RAKE_BPS=250 \
 *   HINT_MIN_TRADE=10000000000000000 \
 *   HINT_PER_TRADE_CAP=5000000000000000000 \
 *   HINT_RAKE_WAIVER=50000000000000000 \
 *   HINT_CHALLENGE_WINDOW=3600 \
 *   HINT_MAX_TTL=86400 \
 *     forge script script/DeployHintEscrow.s.sol \
 *     --rpc-url $CELO_SEPOLIA_RPC_URL --private-key $DEPLOYER_KEY --broadcast --verify
 *
 * Amounts are in the token's own units — cUSD and USDm are 18dp, USDC and USDT
 * are 6dp. A minimum trade set twelve orders of magnitude wrong is a minimum
 * that never binds, so the script prints everything back for a human to read.
 *
 * ─────────────────────────── the two signers ───────────────────────────
 *
 *   HINT_VOUCH_ATTESTOR   certifies that a hint was issued by the game, at a
 *                         stated tier. It authorises nothing financial on its
 *                         own — a vouch with no funding moves nothing — so it
 *                         can be the same hot key as ACTIONS_ATTESTOR.
 *
 *   HINT_RELEASE_ATTESTOR moves a buyer's escrowed money to a seller. This is
 *                         the crown jewel, and it must NOT be the vouch key: one
 *                         leak would otherwise both fabricate what may be sold
 *                         and pay for it. Put it behind a multisig before real
 *                         money trades.
 *
 * The treasury only ever receives the rake, never a buyer's escrow, so it is a
 * far less interesting target here than in LootGridEscrow.
 */
contract DeployHintEscrow is Script {
    function run() external returns (HintEscrow escrow) {
        address token = vm.envAddress("HINT_TOKEN");
        address owner = vm.envAddress("HINT_OWNER");
        address treasury = vm.envAddress("HINT_TREASURY");
        address vouchAttestor = vm.envAddress("HINT_VOUCH_ATTESTOR");
        address releaseAttestor = vm.envAddress("HINT_RELEASE_ATTESTOR");
        address guardian = vm.envAddress("HINT_GUARDIAN");

        HintEscrow.Limits memory limits = HintEscrow.Limits({
            rakeBps: uint16(vm.envUint("HINT_RAKE_BPS")),
            minTradeAmount: vm.envUint("HINT_MIN_TRADE"),
            perTradeCap: vm.envUint("HINT_PER_TRADE_CAP"),
            rakeWaiverAmount: vm.envUint("HINT_RAKE_WAIVER"),
            challengeWindow: uint64(vm.envUint("HINT_CHALLENGE_WINDOW")),
            maxTradeTtl: uint64(vm.envUint("HINT_MAX_TTL"))
        });

        // The separation this contract's two typehashes exist to provide.
        require(
            vouchAttestor != releaseAttestor, "HINT_VOUCH_ATTESTOR must differ from HINT_RELEASE_ATTESTOR"
        );
        require(owner != releaseAttestor, "HINT_OWNER must differ from HINT_RELEASE_ATTESTOR");
        require(guardian != releaseAttestor, "HINT_GUARDIAN must differ from HINT_RELEASE_ATTESTOR");

        // Keep this SHORT — minutes, not hours. The window restarts on every
        // credit, so an account paid more often than once per window never
        // becomes withdrawable: a long one silently freezes a busy seller and
        // the treasury's own rake. Individual trades are worth cents, so the
        // reaction time it buys is worth much less here than on a prize pot.
        //
        // Zero means a seller's credit is withdrawable in the same block it is
        // released, leaving nobody time to notice a compromised signer.
        if (limits.challengeWindow == 0) {
            require(
                vm.envOr("ALLOW_ZERO_CHALLENGE_WINDOW", false),
                "HINT_CHALLENGE_WINDOW=0 leaves no time to halt a bad release"
            );
        }

        vm.startBroadcast();
        escrow = new HintEscrow(token, owner, treasury, vouchAttestor, releaseAttestor, guardian, limits);
        vm.stopBroadcast();

        console.log("HintEscrow        :", address(escrow));
        console.log("token             :", token);
        console.log("owner             :", owner);
        console.log("treasury          :", treasury);
        console.log("vouchAttestor     :", vouchAttestor);
        console.log("releaseAttestor   :", releaseAttestor);
        console.log("guardian          :", guardian);
        console.log("rakeBps           :", limits.rakeBps);
        console.log("minTrade    (raw) :", limits.minTradeAmount);
        console.log("perTradeCap (raw) :", limits.perTradeCap);
        console.log("rakeWaiver  (raw) :", limits.rakeWaiverAmount);
        console.log("challengeWindow   :", limits.challengeWindow);
        console.log("maxTradeTtl       :", limits.maxTradeTtl);
        console.log("");
        console.log("Amounts are in the TOKEN's units. Check the decimals before the first trade.");
        console.log("Buyers must approve() this address before they can fund one.");
    }
}
