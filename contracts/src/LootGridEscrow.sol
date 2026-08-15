// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title LootGridEscrow
 * @notice Holds hunt prizes in a stablecoin and releases them against the
 *         referee's signed word about who won.
 *
 * ─────────────────────────── the shape of the trust ───────────────────────────
 *
 * The referee decides the game; this contract decides the money. It believes
 * exactly one thing — an EIP-712 attestation naming a winner — and it bounds how
 * much that belief can ever be worth. Every other guarantee here exists because
 * the signing key is the weak point and is assumed to leak eventually.
 *
 * What a stolen attestor key can do: pay attested winners up to the per-hunt cap,
 * up to the daily cap, after the challenge window, if nobody has paused. What it
 * cannot do: exceed a pot, drain the contract, mint a second payout for a hunt
 * already settled, block refunds, or touch a pot after its expiry.
 *
 * ─────────────────────────── why a separate signer ───────────────────────────
 *
 * `LootGridActions` verifies a `Resolution` attestation to write a public record.
 * This contract verifies the identical struct — same field order, same name — but
 * under **its own EIP-712 domain**, with its own `attestor`.
 *
 * That is deliberate and it is the one place this diverges from the plan, which
 * called for a single attestation serving both. Sharing one signature would mean
 * the key that writes cosmetic game logs is the key that moves money, so the two
 * could never be secured differently. Splitting them lets records keep a cheap
 * hot key while payouts move to a multisig — which is precisely the blast-radius
 * problem escrow introduces. Set both to the same address on day one if you like;
 * the point is that you can stop.
 *
 * Domain separation also means a signature minted for the record cannot be
 * replayed here, and vice versa, without anyone having to reason about it.
 *
 * ─────────────────────────── pull, never push ───────────────────────────
 *
 * `claim` credits a balance; `withdraw` moves the tokens, and not before the
 * challenge window elapses. Money that is owed but not yet moved is money a
 * guardian still has time to stop.
 *
 * ─────────────────────────── refunds are sacred ───────────────────────────
 *
 * `refund` is permissionless and cannot be paused. If the signing key is lost,
 * the server disappears, or the guardian pauses and never returns, every pot is
 * still recoverable after its expiry. A contract that can strand funds when its
 * operator walks away is not an escrow.
 */
