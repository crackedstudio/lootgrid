// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentVault} from "./AgentVault.sol";

/**
 * @title AgentVaultFactory
 * @notice Creates one {AgentVault} per player and remembers where it is.
 *
 * ─────────────────────────── why this exists ───────────────────────────
 *
 * A vault is per player, so somebody has to deploy one, and the alternatives
 * are both bad. The house deploying on a player's behalf makes the house the
 * deployer of a contract holding that player's money, and the player would be
 * trusting a constructor argument they never saw. The player deploying directly
 * means shipping contract bytecode into a wallet webview that deliberately
 * carries no web3 library at all.
 *
 * A factory makes it one ordinary transaction the server can encode and the
 * player signs, exactly like every other on-chain action in this game — and the
 * owner is `msg.sender` rather than anything the server passes, so the house
 * cannot create a vault it controls on someone else's behalf.
 *
 * ─────────────────────────── why it remembers ───────────────────────────
 *
 * `vaultOf` is the lookup the runtime needs before it can spend anything, and
 * having it on chain means the server's own database is never the authority on
 * whose money is where. One vault per player, and re-creating is refused rather
 * than overwriting: a second vault would orphan the balance in the first while
 * every off-chain index quietly pointed at the new one.
 */
contract AgentVaultFactory {
    /// @notice The vault each player owns. Zero if they have none.
    mapping(address => AgentVault) public vaultOf;

    event VaultCreated(address indexed player, address indexed vault, address indexed spender);

    error VaultExists();
    error ZeroToken();

    /**
     * @notice Deploy the caller's vault.
     *
     * The owner is `msg.sender` and cannot be passed in — that is the whole
     * safety property of doing this here rather than letting the house deploy.
     * `AgentVault`'s constructor enforces the rest, including that the spender
     * is not the owner.
     */
    function create(address token, address spender, uint256 perTxCap, uint256 perDayCap)
        external
        returns (AgentVault vault)
    {
        if (token == address(0)) revert ZeroToken();
        // Overwriting would strand the balance in the old vault while every
        // index off chain pointed at the new one. Rotate the spender instead.
        if (address(vaultOf[msg.sender]) != address(0)) revert VaultExists();

        vault = new AgentVault(token, msg.sender, spender, perTxCap, perDayCap);
        vaultOf[msg.sender] = vault;

        emit VaultCreated(msg.sender, address(vault), spender);
    }

    /// @notice Whether a player already has somewhere to put money.
    function hasVault(address player) external view returns (bool) {
        return address(vaultOf[player]) != address(0);
    }
}
