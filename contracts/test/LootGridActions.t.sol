// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LootGridActions} from "../src/LootGridActions.sol";

contract LootGridActionsTest is Test {
    LootGridActions actions;

    address owner = address(0xB055);
    address relayer = address(0xFEE1);
    address attacker = address(0xBAD);
    address alice = address(0xA11CE);

    /// The referee's attestation signing key, and a key that is not it.
    uint256 attestorKey = 0xA77E;
    uint256 wrongKey = 0xBADC0DE;
    address attestor;

    /// ASCII "ridge" right-padded — how the relayer encodes a zone id.
    bytes32 constant ZONE = bytes32(bytes("ridge"));

    event TileRevealed(
        address indexed player,
        bytes32 indexed zoneId,
        uint32 epoch,
        uint8 r,
        uint8 c,
        uint8 tileType,
        uint64 at
    );
    event HuntEntered(address indexed player, bytes32 indexed huntId, uint8 gameType, uint64 at);
    event HuntResolved(
        address indexed winner, bytes32 indexed huntId, uint32 elapsedMs, uint16 racers, uint64 at
    );
    event RelayerChanged(address indexed previous, address indexed next);
    event AttestorChanged(address indexed previous, address indexed next);

    function setUp() public {
        attestor = vm.addr(attestorKey);
        actions = new LootGridActions(owner, relayer, attestor);
        // Deadlines are absolute unix seconds; start somewhere realistic so
        // `block.timestamp + n` cannot underflow expectations.
        vm.warp(1_700_000_000);
    }

    // ── attestation helpers ──────────────────────────────────────────────────

    function signEntry(uint256 key, address player, bytes32 huntId, uint8 gameType, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, actions.entryDigest(player, huntId, gameType, deadline));
        return abi.encodePacked(r, s, v);
    }

    function signResolution(
        uint256 key,
        address winner,
        bytes32 huntId,
        uint32 elapsedMs,
        uint16 racers,
        uint256 deadline
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, actions.resolutionDigest(winner, huntId, elapsedMs, racers, deadline));
        return abi.encodePacked(r, s, v);
    }

    // ─────────────────────────── construction ───────────────────────────

    function test_constructor_setsOwnerAndRelayer() public view {
        assertEq(actions.owner(), owner);
        assertEq(actions.relayer(), relayer);
        assertEq(actions.attestor(), attestor);
        assertEq(actions.recordCount(), 0);
    }

    function test_constructor_rejectsZeroOwner() public {
        vm.expectRevert(LootGridActions.ZeroAddress.selector);
        new LootGridActions(address(0), relayer, attestor);
    }

    function test_constructor_rejectsZeroRelayer() public {
        vm.expectRevert(LootGridActions.ZeroAddress.selector);
        new LootGridActions(owner, address(0), attestor);
    }

    function test_constructor_rejectsZeroAttestor() public {
        vm.expectRevert(LootGridActions.ZeroAddress.selector);
        new LootGridActions(owner, relayer, address(0));
    }

    // ─────────────────────────── records ───────────────────────────

    function test_recordReveal_emitsAndCounts() public {
        vm.warp(1_700_000_000);
        vm.expectEmit(true, true, false, true);
        emit TileRevealed(alice, ZONE, 7, 3, 4, 2, 1_700_000_000);

        vm.prank(relayer);
        actions.recordReveal(alice, ZONE, 7, 3, 4, 2);
        assertEq(actions.recordCount(), 1);
    }

    function test_recordEntry_emitsAndCounts() public {
        vm.warp(42);
        bytes32 huntId = keccak256("hunt-1");

        vm.expectEmit(true, true, false, true);
        emit HuntEntered(alice, huntId, 0, 42);

        vm.prank(relayer);
        actions.recordEntry(alice, huntId, 0);
        assertEq(actions.recordCount(), 1);
    }

    function test_recordResolution_emitsAndCounts() public {
        vm.warp(99);
        bytes32 huntId = keccak256("hunt-2");

        vm.expectEmit(true, true, false, true);
        emit HuntResolved(alice, huntId, 2105, 3, 99);

        vm.prank(relayer);
        actions.recordResolution(alice, huntId, 2105, 3);
        assertEq(actions.recordCount(), 1);
    }

    function test_recordCount_accumulatesAcrossKinds() public {
        vm.startPrank(relayer);
        actions.recordReveal(alice, ZONE, 1, 0, 0, 0);
        actions.recordEntry(alice, bytes32(0), 0);
        actions.recordResolution(alice, bytes32(0), 1, 1);
        vm.stopPrank();
        assertEq(actions.recordCount(), 3);
    }

    // ─────────────────────────── access control ───────────────────────────

    function test_recordReveal_onlyRelayer() public {
        vm.prank(attacker);
        vm.expectRevert(LootGridActions.NotRelayer.selector);
        actions.recordReveal(alice, ZONE, 1, 0, 0, 0);
    }

    function test_recordEntry_onlyRelayer() public {
        vm.prank(attacker);
        vm.expectRevert(LootGridActions.NotRelayer.selector);
        actions.recordEntry(alice, bytes32(0), 0);
    }

    function test_recordResolution_onlyRelayer() public {
        vm.prank(attacker);
        vm.expectRevert(LootGridActions.NotRelayer.selector);
        actions.recordResolution(alice, bytes32(0), 0, 0);
    }

    /// The owner is not a relayer. Separating them means the hot submitting key
    /// can be rotated without touching the cold key that authorises rotation.
    function test_ownerCannotWriteRecords() public {
        vm.prank(owner);
        vm.expectRevert(LootGridActions.NotRelayer.selector);
        actions.recordReveal(alice, ZONE, 1, 0, 0, 0);
    }

    // ─────────────────────────── batching ───────────────────────────

    function test_recordRevealBatch_emitsEach() public {
        address[] memory players = new address[](3);
        bytes32[] memory zoneIds = new bytes32[](3);
        uint32[] memory epochs = new uint32[](3);
        uint8[] memory rs = new uint8[](3);
        uint8[] memory cs = new uint8[](3);
        uint8[] memory types = new uint8[](3);
        for (uint256 i; i < 3; i++) {
            players[i] = alice;
            zoneIds[i] = ZONE;
            epochs[i] = 1;
            rs[i] = uint8(i);
            cs[i] = uint8(i);
            types[i] = 0;
        }

        vm.prank(relayer);
        actions.recordRevealBatch(players, zoneIds, epochs, rs, cs, types);
        assertEq(actions.recordCount(), 3);
    }

    function test_recordRevealBatch_rejectsMismatchedLengths() public {
        address[] memory players = new address[](2);
        bytes32[] memory zoneIds = new bytes32[](1);
        uint32[] memory epochs = new uint32[](2);
        uint8[] memory rs = new uint8[](2);
        uint8[] memory cs = new uint8[](2);
        uint8[] memory types = new uint8[](2);

        vm.prank(relayer);
        vm.expectRevert(LootGridActions.LengthMismatch.selector);
        actions.recordRevealBatch(players, zoneIds, epochs, rs, cs, types);
    }

    /// An oversized batch that can never be mined would strand the whole queue
    /// behind it, so it is rejected rather than retried forever.
    function test_recordRevealBatch_rejectsOversizedBatch() public {
        uint256 n = actions.MAX_BATCH() + 1;
        address[] memory players = new address[](n);
        bytes32[] memory zoneIds = new bytes32[](n);
        uint32[] memory epochs = new uint32[](n);
        uint8[] memory rs = new uint8[](n);
        uint8[] memory cs = new uint8[](n);
        uint8[] memory types = new uint8[](n);

        vm.prank(relayer);
        vm.expectRevert(LootGridActions.BatchTooLarge.selector);
        actions.recordRevealBatch(players, zoneIds, epochs, rs, cs, types);
    }

    function test_recordRevealBatch_onlyRelayer() public {
        address[] memory empty = new address[](0);
        bytes32[] memory z = new bytes32[](0);
        uint32[] memory e = new uint32[](0);
        uint8[] memory a = new uint8[](0);

        vm.prank(attacker);
        vm.expectRevert(LootGridActions.NotRelayer.selector);
        actions.recordRevealBatch(empty, z, e, a, a, a);
    }

    // ─────────────────────────── admin ───────────────────────────

    function test_setRelayer_rotates() public {
        address next = address(0xDEAD1);
        vm.expectEmit(true, true, false, false);
        emit RelayerChanged(relayer, next);
        vm.prank(owner);
        actions.setRelayer(next);

        assertEq(actions.relayer(), next);

        // The old key is immediately powerless — the point of rotation.
        vm.prank(relayer);
        vm.expectRevert(LootGridActions.NotRelayer.selector);
        actions.recordReveal(alice, ZONE, 1, 0, 0, 0);

        vm.prank(next);
        actions.recordReveal(alice, ZONE, 1, 0, 0, 0);
        assertEq(actions.recordCount(), 1);
    }

    function test_setRelayer_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert(LootGridActions.NotOwner.selector);
        actions.setRelayer(attacker);
    }

    function test_setRelayer_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(LootGridActions.ZeroAddress.selector);
        actions.setRelayer(address(0));
    }

    function test_ownershipTransferIsTwoStep() public {
        address next = address(0xBEEF);

        vm.prank(owner);
        actions.transferOwnership(next);
        assertEq(actions.owner(), owner, "owner must not change until accepted");
        assertEq(actions.pendingOwner(), next);

        vm.prank(next);
        actions.acceptOwnership();
        assertEq(actions.owner(), next);
        assertEq(actions.pendingOwner(), address(0));

        vm.prank(owner);
        vm.expectRevert(LootGridActions.NotOwner.selector);
        actions.setRelayer(attacker);
    }

    function test_acceptOwnership_onlyPendingOwner() public {
        vm.prank(owner);
        actions.transferOwnership(address(0xBEEF));

        vm.prank(attacker);
        vm.expectRevert(LootGridActions.NotPendingOwner.selector);
        actions.acceptOwnership();
    }

    function test_transferOwnership_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert(LootGridActions.NotOwner.selector);
        actions.transferOwnership(attacker);
    }

    function test_transferOwnership_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(LootGridActions.ZeroAddress.selector);
        actions.transferOwnership(address(0));
    }

    // ──────────────────── self-submitted (attested) records ────────────────────

    /// The point of the whole change: a player pays their own gas, and the
    /// referee's signature — not `msg.sender` — is what authorises the record.
    function test_submitEntry_playerPaysAndIsRecorded() public {
        bytes32 huntId = keccak256("hunt-entry");
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signEntry(attestorKey, alice, huntId, 3, deadline);

        vm.expectEmit(true, true, false, true);
        emit HuntEntered(alice, huntId, 3, uint64(block.timestamp));

        vm.prank(alice);
        actions.submitEntry(alice, huntId, 3, deadline, sig);
        assertEq(actions.recordCount(), 1);
    }

    function test_submitResolution_winnerPaysAndIsRecorded() public {
        bytes32 huntId = keccak256("hunt-res");
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signResolution(attestorKey, alice, huntId, 2105, 4, deadline);

        vm.expectEmit(true, true, false, true);
        emit HuntResolved(alice, huntId, 2105, 4, uint64(block.timestamp));

        vm.prank(alice);
        actions.submitResolution(alice, huntId, 2105, 4, deadline, sig);
        assertEq(actions.recordCount(), 1);
    }

    /// Without the signature check, this is the attack: anyone declares
    /// themselves winner of any hunt. An unsigned/garbage attestation must fail.
    function test_submitResolution_rejectsForgedWin() public {
        bytes32 huntId = keccak256("hunt-forge");
        uint256 deadline = block.timestamp + 300;
        bytes memory forged = signResolution(wrongKey, attacker, huntId, 1, 1, deadline);

        vm.prank(attacker);
        vm.expectRevert(LootGridActions.BadAttestation.selector);
        actions.submitResolution(attacker, huntId, 1, 1, deadline, forged);
        assertEq(actions.recordCount(), 0);
    }

    /// An attacker cannot take a valid attestation and redirect the credit.
    function test_submitResolution_rejectsSwappedWinner() public {
        bytes32 huntId = keccak256("hunt-swap");
        uint256 deadline = block.timestamp + 300;
        bytes memory sigForAlice = signResolution(attestorKey, alice, huntId, 2105, 4, deadline);

        vm.prank(attacker);
        vm.expectRevert(LootGridActions.BadAttestation.selector);
        actions.submitResolution(attacker, huntId, 2105, 4, deadline, sigForAlice);
    }

    /// Every signed field is covered: tampering with any of them invalidates it.
    function test_submitResolution_rejectsTamperedFields() public {
        bytes32 huntId = keccak256("hunt-tamper");
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signResolution(attestorKey, alice, huntId, 2105, 4, deadline);

        vm.startPrank(alice);

        vm.expectRevert(LootGridActions.BadAttestation.selector);
        actions.submitResolution(alice, keccak256("other"), 2105, 4, deadline, sig);

        // A faster time than the referee measured — the obvious thing to fake.
        vm.expectRevert(LootGridActions.BadAttestation.selector);
        actions.submitResolution(alice, huntId, 1, 4, deadline, sig);

        vm.expectRevert(LootGridActions.BadAttestation.selector);
        actions.submitResolution(alice, huntId, 2105, 99, deadline, sig);

        vm.expectRevert(LootGridActions.BadAttestation.selector);
        actions.submitResolution(alice, huntId, 2105, 4, deadline + 1, sig);

        vm.stopPrank();
        assertEq(actions.recordCount(), 0);
    }

    /// An attestation is a bearer token: it must burn on use, or a winning
    /// resolution could be replayed forever.
    function test_submitResolution_cannotReplay() public {
        bytes32 huntId = keccak256("hunt-replay");
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signResolution(attestorKey, alice, huntId, 2105, 4, deadline);

        vm.prank(alice);
        actions.submitResolution(alice, huntId, 2105, 4, deadline, sig);

        vm.prank(alice);
        vm.expectRevert(LootGridActions.AttestationAlreadyUsed.selector);
        actions.submitResolution(alice, huntId, 2105, 4, deadline, sig);

        assertEq(actions.recordCount(), 1, "replay must not inflate the count");
    }

    function test_submitEntry_cannotReplay() public {
        bytes32 huntId = keccak256("hunt-replay-entry");
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signEntry(attestorKey, alice, huntId, 0, deadline);

        vm.startPrank(alice);
        actions.submitEntry(alice, huntId, 0, deadline, sig);
        vm.expectRevert(LootGridActions.AttestationAlreadyUsed.selector);
        actions.submitEntry(alice, huntId, 0, deadline, sig);
        vm.stopPrank();
    }

    function test_submitEntry_rejectsExpired() public {
        bytes32 huntId = keccak256("hunt-expired");
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = signEntry(attestorKey, alice, huntId, 0, deadline);

        vm.warp(deadline + 1);
        vm.prank(alice);
        vm.expectRevert(LootGridActions.AttestationExpired.selector);
        actions.submitEntry(alice, huntId, 0, deadline, sig);
    }

    /// Exactly at the deadline is still good — the check is `>`, not `>=`.
    function test_submitEntry_acceptsAtDeadline() public {
        bytes32 huntId = keccak256("hunt-boundary");
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = signEntry(attestorKey, alice, huntId, 0, deadline);

        vm.warp(deadline);
        vm.prank(alice);
        actions.submitEntry(alice, huntId, 0, deadline, sig);
        assertEq(actions.recordCount(), 1);
    }

    /// A third party may pay for someone else's record. Harmless by design, and
    /// it is what lets the relayer stand in for a player with an empty wallet.
    function test_submitEntry_anyoneMaySubmitOnBehalf() public {
        bytes32 huntId = keccak256("hunt-fallback");
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signEntry(attestorKey, alice, huntId, 2, deadline);

        vm.expectEmit(true, true, false, true);
        emit HuntEntered(alice, huntId, 2, uint64(block.timestamp));

        // Submitted by the relayer, credited to alice.
        vm.prank(relayer);
        actions.submitEntry(alice, huntId, 2, deadline, sig);
    }

    /// The domain separator binds signatures to this chain and this address, so
    /// an attestation cannot be replayed onto a redeployment.
    function test_attestation_isBoundToThisDeployment() public {
        bytes32 huntId = keccak256("hunt-domain");
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signEntry(attestorKey, alice, huntId, 0, deadline);

        LootGridActions other = new LootGridActions(owner, relayer, attestor);
        vm.prank(alice);
        vm.expectRevert(LootGridActions.BadAttestation.selector);
        other.submitEntry(alice, huntId, 0, deadline, sig);
    }

    function test_setAttestor_rotates() public {
        address next = vm.addr(wrongKey);

        vm.expectEmit(true, true, false, false);
        emit AttestorChanged(attestor, next);
        vm.prank(owner);
        actions.setAttestor(next);
        assertEq(actions.attestor(), next);

        bytes32 huntId = keccak256("hunt-rotate");
        uint256 deadline = block.timestamp + 300;
        // Signed up front: these helpers call the contract, which would
        // otherwise consume the prank/expectRevert below.
        bytes memory retiredSig = signEntry(attestorKey, alice, huntId, 0, deadline);
        bytes memory freshSig = signEntry(wrongKey, alice, huntId, 0, deadline);

        // Signatures from the retired key stop verifying immediately.
        vm.prank(alice);
        vm.expectRevert(LootGridActions.BadAttestation.selector);
        actions.submitEntry(alice, huntId, 0, deadline, retiredSig);

        vm.prank(alice);
        actions.submitEntry(alice, huntId, 0, deadline, freshSig);
        assertEq(actions.recordCount(), 1);
    }

    function test_setAttestor_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert(LootGridActions.NotOwner.selector);
        actions.setAttestor(attacker);
    }

    function test_setAttestor_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(LootGridActions.ZeroAddress.selector);
        actions.setAttestor(address(0));
    }

    /// Reveals stay relayer-only: they are far too frequent to carry a
    /// signature check, and the tap loop must never wait on a player wallet.
    function test_revealsHaveNoSelfSubmitPath() public {
        vm.prank(alice);
        vm.expectRevert(LootGridActions.NotRelayer.selector);
        actions.recordReveal(alice, ZONE, 1, 0, 0, 0);
    }

    // ─────────────────────────── fuzz ───────────────────────────

    /// No caller and no key other than the attestor's can produce a record.
    function testFuzz_onlyAttestorSignaturesAreAccepted(uint256 key, address submitter) public {
        key = bound(key, 1, type(uint128).max);
        vm.assume(vm.addr(key) != attestor);

        bytes32 huntId = keccak256("hunt-fuzz");
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = signResolution(key, alice, huntId, 10, 2, deadline);

        vm.prank(submitter);
        vm.expectRevert(LootGridActions.BadAttestation.selector);
        actions.submitResolution(alice, huntId, 10, 2, deadline, sig);
    }

    function testFuzz_onlyRelayerCanRecord(address caller) public {
        vm.assume(caller != relayer);
        vm.prank(caller);
        vm.expectRevert(LootGridActions.NotRelayer.selector);
        actions.recordReveal(alice, ZONE, 1, 0, 0, 0);
    }

    function testFuzz_recordCountMatchesCalls(uint8 n) public {
        n = uint8(bound(n, 0, 50));
        vm.startPrank(relayer);
        for (uint256 i; i < n; i++) {
            actions.recordReveal(alice, ZONE, 1, 0, 0, 0);
        }
        vm.stopPrank();
        assertEq(actions.recordCount(), n);
    }
}
