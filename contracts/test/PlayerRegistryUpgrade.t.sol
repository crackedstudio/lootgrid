// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PlayerRegistry} from "../src/PlayerRegistry.sol";
import {MaliciousRegistry, PlayerRegistryV2} from "./mocks/PlayerRegistryV2.sol";

/// @notice Covers the upgrade authority — the part of this contract with the
///         largest blast radius, since an implementation swap is impersonation
///         of every player at once.
contract PlayerRegistryUpgradeTest is Test {
    PlayerRegistry registry;
    PlayerRegistry implV1;

    address owner = address(0xB055);
    address attacker = address(0xBAD);
    address alice = address(0xA11CE);

    uint256 pkA = 0xA1;
    address keyA;

    event UpgradeProposed(address indexed implementation, bytes32 codehash, bytes32 payloadHash, uint64 eta);
    event UpgradeCancelled(address indexed implementation);

    function setUp() public {
        implV1 = new PlayerRegistry();
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(implV1), abi.encodeCall(PlayerRegistry.initialize, (owner)));
        registry = PlayerRegistry(address(proxy));
        keyA = vm.addr(pkA);
    }

    function _bindAlice() internal {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pkA, registry.bindDigest(alice, keyA));
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.prank(alice);
        registry.bind(keyA, sig);
    }

    // ─────────────────────────── initialization ───────────────────────────

    function test_initialize_setsOwner() public view {
        assertEq(registry.owner(), owner);
    }

    function test_initialize_cannotRunTwice() public {
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        registry.initialize(attacker);
    }

    /// A registry with no owner has no upgrade authority and could never be fixed.
    function test_initialize_rejectsZeroOwner() public {
        PlayerRegistry impl = new PlayerRegistry();
        vm.expectRevert(PlayerRegistry.ZeroOwner.selector);
        new ERC1967Proxy(address(impl), abi.encodeCall(PlayerRegistry.initialize, (address(0))));
    }

    /// The classic UUPS footgun: an uninitialized implementation an attacker can
    /// claim. `_disableInitializers()` in the constructor closes it.
    function test_implementation_cannotBeInitialized() public {
        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        implV1.initialize(attacker);
    }

    // ─────────────────────────── authority ───────────────────────────

    function test_proposeUpgrade_onlyOwner() public {
        address v2 = address(new PlayerRegistryV2());
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", attacker));
        registry.proposeUpgrade(v2, "");
    }

    function test_upgrade_revertsForNonOwner() public {
        address v2 = address(new PlayerRegistryV2());
        vm.prank(owner);
        registry.proposeUpgrade(v2, "");
        skip(registry.UPGRADE_DELAY());

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", attacker));
        registry.upgradeToAndCall(v2, "");
    }

    function test_proposeUpgrade_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(PlayerRegistry.ZeroImplementation.selector);
        registry.proposeUpgrade(address(0), "");
    }

    // ─────────────────────────── timelock ───────────────────────────

    function test_upgrade_revertsBeforeDelayElapses() public {
        address v2 = address(new PlayerRegistryV2());
        vm.startPrank(owner);
        registry.proposeUpgrade(v2, "");

        skip(registry.UPGRADE_DELAY() - 1);
        vm.expectRevert(PlayerRegistry.UpgradeNotReady.selector);
        registry.upgradeToAndCall(v2, "");
        vm.stopPrank();
    }

    /// Owning the key is not enough — this is the whole point of the timelock.
    function test_upgrade_revertsForUnproposedImplementation() public {
        address v2 = address(new PlayerRegistryV2());
        address rogue = address(new MaliciousRegistry());

        vm.startPrank(owner);
        registry.proposeUpgrade(v2, "");
        skip(registry.UPGRADE_DELAY());

        // Delay elapsed, but for a *different* implementation.
        vm.expectRevert(PlayerRegistry.UpgradeNotProposed.selector);
        registry.upgradeToAndCall(rogue, "");
        vm.stopPrank();
    }

    /// A stolen owner key cannot swap the implementation in the same transaction.
    function test_maliciousUpgrade_cannotBeInstant() public {
        address rogue = address(new MaliciousRegistry());
        vm.startPrank(owner);

        vm.expectRevert(PlayerRegistry.UpgradeNotProposed.selector);
        registry.upgradeToAndCall(rogue, "");

        // Proposing is public and observable, and still cannot execute now.
        registry.proposeUpgrade(rogue, "");
        vm.expectRevert(PlayerRegistry.UpgradeNotReady.selector);
        registry.upgradeToAndCall(rogue, "");
        vm.stopPrank();
    }

    function test_proposeUpgrade_emitsWithEtaAndCodehash() public {
        address v2 = address(new PlayerRegistryV2());
        uint64 expected = uint64(block.timestamp) + registry.UPGRADE_DELAY();

        vm.expectEmit(true, false, false, true);
        emit UpgradeProposed(v2, v2.codehash, keccak256(""), expected);
        vm.prank(owner);
        registry.proposeUpgrade(v2, "");

        assertEq(registry.pendingImplementation(), v2);
        assertEq(registry.upgradeEta(), expected);
        assertEq(registry.pendingCodehash(), v2.codehash);
    }

    /// Idle and armed must never share a return value — a watcher polling for 0
    /// would otherwise read the most dangerous state as the safe one.
    function test_upgradeReadyIn_distinguishesIdleFromArmed() public {
        assertEq(registry.upgradeReadyIn(), type(uint64).max, "idle must not read as 0");

        address v2 = address(new PlayerRegistryV2());
        vm.prank(owner);
        registry.proposeUpgrade(v2, "");
        assertEq(registry.upgradeReadyIn(), registry.UPGRADE_DELAY());

        skip(1 hours);
        assertEq(registry.upgradeReadyIn(), registry.UPGRADE_DELAY() - 1 hours);

        skip(registry.UPGRADE_DELAY());
        assertEq(registry.upgradeReadyIn(), 0, "armed must read as 0");
    }

    function test_pendingUpgrade_reportsArmedState() public {
        (address i0,, uint64 e0, bool armed0) = registry.pendingUpgrade();
        assertEq(i0, address(0));
        assertEq(e0, 0);
        assertFalse(armed0);

        address v2 = address(new PlayerRegistryV2());
        vm.prank(owner);
        registry.proposeUpgrade(v2, "");

        (address i1, bytes32 c1,, bool armed1) = registry.pendingUpgrade();
        assertEq(i1, v2);
        assertEq(c1, v2.codehash);
        assertFalse(armed1, "not armed before the delay");

        skip(registry.UPGRADE_DELAY());
        (,,, bool armed2) = registry.pendingUpgrade();
        assertTrue(armed2, "armed after the delay");

        skip(registry.UPGRADE_GRACE() + 1);
        (,,, bool armed3) = registry.pendingUpgrade();
        assertFalse(armed3, "no longer armed past the grace window");
    }

    function test_cancelUpgrade_clearsPending() public {
        address v2 = address(new PlayerRegistryV2());
        vm.startPrank(owner);
        registry.proposeUpgrade(v2, "");

        vm.expectEmit(true, false, false, false);
        emit UpgradeCancelled(v2);
        registry.cancelUpgrade();
        vm.stopPrank();

        assertEq(registry.pendingImplementation(), address(0));
        assertEq(registry.upgradeEta(), 0);

        skip(registry.UPGRADE_DELAY());
        vm.prank(owner);
        vm.expectRevert(PlayerRegistry.UpgradeNotProposed.selector);
        registry.upgradeToAndCall(v2, "");
    }

    // ─────────────────────────── the happy path ───────────────────────────

    function test_upgrade_succeedsAfterDelayAndPreservesStorage() public {
        _bindAlice();
        uint64 boundAt = registry.updatedAt(alice);
        assertTrue(registry.isBound(alice, keyA));

        address v2 = address(new PlayerRegistryV2());
        vm.startPrank(owner);
        registry.proposeUpgrade(v2, "");
        skip(registry.UPGRADE_DELAY());
        registry.upgradeToAndCall(v2, "");
        vm.stopPrank();

        // New behaviour is live...
        assertTrue(PlayerRegistryV2(address(registry)).isUpgraded());
        assertEq(PlayerRegistryV2(address(registry)).VERSION(), "2");

        // ...and every binding survived the storage layout.
        assertEq(registry.sessionKeyOf(alice), keyA);
        assertEq(registry.updatedAt(alice), boundAt);
        assertTrue(registry.isBound(alice, keyA));
        assertEq(registry.owner(), owner);
    }

    /// The pending slot must be consumed, so one proposal buys exactly one upgrade.
    function test_upgrade_consumesTheProposal() public {
        address v2 = address(new PlayerRegistryV2());
        vm.startPrank(owner);
        registry.proposeUpgrade(v2, "");
        skip(registry.UPGRADE_DELAY());
        registry.upgradeToAndCall(v2, "");

        assertEq(registry.pendingImplementation(), address(0));
        assertEq(registry.upgradeEta(), 0);

        // Replaying the same upgrade requires a fresh proposal and a fresh delay.
        vm.expectRevert(PlayerRegistry.UpgradeNotProposed.selector);
        registry.upgradeToAndCall(v2, "");
        vm.stopPrank();
    }

    function test_bindingStillWorksAfterUpgrade() public {
        address v2 = address(new PlayerRegistryV2());
        vm.startPrank(owner);
        registry.proposeUpgrade(v2, "");
        skip(registry.UPGRADE_DELAY());
        registry.upgradeToAndCall(v2, "");
        vm.stopPrank();

        _bindAlice();
        assertTrue(registry.isBound(alice, keyA));
    }

    // ────────────────── hardening added after the audit ──────────────────

    /// The delay must elapse over BYTECODE, not over 20 bytes of address. A
    /// CREATE2 target can otherwise be proposed empty, "reviewed" by nobody for
    /// two days, and filled at the moment of execution.
    function test_proposeUpgrade_rejectsAddressWithNoCode() public {
        vm.prank(owner);
        vm.expectRevert(PlayerRegistry.ImplementationHasNoCode.selector);
        registry.proposeUpgrade(address(0xDEADBEEF), "");
    }

    /// Pinning the address is not enough — the bytecode at that address must be
    /// the bytecode that was reviewed. This is what closes the CREATE2 path
    /// where a proposal matures over an address whose code arrives at the end.
    function test_upgrade_revertsIfCodeChangedAfterProposal() public {
        address v2 = address(new PlayerRegistryV2());
        vm.startPrank(owner);
        registry.proposeUpgrade(v2, "");
        skip(registry.UPGRADE_DELAY());
        vm.stopPrank();

        // Substitute different bytecode at the reviewed address.
        vm.etch(v2, address(new MaliciousRegistry()).code);

        vm.prank(owner);
        vm.expectRevert(PlayerRegistry.CodehashChanged.selector);
        registry.upgradeToAndCall(v2, "");
    }

    /// An expired proposal is no more executable than no proposal at all, so it
    /// must not keep reading as armed — otherwise a monitor is stuck on "hot"
    /// forever, which is the alert fatigue the timelock cannot survive.
    function test_upgradeReadyIn_reportsIdleOnceExpired() public {
        address v2 = address(new PlayerRegistryV2());
        vm.prank(owner);
        registry.proposeUpgrade(v2, "");

        skip(registry.UPGRADE_DELAY());
        assertEq(registry.upgradeReadyIn(), 0, "armed");

        skip(registry.UPGRADE_GRACE() + 1);
        assertEq(registry.upgradeReadyIn(), type(uint64).max, "expired must not read as armed");
    }

    /// A matured proposal must not stay armed forever — otherwise it is a
    /// standing zero-delay upgrade whose only public warning is long stale.
    function test_upgrade_revertsAfterGraceWindow() public {
        address v2 = address(new PlayerRegistryV2());
        vm.startPrank(owner);
        registry.proposeUpgrade(v2, "");
        skip(registry.UPGRADE_DELAY() + registry.UPGRADE_GRACE() + 1);

        vm.expectRevert(PlayerRegistry.UpgradeExpired.selector);
        registry.upgradeToAndCall(v2, "");
        vm.stopPrank();
    }

    /// The payload is delegatecalled with msg.sender preserved, so it must be
    /// pinned by the proposal — otherwise an owner-privileged call rides along
    /// having never appeared in UpgradeProposed.
    function test_upgrade_rejectsUnproposedPayload() public {
        address v2 = address(new PlayerRegistryV2());
        vm.startPrank(owner);
        registry.proposeUpgrade(v2, ""); // committed to an EMPTY payload
        skip(registry.UPGRADE_DELAY());

        vm.expectRevert(PlayerRegistry.UpgradePayloadMismatch.selector);
        registry.upgradeToAndCall(v2, abi.encodeCall(PlayerRegistryV2.bump, ()));
        vm.stopPrank();
    }

    /// ...but a payload that WAS proposed executes atomically with the upgrade,
    /// so a future implementation can still migrate its own storage in one
    /// transaction rather than a front-runnable second one.
    function test_upgrade_acceptsTheProposedPayload() public {
        address v2 = address(new PlayerRegistryV2());
        bytes memory migration = abi.encodeCall(PlayerRegistryV2.bump, ());

        vm.startPrank(owner);
        registry.proposeUpgrade(v2, migration);
        skip(registry.UPGRADE_DELAY());
        registry.upgradeToAndCall(v2, migration);
        vm.stopPrank();

        assertTrue(PlayerRegistryV2(address(registry)).isUpgraded());
        assertEq(PlayerRegistryV2(address(registry)).migrated(), 1, "payload did not run");
    }

    /// A pending proposal must not survive a handover — otherwise an outgoing
    /// owner arms it, waits out the delay, and the incoming owner inherits an
    /// instant upgrade.
    function test_ownershipTransferCancelsPendingUpgrade() public {
        address v2 = address(new PlayerRegistryV2());
        address newOwner = address(0xBEEF);

        vm.startPrank(owner);
        registry.proposeUpgrade(v2, "");
        registry.transferOwnership(newOwner);
        vm.stopPrank();

        vm.prank(newOwner);
        registry.acceptOwnership();

        assertEq(registry.pendingImplementation(), address(0), "proposal survived the handover");
        skip(registry.UPGRADE_DELAY());
        vm.prank(newOwner);
        vm.expectRevert(PlayerRegistry.UpgradeNotProposed.selector);
        registry.upgradeToAndCall(v2, "");
    }

    /// Renouncing would permanently destroy the ability to patch the sole
    /// authentication authority — strictly worse than a timelocked bad upgrade,
    /// which a later upgrade can undo.
    function test_renounceOwnership_isDisabled() public {
        vm.prank(owner);
        vm.expectRevert(PlayerRegistry.RenounceDisabled.selector);
        registry.renounceOwnership();
        assertEq(registry.owner(), owner);
    }

    function test_cancelUpgrade_revertsWhenNothingPending() public {
        vm.prank(owner);
        vm.expectRevert(PlayerRegistry.UpgradeNotProposed.selector);
        registry.cancelUpgrade();
    }

    /// The idle state must not satisfy the timelock guards vacuously.
    function test_upgrade_revertsInIdleStateForZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(PlayerRegistry.UpgradeNotProposed.selector);
        registry.upgradeToAndCall(address(0), "");
    }

    /// Displacing a live proposal must announce the retirement, exactly as
    /// `bind` announces a retired session key.
    function test_proposeUpgrade_announcesDisplacedProposal() public {
        address v2 = address(new PlayerRegistryV2());
        address other = address(new MaliciousRegistry());

        vm.startPrank(owner);
        registry.proposeUpgrade(v2, "");

        vm.expectEmit(true, false, false, false);
        emit UpgradeCancelled(v2);
        registry.proposeUpgrade(other, "");
        vm.stopPrank();
    }

    // ─────────────────────────── ownership ───────────────────────────

    function test_ownershipTransferIsTwoStep() public {
        address newOwner = address(0xBEEF);

        vm.prank(owner);
        registry.transferOwnership(newOwner);
        // Not yet — a typo'd address cannot take the seat by itself.
        assertEq(registry.owner(), owner);
        assertEq(registry.pendingOwner(), newOwner);

        vm.prank(newOwner);
        registry.acceptOwnership();
        assertEq(registry.owner(), newOwner);

        // And the old owner has lost upgrade authority.
        address v2 = address(new PlayerRegistryV2());
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", owner));
        registry.proposeUpgrade(v2, "");
    }
}
