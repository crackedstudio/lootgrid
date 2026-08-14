// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HintEscrow} from "../src/HintEscrow.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * HintEscrow tests.
 *
 * Two signatures guard this contract and they guard different things. The vouch
 * decides *what may be sold*; the release decides *when the money moves*. Most
 * of what follows is about keeping those apart, and about the one property that
 * has to survive every failure: a buyer's money comes back.
 */
contract HintEscrowTest is Test {
    HintEscrow escrow;
    MockERC20 token;

    address owner = address(0xB055);
    address treasury = address(0x7EA5);
    address guardian = address(0x6A12);
    address attacker = address(0xBAD);
    address alice = address(0xA11CE); // buyer
    address bob = address(0xB0B); // seller

    uint256 vouchKey = 0x0000000000000000000000000000000000000000000000000000000000005001;
    uint256 releaseKey = 0x0000000000000000000000000000000000000000000000000000000000005002;
    uint256 wrongKey = 0x00000000000000000000000000000000000000000000000000000000000BADC0;
    address vouchAttestor;
    address releaseAttestor;

    // $0.01 and $5 at 18dp, matching the prize band hints are priced against.
    uint256 constant MIN_TRADE = 0.01e18;
    uint256 constant PER_TRADE = 5e18;
    uint256 constant WAIVER = 0.05e18;
    uint16 constant RAKE_BPS = 250;
    uint64 constant WINDOW = 1 hours;
    uint64 constant MAX_TTL = 24 hours;
    uint64 constant TTL = 1 hours;

    bytes32 constant TRADE = keccak256("trade-1");
    bytes32 constant HINT_HASH = keccak256("hint-payload");
    bytes32 constant ZONE = bytes32("ridge");

    function setUp() public {
        vouchAttestor = vm.addr(vouchKey);
        releaseAttestor = vm.addr(releaseKey);
        token = new MockERC20();

        escrow = new HintEscrow(
            address(token),
            owner,
            treasury,
            vouchAttestor,
            releaseAttestor,
            guardian,
            HintEscrow.Limits({
                rakeBps: RAKE_BPS,
                minTradeAmount: MIN_TRADE,
                perTradeCap: PER_TRADE,
                rakeWaiverAmount: WAIVER,
                challengeWindow: WINDOW,
                maxTradeTtl: MAX_TTL
            })
        );

        address[3] memory funded = [alice, bob, attacker];
        for (uint256 i = 0; i < funded.length; i++) {
            token.mint(funded[i], 100e18);
            vm.prank(funded[i]);
            token.approve(address(escrow), type(uint256).max);
        }

        vm.warp(1_700_000_000);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function vouchFor(bytes32 hintHash, uint8 tier, uint16 reliabilityBps)
        internal
        view
        returns (HintEscrow.Vouch memory)
    {
        return HintEscrow.Vouch({
            hintHash: hintHash,
            zoneId: ZONE,
            tier: tier,
            reliabilityBps: reliabilityBps,
            deadline: block.timestamp + 300
        });
    }

    function sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /**
     * NOTE: these call the contract for the digest, so they consume a pending
     * `vm.prank` or `vm.expectRevert`. Bind the signature to a local BEFORE
     * setting either, or the cheatcode lands on the digest view — which fails
     * loudly for a prank (no allowance) and silently for an expectation.
     */
    function signVouch(uint256 key, HintEscrow.Vouch memory vouch) internal view returns (bytes memory) {
        return sign(key, escrow.vouchDigest(vouch));
    }

    function signRelease(uint256 key, bytes32 tradeId, bytes32 hintHash, address buyer, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return sign(key, escrow.releaseDigest(tradeId, hintHash, buyer, deadline));
    }

    function fundAs(address buyer, bytes32 tradeId, uint256 amount) internal returns (uint64 expiresAt) {
        expiresAt = uint64(block.timestamp) + TTL;
        HintEscrow.Vouch memory vouch = vouchFor(HINT_HASH, 2, 7_000);
        bytes memory sig = signVouch(vouchKey, vouch);
        vm.prank(buyer);
        escrow.fund(tradeId, bob, amount, expiresAt, vouch, sig);
    }

    function settle(bytes32 tradeId, bytes32 hintHash, address buyer, uint256 key) internal {
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signRelease(key, tradeId, hintHash, buyer, deadline);
        escrow.settle(tradeId, hintHash, buyer, deadline, sig);
    }

    function statusOf(bytes32 tradeId) internal view returns (HintEscrow.Status) {
        (,,,, HintEscrow.Status status,) = escrow.trades(tradeId);
        return status;
    }

    // ── the happy path ───────────────────────────────────────────────────────

    function test_fundSettleWithdraw() public {
        fundAs(alice, TRADE, 1e18);
        assertEq(token.balanceOf(address(escrow)), 1e18);
        assertEq(escrow.totalEscrowed(), 1e18);

        settle(TRADE, HINT_HASH, alice, releaseKey);

        uint256 rake = (uint256(1e18) * RAKE_BPS) / 10_000;
        assertEq(escrow.owed(bob), 1e18 - rake);
        assertEq(escrow.owed(treasury), rake);
        assertEq(escrow.totalEscrowed(), 0);
        // Credited, not paid: the window is the guardian's chance to stop it.
        assertEq(token.balanceOf(bob), 100e18);

        vm.warp(block.timestamp + WINDOW);
        escrow.withdraw(bob);
        escrow.withdraw(treasury);

        assertEq(token.balanceOf(bob), 100e18 + 1e18 - rake);
        assertEq(token.balanceOf(treasury), rake);
        assertEq(escrow.totalOwed(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    /// Either party may settle, so neither depends on the other being online.
    function test_settleIsPermissionless() public {
        fundAs(alice, TRADE, 1e18);
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signRelease(releaseKey, TRADE, HINT_HASH, alice, deadline);

        vm.prank(attacker);
        escrow.settle(TRADE, HINT_HASH, alice, deadline, sig);

        assertEq(escrow.owed(bob), 1e18 - escrow.rakeFor(1e18));
        assertEq(escrow.owed(attacker), 0, "gas payer must not be paid");
    }

    /**
     * The same hint backs many trades at once. Information copies rather than
     * moves — a vouch that could only be spent once would make a hint sellable
     * exactly once, which is not this market.
     */
    function test_oneVouchBacksManyTrades() public {
        fundAs(alice, TRADE, 1e18);
        fundAs(attacker, keccak256("trade-2"), 1e18);

        settle(TRADE, HINT_HASH, alice, releaseKey);
        settle(keccak256("trade-2"), HINT_HASH, attacker, releaseKey);

        assertEq(escrow.owed(bob), 2 * (1e18 - escrow.rakeFor(1e18)));
    }

    // ── the vouch decides what may be sold ───────────────────────────────────

    function test_fund_rejectsFabricatedHint() public {
        // The lemon market in one test: without the referee's vouch a seller
        // could offer anything, and a buyer could not tell.
        HintEscrow.Vouch memory vouch = vouchFor(keccak256("invented"), 1, 9_000);
        bytes memory sig = signVouch(wrongKey, vouch);

        vm.prank(alice);
        vm.expectRevert(HintEscrow.BadVouch.selector);
        escrow.fund(TRADE, bob, 1e18, uint64(block.timestamp) + TTL, vouch, sig);
    }

    function test_fund_rejectsRelabelledTier() public {
        // Signed at tier 3 / 50%, presented as tier 1 / 90%. The reliability is
        // inside the signature precisely so this cannot work.
        HintEscrow.Vouch memory honest = vouchFor(HINT_HASH, 3, 5_000);
        bytes memory sig = signVouch(vouchKey, honest);

        HintEscrow.Vouch memory inflated = vouchFor(HINT_HASH, 1, 9_000);
        vm.prank(alice);
        vm.expectRevert(HintEscrow.BadVouch.selector);
        escrow.fund(TRADE, bob, 1e18, uint64(block.timestamp) + TTL, inflated, sig);
    }

    function test_fund_rejectsExpiredVouch() public {
        HintEscrow.Vouch memory vouch = vouchFor(HINT_HASH, 2, 7_000);
        bytes memory sig = signVouch(vouchKey, vouch);
        vm.warp(vouch.deadline + 1);

        vm.prank(alice);
        vm.expectRevert(HintEscrow.AttestationExpired.selector);
        escrow.fund(TRADE, bob, 1e18, uint64(block.timestamp) + TTL, vouch, sig);
    }

    /// The vouch key cannot move money on its own. That is why it may stay hot.
    function test_vouchKeyCannotRelease() public {
        fundAs(alice, TRADE, 1e18);
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signRelease(vouchKey, TRADE, HINT_HASH, alice, deadline);

        vm.expectRevert(HintEscrow.BadRelease.selector);
        escrow.settle(TRADE, HINT_HASH, alice, deadline, sig);
    }

    /// And the payout key cannot decide what is genuine.
    function test_releaseKeyCannotVouch() public {
        HintEscrow.Vouch memory vouch = vouchFor(HINT_HASH, 2, 7_000);
        bytes memory sig = signVouch(releaseKey, vouch);

        vm.prank(alice);
        vm.expectRevert(HintEscrow.BadVouch.selector);
        escrow.fund(TRADE, bob, 1e18, uint64(block.timestamp) + TTL, vouch, sig);
    }

    // ── the release is a bearer token ────────────────────────────────────────

    function test_settle_rejectsForgedRelease() public {
        fundAs(alice, TRADE, 1e18);
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signRelease(wrongKey, TRADE, HINT_HASH, alice, deadline);

        vm.expectRevert(HintEscrow.BadRelease.selector);
        escrow.settle(TRADE, HINT_HASH, alice, deadline, sig);
    }

    function test_settle_rejectsReplay() public {
        fundAs(alice, TRADE, 1e18);
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signRelease(releaseKey, TRADE, HINT_HASH, alice, deadline);
        escrow.settle(TRADE, HINT_HASH, alice, deadline, sig);

        // Caught by the trade's own status before the digest is consulted;
        // either way there is no second payout.
        vm.expectRevert(HintEscrow.NotFunded.selector);
        escrow.settle(TRADE, HINT_HASH, alice, deadline, sig);
    }

    /// A release for one trade must not settle another.
    function test_settle_rejectsReleaseFromAnotherTrade() public {
        fundAs(alice, TRADE, 1e18);
        bytes32 other = keccak256("trade-2");
        fundAs(alice, other, 1e18);

        uint256 deadline = block.timestamp + 300;
        bytes memory forFirst = signRelease(releaseKey, TRADE, HINT_HASH, alice, deadline);

        vm.expectRevert(HintEscrow.BadRelease.selector);
        escrow.settle(other, HINT_HASH, alice, deadline, forFirst);
    }

    /// Nor may it be aimed at a different hint under the same trade.
    function test_settle_rejectsSwappedHint() public {
        fundAs(alice, TRADE, 1e18);
        bytes32 sharper = keccak256("a-better-hint");
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signRelease(releaseKey, TRADE, sharper, alice, deadline);

        vm.expectRevert(HintEscrow.WrongHint.selector);
        escrow.settle(TRADE, sharper, alice, deadline, sig);
    }

    function test_settle_rejectsSwappedBuyer() public {
        fundAs(alice, TRADE, 1e18);
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signRelease(releaseKey, TRADE, HINT_HASH, attacker, deadline);

        vm.expectRevert(HintEscrow.BadRelease.selector);
        escrow.settle(TRADE, HINT_HASH, attacker, deadline, sig);
    }

    function test_settle_rejectsExpiredRelease() public {
        fundAs(alice, TRADE, 1e18);
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signRelease(releaseKey, TRADE, HINT_HASH, alice, deadline);
        vm.warp(deadline + 1);

        vm.expectRevert(HintEscrow.AttestationExpired.selector);
        escrow.settle(TRADE, HINT_HASH, alice, deadline, sig);
    }

    /**
     * A signature from another deployment must be worthless here. The domain
     * separator is what provides that, and nothing else does.
     */
    function test_settle_rejectsReleaseFromAnotherDeployment() public {
        HintEscrow twin = new HintEscrow(
            address(token),
            owner,
            treasury,
            vouchAttestor,
            releaseAttestor,
            guardian,
            HintEscrow.Limits({
                rakeBps: RAKE_BPS,
                minTradeAmount: MIN_TRADE,
                perTradeCap: PER_TRADE,
                rakeWaiverAmount: WAIVER,
                challengeWindow: WINDOW,
                maxTradeTtl: MAX_TTL
            })
        );

        fundAs(alice, TRADE, 1e18);
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = sign(releaseKey, twin.releaseDigest(TRADE, HINT_HASH, alice, deadline));

        vm.expectRevert(HintEscrow.BadRelease.selector);
        escrow.settle(TRADE, HINT_HASH, alice, deadline, sig);
    }

    // ── refunds are sacred ───────────────────────────────────────────────────

    function test_refundAfterExpiry() public {
        fundAs(alice, TRADE, 1e18);
        assertEq(token.balanceOf(alice), 99e18);

        vm.warp(block.timestamp + TTL + 1);
        vm.prank(attacker); // permissionless — the money still goes to the buyer
        escrow.refund(TRADE);

        assertEq(token.balanceOf(alice), 100e18);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(uint8(statusOf(TRADE)), uint8(HintEscrow.Status.Refunded));
    }

    function test_refund_worksWhilePaused() public {
        // The whole point: a guardian who pauses and vanishes, or a referee that
        // never attests, must not be able to hold a buyer's money.
        fundAs(alice, TRADE, 1e18);
        vm.prank(guardian);
        escrow.setPaused(true);

        vm.warp(block.timestamp + TTL + 1);
        escrow.refund(TRADE);
        assertEq(token.balanceOf(alice), 100e18);
    }

    function test_refund_rejectsBeforeExpiry() public {
        fundAs(alice, TRADE, 1e18);
        vm.expectRevert(HintEscrow.NotExpired.selector);
        escrow.refund(TRADE);
    }

    function test_refund_rejectsSettledTrade() public {
        fundAs(alice, TRADE, 1e18);
        settle(TRADE, HINT_HASH, alice, releaseKey);

        vm.warp(block.timestamp + TTL + 1);
        vm.expectRevert(HintEscrow.NotFunded.selector);
        escrow.refund(TRADE);
    }

    function test_refund_rejectsTwice() public {
        fundAs(alice, TRADE, 1e18);
        vm.warp(block.timestamp + TTL + 1);
        escrow.refund(TRADE);

        vm.expectRevert(HintEscrow.NotFunded.selector);
        escrow.refund(TRADE);
    }

    /**
     * The race that decides whether a buyer can be paid twice: settlement after
     * expiry must lose to the refund that is already due.
     */
    function test_settle_rejectsAfterExpiry() public {
        fundAs(alice, TRADE, 1e18);
        vm.warp(block.timestamp + TTL + 1);

        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signRelease(releaseKey, TRADE, HINT_HASH, alice, deadline);
        vm.expectRevert(HintEscrow.TradeExpired.selector);
        escrow.settle(TRADE, HINT_HASH, alice, deadline, sig);
    }

    // ── limits ───────────────────────────────────────────────────────────────

    function test_fund_rejectsDust() public {
        HintEscrow.Vouch memory vouch = vouchFor(HINT_HASH, 2, 7_000);
        bytes memory sig = signVouch(vouchKey, vouch);

        vm.prank(alice);
        vm.expectRevert(HintEscrow.BelowMinimum.selector);
        escrow.fund(TRADE, bob, MIN_TRADE - 1, uint64(block.timestamp) + TTL, vouch, sig);
    }

    function test_fund_rejectsAboveCap() public {
        HintEscrow.Vouch memory vouch = vouchFor(HINT_HASH, 2, 7_000);
        bytes memory sig = signVouch(vouchKey, vouch);

        vm.prank(alice);
        vm.expectRevert(HintEscrow.ExceedsTradeCap.selector);
        escrow.fund(TRADE, bob, PER_TRADE + 1, uint64(block.timestamp) + TTL, vouch, sig);
    }

    function test_fund_rejectsSelfTrade() public {
        // Wash trading fabricates the history phase 9 reads as reputation.
        HintEscrow.Vouch memory vouch = vouchFor(HINT_HASH, 2, 7_000);
        bytes memory sig = signVouch(vouchKey, vouch);

        vm.prank(bob);
        vm.expectRevert(HintEscrow.SelfTrade.selector);
        escrow.fund(TRADE, bob, 1e18, uint64(block.timestamp) + TTL, vouch, sig);
    }

    function test_fund_rejectsDuplicateTradeId() public {
        fundAs(alice, TRADE, 1e18);
        HintEscrow.Vouch memory vouch = vouchFor(HINT_HASH, 2, 7_000);
        bytes memory sig = signVouch(vouchKey, vouch);

        vm.prank(alice);
        vm.expectRevert(HintEscrow.TradeExists.selector);
        escrow.fund(TRADE, bob, 1e18, uint64(block.timestamp) + TTL, vouch, sig);
    }

    function test_fund_rejectsTtlBeyondTheMaximum() public {
        // An unbounded TTL locks a buyer's money in a refund that never becomes due.
        HintEscrow.Vouch memory vouch = vouchFor(HINT_HASH, 2, 7_000);
        bytes memory sig = signVouch(vouchKey, vouch);

        vm.prank(alice);
        vm.expectRevert(HintEscrow.BadExpiry.selector);
        escrow.fund(TRADE, bob, 1e18, uint64(block.timestamp) + MAX_TTL + 1, vouch, sig);
    }

    function test_fund_rejectsExpiryInThePast() public {
        HintEscrow.Vouch memory vouch = vouchFor(HINT_HASH, 2, 7_000);
        bytes memory sig = signVouch(vouchKey, vouch);

        vm.prank(alice);
        vm.expectRevert(HintEscrow.BadExpiry.selector);
        escrow.fund(TRADE, bob, 1e18, uint64(block.timestamp), vouch, sig);
    }

    // ── the rake ─────────────────────────────────────────────────────────────

    /// Small trades stay liquid: below the waiver the seller keeps everything.
    function test_rakeIsWaivedOnSmallTrades() public {
        assertEq(escrow.rakeFor(WAIVER - 1), 0);

        fundAs(alice, TRADE, MIN_TRADE);
        settle(TRADE, HINT_HASH, alice, releaseKey);

        assertEq(escrow.owed(bob), MIN_TRADE);
        assertEq(escrow.owed(treasury), 0);
    }

    function test_rakeRoundsTowardTheSeller() public {
        // 2.5% of an amount that does not divide evenly. The remainder stays
        // with the seller — the house never rounds a fee up in its own favour.
        uint256 odd = WAIVER + 7;
        uint256 rake = escrow.rakeFor(odd);
        assertEq(rake, (odd * RAKE_BPS) / 10_000);
        assertLe(rake * 10_000, odd * RAKE_BPS);
    }

    function test_setLimits_cannotRaiseRakeAboveTheCeiling() public {
        HintEscrow.Limits memory limits = HintEscrow.Limits({
            rakeBps: escrow.MAX_RAKE_BPS() + 1,
            minTradeAmount: MIN_TRADE,
            perTradeCap: PER_TRADE,
            rakeWaiverAmount: WAIVER,
            challengeWindow: WINDOW,
            maxTradeTtl: MAX_TTL
        });

        vm.prank(owner);
        vm.expectRevert(HintEscrow.RakeTooHigh.selector);
        escrow.setLimits(limits);
    }

    function testFuzz_rakeNeverExceedsTheAdvertisedRate(uint256 amount) public view {
        amount = bound(amount, 0, 1e30);
        uint256 rake = escrow.rakeFor(amount);
        assertLe(rake, (amount * RAKE_BPS) / 10_000);
        assertLe(rake, amount);
    }

    // ── custody ──────────────────────────────────────────────────────────────

    /**
     * The invariant a buyer actually cares about: every token in here is
     * accounted for as somebody's escrow or somebody's credit.
     */
    function test_nothingIsUnaccountedFor() public {
        fundAs(alice, TRADE, 1e18);
        fundAs(attacker, keccak256("trade-2"), 2e18);
        settle(TRADE, HINT_HASH, alice, releaseKey);

        assertEq(escrow.unencumberedBalance(), 0);
        assertEq(token.balanceOf(address(escrow)), escrow.totalEscrowed() + escrow.totalOwed());
    }

    function test_withdraw_waitsOutTheChallengeWindow() public {
        fundAs(alice, TRADE, 1e18);
        settle(TRADE, HINT_HASH, alice, releaseKey);

        vm.expectRevert(HintEscrow.NotYetWithdrawable.selector);
        escrow.withdraw(bob);

        vm.warp(block.timestamp + WINDOW);
        escrow.withdraw(bob);
    }

    function test_withdraw_windowRestartsOnANewCredit() public {
        // The guardian's time to react must cover the newest obligation.
        fundAs(alice, TRADE, 1e18);
        settle(TRADE, HINT_HASH, alice, releaseKey);

        vm.warp(block.timestamp + WINDOW - 1);
        fundAs(alice, keccak256("trade-2"), 1e18);
        settle(keccak256("trade-2"), HINT_HASH, alice, releaseKey);

        vm.warp(block.timestamp + WINDOW - 1);
        vm.expectRevert(HintEscrow.NotYetWithdrawable.selector);
        escrow.withdraw(bob);
    }

    function test_withdraw_rejectsEmptyBalance() public {
        vm.expectRevert(HintEscrow.NothingOwed.selector);
        escrow.withdraw(attacker);
    }

    // ── pause and roles ──────────────────────────────────────────────────────

    function test_pause_haltsFundingAndSettlement() public {
        fundAs(alice, TRADE, 1e18);
        vm.prank(guardian);
        escrow.setPaused(true);

        HintEscrow.Vouch memory vouch = vouchFor(HINT_HASH, 2, 7_000);
        bytes memory vsig = signVouch(vouchKey, vouch);
        vm.prank(alice);
        vm.expectRevert(HintEscrow.Paused.selector);
        escrow.fund(keccak256("trade-2"), bob, 1e18, uint64(block.timestamp) + TTL, vouch, vsig);

        uint256 deadline = block.timestamp + 300;
        bytes memory rsig = signRelease(releaseKey, TRADE, HINT_HASH, alice, deadline);
        vm.expectRevert(HintEscrow.Paused.selector);
        escrow.settle(TRADE, HINT_HASH, alice, deadline, rsig);
    }

    function test_pause_isNotOpenToStrangers() public {
        vm.prank(attacker);
        vm.expectRevert(HintEscrow.NotGuardian.selector);
        escrow.setPaused(true);
    }

    function test_ownerMayAlsoPause() public {
        // Incident response must not depend on one key being reachable at 3am.
        vm.prank(owner);
        escrow.setPaused(true);
        assertTrue(escrow.paused());
    }

    function test_rotatingTheVouchKeyInvalidatesOldVouches() public {
        HintEscrow.Vouch memory vouch = vouchFor(HINT_HASH, 2, 7_000);
        bytes memory sig = signVouch(vouchKey, vouch);

        vm.prank(owner);
        escrow.setVouchAttestor(vm.addr(wrongKey));

        vm.prank(alice);
        vm.expectRevert(HintEscrow.BadVouch.selector);
        escrow.fund(TRADE, bob, 1e18, uint64(block.timestamp) + TTL, vouch, sig);
    }

    function test_rotatingTheReleaseKeyInvalidatesOldReleases() public {
        fundAs(alice, TRADE, 1e18);
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signRelease(releaseKey, TRADE, HINT_HASH, alice, deadline);

        vm.prank(owner);
        escrow.setReleaseAttestor(vm.addr(wrongKey));

        vm.expectRevert(HintEscrow.BadRelease.selector);
        escrow.settle(TRADE, HINT_HASH, alice, deadline, sig);
    }

    function test_adminIsClosedToStrangers() public {
        HintEscrow.Limits memory limits = HintEscrow.Limits({
            rakeBps: 0,
            minTradeAmount: 1,
            perTradeCap: 1e18,
            rakeWaiverAmount: 0,
            challengeWindow: 0,
            maxTradeTtl: 1 hours
        });

        vm.startPrank(attacker);
        vm.expectRevert(HintEscrow.NotOwner.selector);
        escrow.setLimits(limits);
        vm.expectRevert(HintEscrow.NotOwner.selector);
        escrow.setReleaseAttestor(attacker);
        vm.expectRevert(HintEscrow.NotOwner.selector);
        escrow.setTreasury(attacker);
        vm.expectRevert(HintEscrow.NotOwner.selector);
        escrow.transferOwnership(attacker);
        vm.stopPrank();
    }

    function test_ownershipTransferIsTwoStep() public {
        vm.prank(owner);
        escrow.transferOwnership(alice);
        assertEq(escrow.owner(), owner, "ownership must not move on the offer alone");

        vm.prank(alice);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), alice);
        assertEq(escrow.pendingOwner(), address(0));
    }

    // ── token quirks ─────────────────────────────────────────────────────────

    /**
     * Celo's stablecoins are not uniform: some revert on failure, some return
     * false. A token that quietly returns false must not look like a funded
     * trade — SafeERC20 is what makes that true, and this proves it.
     */
    function test_fund_revertsWhenTheTokenReturnsFalse() public {
        token.setReturnsFalse(true);
        HintEscrow.Vouch memory vouch = vouchFor(HINT_HASH, 2, 7_000);
        bytes memory sig = signVouch(vouchKey, vouch);

        vm.prank(alice);
        vm.expectRevert();
        escrow.fund(TRADE, bob, 1e18, uint64(block.timestamp) + TTL, vouch, sig);

        assertEq(uint8(statusOf(TRADE)), uint8(HintEscrow.Status.None));
    }
}
