// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Treasury} from "../src/Treasury.sol";

/**
 * Deploys Treasury.
 *
 *   TREASURY_TOKEN=0x765DE816845861e75A25fCA122bb6898B8B1282a \
 *   TREASURY_OWNER=0xYourMultisig \
 *   TREASURY_PROPOSER=0xAgentKey TREASURY_GUARDIAN=0xOncall \
 *   TREASURY_RESERVE=... TREASURY_PER_PROPOSAL=... TREASURY_PER_DAY=... \
 *   TREASURY_DELAY=86400 \
 *     forge script script/DeployTreasury.s.sol \
 *     --rpc-url $CELO_SEPOLIA_RPC_URL --private-key $DEPLOYER_KEY --broadcast --verify
 *
 * Amounts are in the token's own units — cUSD and USDm are 18dp, USDC and USDT
 * are 6dp — so everything is printed back for a human to read before the first
 * proposal.
 *
 * ─────────────────────────── the reserve is the payout guarantee ────────────
 *
 * `TREASURY_RESERVE` is money the agent can never allocate. It is a floor under
 * the balance, not a cap on outflow, which is what makes it survive any sequence
 * of individually-legal proposals. Set it to cover the prizes already promised —
 * an escrow that cannot pay a winner because the treasury agent moved the float
 * has failed at the only job the treasury has.
 *
 * ─────────────────────────── the delay is the veto window ───────────────────
 *
 * `TREASURY_DELAY` is how long somebody has to notice a bad proposal and stop
 * it. Zero means the agent's first mistake is also its last unblockable one, so
 * it has to be opted into explicitly.
 *
 * After deployment, allowlist the destinations with `setTarget` — the list starts
 * empty, so a freshly deployed treasury can send money precisely nowhere. That is
 * the intended state until somebody chooses otherwise.
 */
contract DeployTreasury is Script {
    function run() external returns (Treasury treasury) {
        address token = vm.envAddress("TREASURY_TOKEN");
        address owner = vm.envAddress("TREASURY_OWNER");
        address proposer = vm.envAddress("TREASURY_PROPOSER");
        address guardian = vm.envAddress("TREASURY_GUARDIAN");

        uint256 reserveFloor = vm.envUint("TREASURY_RESERVE");
        uint256 perProposalCap = vm.envUint("TREASURY_PER_PROPOSAL");
        uint256 perDayCap = vm.envUint("TREASURY_PER_DAY");
        uint64 delay = uint64(vm.envUint("TREASURY_DELAY"));

        // The contract enforces this too. Checking here means the deployer is
        // told before spending gas rather than after.
        require(proposer != owner, "TREASURY_PROPOSER must differ from TREASURY_OWNER");
        require(guardian != proposer, "TREASURY_GUARDIAN must differ from TREASURY_PROPOSER");

        // A guardian that cannot act without the multisig is not incident
        // response, and an owner that is a single key is not a treasury.
        if (!vm.envOr("ALLOW_EOA_OWNER", false)) {
            require(owner.code.length > 0, "TREASURY_OWNER must be a contract (multisig)");
        }

        if (delay == 0) {
            require(
                vm.envOr("ALLOW_ZERO_DELAY", false),
                "TREASURY_DELAY=0 leaves no window to veto a bad proposal"
            );
        }

        // Per-day below per-proposal makes the larger cap unreachable, which is
        // not dangerous but is certainly not what anybody meant to configure.
        require(perDayCap >= perProposalCap, "TREASURY_PER_DAY must be at least TREASURY_PER_PROPOSAL");

        vm.startBroadcast();
        treasury =
            new Treasury(token, owner, proposer, guardian, reserveFloor, perProposalCap, perDayCap, delay);
        vm.stopBroadcast();

        console.log("Treasury            :", address(treasury));
        console.log("token               :", token);
        console.log("owner               :", owner);
        console.log("proposer (agent)    :", proposer);
        console.log("guardian            :", guardian);
        console.log("reserveFloor  (raw) :", reserveFloor);
        console.log("perProposalCap(raw) :", perProposalCap);
        console.log("perDayCap     (raw) :", perDayCap);
        console.log("delay        (secs) :", delay);
        console.log("");
        console.log("Amounts are in the TOKEN's units. Check the decimals before funding.");
        console.log("No destination is allowlisted yet: call setTarget() before the agent proposes.");
    }
}
