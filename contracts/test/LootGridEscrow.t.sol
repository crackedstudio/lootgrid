// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LootGridEscrow} from "../src/LootGridEscrow.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * Escrow tests.
 *
 * This contract holds real money and believes exactly one thing: a signature. So
 * the tests below are less about features than about the size of the hole when
 * that signature is forged, replayed, or stolen. Everything in the plan's
 * pre-mainnet matrix is here, plus the cases that matter for a key that is
 * assumed to leak eventually.
 */
contract LootGridEscrowTest is Test {
    LootGridEscrow escrow;
    MockERC20 token;

    address owner = address(0xB055);
    address treasury = address(0x7EA5);
    address guardian = address(0x6A12);
    address attacker = address(0xBAD);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint256 attestorKey = 0xA77E;
    uint256 wrongKey = 0xBADC0DE;
    address attestor;

    uint256 constant PER_HUNT = 5e18;
    uint256 constant PER_DAY = 20e18;
    uint64 constant WINDOW = 1 hours;
    uint64 constant TTL = 24 hours;

    bytes32 constant HUNT = keccak256("hunt-1");

    function setUp() public {
        attestor = vm.addr(attestorKey);
        token = new MockERC20();
        escrow = new LootGridEscrow(
            address(token), owner, treasury, attestor, guardian, PER_HUNT, PER_DAY, WINDOW
        );

        token.mint(treasury, 1_000e18);
        vm.prank(treasury);
        token.approve(address(escrow), type(uint256).max);

        vm.warp(1_700_000_000);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function fund(bytes32 huntId, uint256 amount) internal returns (uint64 expiry) {
        expiry = uint64(block.timestamp) + TTL;
        vm.prank(treasury);
        escrow.fundHunt(huntId, amount, expiry);
    }

    /**
     * NOTE: this calls the contract for the digest, so it consumes a pending
     * `vm.expectRevert`. Always bind the signature to a local BEFORE setting the
     * expectation, or the expectation lands on `resolutionDigest` and the test
     * passes for the wrong reason.
     */
    function sign(uint256 key, address winner, bytes32 huntId, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, escrow.resolutionDigest(winner, huntId, 2105, 4, deadline));
        return abi.encodePacked(r, s, v);
    }

    function claimAs(address winner, bytes32 huntId, uint256 key) internal {
        uint256 deadline = block.timestamp + 300;
        escrow.claim(winner, huntId, 2105, 4, deadline, sign(key, winner, huntId, deadline));
    }

    // ── the happy path ───────────────────────────────────────────────────────

    function test_fundClaimWithdraw() public {
        fund(HUNT, 1e18);
        assertEq(token.balanceOf(address(escrow)), 1e18);

        claimAs(alice, HUNT, attestorKey);
        assertEq(escrow.owed(alice), 1e18);
        // Credited, not paid: the window is the guardian's chance to stop it.
        assertEq(token.balanceOf(alice), 0);

        vm.warp(block.timestamp + WINDOW);
        escrow.withdraw(alice);
        assertEq(token.balanceOf(alice), 1e18);
        assertEq(escrow.owed(alice), 0);
        assertEq(escrow.totalOwed(), 0);
    }

    /// Anyone may submit — the money still goes where the referee said.
    function test_claimAndWithdrawArePermissionless() public {
        fund(HUNT, 1e18);
        vm.prank(attacker);
        claimAs(alice, HUNT, attestorKey);

        vm.warp(block.timestamp + WINDOW);
        vm.prank(attacker);
        escrow.withdraw(alice);

        assertEq(token.balanceOf(alice), 1e18, "payout must follow the attestation, not the sender");
        assertEq(token.balanceOf(attacker), 0);
    }

    // ── the signature is the whole security model ────────────────────────────

    function test_claim_rejectsForgedSignature() public {
        fund(HUNT, 1e18);
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = sign(wrongKey, attacker, HUNT, deadline);
        vm.expectRevert(LootGridEscrow.BadAttestation.selector);
        escrow.claim(attacker, HUNT, 2105, 4, deadline, sig);
    }

    function test_claim_rejectsSwappedWinner() public {
        fund(HUNT, 1e18);
        uint256 deadline = block.timestamp + 300;
        bytes memory forAlice = sign(attestorKey, alice, HUNT, deadline);

        vm.expectRevert(LootGridEscrow.BadAttestation.selector);
        escrow.claim(attacker, HUNT, 2105, 4, deadline, forAlice);
    }

    function test_claim_rejectsReplay() public {
        fund(HUNT, 1e18);
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = sign(attestorKey, alice, HUNT, deadline);
        escrow.claim(alice, HUNT, 2105, 4, deadline, sig);

        // Second use fails on the pot being settled before the digest is even
        // consulted; either way no second payout exists.
        vm.expectRevert(LootGridEscrow.AlreadySettled.selector);
        escrow.claim(alice, HUNT, 2105, 4, deadline, sig);
        assertEq(escrow.owed(alice), 1e18, "a replay must not credit twice");
    }

    /// The same attestation must not pay out of a different hunt's pot.
    function test_claim_attestationIsBoundToItsHunt() public {
        fund(HUNT, 1e18);
        bytes32 other = keccak256("hunt-2");
        fund(other, 1e18);

        uint256 deadline = block.timestamp + 300;
        bytes memory forHunt1 = sign(attestorKey, alice, HUNT, deadline);

        vm.expectRevert(LootGridEscrow.BadAttestation.selector);
        escrow.claim(alice, other, 2105, 4, deadline, forHunt1);
    }

    function test_claim_rejectsExpiredAttestation() public {
        fund(HUNT, 1e18);
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = sign(attestorKey, alice, HUNT, deadline);

        vm.warp(deadline + 1);
        vm.expectRevert(LootGridEscrow.AttestationExpired.selector);
        escrow.claim(alice, HUNT, 2105, 4, deadline, sig);
    }

    /// Domain separation: a signature minted for another deployment is worthless.
    function test_claim_isBoundToThisDeployment() public {
        fund(HUNT, 1e18);
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = sign(attestorKey, alice, HUNT, deadline);

        LootGridEscrow other = new LootGridEscrow(
            address(token), owner, treasury, attestor, guardian, PER_HUNT, PER_DAY, WINDOW
        );
        vm.prank(treasury);
        token.approve(address(other), type(uint256).max);
        vm.prank(treasury);
        other.fundHunt(HUNT, 1e18, uint64(block.timestamp) + TTL);

        vm.expectRevert(LootGridEscrow.BadAttestation.selector);
        other.claim(alice, HUNT, 2105, 4, deadline, sig);
    }

    function test_claim_rejectsUnfundedHunt() public {
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = sign(attestorKey, alice, HUNT, deadline);
        vm.expectRevert(LootGridEscrow.NotFunded.selector);
        escrow.claim(alice, HUNT, 2105, 4, deadline, sig);
    }

    // ── caps bound a stolen key ──────────────────────────────────────────────

    function test_fund_rejectsAbovePerHuntCap() public {
        vm.prank(treasury);
        vm.expectRevert(LootGridEscrow.ExceedsHuntCap.selector);
        escrow.fundHunt(HUNT, PER_HUNT + 1, uint64(block.timestamp) + TTL);
    }

    /// A cap lowered after funding still binds the payout.
    function test_claim_rejectsPotAboveCurrentHuntCap() public {
        fund(HUNT, 5e18);
        vm.prank(owner);
        escrow.setCaps(1e18, PER_DAY);

        uint256 deadline = block.timestamp + 300;
        bytes memory sig = sign(attestorKey, alice, HUNT, deadline);
        vm.expectRevert(LootGridEscrow.ExceedsHuntCap.selector);
        escrow.claim(alice, HUNT, 2105, 4, deadline, sig);
    }

    function test_claim_enforcesDailyCap() public {
        // Four 5e18 pots against a 20e18 day: the fifth must not settle.
        for (uint256 i = 0; i < 5; i++) {
            fund(keccak256(abi.encode("h", i)), 5e18);
        }
        for (uint256 i = 0; i < 4; i++) {
            claimAs(alice, keccak256(abi.encode("h", i)), attestorKey);
        }
        assertEq(escrow.spentThisDay(), 20e18);

        bytes32 fifth = keccak256(abi.encode("h", uint256(4)));
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = sign(attestorKey, bob, fifth, deadline);
        vm.expectRevert(LootGridEscrow.ExceedsDayCap.selector);
        escrow.claim(bob, fifth, 2105, 4, deadline, sig);
    }

    function test_dailyCapRollsOver() public {
        for (uint256 i = 0; i < 5; i++) {
            fund(keccak256(abi.encode("h", i)), 5e18);
        }
        for (uint256 i = 0; i < 4; i++) {
            claimAs(alice, keccak256(abi.encode("h", i)), attestorKey);
        }

        vm.warp(block.timestamp + 1 days);
        claimAs(bob, keccak256(abi.encode("h", uint256(4))), attestorKey);
        assertEq(escrow.owed(bob), 5e18);
    }

    // ── the challenge window ─────────────────────────────────────────────────

    function test_withdraw_rejectedDuringChallengeWindow() public {
        fund(HUNT, 1e18);
        claimAs(alice, HUNT, attestorKey);

        vm.warp(block.timestamp + WINDOW - 1);
        vm.expectRevert(LootGridEscrow.NotYetWithdrawable.selector);
        escrow.withdraw(alice);
    }

    function test_withdraw_rejectsNothingOwed() public {
        vm.expectRevert(LootGridEscrow.NothingOwed.selector);
        escrow.withdraw(alice);
    }

    /// A guardian who notices a fraudulent claim inside the window can stop it.
    function test_guardianCanFreezeAPayoutMidWindow() public {
        fund(HUNT, 1e18);
        claimAs(alice, HUNT, attestorKey);

        vm.prank(guardian);
        escrow.setPaused(true);

        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(LootGridEscrow.Paused.selector);
        escrow.withdraw(alice);
    }

    // ── refunds are the escape hatch ─────────────────────────────────────────

    function test_refund_afterExpiry() public {
        uint64 expiry = fund(HUNT, 1e18);
        uint256 before = token.balanceOf(treasury);

        vm.warp(expiry + 1);
        escrow.refund(HUNT);
        assertEq(token.balanceOf(treasury), before + 1e18);
    }

    function test_refund_rejectedBeforeExpiry() public {
        uint64 expiry = fund(HUNT, 1e18);
        vm.warp(expiry);
        vm.expectRevert(LootGridEscrow.NotExpired.selector);
        escrow.refund(HUNT);
    }

    /**
     * The property that keeps this an escrow rather than a trap: a guardian who
     * pauses and disappears cannot strand the money.
     */
    function test_refund_worksWhilePaused() public {
        uint64 expiry = fund(HUNT, 1e18);
        vm.prank(guardian);
        escrow.setPaused(true);

        vm.warp(expiry + 1);
        escrow.refund(HUNT);
        assertEq(token.balanceOf(treasury), 1_000e18);
    }

    /// Anyone may trigger it, because the money can only go to the treasury.
    function test_refund_isPermissionless() public {
        uint64 expiry = fund(HUNT, 1e18);
        vm.warp(expiry + 1);
        vm.prank(attacker);
        escrow.refund(HUNT);
        assertEq(token.balanceOf(attacker), 0);
        assertEq(token.balanceOf(treasury), 1_000e18);
    }

    function test_refund_rejectsDoubleSpend() public {
        uint64 expiry = fund(HUNT, 1e18);
        vm.warp(expiry + 1);
        escrow.refund(HUNT);
        vm.expectRevert(LootGridEscrow.AlreadySettled.selector);
        escrow.refund(HUNT);
    }

    /// A claim and a refund must never both succeed on one pot.
    function test_cannotRefundAClaimedPot() public {
        fund(HUNT, 1e18);
        claimAs(alice, HUNT, attestorKey);
        vm.warp(block.timestamp + TTL + 1);

        vm.expectRevert(LootGridEscrow.AlreadySettled.selector);
        escrow.refund(HUNT);
    }

    function test_cannotClaimAnExpiredPot() public {
        uint64 expiry = fund(HUNT, 1e18);
        vm.warp(expiry + 1);

        uint256 deadline = block.timestamp + 300;
        bytes memory sig = sign(attestorKey, alice, HUNT, deadline);
        vm.expectRevert(LootGridEscrow.NotExpired.selector);
        escrow.claim(alice, HUNT, 2105, 4, deadline, sig);
    }

    // ── funding ──────────────────────────────────────────────────────────────

    function test_fund_onlyTreasury() public {
        vm.prank(attacker);
        vm.expectRevert(LootGridEscrow.NotTreasury.selector);
        escrow.fundHunt(HUNT, 1e18, uint64(block.timestamp) + TTL);
    }

    function test_fund_rejectsDoubleFunding() public {
        fund(HUNT, 1e18);
        vm.prank(treasury);
        vm.expectRevert(LootGridEscrow.AlreadyFunded.selector);
        escrow.fundHunt(HUNT, 1e18, uint64(block.timestamp) + TTL);
    }

    function test_fund_rejectsPastExpiry() public {
        vm.prank(treasury);
        vm.expectRevert(LootGridEscrow.ExpiryInPast.selector);
        escrow.fundHunt(HUNT, 1e18, uint64(block.timestamp));
    }

    /// SafeERC20 must catch a token that reports failure by returning false.
    function test_fund_revertsOnSilentlyFailingToken() public {
        token.setReturnsFalse(true);
        vm.prank(treasury);
        vm.expectRevert();
        escrow.fundHunt(HUNT, 1e18, uint64(block.timestamp) + TTL);
    }

    // ── solvency ─────────────────────────────────────────────────────────────

    /// Credited obligations must never exceed what the contract actually holds.
    function test_neverOwesMoreThanItHolds() public {
        for (uint256 i = 0; i < 4; i++) {
            fund(keccak256(abi.encode("h", i)), 5e18);
            claimAs(alice, keccak256(abi.encode("h", i)), attestorKey);
        }
        assertLe(escrow.totalOwed(), token.balanceOf(address(escrow)));

        vm.warp(block.timestamp + WINDOW);
        escrow.withdraw(alice);
        assertEq(escrow.totalOwed(), 0);
        assertLe(escrow.totalOwed(), token.balanceOf(address(escrow)));
    }

    // ── admin ────────────────────────────────────────────────────────────────

    function test_setAttestor_rotates() public {
        fund(HUNT, 1e18);
        address next = vm.addr(wrongKey);
        vm.prank(owner);
        escrow.setAttestor(next);

        uint256 deadline = block.timestamp + 300;
        bytes memory retired = sign(attestorKey, alice, HUNT, deadline);
        bytes memory fresh = sign(wrongKey, alice, HUNT, deadline);

        vm.expectRevert(LootGridEscrow.BadAttestation.selector);
        escrow.claim(alice, HUNT, 2105, 4, deadline, retired);

        escrow.claim(alice, HUNT, 2105, 4, deadline, fresh);
        assertEq(escrow.owed(alice), 1e18);
    }

    function test_adminIsOwnerOnly() public {
        vm.startPrank(attacker);
        vm.expectRevert(LootGridEscrow.NotOwner.selector);
        escrow.setCaps(1, 1);
        vm.expectRevert(LootGridEscrow.NotOwner.selector);
        escrow.setAttestor(attacker);
        vm.expectRevert(LootGridEscrow.NotOwner.selector);
        escrow.setTreasury(attacker);
        vm.expectRevert(LootGridEscrow.NotOwner.selector);
        escrow.setGuardian(attacker);
        vm.expectRevert(LootGridEscrow.NotGuardian.selector);
        escrow.setPaused(true);
        vm.stopPrank();
    }

    function test_ownershipTransferIsTwoStep() public {
        vm.prank(owner);
        escrow.transferOwnership(bob);
        assertEq(escrow.owner(), owner);

        vm.prank(bob);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), bob);
    }

    function test_ownerCanAlsoPause() public {
        // Incident response must not hinge on one key being reachable.
        vm.prank(owner);
        escrow.setPaused(true);
        assertTrue(escrow.paused());
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(LootGridEscrow.ZeroAddress.selector);
        new LootGridEscrow(address(0), owner, treasury, attestor, guardian, PER_HUNT, PER_DAY, WINDOW);
        vm.expectRevert(LootGridEscrow.ZeroAddress.selector);
        new LootGridEscrow(address(token), owner, treasury, address(0), guardian, PER_HUNT, PER_DAY, WINDOW);
    }

    function test_constructor_rejectsZeroCaps() public {
        vm.expectRevert(LootGridEscrow.ZeroAmount.selector);
        new LootGridEscrow(address(token), owner, treasury, attestor, guardian, 0, PER_DAY, WINDOW);
    }

    // ── fuzz ─────────────────────────────────────────────────────────────────

    function testFuzz_onlyTheAttestorKeyCanRelease(uint256 key, address submitter) public {
        key = bound(key, 1, type(uint128).max);
        vm.assume(vm.addr(key) != attestor);
        vm.assume(submitter != address(0));

        fund(HUNT, 1e18);
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = sign(key, alice, HUNT, deadline);

        vm.prank(submitter);
        vm.expectRevert(LootGridEscrow.BadAttestation.selector);
        escrow.claim(alice, HUNT, 2105, 4, deadline, sig);
        assertEq(escrow.owed(alice), 0);
    }

    function testFuzz_potIsPaidExactlyOnceOrRefunded(uint96 amount, bool claimIt) public {
        amount = uint96(bound(amount, 1, PER_HUNT));
        uint64 expiry = fund(HUNT, amount);
        uint256 treasuryBefore = token.balanceOf(treasury);

        if (claimIt) {
            claimAs(alice, HUNT, attestorKey);
            vm.warp(block.timestamp + WINDOW);
            escrow.withdraw(alice);
            assertEq(token.balanceOf(alice), amount);
            vm.warp(expiry + 1);
            vm.expectRevert(LootGridEscrow.AlreadySettled.selector);
            escrow.refund(HUNT);
        } else {
            vm.warp(expiry + 1);
            escrow.refund(HUNT);
            assertEq(token.balanceOf(treasury), treasuryBefore + amount);
        }
        // Either way the pot is gone and the contract keeps nothing back.
        assertEq(token.balanceOf(address(escrow)), 0);
    }
}
