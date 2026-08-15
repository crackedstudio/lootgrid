// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {HintBond} from "../src/HintBond.sol";

/**
 * Deploys HintBond.
 *
 *   BOND_TOKEN=0x765DE816845861e75A25fCA122bb6898B8B1282a \
 *   BOND_OWNER=0xYourMultisig BOND_SLASH_ATTESTOR=0xVerdictSigner \
 *   BOND_GUARDIAN=0xOncall BOND_BENEFICIARY=0xTreasury \
 *   BOND_WITHDRAW_DELAY=259200 BOND_MIN=... \
 *     forge script script/DeployHintBond.s.sol \
 *     --rpc-url $CELO_SEPOLIA_RPC_URL --private-key $DEPLOYER_KEY --broadcast --verify
 *
 * Put the resulting address in the server's HINT_BOND_ADDRESS. Until it is set,
 * the bond requirement does not exist and listing behaves as it did before —
 * which means deploying this is what turns slashing from a capability into a
 * rule.
 *
 * ─────────────────────────── BOND_WITHDRAW_DELAY is the design ──────────────
 *
 * It must outlast the longest hunt PLUS the window in which that hunt's hints
 * are revealed and the seller's record is judged. Set it too short and the
 * attack is complete and trivial: post a bond, sell hints you know are false,
 * withdraw before anyone can prove it.
 *
 * Agent-zone hunts run for hours and verdicts are computed over a window of
 * settled trades, so three days is a starting point rather than a maximum. The
 * check below refuses anything under a day, because a delay shorter than a hunt
 * is not a delay at all — it is a formality that looks like one.
 *
 * ─────────────────────────── BOND_MIN gates listing ─────────────────────────
 *
 * A seller below it fails `canList`, which is how a slash removes somebody from
 * the market rather than merely costing them. Too low and the penalty is a
 * rounding error against what adverse selection earns; too high and the honest
 * small seller cannot participate at all. It is a product decision, so it is
 * printed rather than defaulted.
 *
 * BOND_BENEFICIARY should be the Treasury: money taken from a cheating seller
 * going back into prizes is the only destination that does not give somebody an
 * incentive to find sellers guilty.
 */
contract DeployHintBond is Script {
    /// A delay shorter than a hunt cannot do the one job it exists for.
    uint64 internal constant MIN_SANE_DELAY = 1 days;

    function run() external returns (HintBond bond) {
        address token = vm.envAddress("BOND_TOKEN");
        address owner = vm.envAddress("BOND_OWNER");
        address slashAttestor = vm.envAddress("BOND_SLASH_ATTESTOR");
        address guardian = vm.envAddress("BOND_GUARDIAN");
        address beneficiary = vm.envAddress("BOND_BENEFICIARY");

        uint64 withdrawDelay = uint64(vm.envUint("BOND_WITHDRAW_DELAY"));
        uint256 minBond = vm.envUint("BOND_MIN");

        // Enforced by the constructor as well. Failing here means the deployer
        // learns before spending gas rather than after.
        require(slashAttestor != owner, "BOND_SLASH_ATTESTOR must differ from BOND_OWNER");
        // The signer decides who loses money; the beneficiary receives it. One
        // key holding both ends is a key that can pay itself.
        require(slashAttestor != beneficiary, "BOND_SLASH_ATTESTOR must differ from BOND_BENEFICIARY");

        if (!vm.envOr("ALLOW_EOA_OWNER", false)) {
            require(owner.code.length > 0, "BOND_OWNER must be a contract (multisig)");
        }

        if (withdrawDelay < MIN_SANE_DELAY) {
            require(
                vm.envOr("ALLOW_SHORT_DELAY", false),
                "BOND_WITHDRAW_DELAY under a day lets a seller exit before the verdict"
            );
        }

        vm.startBroadcast();
        bond = new HintBond(token, owner, slashAttestor, guardian, beneficiary, withdrawDelay, minBond);
        vm.stopBroadcast();

        console.log("HintBond            :", address(bond));
        console.log("token               :", token);
        console.log("owner               :", owner);
        console.log("slashAttestor       :", slashAttestor);
        console.log("guardian            :", guardian);
        console.log("beneficiary         :", beneficiary);
        console.log("withdrawDelay(secs) :", withdrawDelay);
        console.log("minBond       (raw) :", minBond);
        console.log("");
        console.log("Amounts are in the TOKEN's units. Check the decimals before sellers post.");
        console.log("Set HINT_BOND_ADDRESS on the server to start requiring a bond to list.");
    }
}
