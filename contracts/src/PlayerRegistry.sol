// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    Ownable2StepUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

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
 * The *session key* signs the binding, not the wallet, so the MiniPay
 * limitation is untouched: the wallet still only ever sends a transaction.
 *
 * ─────────────────────────── UPGRADE AUTHORITY ───────────────────────────
 *
 * This contract is UUPS-upgradeable, which makes `owner` the highest-value key
 * in the system. It holds no funds — but it holds *authentication authority*,
 * and an implementation where `isBound` returns true unconditionally is
 * impersonation of every player at once. That is a strictly larger blast radius
 * than the escrow's signer key, which can only ever move escrowed prizes.
 *
 * Two mitigations, and they are the reason upgradeability is tolerable here:
 *
 *   1. Upgrades are timelocked by {UPGRADE_DELAY}. An upgrade must be proposed,
 *      is publicly visible via {UpgradeProposed}, and cannot execute for two
 *      days. The delay does not let players exit — there is nothing to exit —
 *      but it gives the operator and any watcher time to *notice* and stop
 *      trusting the registry.
 *   2. Ownership transfer is two-step, so the seat cannot be handed to a typo.
 *
 * `owner` MUST be a multisig in production. A single EOA holding instant-propose
 * rights over every player's identity is not an acceptable configuration.
 */