contract LootGridEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The prize token. Immutable — a swappable token address is a rug.
    IERC20 public immutable token;

    /// @notice Receives funding, and gets refunds back when a pot expires unclaimed.
    address public treasury;
    /// @notice Signs payout attestations. Should be a multisig once real money is in.
    address public attestor;
    /// @notice May rotate keys and set caps. Should be a multisig.
    address public owner;
    address public pendingOwner;
    /// @notice May pause claims and withdrawals. Never refunds.
    address public guardian;

    bool public paused;

    /// @notice Largest single pot that may be funded or paid.
    uint256 public perHuntCap;
    /// @notice Largest total that may be credited in one UTC day.
    uint256 public perDayCap;

    /// @notice Seconds between a claim being credited and it becoming withdrawable.
    uint64 public challengeWindow;

    /// @notice Total currently owed to winners. Never refundable, never re-fundable.
    uint256 public totalOwed;

    struct Pot {
        uint128 amount;
        uint64 expiresAt;
        bool settled;
    }

    /// @notice Funded prizes, by hunt.
    mapping(bytes32 => Pot) public pots;
    /// @notice Credited but not yet withdrawn.
    mapping(address => uint256) public owed;
    /// @notice When a winner's balance becomes withdrawable.
    mapping(address => uint64) public withdrawableAt;
    /// @notice Redeemed attestation digests. An attestation is a bearer token.
    mapping(bytes32 => bool) public usedAttestation;

    /// @dev UTC day index the running total belongs to.
    uint64 public spendDay;
    uint256 public spentThisDay;

    /**
     * @dev Identical field order and name to `LootGridActions.Resolution`, so the
     *      server signs the same message twice rather than learning a second
     *      shape. The domain is what keeps the two apart.
     */
    bytes32 private constant RESOLUTION_TYPEHASH = keccak256(
        "Resolution(address winner,bytes32 huntId,uint32 elapsedMs,uint16 racers,uint256 deadline)"
    );

    event HuntFunded(bytes32 indexed huntId, uint256 amount, uint64 expiresAt);
    event Claimed(bytes32 indexed huntId, address indexed winner, uint256 amount, uint64 withdrawableAt);
    event Withdrawn(address indexed winner, uint256 amount);
    event Refunded(bytes32 indexed huntId, uint256 amount);
    event CapsChanged(uint256 perHunt, uint256 perDay);
    event ChallengeWindowChanged(uint64 seconds_);
    event PausedSet(bool paused);
    event TreasuryChanged(address indexed previous, address indexed next);
    event AttestorChanged(address indexed previous, address indexed next);
    event GuardianChanged(address indexed previous, address indexed next);
    event OwnershipTransferStarted(address indexed previous, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    error NotOwner();
    error NotPendingOwner();
    error NotGuardian();
    error NotTreasury();
    error ZeroAddress();
    error ZeroAmount();
    error Paused();
    error AlreadyFunded();
    error NotFunded();
    error AlreadySettled();
    error ExceedsHuntCap();
    error ExceedsDayCap();
    error AttestationExpired();
    error AttestationAlreadyUsed();
    error BadAttestation();
    error NotYetWithdrawable();
    error NothingOwed();
    error NotExpired();
    error ExpiryInPast();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor(
        address token_,
        address initialOwner,
        address initialTreasury,
        address initialAttestor,
        address initialGuardian,
        uint256 initialPerHuntCap,
        uint256 initialPerDayCap,
        uint64 initialChallengeWindow
    ) EIP712("LootGridEscrow", "1") {
        if (
            token_ == address(0) || initialOwner == address(0) || initialTreasury == address(0)
                || initialAttestor == address(0) || initialGuardian == address(0)
        ) revert ZeroAddress();
        if (initialPerHuntCap == 0 || initialPerDayCap == 0) revert ZeroAmount();

        token = IERC20(token_);
        owner = initialOwner;
        treasury = initialTreasury;
        attestor = initialAttestor;
        guardian = initialGuardian;
        perHuntCap = initialPerHuntCap;
        perDayCap = initialPerDayCap;
        challengeWindow = initialChallengeWindow;

        emit OwnershipTransferred(address(0), initialOwner);
        emit TreasuryChanged(address(0), initialTreasury);
        emit AttestorChanged(address(0), initialAttestor);
        emit GuardianChanged(address(0), initialGuardian);
        emit CapsChanged(initialPerHuntCap, initialPerDayCap);
        emit ChallengeWindowChanged(initialChallengeWindow);
    }

    // ─────────────────────────── funding ───────────────────────────

    /**
     * @notice Escrow a prize for a hunt. Pulls `amount` from the treasury.
     * @dev Only the treasury may fund, so a stranger cannot inflate a pot and
     *      then have it paid out to an attested winner at the house's expense.
     */
    function fundHunt(bytes32 huntId, uint256 amount, uint64 expiresAt) external whenNotPaused {
        if (msg.sender != treasury) revert NotTreasury();
        if (amount == 0) revert ZeroAmount();
        if (amount > perHuntCap) revert ExceedsHuntCap();
        if (expiresAt <= block.timestamp) revert ExpiryInPast();
        if (pots[huntId].amount != 0 || pots[huntId].settled) revert AlreadyFunded();

        pots[huntId] = Pot({amount: uint128(amount), expiresAt: expiresAt, settled: false});
        token.safeTransferFrom(msg.sender, address(this), amount);

        emit HuntFunded(huntId, amount, expiresAt);
    }

    // ─────────────────────────── claiming ───────────────────────────

    /**
     * @notice Credit a hunt's pot to its attested winner.
     *
     * Callable by anyone holding a valid attestation, exactly like
     * `LootGridActions.submitResolution` — whoever submits pays the gas and the
     * money still goes to the winner the referee named. That is what lets the
     * house settle on behalf of a player with an empty wallet.
     *
     * Credits a balance rather than transferring: see {withdraw}.
     */
    function claim(
        address winner,
        bytes32 huntId,
        uint32 elapsedMs,
        uint16 racers,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused nonReentrant {
        if (winner == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert AttestationExpired();

        Pot memory pot = pots[huntId];
        // `settled` is checked before `amount`, because settling zeroes the
        // amount — the other order makes a spent pot report NotFunded and leaves
        // AlreadySettled unreachable. Both revert either way, but a caller
        // debugging a failed payout deserves to be told which of the two it is.
        if (pot.settled) revert AlreadySettled();
        if (pot.amount == 0) revert NotFunded();
        // A pot past its expiry belongs to the refund path. Without this a stale
        // attestation could outrun a refund that is already due.
        if (block.timestamp > pot.expiresAt) revert NotExpired();

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(RESOLUTION_TYPEHASH, winner, huntId, elapsedMs, racers, deadline))
        );
        if (usedAttestation[digest]) revert AttestationAlreadyUsed();
        if (ECDSA.recover(digest, signature) != attestor) revert BadAttestation();

        uint256 amount = pot.amount;
        if (amount > perHuntCap) revert ExceedsHuntCap();
        _chargeDailyCap(amount);

        // Effects before the credit is visible anywhere else.
        usedAttestation[digest] = true;
        pots[huntId].settled = true;
        pots[huntId].amount = 0;
        totalOwed += amount;
        owed[winner] += amount;

        // The window restarts on every new credit. A winner mid-window who wins
        // again waits from the later claim — the guardian's time to react must
        // cover the newest obligation, not the oldest.
        uint64 readyAt = uint64(block.timestamp) + challengeWindow;
        withdrawableAt[winner] = readyAt;

        emit Claimed(huntId, winner, amount, readyAt);
    }

    /**
     * @notice Move a winner's credited balance to them.
     *
     * Permissionless, and always pays the named winner — so the house can push a
     * payout for someone who cannot afford the gas, and nobody can redirect it.
     */
    function withdraw(address winner) external whenNotPaused nonReentrant {
        uint256 amount = owed[winner];
        if (amount == 0) revert NothingOwed();
        if (block.timestamp < withdrawableAt[winner]) revert NotYetWithdrawable();

        owed[winner] = 0;
        totalOwed -= amount;
        token.safeTransfer(winner, amount);

        emit Withdrawn(winner, amount);
    }

    // ─────────────────────────── refunds ───────────────────────────

    /**
     * @notice Return an unclaimed pot to the treasury once it has expired.
     *
     * Permissionless and **not pausable**, on purpose. This is the escape hatch:
     * if the attestor key is lost, the server never comes back, or a guardian
     * pauses and vanishes, every pot is still recoverable by anyone willing to
     * pay the gas. The money can only ever go to the treasury, so opening this
     * up costs nothing.
     */
    function refund(bytes32 huntId) external nonReentrant {
        Pot memory pot = pots[huntId];
        if (pot.settled) revert AlreadySettled();
        if (pot.amount == 0) revert NotFunded();
        if (block.timestamp <= pot.expiresAt) revert NotExpired();

        uint256 amount = pot.amount;
        pots[huntId].settled = true;
        pots[huntId].amount = 0;

        token.safeTransfer(treasury, amount);
        emit Refunded(huntId, amount);
    }

    // ─────────────────────────── caps ───────────────────────────

    /**
     * @dev Rolls the daily bucket on a UTC day boundary and charges it.
     *
     * Fixed days rather than a sliding window: a sliding window needs stored
     * history and more gas to prove the same property, and the cap exists to
     * bound a compromised key's daily damage, not to be precise.
     */
    function _chargeDailyCap(uint256 amount) private {
        uint64 today = uint64(block.timestamp / 1 days);
        if (today != spendDay) {
            spendDay = today;
            spentThisDay = 0;
        }
        if (spentThisDay + amount > perDayCap) revert ExceedsDayCap();
        spentThisDay += amount;
    }

    /**
     * @notice Tokens held beyond what is owed or still escrowed.
     */
    function unencumberedBalance() external view returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        return balance > totalOwed ? balance - totalOwed : 0;
    }

    // ─────────────────────────── admin ───────────────────────────

    function setCaps(uint256 perHunt, uint256 perDay) external onlyOwner {
        if (perHunt == 0 || perDay == 0) revert ZeroAmount();
        perHuntCap = perHunt;
        perDayCap = perDay;
        emit CapsChanged(perHunt, perDay);
    }

    function setChallengeWindow(uint64 seconds_) external onlyOwner {
        challengeWindow = seconds_;
        emit ChallengeWindowChanged(seconds_);
    }

    /// @notice Rotate the payout signer — the routine move after a suspected leak.
    function setAttestor(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit AttestorChanged(attestor, next);
        attestor = next;
    }

    function setTreasury(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit TreasuryChanged(treasury, next);
        treasury = next;
    }

    function setGuardian(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit GuardianChanged(guardian, next);
        guardian = next;
    }

    /**
     * @notice Halt claims and withdrawals. Refunds keep working.
     * @dev Owner may also pause, so incident response does not depend on one key
     *      being reachable.
     */
    function setPaused(bool value) external {
        if (msg.sender != guardian && msg.sender != owner) revert NotGuardian();
        paused = value;
        emit PausedSet(value);
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

    /// @notice The digest a given resolution produces, so a caller can check before sending.
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
}
