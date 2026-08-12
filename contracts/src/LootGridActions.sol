// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title LootGridActions
 * @notice Append-only public record of gameplay: tile reveals, hunt entries and
 *         hunt resolutions.
 *
 * ─────────────────────────── what this is not ───────────────────────────
 *
 * This is NOT the game. It holds no state, decides nothing, and gates nothing.
 * The referee remains authoritative: it owns the hidden grid, runs the clock and
 * elects winners. Gameplay cannot be settled on-chain — Tap Challenge is 14
 * inputs in 6 seconds against ~1s blocks, so block inclusion order would decide
 * races instead of reflexes.
 *
 * What this contract does is make each completed action publicly visible and
 * permanently timestamped, one transaction per action.
 *
 * Reveals are relayed: the player's session key signs the request, the referee
 * validates it, and a relayer submits the record — no wallet prompt, no gas, at
 * the speed the tap loop demands. Hunt entries and wins are instead published by
 * the player, who pays for them in a Celo fee currency; those happen once per
 * hunt rather than fourteen times in six seconds, so a wallet round trip fits.
 *
 * ─────────────────────────── design notes ───────────────────────────
 *
 * **Events, not storage.** A log entry costs ~1-2k gas against ~20k for an
 * SSTORE, and the server already holds the authoritative copy. Storing state
 * here would be paying 10-20x to duplicate a database.
 *
 * **Two ways in, one trust boundary.** Reveals arrive from the relayer, which is
 * trusted by address: verifying the referee's own attestation on those would
 * cost gas and prove nothing extra, since the referee controls the hidden grid
 * and could fabricate reveals whether or not a signature is checked.
 *
 * Hunt entries and resolutions may instead be submitted by *anyone* — normally
 * the player, paying their own gas — by presenting an EIP-712 attestation signed
 * by the referee's `attestor` key. Here the signature check is load-bearing
 * rather than ceremonial: with no trusted `msg.sender` to lean on, it is the
 * only thing stopping a player from declaring themselves winner of every hunt.
 *
 * Either way the trust boundary is the referee, exactly as it already was. Do
 * not read these logs as proof the game was played fairly; read them as the
 * referee's signed, timestamped claim about what happened.
 *
 * **Attestations name the player; they do not bind to `msg.sender`.** A player's
 * game identity is a session key, which need not be the wallet paying the gas —
 * and MiniPay cannot sign messages, so the player signs nothing and merely sends
 * a transaction. Leaving the submitter unconstrained is therefore deliberate:
 * whoever submits pays, the recorded `player` is whoever the referee named, and
 * the relayer can re-submit the identical attestation as a fallback for a player
 * with an empty wallet. The worst a third party can do is pay for someone else's
 * record.
 *
 * **Not upgradeable, on purpose.** No funds, and the only state is two rotatable
 * keys plus the spent-attestation set. If the schema changes, deploy a new one
 * and repoint the relayer — cheaper and far safer than another upgrade key.
 * Note that a redeployment starts with an empty spent set, and the old contract's
 * in-flight attestations will not verify against it anyway.
 *
 * **Events may repeat.** The relayer's outbox is at-least-once: a transaction
 * that is mined but whose response is lost gets retried and both land. Indexers
 * MUST deduplicate on the event contents — (player, zoneId, epoch, r, c) for a
 * reveal, (player, huntId) for an entry, huntId for a resolution. `recordCount`
 * therefore counts emissions, not distinct game events. (The attested paths burn
 * their digest and so cannot repeat, but an indexer should not have to know
 * which path a given event arrived by.)
 */
