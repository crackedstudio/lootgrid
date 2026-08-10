// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PlayerRegistry
 * @notice Binds a player's wallet to a locally-generated session key.
 *
 * MiniPay cannot sign messages, which rules out SIWE and every other
 * challenge/response scheme. Instead a player generates a keypair on their
 * device, binds its address here with one cheap transaction (gas payable in a
 * stablecoin via feeCurrency), and from then on signs API requests with that
 * key — no wallet interaction at all.
 *
 * Holds no funds. Has no owner, no upgrade path and no admin functions, so
 * there is nothing here to compromise: the worst an attacker with a player's
 * wallet can do is rebind that player's own session key, which is the same
 * authority they already had.
 */
contract PlayerRegistry {
    /// @notice player wallet => bound session key address
    mapping(address => address) public sessionKeyOf;
    /// @notice timestamp of the last bind or clear, for auditing
    mapping(address => uint64) public updatedAt;

    event SessionKeyBound(address indexed player, address indexed sessionKey, uint64 at);
    event SessionKeyCleared(address indexed player, uint64 at);

    error ZeroKey();
    error SelfKey();

    /**
     * @notice Bind (or rotate) the caller's session key.
     * @dev Rebinding replaces the previous key, which is also the
     *      "log out of my other devices" action.
     */
    function bind(address sessionKey) external {
        if (sessionKey == address(0)) revert ZeroKey();
        // A session key equal to the wallet would defeat the point: the whole
        // design assumes the session key is a *separate*, lower-value secret
        // that lives in browser storage.
        if (sessionKey == msg.sender) revert SelfKey();

        sessionKeyOf[msg.sender] = sessionKey;
        updatedAt[msg.sender] = uint64(block.timestamp);
        emit SessionKeyBound(msg.sender, sessionKey, uint64(block.timestamp));
    }

    /// @notice Revoke the caller's session key.
    function clear() external {
        delete sessionKeyOf[msg.sender];
        updatedAt[msg.sender] = uint64(block.timestamp);
        emit SessionKeyCleared(msg.sender, uint64(block.timestamp));
    }

    /// @notice Single call the game server uses to authenticate a request.
    function isBound(address player, address sessionKey) external view returns (bool) {
        return sessionKey != address(0) && sessionKeyOf[player] == sessionKey;
    }
}