contract PlayerRegistry is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    // ─────────────────────────── storage ───────────────────────────
    // Append-only. Never reorder or remove — the proxy reads by slot.

    // slot 0
    /// @notice player wallet => bound session key address
    mapping(address => address) public sessionKeyOf;
    // slot 1
    /// @notice timestamp of the last bind or clear, for auditing
    mapping(address => uint64) public updatedAt;
    // slot 2 (packed: 20 + 8 bytes)
    /// @notice Implementation awaiting the timelock, or zero.
    address public pendingImplementation;
    /// @notice Earliest timestamp at which {pendingImplementation} may execute.
    uint64 public upgradeEta;

    // ── appended after the original layout; never inserted above ──
    // slot 3
    /// @notice Reverse index: session key => the one player it authenticates.
    /// @dev Possession alone proves a key *consented* to a binding, not that it
    ///      is exclusive to it — a key holder can sign for any number of wallets.
    ///      This mapping is what actually enforces one-key-one-player.
    mapping(address => address) public playerOfKey;
    // slot 4
    /// @notice Codehash of {pendingImplementation} captured at proposal time.
    /// @dev The delay is worthless if it commits to an address whose bytecode
    ///      does not exist yet — a CREATE2 address can be proposed empty,
    ///      reviewed by nobody for two days, then filled at execution.
    bytes32 public pendingCodehash;
    // slot 5
    /// @notice keccak256 of the migration calldata this proposal authorises.
    /// @dev Pinned rather than banned. Banning non-empty payloads would close the
    ///      unannounced-delegatecall hole but also remove the only way to run a
    ///      new implementation's state migration atomically with the upgrade,
    ///      turning every future migration into a front-runnable second
    ///      transaction. Committing to the hash keeps atomicity AND keeps the
    ///      executed payload identical to the reviewed one.
    bytes32 public pendingPayloadHash;

    /// @dev Room for future variables. Shrink this when appending, never insert
    ///      above — the proxy reads by slot, so an inserted variable silently
    ///      shifts every mapping below it.
    uint256[44] private __gap;

    // ─────────────────────────── constants ───────────────────────────

    uint64 public constant UPGRADE_DELAY = 48 hours;
    /// @notice Window after {UPGRADE_DELAY} in which a proposal may still execute.
    /// @dev Without an upper bound a matured proposal is a permanently armed
    ///      zero-delay upgrade, and the single `UpgradeProposed` alert that the
    ///      whole mitigation depends on can be arbitrarily stale by the time it
    ///      fires. Expiry forces a fresh proposal and therefore a fresh alert.
    uint64 public constant UPGRADE_GRACE = 7 days;

    /// @dev Domain separator for the possession proof. Includes the chain id and
    ///      this contract's address so a signature cannot be replayed onto
    ///      another deployment, and the player so it cannot be replayed by a
    ///      different wallet. Under a proxy, `address(this)` is the proxy — the
    ///      stable identity — which is what clients should be signing against.
    bytes32 private constant BIND_TYPEHASH =
        keccak256("LootGridBindSessionKey(address player,address sessionKey)");

    // ─────────────────────────── events ───────────────────────────

    event SessionKeyBound(address indexed player, address indexed sessionKey, uint64 at);
    /// @dev The retired key is indexed so a log consumer filtering on a specific
    ///      session key sees its revocation, not just its creation.
    event SessionKeyCleared(address indexed player, address indexed sessionKey, uint64 at);
    event UpgradeProposed(address indexed implementation, bytes32 codehash, bytes32 payloadHash, uint64 eta);
    event UpgradeCancelled(address indexed implementation);

    // ─────────────────────────── errors ───────────────────────────

    error ZeroKey();
    error SelfKey();
    error NotBound();
    error BadSignature();
    error NotKeyOwner();
    error KeyAlreadyBound();
    error ZeroOwner();
    error ZeroImplementation();
    error ImplementationHasNoCode();
    error UpgradeNotProposed();
    error UpgradeNotReady();
    error UpgradeExpired();
    error CodehashChanged();
    error RenounceDisabled();
    error UpgradePayloadMismatch();

    // ─────────────────────────── init ───────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Locks the implementation contract itself. Without this an attacker can
        // initialize the bare implementation and — combined with a UUPS
        // `upgradeToAndCall` on that instance — brick or hijack the proxy.
        _disableInitializers();
    }

    function initialize(address initialOwner) external initializer {
        if (initialOwner == address(0)) revert ZeroOwner();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        // UUPSUpgradeable has no initializer in OZ 5.x — it holds no storage.
    }

    // ─────────────────────────── bindings ───────────────────────────

    /// @notice The exact digest a session key must sign to be bindable.
    /// @dev Exposed so clients compute it from the contract rather than
    ///      reimplementing the encoding and drifting.
    function bindDigest(address player, address sessionKey) public view returns (bytes32) {
        bytes32 inner = keccak256(abi.encode(BIND_TYPEHASH, block.chainid, address(this), player, sessionKey));
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
    }

    /**
     * @notice Bind (or rotate) the caller's session key.
     * @param sessionKey The address to bind.
     * @param sig An EIP-191 signature by `sessionKey` over `bindDigest(msg.sender, sessionKey)`.
     * @dev `sig` is what makes this a proof rather than a claim. Without it any
     *      wallet could name any address — including a key already bound to
     *      someone else — so one key could authenticate several accounts.
     */
    function bind(address sessionKey, bytes calldata sig) external {
        if (sessionKey == address(0)) revert ZeroKey();
        // A session key equal to the wallet would defeat the point: the whole
        // design assumes the session key is a *separate*, lower-value secret
        // that lives in browser storage.
        if (sessionKey == msg.sender) revert SelfKey();

        // Possession proves the key agreed to THIS binding; it does not prove the
        // key is exclusive to it, because the holder can sign for any number of
        // wallets. The reverse index is what makes one-key-one-player true.
        address claimedBy = playerOfKey[sessionKey];
        if (claimedBy != address(0) && claimedBy != msg.sender) revert KeyAlreadyBound();

        if (_recover(bindDigest(msg.sender, sessionKey), sig) != sessionKey) revert NotKeyOwner();

        address previous = sessionKeyOf[msg.sender];
        if (previous != address(0) && previous != sessionKey) delete playerOfKey[previous];

        sessionKeyOf[msg.sender] = sessionKey;
        playerOfKey[sessionKey] = msg.sender;
        updatedAt[msg.sender] = uint64(block.timestamp);

        // Rotation retires the old key in the same transaction; announce it so a
        // consumer watching that key learns it is dead.
        if (previous != address(0) && previous != sessionKey) {
            emit SessionKeyCleared(msg.sender, previous, uint64(block.timestamp));
        }
        emit SessionKeyBound(msg.sender, sessionKey, uint64(block.timestamp));
    }

    /**
     * @notice Revoke the caller's session key.
     * @dev Reverts when nothing is bound, so an unbound address cannot
     *      manufacture revocation records for keys that never existed.
     */
    function clear() external {
        address previous = sessionKeyOf[msg.sender];
        if (previous == address(0)) revert NotBound();

        delete sessionKeyOf[msg.sender];
        delete playerOfKey[previous];
        updatedAt[msg.sender] = uint64(block.timestamp);
        emit SessionKeyCleared(msg.sender, previous, uint64(block.timestamp));
    }

    /// @notice Single call the game server uses to authenticate a request.
    function isBound(address player, address sessionKey) external view returns (bool) {
        return sessionKey != address(0) && sessionKeyOf[player] == sessionKey;
    }

    /// @notice The binding and when it last changed, in one call.
    /// @dev Lets a caching consumer detect a rotation without a second read.
    function binding(address player) external view returns (address key, uint64 at) {
        return (sessionKeyOf[player], updatedAt[player]);
    }

    // ─────────────────────────── upgrades ───────────────────────────

    /// @notice Start the timelock on a new implementation.
    /// @dev The proposed address must already hold code, and its codehash is
    ///      pinned here. Proposing a bare address would let a CREATE2 target be
    ///      "reviewed" for two days while empty and filled at execution — the
    ///      delay would elapse over 20 bytes of address, never over bytecode.
    /// @param migrationData Calldata to delegatecall into the new implementation
    ///        at execution, or empty. Its hash is pinned now, so the executed
    ///        payload is the reviewed payload.
    function proposeUpgrade(address newImplementation, bytes calldata migrationData) external onlyOwner {
        if (newImplementation == address(0)) revert ZeroImplementation();
        if (newImplementation.code.length == 0) revert ImplementationHasNoCode();

        // Retiring a live proposal is announced, exactly as `bind` announces a
        // retired session key — otherwise a log consumer still believes the
        // displaced implementation is armed.
        address previous = pendingImplementation;
        if (previous != address(0) && previous != newImplementation) {
            emit UpgradeCancelled(previous);
        }

        pendingImplementation = newImplementation;
        pendingCodehash = newImplementation.codehash;
        pendingPayloadHash = keccak256(migrationData);
        upgradeEta = uint64(block.timestamp) + UPGRADE_DELAY;
        emit UpgradeProposed(newImplementation, pendingCodehash, pendingPayloadHash, upgradeEta);
    }

    /// @notice Abandon a pending upgrade.
    /// @dev Reverts when nothing is pending, for the same reason `clear()` does:
    ///      the upgrade log is a security signal, and a no-op must not be able to
    ///      emit `UpgradeCancelled(0x0)` into it.
    function cancelUpgrade() external onlyOwner {
        address previous = pendingImplementation;
        if (previous == address(0)) revert UpgradeNotProposed();

        emit UpgradeCancelled(previous);
        _clearProposal();
    }

    /// @notice Seconds until the pending upgrade may execute.
    /// @return 0 ONLY when a proposal is armed and executable right now;
    ///         `type(uint64).max` when nothing is pending OR the proposal has
    ///         expired past its grace window.
    /// @dev `0` must mean exactly one thing. An expired proposal is no more
    ///      executable than no proposal at all, and reporting it as armed would
    ///      leave a monitor stuck reading "hot" forever — the alert fatigue the
    ///      timelock cannot survive.
    function upgradeReadyIn() external view returns (uint64) {
        if (pendingImplementation == address(0)) return type(uint64).max;
        if (block.timestamp > uint256(upgradeEta) + UPGRADE_GRACE) return type(uint64).max;
        if (block.timestamp >= upgradeEta) return 0;
        return upgradeEta - uint64(block.timestamp);
    }

    /// @notice Everything a monitor needs, in one call.
    function pendingUpgrade() external view returns (address impl, bytes32 codehash, uint64 eta, bool armed) {
        impl = pendingImplementation;
        codehash = pendingCodehash;
        eta = upgradeEta;
        armed =
            impl != address(0) && block.timestamp >= eta && block.timestamp <= uint256(eta) + UPGRADE_GRACE;
    }

    /**
     * @dev Owner alone is not sufficient — the implementation must also have been
     *      proposed, the delay elapsed, the grace window still open, and the
     *      bytecode unchanged since the proposal.
     *
     *      The grace window matters as much as the delay: without an upper bound
     *      a matured-but-unexecuted proposal is a permanently armed zero-delay
     *      upgrade whose only public warning fired arbitrarily long ago.
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        address pending = pendingImplementation;
        // Explicit zero check: without it, the idle state (pending == 0, eta == 0)
        // satisfies both guards below for `newImplementation == address(0)`.
        if (pending == address(0) || newImplementation != pending) revert UpgradeNotProposed();
        if (block.timestamp < upgradeEta) revert UpgradeNotReady();
        if (block.timestamp > uint256(upgradeEta) + UPGRADE_GRACE) revert UpgradeExpired();
        if (newImplementation.codehash != pendingCodehash) revert CodehashChanged();
        _clearProposal();
    }

    function _clearProposal() private {
        delete pendingImplementation;
        delete upgradeEta;
        delete pendingCodehash;
        delete pendingPayloadHash;
    }

    /// @dev A pending upgrade must not survive a change of authority — otherwise
    ///      an outgoing owner can arm a proposal, wait out the delay, hand over
    ///      the seat, and the incoming owner inherits an instant upgrade.
    function _transferOwnership(address newOwner) internal override {
        if (pendingImplementation != address(0)) {
            emit UpgradeCancelled(pendingImplementation);
            _clearProposal();
        }
        super._transferOwnership(newOwner);
    }

    /**
     * @notice Upgrade to a previously proposed implementation.
     * @dev Without this override, only the implementation ADDRESS goes through
     *      the timelock: `data` is chosen at execution time and delegatecalled
     *      with `msg.sender` preserved, so an owner-privileged call could ride
     *      along having never appeared in {UpgradeProposed} — the reviewed
     *      artifact and the executed transaction would not be the same thing.
     *      Pinning the payload hash closes that while still allowing a migration
     *      to run atomically with the upgrade.
     */
    function upgradeToAndCall(address newImplementation, bytes memory data) public payable override {
        // Only meaningful once a proposal exists — otherwise defer to
        // `_authorizeUpgrade`, which reports the more precise UpgradeNotProposed
        // rather than masking it with a payload complaint.
        if (pendingImplementation != address(0) && keccak256(data) != pendingPayloadHash) {
            revert UpgradePayloadMismatch();
        }
        super.upgradeToAndCall(newImplementation, data);
    }

    /// @notice Disabled.
    /// @dev `Ownable` would otherwise let the owner set itself to zero in one
    ///      unannounced call, permanently removing the ability to upgrade — a
    ///      strictly worse outcome than the timelocked malicious upgrade this
    ///      contract spends its header defending against, because that one is at
    ///      least reversible by a later upgrade and this is not.
    function renounceOwnership() public override onlyOwner {
        revert RenounceDisabled();
    }

    // ─────────────────────────── internal ───────────────────────────

    /// @dev ECDSA recovery with the standard malleability guards.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();

        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);

        // Reject the upper half of the curve order: for every valid signature
        // there is a second one with the same signer, and accepting both would
        // make the proof malleable.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadSignature();
        }
        if (v != 27 && v != 28) revert BadSignature();

        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
