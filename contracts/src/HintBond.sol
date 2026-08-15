// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title HintBond
 * @notice Money a hint seller stands to lose. The thing slashing was missing.
 *
 * ─────────────────────────── why reputation was not enough ──────────────────
 *
 * Phase 9 built a reputation score that is expensive to forge. What it could
 * not do is take anything away: a seller caught behaving badly lost a number,
 * and numbers are rebuildable with fresh wallets and a little volume. The plan
 * says *detect and slash, not prevent* — and until this contract existed only
 * the first half was true, because nothing was staked.
 *
 * ─────────────────────────── what is actually slashable ─────────────────────
 *
 * Not "the hint turned out false". Hints are advertised as probabilistic — tier
 * 3 is a published coin flip — so a false hint is the product working, and
 * punishing one would be punishing a seller for randomness the house generated
 * and the buyer was told about.
 *
 * What is slashable is **selection**. A seller does not choose a hint's
 * reliability (the house sets it per tier and the vouch attests it) but they do
 * choose *which* of the hints they hold to sell. A seller who can tell their
 * false hints from their true ones — because they hold several, or because they
 * are playing the hunt — sells the false ones and keeps the rest. The vouch
 * still says 70%; what that seller actually delivers is far worse, and every
 * buyer paid the 70% price.
 *
 * That is a statistical claim, not a per-trade one, so it is decided off chain
 * against the phase 2 commitment — which fixed every hint's truth before anyone
 * played — and arrives here as one signed number. This contract holds the
 * money and enforces the limits; it does not compute the verdict.
 *
 * ─────────────────────────── the delay is the whole design ──────────────────
 *
 * `withdrawDelay` must outlast a hunt plus the window in which its hints are
 * revealed and judged. If it does not, the attack is trivial and complete: post
 * a bond, sell hints you know are false, withdraw before anyone can prove it.
 * Everything else here is ordinary; this one number is the security property.
 *
 * ─────────────────────────── a bond you cannot retrieve is a bond you lost ───
 *
 * So withdrawal after the delay is **not pausable and not blockable**, exactly
 * like `HintEscrow`'s refund path. A guardian who can freeze a seller's bond
 * indefinitely is a guardian who can take it, and "we paused it" is
 * indistinguishable from theft on any timescale a seller cares about.
 *
 * For the same reason `slash` is not pausable either. It needs an attestor
 * signature with a deadline and it can never take more than is bonded, so there
 * is no runaway a pause would protect against — while a pausable slash would be
 * precisely the escape hatch a fraudulent seller needs while their delay runs
 * out. A compromised attestor is answered by rotating it, not by freezing.
 */
