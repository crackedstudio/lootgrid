// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Treasury} from "../src/Treasury.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * Treasury.
 *
 * A compromised player agent spends one player's allowance. A compromised
 * treasury agent would be trying to spend everybody's prizes, so these tests
 * assume it is hostile and ask the same question phase 7 asked: what does it
 * cost when it is?
 *
 * The answer has to be bounded three ways at once — per proposal, per day, and
 * never below the reserve — and the reserve is the one that carries the payout
 * guarantee. A cap on outflow can be walked around with a sequence of legal
 * proposals; a floor under the balance cannot.
 */
contract TreasuryTest is Test {
    Treasury treasury;
    MockERC20 token;

    address owner = address(0xB055);
    address agent = address(0xA6E17);
    address guardian = address(0x6A12);
    address escrow = address(0xE5C0); // an allowlisted destination
    address attacker = address(0xBAD);

    uint256 constant FLOAT = 1_000e18;
    uint256 constant RESERVE = 400e18;
    uint256 constant PER_PROPOSAL = 100e18;
    uint256 constant PER_DAY = 250e18;
    uint64 constant DELAY = 1 hours;

    bytes32 constant P1 = keccak256("proposal-1");

    function setUp() public {
        token = new MockERC20();
        treasury = new Treasury(address(token), owner, agent, guardian, RESERVE, PER_PROPOSAL, PER_DAY, DELAY);

        token.mint(address(this), FLOAT);
        token.approve(address(treasury), type(uint256).max);
        treasury.deposit(FLOAT);

        vm.prank(owner);
        treasury.setTarget(escrow, true);

        vm.warp(1_700_000_000);
    }

    function propose(bytes32 id, uint256 amount) internal {
        vm.prank(agent);
        treasury.propose(id, escrow, amount);
    }

    function passDelay() internal {
        vm.warp(block.timestamp + DELAY);
    }

    // ── the happy path ───────────────────────────────────────────────────────

    function test_proposeWaitExecute() public {
        propose(P1, 50e18);
        passDelay();
        treasury.execute(P1);

        assertEq(token.balanceOf(escrow), 50e18);
        assertEq(token.balanceOf(address(treasury)), FLOAT - 50e18);
    }

    /// Execution is open: the money can only go where the owner allowlisted.
    function test_executeIsPermissionless() public {
        propose(P1, 10e18);
        passDelay();

        vm.prank(attacker);
        treasury.execute(P1);

        assertEq(token.balanceOf(escrow), 10e18);
        assertEq(token.balanceOf(attacker), 0);
    }

    // ── the reserve is the payout guarantee ──────────────────────────────────

    /**
     * THE test for this phase. A floor under the balance, not a cap on outflow —
     * so it survives any sequence of individually-legal proposals.
     */
    function test_agentCannotDrainBelowTheReserveHoweverManyProposals() public {
        // Each is inside the per-proposal cap; together they would empty it.
        for (uint256 i = 0; i < 20; i++) {
            vm.prank(agent);
            try treasury.propose(keccak256(abi.encode(i)), escrow, PER_PROPOSAL) {} catch {}
        }
        passDelay();
        for (uint256 i = 0; i < 20; i++) {
            try treasury.execute(keccak256(abi.encode(i))) {} catch {}
        }

        // An escrow that cannot pay a winner because the agent moved the float
        // has failed at the only job the treasury has.
        assertGe(token.balanceOf(address(treasury)), RESERVE);
    }

    function test_propose_rejectsWhatWouldBreachTheReserve() public {
        // Free float is 600; the reserve is 400. Asking for more than 600 fails
        // even though it is under the per-proposal cap... so lower the reserve
        // gap first by allocating, then try again.
        propose(P1, PER_PROPOSAL);
        passDelay();
        treasury.execute(P1);

        vm.prank(owner);
        treasury.setLimits(FLOAT - 50e18, PER_PROPOSAL, PER_DAY, DELAY);

        vm.prank(agent);
        vm.expectRevert(Treasury.BreachesReserve.selector);
        treasury.propose(keccak256("next"), escrow, 100e18);
    }

    function test_reserveIsRecheckedAtExecution() public {
        propose(P1, 100e18);

        // Legal when proposed. The owner then raises the floor during the delay,
        // which is exactly the kind of thing a delay exists to allow.
        vm.prank(owner);
        treasury.setLimits(FLOAT, PER_PROPOSAL, PER_DAY, DELAY);

        passDelay();
        vm.expectRevert(Treasury.BreachesReserve.selector);
        treasury.execute(P1);
    }

    // ── caps ─────────────────────────────────────────────────────────────────

    function test_propose_rejectsAboveTheProposalCap() public {
        vm.prank(agent);
        vm.expectRevert(Treasury.ExceedsProposalCap.selector);
        treasury.propose(P1, escrow, PER_PROPOSAL + 1);
    }

    function test_dailyCapIsChargedAtExecution() public {
        // Proposing costs nothing; executing is what spends. Charging at
        // proposal time would let a vetoed proposal consume the day's budget.
        for (uint256 i = 0; i < 3; i++) {
            propose(keccak256(abi.encode(i)), PER_PROPOSAL);
        }
        passDelay();

        treasury.execute(keccak256(abi.encode(uint256(0))));
        treasury.execute(keccak256(abi.encode(uint256(1))));

        vm.expectRevert(Treasury.ExceedsDayCap.selector);
        treasury.execute(keccak256(abi.encode(uint256(2))));
    }

    function test_dailyCapRollsOver() public {
        for (uint256 i = 0; i < 2; i++) {
            propose(keccak256(abi.encode(i)), PER_PROPOSAL);
        }
        passDelay();
        treasury.execute(keccak256(abi.encode(uint256(0))));
        treasury.execute(keccak256(abi.encode(uint256(1))));

        vm.warp(block.timestamp + 1 days);
        propose(keccak256("tomorrow"), 50e18);
        vm.warp(block.timestamp + DELAY);
        treasury.execute(keccak256("tomorrow"));

        assertEq(token.balanceOf(escrow), 2 * PER_PROPOSAL + 50e18);
    }

    function test_propose_rejectsAnAddressTheOwnerNeverApproved() public {
        // Paying the wrong address is the mistake no cap undoes.
        vm.prank(agent);
        vm.expectRevert(Treasury.TargetNotAllowed.selector);
        treasury.propose(P1, attacker, 1e18);
    }

    function test_targetRevokedDuringTheDelayStopsExecution() public {
        propose(P1, 10e18);
        vm.prank(owner);
        treasury.setTarget(escrow, false);

        passDelay();
        vm.expectRevert(Treasury.TargetNotAllowed.selector);
        treasury.execute(P1);
    }

    // ── the delay is a veto window ───────────────────────────────────────────

    function test_executeBeforeTheDelayFails() public {
        propose(P1, 10e18);
        vm.expectRevert(Treasury.NotReady.selector);
        treasury.execute(P1);
    }

    function test_ownerCanVeto() public {
        propose(P1, 10e18);
        vm.prank(owner);
        treasury.veto(P1);

        passDelay();
        vm.expectRevert(Treasury.NotPending.selector);
        treasury.execute(P1);
        assertEq(token.balanceOf(escrow), 0);
    }

    function test_guardianCanVeto() public {
        // Incident response must not depend on the multisig being reachable.
        propose(P1, 10e18);
        vm.prank(guardian);
        treasury.veto(P1);

        passDelay();
        vm.expectRevert(Treasury.NotPending.selector);
        treasury.execute(P1);
    }

    function test_strangersCannotVeto() public {
        propose(P1, 10e18);
        vm.prank(attacker);
        vm.expectRevert(Treasury.NotGuardian.selector);
        treasury.veto(P1);
    }

    function test_cannotExecuteTwice() public {
        propose(P1, 10e18);
        passDelay();
        treasury.execute(P1);

        vm.expectRevert(Treasury.NotPending.selector);
        treasury.execute(P1);
    }

    function test_cannotReuseAProposalId() public {
        propose(P1, 10e18);
        vm.prank(agent);
        vm.expectRevert(Treasury.ProposalExists.selector);
        treasury.propose(P1, escrow, 5e18);
    }

    // ── the agent may only propose ───────────────────────────────────────────

    function test_agentCanDoNothingElse() public {
        vm.startPrank(agent);
        vm.expectRevert(Treasury.NotOwner.selector);
        treasury.withdraw(agent, 1);
        vm.expectRevert(Treasury.NotOwner.selector);
        treasury.setLimits(0, type(uint256).max, type(uint256).max, 0);
        vm.expectRevert(Treasury.NotOwner.selector);
        treasury.setTarget(attacker, true);
        vm.expectRevert(Treasury.NotOwner.selector);
        treasury.setProposer(attacker);
        vm.expectRevert(Treasury.NotGuardian.selector);
        treasury.veto(P1);
        vm.stopPrank();
    }

    function test_strangersCannotPropose() public {
        vm.prank(attacker);
        vm.expectRevert(Treasury.NotProposer.selector);
        treasury.propose(P1, escrow, 1e18);
    }

    function test_constructor_rejectsProposerEqualToOwner() public {
        // A proposer that is also the owner faces no limits at all.
        vm.expectRevert(Treasury.NotProposer.selector);
        new Treasury(address(token), owner, owner, guardian, RESERVE, PER_PROPOSAL, PER_DAY, DELAY);
    }

    function test_ownershipCannotBeAcceptedByTheProposer() public {
        address next = address(0xC0FFEE);
        vm.prank(owner);
        treasury.transferOwnership(next);
        vm.prank(owner);
        treasury.setProposer(next);

        vm.prank(next);
        vm.expectRevert(Treasury.NotProposer.selector);
        treasury.acceptOwnership();
    }

    // ── the owner outranks everything ────────────────────────────────────────

    function test_ownerWithdrawalIgnoresTheReserve() public {
        // The floor binds the AGENT. It exists to stop an allocation stranding a
        // payout, not to trap the operator's own money.
        vm.prank(owner);
        treasury.withdraw(owner, FLOAT);
        assertEq(token.balanceOf(owner), FLOAT);
    }

    function test_ownerWithdrawalWorksWhilePaused() public {
        vm.prank(guardian);
        treasury.setPaused(true);

        vm.prank(owner);
        treasury.withdraw(owner, 10e18);
        assertEq(token.balanceOf(owner), 10e18);
    }

    function test_pauseHaltsProposalsAndExecutions() public {
        propose(P1, 10e18);
        vm.prank(guardian);
        treasury.setPaused(true);

        passDelay();
        vm.expectRevert(Treasury.Paused.selector);
        treasury.execute(P1);

        vm.prank(agent);
        vm.expectRevert(Treasury.Paused.selector);
        treasury.propose(keccak256("another"), escrow, 1e18);
    }

    // ── what the runtime reads ───────────────────────────────────────────────

    function test_allocatableRespectsEveryLimit() public {
        // Free float 600, per-day 250, per-proposal 100 — the tightest wins.
        assertEq(treasury.allocatable(), PER_PROPOSAL);

        vm.prank(owner);
        treasury.setLimits(RESERVE, 500e18, 250e18, DELAY);
        assertEq(treasury.allocatable(), 250e18);

        vm.prank(owner);
        treasury.setLimits(FLOAT - 10e18, 500e18, 250e18, DELAY);
        assertEq(treasury.allocatable(), 10e18);
    }

    function test_allocatableIsZeroAtTheFloor() public {
        vm.prank(owner);
        treasury.setLimits(FLOAT, PER_PROPOSAL, PER_DAY, DELAY);
        assertEq(treasury.allocatable(), 0);
    }

    function testFuzz_reserveAlwaysSurvives(uint256[6] calldata amounts) public {
        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 amount = bound(amounts[i], 1, PER_PROPOSAL);
            vm.prank(agent);
            try treasury.propose(keccak256(abi.encode(i)), escrow, amount) {} catch {}
        }
        passDelay();
        for (uint256 i = 0; i < amounts.length; i++) {
            try treasury.execute(keccak256(abi.encode(i))) {} catch {}
        }
        assertGe(token.balanceOf(address(treasury)), RESERVE);
    }
}
