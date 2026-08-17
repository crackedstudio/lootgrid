// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PlayerRegistry} from "../src/PlayerRegistry.sol";

contract PlayerRegistryTest is Test {
    PlayerRegistry registry;

    address owner = address(0xB055);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    // Session keys are real keypairs now — the contract requires the key itself
    // to sign, so the tests must hold private keys rather than bare addresses.
    uint256 pkA = 0xA1;
    uint256 pkB = 0xB2;
    address keyA;
    address keyB;

    event SessionKeyBound(address indexed player, address indexed sessionKey, uint64 at);
    event SessionKeyCleared(address indexed player, address indexed sessionKey, uint64 at);

    function setUp() public {
        // Behaviour is exercised through the proxy, because that is what players
        // and the server actually call. `address(this)` inside bindDigest is the
        // proxy address, so signatures are bound to the stable identity.
        PlayerRegistry impl = new PlayerRegistry();
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(impl), abi.encodeCall(PlayerRegistry.initialize, (owner)));
        registry = PlayerRegistry(address(proxy));

        keyA = vm.addr(pkA);
        keyB = vm.addr(pkB);
    }

    /// @dev Produces the possession proof a real client would produce.
    function _sign(uint256 pk, address player, address sessionKey) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, registry.bindDigest(player, sessionKey));
        return abi.encodePacked(r, s, v);
    }

    /// @dev The signature MUST be built before any prank/expectRevert. `_sign`
    ///      calls `registry.bindDigest`, and Solidity evaluates arguments before
    ///      the call — so an inline `_sign(...)` would consume the cheatcode.
    function _bind(address player, uint256 pk, address sessionKey) internal {
        bytes memory sig = _sign(pk, player, sessionKey);
        vm.prank(player);
        registry.bind(sessionKey, sig);
    }

    // ─────────────────────────── binding ───────────────────────────

    function test_bind_setsKeyAndTimestamp() public {
        vm.warp(1_700_000_000);
        _bind(alice, pkA, keyA);

        assertEq(registry.sessionKeyOf(alice), keyA);
        assertEq(registry.updatedAt(alice), 1_700_000_000);
        assertTrue(registry.isBound(alice, keyA));
    }

    function test_bind_emitsEvent() public {
        vm.warp(42);
        vm.expectEmit(true, true, false, true);
        emit SessionKeyBound(alice, keyA, 42);
        _bind(alice, pkA, keyA);
    }

    function test_rebind_replacesPreviousKey() public {
        _bind(alice, pkA, keyA);
        _bind(alice, pkB, keyB);

        assertEq(registry.sessionKeyOf(alice), keyB);
        // The old key must stop working — this is the "log out everywhere" path.
        assertFalse(registry.isBound(alice, keyA));
        assertTrue(registry.isBound(alice, keyB));
    }

    function test_rebind_announcesTheRetiredKey() public {
        _bind(alice, pkA, keyA);
        vm.warp(99);
        // A consumer filtering logs on keyA must learn that it died.
        vm.expectEmit(true, true, false, true);
        emit SessionKeyCleared(alice, keyA, 99);
        _bind(alice, pkB, keyB);
    }

    function test_binding_returnsKeyAndTimestamp() public {
        vm.warp(1234);
        _bind(alice, pkA, keyA);
        (address key, uint64 at) = registry.binding(alice);
        assertEq(key, keyA);
        assertEq(at, 1234);
    }

    // ─────────────────────── proof of possession ───────────────────────

    /// You cannot bind a key you do not control.
    function test_bind_revertsWithoutPossessionOfTheKey() public {
        // keyA is unclaimed, so the reverse index does not fire — this isolates
        // the possession check.
        bytes memory wrongSig = _sign(pkB, bob, keyA); // signed by the wrong key
        vm.prank(bob);
        vm.expectRevert(PlayerRegistry.NotKeyOwner.selector);
        registry.bind(keyA, wrongSig);
    }

    /// Possession proves the key CONSENTED to a binding, not that it is
    /// exclusive to one — the holder can sign a valid digest per wallet. The
    /// reverse index is what makes one-key-one-player actually true.
    function test_bind_revertsWhenKeyIsAlreadyBoundElsewhere() public {
        _bind(alice, pkA, keyA);

        // Bob has a genuine signature from keyA for his own wallet.
        bytes memory validSigForBob = _sign(pkA, bob, keyA);
        vm.prank(bob);
        vm.expectRevert(PlayerRegistry.KeyAlreadyBound.selector);
        registry.bind(keyA, validSigForBob);

        assertTrue(registry.isBound(alice, keyA));
        assertFalse(registry.isBound(bob, keyA));
    }

    function test_playerOfKey_tracksTheOwner() public {
        _bind(alice, pkA, keyA);
        assertEq(registry.playerOfKey(keyA), alice);
    }

    /// Rotation releases the old key so somebody else may claim it.
    function test_rotation_releasesThePreviousKey() public {
        _bind(alice, pkA, keyA);
        _bind(alice, pkB, keyB);
        assertEq(registry.playerOfKey(keyA), address(0), "old key still claimed");

        _bind(bob, pkA, keyA);
        assertTrue(registry.isBound(bob, keyA));
    }

    /// So does clearing.
    function test_clear_releasesTheKey() public {
        _bind(alice, pkA, keyA);
        vm.prank(alice);
        registry.clear();
        assertEq(registry.playerOfKey(keyA), address(0));

        _bind(bob, pkA, keyA);
        assertTrue(registry.isBound(bob, keyA));
    }

    /// Re-binding your own key must not trip the reverse-index guard.
    function test_bind_sameKeyTwiceBySamePlayerIsAllowed() public {
        _bind(alice, pkA, keyA);
        _bind(alice, pkA, keyA);
        assertTrue(registry.isBound(alice, keyA));
        assertEq(registry.playerOfKey(keyA), alice);
    }

    /// A signature for one player must not work for another.
    function test_bind_revertsOnSignatureBoundToAnotherPlayer() public {
        bytes memory sigForAlice = _sign(pkA, alice, keyA);
        vm.prank(bob);
        vm.expectRevert(PlayerRegistry.NotKeyOwner.selector);
        registry.bind(keyA, sigForAlice);
    }

    /// A signature for one key must not work for another.
    function test_bind_revertsOnSignatureBoundToAnotherKey() public {
        bytes memory sigForKeyB = _sign(pkA, alice, keyB);
        vm.prank(alice);
        vm.expectRevert(PlayerRegistry.NotKeyOwner.selector);
        registry.bind(keyA, sigForKeyB);
    }

    function test_bind_revertsOnMalformedSignature() public {
        vm.prank(alice);
        vm.expectRevert(PlayerRegistry.BadSignature.selector);
        registry.bind(keyA, hex"deadbeef");
    }

    function test_bind_revertsOnMalleableSignature() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pkA, registry.bindDigest(alice, keyA));
        // Flip to the equivalent upper-half-order signature.
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 sFlipped = bytes32(n - uint256(s));
        uint8 vFlipped = v == 27 ? 28 : 27;

        vm.prank(alice);
        vm.expectRevert(PlayerRegistry.BadSignature.selector);
        registry.bind(keyA, abi.encodePacked(r, sFlipped, vFlipped));
    }

    function test_bind_revertsOnInvalidV() public {
        (, bytes32 r, bytes32 s) = vm.sign(pkA, registry.bindDigest(alice, keyA));
        vm.prank(alice);
        vm.expectRevert(PlayerRegistry.BadSignature.selector);
        registry.bind(keyA, abi.encodePacked(r, s, uint8(29)));
    }

    /// ecrecover returns the zero address for a signature it cannot resolve;
    /// that must be rejected rather than compared against a stored key.
    function test_bind_revertsWhenRecoveryYieldsZero() public {
        vm.prank(alice);
        vm.expectRevert(PlayerRegistry.BadSignature.selector);
        registry.bind(keyA, abi.encodePacked(bytes32(0), bytes32(uint256(1)), uint8(27)));
    }

    function test_bind_revertsOnZeroKey() public {
        bytes memory sig = _sign(pkA, alice, address(0));
        vm.prank(alice);
        vm.expectRevert(PlayerRegistry.ZeroKey.selector);
        registry.bind(address(0), sig);
    }

    function test_bind_revertsWhenKeyEqualsWallet() public {
        bytes memory sig = _sign(pkA, alice, alice);
        vm.prank(alice);
        vm.expectRevert(PlayerRegistry.SelfKey.selector);
        registry.bind(alice, sig);
    }

    // ─────────────────────────── clearing ───────────────────────────

    function test_clear_revokes() public {
        _bind(alice, pkA, keyA);
        vm.prank(alice);
        registry.clear();

        assertEq(registry.sessionKeyOf(alice), address(0));
        assertFalse(registry.isBound(alice, keyA));
    }

    function test_clear_emitsTheRetiredKey() public {
        _bind(alice, pkA, keyA);
        vm.warp(555);
        vm.expectEmit(true, true, false, true);
        emit SessionKeyCleared(alice, keyA, 555);
        vm.prank(alice);
        registry.clear();
    }

    /// No phantom revocations: an unbound account cannot manufacture an audit record.
    function test_clear_revertsWhenNothingBound() public {
        vm.prank(alice);
        vm.expectRevert(PlayerRegistry.NotBound.selector);
        registry.clear();
    }

    function test_clear_revertsOnSecondCall() public {
        _bind(alice, pkA, keyA);
        vm.startPrank(alice);
        registry.clear();
        vm.expectRevert(PlayerRegistry.NotBound.selector);
        registry.clear();
        vm.stopPrank();
    }

    // ─────────────────────────── isBound ───────────────────────────

    function test_isBound_falseForUnboundPlayer() public view {
        assertFalse(registry.isBound(bob, keyA));
    }

    /// A zero session key must never authenticate, even against an unbound
    /// player whose stored value is also zero.
    function test_isBound_falseForZeroKey() public {
        _bind(alice, pkA, keyA);
        assertFalse(registry.isBound(alice, address(0)));
        assertFalse(registry.isBound(bob, address(0)));
    }

    function test_bindingsAreIndependentPerPlayer() public {
        _bind(alice, pkA, keyA);
        _bind(bob, pkB, keyB);

        assertTrue(registry.isBound(alice, keyA));
        assertTrue(registry.isBound(bob, keyB));
        assertFalse(registry.isBound(bob, keyA));
        assertFalse(registry.isBound(alice, keyB));
    }

    // ─────────────────────────── fuzz ───────────────────────────

    function testFuzz_bindThenIsBound(address player, uint256 pk) public {
        pk = bound(pk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        address key = vm.addr(pk);
        vm.assume(player != key);
        vm.assume(player != address(0));

        bytes memory sig = _sign(pk, player, key);
        vm.prank(player);
        registry.bind(key, sig);
        assertTrue(registry.isBound(player, key));
    }

    /// No matter who signs, a key can only ever be bound by a caller that holds it.
    function testFuzz_cannotBindKeyYouDoNotHold(uint256 pkOwner, uint256 pkOther) public {
        uint256 max = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140;
        pkOwner = bound(pkOwner, 1, max);
        pkOther = bound(pkOther, 1, max);
        vm.assume(pkOwner != pkOther);

        address key = vm.addr(pkOwner);
        vm.assume(alice != key);

        bytes memory sig = _sign(pkOther, alice, key);
        vm.prank(alice);
        vm.expectRevert(PlayerRegistry.NotKeyOwner.selector);
        registry.bind(key, sig);
    }
}