contract HintBond is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The bond's token. Immutable — a swappable token address is a rug.
    IERC20 public immutable token;

    address public owner;
    address public pendingOwner;
    /// @notice Signs slash claims. Never the owner; see the constructor.
    address public slashAttestor;
    /// @notice May pause new bonds. Can never block a withdrawal or a slash.
    address public guardian;
    /// @notice Where slashed money goes. The treasury, so it returns to prizes.
    address public beneficiary;

    /// @notice Stops new bonds being accepted. Deliberately nothing else.
    bool public paused;

    /**
     * @notice How long a withdrawal waits.
     *
     * Must exceed the longest hunt plus the window in which its hints are
     * revealed and a seller's sales are judged. Set it shorter and a seller can
     * sell hints they know are false and be gone before it can be shown.
     */
    uint64 public withdrawDelay;

    /// @notice The smallest bond that lets a seller list at all.
    uint256 public minBond;

    /// @notice Bonded, per seller.
    mapping(address => uint256) public bonded;
    /// @notice When a requested withdrawal may run. Zero means none requested.
    mapping(address => uint64) public unlockAt;
    /// @notice Claims already applied. A verdict is spent once.
    mapping(bytes32 => bool) public claimUsed;

    bytes32 private constant SLASH_TYPEHASH = keccak256(
        "Slash(bytes32 claimId,address seller,uint256 amount,bytes32 evidenceHash,uint256 deadline)"
    );

    struct Claim {
        bytes32 claimId;
        address seller;
        uint256 amount;
        /**
         * @notice Hash of the off-chain evidence: the trades, the reliabilities
         *         vouched, and the outcomes the commitment revealed.
         *
         * Recorded rather than verified. The chain cannot recompute a binomial
         * test, but it can pin exactly which evidence was claimed to justify
         * this slash, so a seller who disputes it can show the same bytes and
         * anyone can rerun the arithmetic.
         */
        bytes32 evidenceHash;
        uint256 deadline;
    }

    event Bonded(address indexed seller, uint256 amount, uint256 total);
    event WithdrawRequested(address indexed seller, uint64 unlockAt);
    event WithdrawCancelled(address indexed seller);
    event Withdrawn(address indexed seller, uint256 amount, uint256 remaining);
    event Slashed(
        bytes32 indexed claimId,
        address indexed seller,
        uint256 amount,
        bytes32 evidenceHash,
        uint256 remaining
    );
    event LimitsChanged(uint64 withdrawDelay, uint256 minBond);
    event SlashAttestorChanged(address indexed previous, address indexed next);
    event GuardianChanged(address indexed previous, address indexed next);
    event BeneficiaryChanged(address indexed previous, address indexed next);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed previous, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    error NotOwner();
    error NotGuardian();
    error NotPendingOwner();
    error NotAttestor();
    error ZeroAddress();
    error ZeroAmount();
    error Paused();
    error BadClaim();
    error ClaimExpired();
    error ClaimUsed();
    error NotRequested();
    error NotUnlocked();
    error InsufficientBond();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address token_,
        address initialOwner,
        address initialSlashAttestor,
        address initialGuardian,
        address initialBeneficiary,
        uint64 initialWithdrawDelay,
        uint256 initialMinBond
    ) EIP712("LootgridHintBond", "1") {
        if (
            token_ == address(0) || initialOwner == address(0) || initialSlashAttestor == address(0)
                || initialGuardian == address(0) || initialBeneficiary == address(0)
        ) {
            revert ZeroAddress();
        }
        // The same invariant `AgentVault` and `Treasury` rest on. An attestor
        // that is also the owner faces no limits: it could sign a slash and set
        // the beneficiary to itself in the same breath.
        if (initialSlashAttestor == initialOwner) revert NotAttestor();

        token = IERC20(token_);
        owner = initialOwner;
        slashAttestor = initialSlashAttestor;
        guardian = initialGuardian;
        beneficiary = initialBeneficiary;
        withdrawDelay = initialWithdrawDelay;
        minBond = initialMinBond;

        emit OwnershipTransferred(address(0), initialOwner);
        emit SlashAttestorChanged(address(0), initialSlashAttestor);
        emit GuardianChanged(address(0), initialGuardian);
        emit BeneficiaryChanged(address(0), initialBeneficiary);
        emit LimitsChanged(initialWithdrawDelay, initialMinBond);
    }

    // ─────────────────────────── posting ───────────────────────────

    /**
     * @notice Put money at risk so a listing means something.
     *
     * Posting cancels any pending withdrawal. A seller topping up while halfway
     * out of the door is a seller whose clock should restart — otherwise the
     * delay could be started once and left running as permanent notice.
     */
    function post(uint256 amount) external nonReentrant {
        if (paused) revert Paused();
        if (amount == 0) revert ZeroAmount();

        token.safeTransferFrom(msg.sender, address(this), amount);
        bonded[msg.sender] += amount;

        if (unlockAt[msg.sender] != 0) {
            unlockAt[msg.sender] = 0;
            emit WithdrawCancelled(msg.sender);
        }

        emit Bonded(msg.sender, amount, bonded[msg.sender]);
    }

    /// @notice Whether this seller has enough at risk to be allowed to list.
    function canList(address seller) external view returns (bool) {
        // A seller on the way out is not a seller in good standing, however much
        // is still nominally posted.
        return bonded[seller] >= minBond && unlockAt[seller] == 0;
    }

    // ─────────────────────────── leaving ───────────────────────────

    /// @notice Start the clock. Nothing moves until {@link withdraw}.
    function requestWithdraw() external {
        if (bonded[msg.sender] == 0) revert InsufficientBond();
        unlockAt[msg.sender] = uint64(block.timestamp) + withdrawDelay;
        emit WithdrawRequested(msg.sender, unlockAt[msg.sender]);
    }

    function cancelWithdraw() external {
        if (unlockAt[msg.sender] == 0) revert NotRequested();
        unlockAt[msg.sender] = 0;
        emit WithdrawCancelled(msg.sender);
    }

    /**
     * @notice Take the bond back.
     *
     * Not pausable, not blockable, not subject to anybody's approval once the
     * delay has run. A bond that can be frozen indefinitely is a bond that has
     * been taken, and the delay — not a veto — is what keeps a seller present
     * long enough to be judged.
     *
     * Note the delay is re-read from storage at withdrawal, not captured at
     * request time: an owner who lengthens it because hunts got longer must
     * bind the sellers already queued, or the change protects nobody until
     * everyone currently listed has cycled out.
     */
    function withdraw(uint256 amount) external nonReentrant {
        uint64 unlock = unlockAt[msg.sender];
        if (unlock == 0) revert NotRequested();
        if (block.timestamp < unlock) revert NotUnlocked();
        if (amount == 0) revert ZeroAmount();
        if (amount > bonded[msg.sender]) revert InsufficientBond();

        bonded[msg.sender] -= amount;
        if (bonded[msg.sender] == 0) unlockAt[msg.sender] = 0;

        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, bonded[msg.sender]);
    }

    // ─────────────────────────── slashing ───────────────────────────

    /**
     * @notice Apply a signed verdict.
     *
     * Permissionless to submit: the signature is the authority and the money can
     * only go to the beneficiary the owner set, so opening this up costs nothing
     * and means enforcement does not wait on one server being awake.
     *
     * Takes what is there rather than reverting when the bond is short. A slash
     * that failed because the seller had already withdrawn part of it would
     * leave the verdict unspent and the remainder untouched — worse in every
     * case than collecting what exists and recording that it happened.
     */
    function slash(Claim calldata claim, bytes calldata signature) external nonReentrant {
        if (block.timestamp > claim.deadline) revert ClaimExpired();
        if (claim.amount == 0) revert ZeroAmount();
        if (claimUsed[claim.claimId]) revert ClaimUsed();
        if (ECDSA.recover(claimDigest(claim), signature) != slashAttestor) revert BadClaim();

        claimUsed[claim.claimId] = true;

        uint256 taken = claim.amount > bonded[claim.seller] ? bonded[claim.seller] : claim.amount;
        if (taken > 0) {
            bonded[claim.seller] -= taken;
            token.safeTransfer(beneficiary, taken);
        }

        emit Slashed(claim.claimId, claim.seller, taken, claim.evidenceHash, bonded[claim.seller]);
    }

    function claimDigest(Claim calldata claim) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SLASH_TYPEHASH,
                    claim.claimId,
                    claim.seller,
                    claim.amount,
                    claim.evidenceHash,
                    claim.deadline
                )
            )
        );
    }

    // ─────────────────────────── admin ───────────────────────────

    function setLimits(uint64 withdrawDelay_, uint256 minBond_) external onlyOwner {
        withdrawDelay = withdrawDelay_;
        minBond = minBond_;
        emit LimitsChanged(withdrawDelay_, minBond_);
    }

    function setSlashAttestor(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        if (next == owner) revert NotAttestor();
        emit SlashAttestorChanged(slashAttestor, next);
        slashAttestor = next;
    }

    function setGuardian(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit GuardianChanged(guardian, next);
        guardian = next;
    }

    function setBeneficiary(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit BeneficiaryChanged(beneficiary, next);
        beneficiary = next;
    }

    /// @notice Stops new bonds. Withdrawal and slashing keep working — see the header.
    function setPaused(bool value) external {
        if (msg.sender != guardian && msg.sender != owner) revert NotGuardian();
        paused = value;
        emit PausedSet(value);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        if (next == slashAttestor) revert NotAttestor();
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        // Re-checked at acceptance: the attestor may have been rotated to this
        // address in between, and the invariant must hold when it starts to
        // matter rather than only when it was proposed.
        if (msg.sender == slashAttestor) revert NotAttestor();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}
