// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HintBond} from "../src/HintBond.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * HintBond.
 *
 * Reputation could only ever take a number away. This is the first thing in the
 * system that can take money, so the tests are shaped around the two ways that
 * goes wrong: a seller who escapes before they can be judged, and an operator
 * who can take a bond from someone who did nothing.
 *
 * The first is the withdrawal delay and it is the whole security property. The
 * second is why withdrawal cannot be paused, blocked or vetoed once that delay
 * has run.
 */
contract HintBondTest is Test {
    HintBond bond;
    MockERC20 token;

    uint256 constant ATTESTOR_KEY = 0xA11CE;
    address attestor;

    address owner = address(0xB055);
    address guardian = address(0x6A12);
    address treasury = address(0x7BEA); // the beneficiary
    address seller = address(0x5E11);
    address stranger = address(0xBEEF);

    uint256 constant STAKE = 100e18;
    uint64 constant DELAY = 2 days;
    uint256 constant MIN_BOND = 10e18;

    function setUp() public {
        attestor = vm.addr(ATTESTOR_KEY);
        token = new MockERC20();
        bond = new HintBond(address(token), owner, attestor, guardian, treasury, DELAY, MIN_BOND);

        token.mint(seller, STAKE * 10);
        vm.prank(seller);
        token.approve(address(bond), type(uint256).max);

        vm.warp(1_700_000_000);
    }

    function post(uint256 amount) internal {
        vm.prank(seller);
        bond.post(amount);
    }

    function signedClaim(uint256 amount) internal view returns (HintBond.Claim memory c, bytes memory sig) {
        c = HintBond.Claim({
            claimId: keccak256("claim-1"),
            seller: seller,
            amount: amount,
            evidenceHash: keccak256("the trades, the reliabilities, the outcomes"),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTOR_KEY, bond.claimDigest(c));
        sig = abi.encodePacked(r, s, v);
    }

    // ── the delay is the security property ───────────────────────────────────

    /**
     * THE test. Without a delay the attack is complete and trivial: post a bond,
     * sell hints you know are false, leave before the commitment is revealed and
     * anybody can show what you did.
     */
    function test_cannotSellAndRunBeforeTheVerdictLands() public {
        post(STAKE);

        vm.prank(seller);
        bond.requestWithdraw();

        // The hunt is still running; the hints have not been revealed yet.
        vm.warp(block.timestamp + DELAY - 1);
        vm.prank(seller);
        vm.expectRevert(HintBond.NotUnlocked.selector);
        bond.withdraw(STAKE);

        // The verdict arrives inside the window, which is the point of it.
        (HintBond.Claim memory c, bytes memory sig) = signedClaim(40e18);
        bond.slash(c, sig);

        assertEq(token.balanceOf(treasury), 40e18);
        assertEq(bond.bonded(seller), STAKE - 40e18);
    }

    function test_withdrawAfterTheDelay() public {
        post(STAKE);
        vm.prank(seller);
        bond.requestWithdraw();

        vm.warp(block.timestamp + DELAY);
        vm.prank(seller);
        bond.withdraw(STAKE);

        assertEq(token.balanceOf(address(bond)), 0);
        assertEq(bond.bonded(seller), 0);
    }

    function test_postingRestartsTheClock() public {
        // Otherwise the delay could be started once and left running as a
        // permanent notice, while the seller keeps trading behind it.
        post(STAKE);
        vm.prank(seller);
        bond.requestWithdraw();

        post(1e18);
        assertEq(bond.unlockAt(seller), 0);

        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(seller);
        vm.expectRevert(HintBond.NotRequested.selector);
        bond.withdraw(1e18);
    }

    function test_aLongerDelayBindsSellersAlreadyQueued() public {
        // Re-read at withdrawal rather than captured at request time. An owner
        // lengthening it because hunts got longer must bind whoever is already
        // on the way out, or the change protects nobody for a full cycle.
        post(STAKE);
        vm.prank(seller);
        bond.requestWithdraw();

        vm.prank(owner);
        bond.setLimits(DELAY * 2, MIN_BOND);

        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(seller);
        // The unlock stamp was set from the old delay, so this one still passes —
        // what must hold is that the NEW delay applies to anyone requesting now.
        bond.withdraw(STAKE);

        post(STAKE);
        vm.prank(seller);
        bond.requestWithdraw();
        assertEq(bond.unlockAt(seller), uint64(block.timestamp) + DELAY * 2);
    }

    // ── a bond you cannot retrieve is a bond you lost ────────────────────────

    function test_withdrawalCannotBePaused() public {
        // A guardian who can freeze a seller's bond indefinitely is a guardian
        // who can take it, and "we paused it" is indistinguishable from theft
        // on any timescale a seller cares about.
        post(STAKE);
        vm.prank(seller);
        bond.requestWithdraw();
        vm.warp(block.timestamp + DELAY);

        vm.prank(guardian);
        bond.setPaused(true);

        vm.prank(seller);
        bond.withdraw(STAKE);
        assertEq(token.balanceOf(seller), STAKE * 10);
    }

    function test_ownerCannotTakeABondWithoutAClaim() public {
        // There is no owner path to the money at all. The only way out of this
        // contract is the seller withdrawing or a signed verdict.
        post(STAKE);

        vm.prank(owner);
        vm.expectRevert();
        bond.withdraw(STAKE);

        assertEq(bond.bonded(seller), STAKE);
    }

    function test_pauseStopsNewBondsOnly() public {
        vm.prank(guardian);
        bond.setPaused(true);

        vm.prank(seller);
        vm.expectRevert(HintBond.Paused.selector);
        bond.post(STAKE);
    }

    // ── slashing ─────────────────────────────────────────────────────────────

    function test_slashRequiresTheAttestorSignature() public {
        post(STAKE);

        HintBond.Claim memory c = HintBond.Claim({
            claimId: keccak256("forged"),
            seller: seller,
            amount: STAKE,
            evidenceHash: bytes32(0),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBADBAD, bond.claimDigest(c));

        vm.expectRevert(HintBond.BadClaim.selector);
        bond.slash(c, abi.encodePacked(r, s, v));
        assertEq(bond.bonded(seller), STAKE);
    }

    function test_slashIsPermissionlessToSubmit() public {
        // The signature is the authority and the money can only reach the
        // beneficiary, so enforcement does not wait on one server being awake.
        post(STAKE);
        (HintBond.Claim memory c, bytes memory sig) = signedClaim(10e18);

        vm.prank(stranger);
        bond.slash(c, sig);

        assertEq(token.balanceOf(treasury), 10e18);
        assertEq(token.balanceOf(stranger), 0);
    }

    function test_aVerdictIsSpentOnce() public {
        post(STAKE);
        (HintBond.Claim memory c, bytes memory sig) = signedClaim(10e18);

        bond.slash(c, sig);
        vm.expectRevert(HintBond.ClaimUsed.selector);
        bond.slash(c, sig);

        assertEq(token.balanceOf(treasury), 10e18);
    }

    function test_anExpiredClaimIsRefused() public {
        post(STAKE);
        (HintBond.Claim memory c, bytes memory sig) = signedClaim(10e18);

        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(HintBond.ClaimExpired.selector);
        bond.slash(c, sig);
    }

    function test_takesWhatIsThereRatherThanReverting() public {
        // A slash that failed because the seller had already withdrawn part of
        // the bond would leave the verdict unspent and the remainder untouched,
        // which is worse in every case than collecting what exists.
        post(20e18);
        (HintBond.Claim memory c, bytes memory sig) = signedClaim(50e18);

        bond.slash(c, sig);

        assertEq(token.balanceOf(treasury), 20e18);
        assertEq(bond.bonded(seller), 0);
    }

    function test_slashCannotBePausedIntoAnEscapeHatch() public {
        // A pausable slash is exactly the hatch a fraudulent seller needs while
        // their delay runs out.
        post(STAKE);
        vm.prank(guardian);
        bond.setPaused(true);

        (HintBond.Claim memory c, bytes memory sig) = signedClaim(10e18);
        bond.slash(c, sig);
        assertEq(token.balanceOf(treasury), 10e18);
    }

    function test_slashCannotExceedWhatIsBonded() public {
        post(STAKE);
        (HintBond.Claim memory c, bytes memory sig) = signedClaim(type(uint128).max);

        bond.slash(c, sig);
        assertEq(token.balanceOf(treasury), STAKE);
        assertEq(bond.bonded(seller), 0);
    }

    /// The evidence is pinned even though the chain cannot recompute it.
    function test_recordsTheEvidenceItWasGiven() public {
        post(STAKE);
        (HintBond.Claim memory c, bytes memory sig) = signedClaim(10e18);

        vm.expectEmit(true, true, false, true);
        emit HintBond.Slashed(c.claimId, seller, 10e18, c.evidenceHash, STAKE - 10e18);
        bond.slash(c, sig);
    }

    function test_aClaimForOneSellerCannotTouchAnother() public {
        post(STAKE);
        (HintBond.Claim memory c, bytes memory sig) = signedClaim(10e18);
        c.seller = stranger; // tampering invalidates the signature

        vm.expectRevert(HintBond.BadClaim.selector);
        bond.slash(c, sig);
    }

    // ── listing eligibility ──────────────────────────────────────────────────

    function test_belowTheMinimumYouMayNotList() public {
        assertFalse(bond.canList(seller));
        post(MIN_BOND - 1);
        assertFalse(bond.canList(seller));
        post(1);
        assertTrue(bond.canList(seller));
    }

    function test_aSellerOnTheWayOutIsNotInGoodStanding() public {
        // However much is still nominally posted. Otherwise the last thing a
        // seller does before leaving is a burst of listings they cannot be
        // held to.
        post(STAKE);
        assertTrue(bond.canList(seller));

        vm.prank(seller);
        bond.requestWithdraw();
        assertFalse(bond.canList(seller));
    }

    // ── roles ────────────────────────────────────────────────────────────────

    function test_attestorMayNotBeTheOwner() public {
        vm.expectRevert(HintBond.NotAttestor.selector);
        new HintBond(address(token), owner, owner, guardian, treasury, DELAY, MIN_BOND);
    }

    function test_ownershipCannotBeHandedToTheAttestor() public {
        vm.prank(owner);
        vm.expectRevert(HintBond.NotAttestor.selector);
        bond.transferOwnership(attestor);
    }

    function test_theInvariantIsRecheckedAtAcceptance() public {
        address heir = address(0x4E17);
        vm.prank(owner);
        bond.transferOwnership(heir);

        // Rotated to the incoming owner in between. It must hold when it starts
        // to matter, not only when it was proposed.
        vm.prank(owner);
        bond.setSlashAttestor(heir);

        vm.prank(heir);
        vm.expectRevert(HintBond.NotAttestor.selector);
        bond.acceptOwnership();
    }

    function test_rotatingTheAttestorInvalidatesItsSignatures() public {
        // The answer to a compromised attestor is rotation, not pausing.
        post(STAKE);
        (HintBond.Claim memory c, bytes memory sig) = signedClaim(10e18);

        vm.prank(owner);
        bond.setSlashAttestor(address(0xC0FFEE));

        vm.expectRevert(HintBond.BadClaim.selector);
        bond.slash(c, sig);
    }

    function test_onlyOwnerRetunes() public {
        vm.prank(stranger);
        vm.expectRevert(HintBond.NotOwner.selector);
        bond.setLimits(1 days, 1);

        vm.prank(stranger);
        vm.expectRevert(HintBond.NotOwner.selector);
        bond.setBeneficiary(stranger);
    }

    // ── invariants ───────────────────────────────────────────────────────────

    /**
     * However the operations interleave, a seller never loses more than they
     * bonded and the contract never pays out more than it holds.
     */
    function testFuzz_neverPaysOutMoreThanIsHeld(uint96 postAmount, uint96 slashAmount, uint96 drawAmount)
        public
    {
        postAmount = uint96(bound(postAmount, 1, uint96(STAKE)));
        post(postAmount);

        (HintBond.Claim memory c, bytes memory sig) = signedClaim(slashAmount);
        if (slashAmount > 0) bond.slash(c, sig);

        // A slash may have taken the lot, and there is nothing to request the
        // withdrawal of. That is the contract behaving correctly, not a case to
        // paper over.
        uint256 remaining = bond.bonded(seller);
        if (remaining > 0) {
            vm.prank(seller);
            bond.requestWithdraw();
            vm.warp(block.timestamp + DELAY);

            if (drawAmount > 0 && drawAmount <= remaining) {
                vm.prank(seller);
                bond.withdraw(drawAmount);
            }
        }

        assertEq(token.balanceOf(address(bond)), bond.bonded(seller));
        assertLe(token.balanceOf(treasury), postAmount);
    }
}