contract LootGridActions is EIP712 {
    /// @notice The referee's submitting address. Only it may write reveals.
    address public relayer;
    /**
     * @notice The referee's attestation *signing* key, checked on the
     *         self-submitted paths. Deliberately separate from {relayer}: that
     *         one is a hot wallet holding gas and rotates routinely, while this
     *         one signs and can stay colder.
     */
    address public attestor;
    /// @notice May rotate the relayer and the attestor. Should be a multisig.
    address public owner;
    address public pendingOwner;

    /// @notice Monotonic count of records emitted, for cheap off-chain reconciliation.
    uint256 public recordCount;

    /**
     * @notice Attestation digests already redeemed.
     * @dev The one place this contract accepts the cost of storage. On the
     *      relayer paths a duplicate is merely noise an indexer dedupes away,
     *      but an attestation is a bearer token: without burning it, a player
     *      could replay a winning resolution forever. ~20k gas on a
     *      once-per-hunt action, paid by the submitter.
     */
    mapping(bytes32 => bool) public attestationUsed;

    /**
     * @dev `zoneId` and `huntId` are the server's own string ids, ASCII
     *      right-padded into bytes32 so they stay readable in an explorer. An
     *      indexed topic occupies a full word regardless of declared type, so
     *      bytes32 costs exactly what uint16 would have and avoids maintaining a
     *      numeric id registry. Ids longer than 31 bytes are keccak-hashed
     *      instead; see the relayer's `toBytes32Id`.
     */
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
    event OwnershipTransferStarted(address indexed previous, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    error NotRelayer();
    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error LengthMismatch();
    error BatchTooLarge();
    error AttestationExpired();
    error AttestationAlreadyUsed();
    error BadAttestation();

    /**
     * @dev EIP-712 type hashes. The field order here is consensus with the
     *      referee's signer — reordering silently invalidates every signature it
     *      produces, so treat these as append-only alongside the server.
     */
    bytes32 private constant ENTRY_TYPEHASH =
        keccak256("Entry(address player,bytes32 huntId,uint8 gameType,uint256 deadline)");
    bytes32 private constant RESOLUTION_TYPEHASH = keccak256(
        "Resolution(address winner,bytes32 huntId,uint32 elapsedMs,uint16 racers,uint256 deadline)"
    );

    /// @dev Caps a batch so one call cannot exceed the block gas limit and strand
    ///      the whole queue behind a transaction that can never be mined.
    uint256 public constant MAX_BATCH = 128;

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev The EIP-712 domain binds signatures to this chain and this address,
    ///      so an attestation cannot be replayed onto a redeployment or a fork.
    constructor(address initialOwner, address initialRelayer, address initialAttestor)
        EIP712("LootGridActions", "1")
    {
        if (initialOwner == address(0) || initialRelayer == address(0) || initialAttestor == address(0)) {
            revert ZeroAddress();
        }
        owner = initialOwner;
        relayer = initialRelayer;
        attestor = initialAttestor;
        emit OwnershipTransferred(address(0), initialOwner);
        emit RelayerChanged(address(0), initialRelayer);
        emit AttestorChanged(address(0), initialAttestor);
    }

    // ─────────────────────────── records ───────────────────────────

    function recordReveal(address player, bytes32 zoneId, uint32 epoch, uint8 r, uint8 c, uint8 tileType)
        external
        onlyRelayer
    {
        unchecked {
            recordCount += 1;
        }
        emit TileRevealed(player, zoneId, epoch, r, c, tileType, uint64(block.timestamp));
    }

    function recordEntry(address player, bytes32 huntId, uint8 gameType) external onlyRelayer {
        unchecked {
            recordCount += 1;
        }
        emit HuntEntered(player, huntId, gameType, uint64(block.timestamp));
    }

    function recordResolution(address winner, bytes32 huntId, uint32 elapsedMs, uint16 racers)
        external
        onlyRelayer
    {
        unchecked {
            recordCount += 1;
        }
        emit HuntResolved(winner, huntId, elapsedMs, racers, uint64(block.timestamp));
    }

    /**
     * @notice Batched reveals, for when cost matters more than transaction count.
     * @dev Deliberately NOT the default path. One transaction per action is the
     *      point of this contract; batching is the lever to pull if relayer gas
     *      becomes the binding constraint.
     */
    function recordRevealBatch(
        address[] calldata players,
        bytes32[] calldata zoneIds,
        uint32[] calldata epochs,
        uint8[] calldata rs,
        uint8[] calldata cs,
        uint8[] calldata tileTypes
    ) external onlyRelayer {
        uint256 n = players.length;
        if (n > MAX_BATCH) revert BatchTooLarge();
        if (
            zoneIds.length != n || epochs.length != n || rs.length != n || cs.length != n
                || tileTypes.length != n
        ) revert LengthMismatch();

        uint64 ts = uint64(block.timestamp);
        for (uint256 i; i < n;) {
            emit TileRevealed(players[i], zoneIds[i], epochs[i], rs[i], cs[i], tileTypes[i], ts);
            unchecked {
                ++i;
            }
        }
        unchecked {
            recordCount += n;
        }
    }

    // ─────────────────── self-submitted (attested) records ───────────────────
    //
    // The player pays the gas here, in a Celo fee currency they already hold.
    // These carry no `onlyRelayer`, so the referee's signature is the whole of
    // the authorisation — see `_consume`.

    /**
     * @notice Record a hunt entry using a referee-signed attestation.
     * @param player   The game identity being recorded. Need not be `msg.sender`.
     * @param deadline Unix seconds after which the attestation is refused.
     * @param signature The attestor's EIP-712 signature over the fields above.
     */
    function submitEntry(
        address player,
        bytes32 huntId,
        uint8 gameType,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _consume(
            keccak256(abi.encode(ENTRY_TYPEHASH, player, huntId, gameType, deadline)), deadline, signature
        );
        unchecked {
            recordCount += 1;
        }
        emit HuntEntered(player, huntId, gameType, uint64(block.timestamp));
    }

    /**
     * @notice Record a hunt resolution using a referee-signed attestation.
     * @dev Normally submitted by the winner, who has the clearest reason to want
     *      the record on chain and is the one paying for it.
     */
    function submitResolution(
        address winner,
        bytes32 huntId,
        uint32 elapsedMs,
        uint16 racers,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _consume(
            keccak256(abi.encode(RESOLUTION_TYPEHASH, winner, huntId, elapsedMs, racers, deadline)),
            deadline,
            signature
        );
        unchecked {
            recordCount += 1;
        }
        emit HuntResolved(winner, huntId, elapsedMs, racers, uint64(block.timestamp));
    }

    /// @notice The EIP-712 digest for a set of entry fields, so the client can
    ///         check what it is about to submit without guessing at encoding.
    function entryDigest(address player, bytes32 huntId, uint8 gameType, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(ENTRY_TYPEHASH, player, huntId, gameType, deadline)));
    }

    /// @notice The EIP-712 digest for a set of resolution fields.
    function resolutionDigest(
        address winner,
        bytes32 huntId,
        uint32 elapsedMs,
        uint16 racers,
        uint256 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(RESOLUTION_TYPEHASH, winner, huntId, elapsedMs, racers, deadline))
        );
    }

    /**
     * @dev Validate an attestation and burn it.
     *
     * Every field the event will carry is inside `structHash`, so a submitter
     * cannot alter one without invalidating the signature. `ECDSA.recover`
     * rejects malleable (high-s) signatures and reverts rather than returning
     * `address(0)` on a malformed one, so a zero `attestor` could never be
     * matched by accident — but the setters refuse zero regardless.
     */
    function _consume(bytes32 structHash, uint256 deadline, bytes calldata signature) private {
        if (block.timestamp > deadline) revert AttestationExpired();

        bytes32 digest = _hashTypedDataV4(structHash);
        // Checks-effects: burn before emitting, so a future non-view addition
        // here cannot be re-entered on the same attestation.
        if (attestationUsed[digest]) revert AttestationAlreadyUsed();
        if (ECDSA.recover(digest, signature) != attestor) revert BadAttestation();
        attestationUsed[digest] = true;
    }

    // ─────────────────────────── admin ───────────────────────────

    /// @notice Rotate the submitting key — the routine operation, since a relayer
    ///         hot wallet is far more exposed than the owner.
    function setRelayer(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit RelayerChanged(relayer, next);
        relayer = next;
    }

    /**
     * @notice Rotate the attestation signing key.
     * @dev In-flight attestations signed by the previous key stop verifying the
     *      moment this lands. Rotate when the queue is quiet, or expect a few
     *      submissions to revert with {BadAttestation} and need re-signing.
     */
    function setAttestor(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit AttestorChanged(attestor, next);
        attestor = next;
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}
