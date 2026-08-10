// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlayerRegistry} from "../src/PlayerRegistry.sol";

contract PlayerRegistryTest is Test {
    PlayerRegistry registry;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address keyA = address(0xCAFE1);
    address keyB = address(0xCAFE2);

    event SessionKeyBound(address indexed player, address indexed sessionKey, uint64 at);
    event SessionKeyCleared(address indexed player, uint64 at);

    function setUp() public {
        registry = new PlayerRegistry();
    }

    function test_bind_setsKeyAndTimestamp() public {
        vm.warp(1_700_000_000);
        vm.prank(alice);
        registry.bind(keyA);

        assertEq(registry.sessionKeyOf(alice), keyA);
        assertEq(registry.updatedAt(alice), 1_700_000_000);
        assertTrue(registry.isBound(alice, keyA));
    }

    function test_bind_emitsEvent() public {
        vm.warp(42);
        vm.expectEmit(true, true, false, true);
        emit SessionKeyBound(alice, keyA, 42);
        vm.prank(alice);
        registry.bind(keyA);
    }

    function test_rebind_replacesPreviousKey() public {
        vm.startPrank(alice);
        registry.bind(keyA);
        registry.bind(keyB);
        vm.stopPrank();

        assertEq(registry.sessionKeyOf(alice), keyB);
        // The old key must stop working — this is the "log out everywhere" path.
        assertFalse(registry.isBound(alice, keyA));
        assertTrue(registry.isBound(alice, keyB));
    }

    function test_clear_revokes() public {
        vm.startPrank(alice);
        registry.bind(keyA);
        registry.clear();
        vm.stopPrank();

        assertEq(registry.sessionKeyOf(alice), address(0));
        assertFalse(registry.isBound(alice, keyA));
    }

    function test_bind_revertsOnZeroKey() public {
        vm.prank(alice);
        vm.expectRevert(PlayerRegistry.ZeroKey.selector);
        registry.bind(address(0));
    }

    function test_bind_revertsWhenKeyEqualsWallet() public {
        vm.prank(alice);
        vm.expectRevert(PlayerRegistry.SelfKey.selector);
        registry.bind(alice);
    }

    function test_isBound_falseForUnboundPlayer() public view {
        assertFalse(registry.isBound(bob, keyA));
    }

    /// A zero session key must never authenticate, even against an unbound
    /// player whose stored value is also zero.
    function test_isBound_falseForZeroKey() public {
        vm.prank(alice);
        registry.bind(keyA);
        assertFalse(registry.isBound(alice, address(0)));
        assertFalse(registry.isBound(bob, address(0)));
    }

    function test_bindingsAreIndependentPerPlayer() public {
        vm.prank(alice);
        registry.bind(keyA);
        vm.prank(bob);
        registry.bind(keyB);

        assertTrue(registry.isBound(alice, keyA));
        assertTrue(registry.isBound(bob, keyB));
        // Alice's key must not authenticate Bob.
        assertFalse(registry.isBound(bob, keyA));
        assertFalse(registry.isBound(alice, keyB));
    }

    function testFuzz_bindThenIsBound(address player, address key) public {
        vm.assume(key != address(0));
        vm.assume(player != key);

        vm.prank(player);
        registry.bind(key);
        assertTrue(registry.isBound(player, key));
    }
}
