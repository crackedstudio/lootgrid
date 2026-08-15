// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PlayerRegistry} from "../../src/PlayerRegistry.sol";

/// @notice Minimal V2 used only to prove upgrades work and preserve storage.
/// @dev Appends a variable AFTER the inherited layout, consuming one gap slot.
contract PlayerRegistryV2 is PlayerRegistry {
    string public constant VERSION = "2";

    /// @dev A REAL storage variable, appended after the parent layout, so the
    ///      upgrade tests actually exercise slot preservation. A `constant`
    ///      occupies no storage and would prove nothing.
    uint256 public migrated;

    function isUpgraded() external pure returns (bool) {
        return true;
    }

    /// @dev Stand-in for a state migration a new implementation would run
    ///      atomically with its own upgrade.
    function bump() external {
        migrated += 1;
    }
}

/// @notice A hostile implementation — the thing the timelock exists to make visible.
/// @dev Authenticates everyone against everything. Used to assert that reaching
///      it requires both ownership AND the elapsed delay.
contract MaliciousRegistry is PlayerRegistry {
    function isBoundAlways(address, address) external pure returns (bool) {
        return true;
    }
}
