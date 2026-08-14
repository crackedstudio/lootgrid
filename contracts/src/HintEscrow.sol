// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title HintEscrow
 * @notice Holds a buyer's money while a hint changes hands, and releases it to
 *         the seller once the referee says the hint was handed over.
 *
 * ─────────────────────────── the lemon market ───────────────────────────
 *
 * A buyer cannot evaluate a hint before paying — reading it *is* receiving it.
 * Left alone that market dies: a seller can fabricate hints, buyers cannot tell,
 * bad drives out good. The fix is that the referee knows which hints the game
 * issued, and vouches for one without disclosing it:
 *
 *     Hint(bytes32 hintHash, bytes32 zoneId, uint8 tier, uint16 reliabilityBps, ...)
 *
 * {fund} refuses to hold money for anything that vouch does not cover. So the
 * worst a seller can do is sell a genuine hint that happens to be one of the
 * false ones — which is the game, not a fraud.
 *
 * Note what the vouch does NOT say: whether the hint is correct. Hints lie on
 * purpose (docs/AGENTIC_ARCHITECTURE.md §5.0) and certifying accuracy would mean
 * handing over the answer. The buyer is buying odds, never an outcome, and
 * `reliabilityBps` is inside the signature so a seller cannot relabel a tier-3
 * coin flip as a tier-1 near certainty.
 *
 * ─────────────────────────── why not commit-reveal ───────────────────────────
 *
 * The obvious design — seller commits keccak(hint), buyer funds, seller reveals
 * on chain, contract checks the hash — does not work here. **Revealing on chain
 * publishes the hint to everybody**, so the buyer would pay for something the
 * whole world receives in the same block. The thing being sold is destroyed by
 * the mechanism meant to protect it.
 *
 * Delivery happens off chain instead, where the referee already owns hint
 * ownership, and this contract releases against the referee's `Release`
 * attestation. `hintHash` still travels through both signatures, so a buyer can
 * check afterwards that what they received is what they were promised.
 *
 * ─────────────────────────── who moves first ───────────────────────────
 *
 * Somebody has to, and the order chosen here is the only one without a free
 * lunch in it:
 *
 *     buyer funds → referee attests release → anyone submits it → seller credited
 *                                                              → referee hands the hint over
 *
 * The referee grants the hint **after** observing settlement, not before. Grant
 * it first and a buyer takes delivery, sits on the attestation until the trade
 * expires, refunds, and keeps the hint for nothing. Settling first means the
 * money is committed before the information moves, and a seller who never gets
 * settled simply never gets paid — the buyer's refund is untouched.
 *
 * Either party may submit the release, so neither depends on the other being
 * online. A buyer in a hurry pays the gas to pay their seller.
 *
 * ─────────────────────────── refunds are sacred ───────────────────────────
 *
 * As in LootGridEscrow: {refund} is permissionless and cannot be paused. If the
 * referee never attests, the server disappears, or a guardian pauses and never
 * returns, every buyer's money is recoverable after the trade expires. The
 * escrow can strand a hint. It must never strand money.
 *
 * ─────────────────────────── dust ───────────────────────────
 *
 * Hints trade for cents, so the rake is a fraction of a cent — expressible in
 * token base units, but worth far less than the gas to move it. Two answers,
 * both here: rake below {rakeWaiverAmount} is not charged at all (small trades
 * stay liquid), and everything credited is *pulled* rather than pushed, so the
 * treasury sweeps many trades' rake in one withdrawal instead of paying for a
 * transfer per trade.
 */
contract HintEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The settlement token. Immutable — a swappable token address is a rug.
    IERC20 public immutable token;

    /// @notice Receives the rake. Never receives a buyer's escrowed funds.
    address public treasury;
    /**
     * @notice Signs `Hint` vouches: "the game issued this hint, at this tier".
     * @dev The records key. It authorises nothing financial on its own — a vouch
     *      with no funding moves nothing — so it can stay as hot as the key that
     *      writes game logs.
     */
    address public vouchAttestor;
    /**
     * @notice Signs `Release` attestations, which move a buyer's money.
     * @dev The payout key. Strictly more dangerous than {vouchAttestor} and
     *      deliberately a separate role: a leak here pays sellers for trades the
     *      referee never approved, bounded by {perTradeCap} and by what is
     *      actually escrowed.
     */
    address public releaseAttestor;
    /// @notice May rotate keys and set limits. Should be a multisig.
    address public owner;
    address public pendingOwner;
    /// @notice May pause funding and settlement. Never refunds.
    address public guardian;

    bool public paused;

    /// @notice Rake taken from a settled trade, in basis points.
    uint16 public rakeBps;
    /// @notice Hard ceiling on {rakeBps}, fixed at deployment and not raisable.
    uint16 public constant MAX_RAKE_BPS = 1_000;
    /// @notice Trades below this pay no rake at all — the fee waiver.
    uint256 public rakeWaiverAmount;
    /// @notice Smallest trade the escrow will hold. Below it, noise.
    uint256 public minTradeAmount;
    /// @notice Largest single trade. Bounds what one forged release is worth.
    uint256 public perTradeCap;
    /// @notice Seconds between a credit and it becoming withdrawable.
    uint64 public challengeWindow;
    /// @notice Longest a trade may hold a buyer's money before refund is due.
    uint64 public maxTradeTtl;

    enum Status {
        None,
        Funded,
        Settled,
        Refunded
    }

    struct Trade {
        address buyer;
        address seller;
        uint128 amount;
        uint64 expiresAt;
        Status status;
        /// @dev What was bought. Binds funding and release to the same hint.
        bytes32 hintHash;
    }

    /// @notice The referee's vouch for a hint being offered.
    struct Vouch {
        bytes32 hintHash;
        bytes32 zoneId;
        uint8 tier;
        uint16 reliabilityBps;
        uint256 deadline;
    }

    /// @notice Limits, grouped so the constructor stays readable.
    struct Limits {
        uint16 rakeBps;
        uint256 minTradeAmount;
        uint256 perTradeCap;
        uint256 rakeWaiverAmount;
        uint64 challengeWindow;
        uint64 maxTradeTtl;
    }

    mapping(bytes32 => Trade) public trades;
    /// @notice Credited but not yet withdrawn — sellers and the treasury alike.
    mapping(address => uint256) public owed;
    /// @notice When an account's balance becomes withdrawable.
    mapping(address => uint64) public withdrawableAt;
    /// @notice Redeemed release digests. An attestation is a bearer token.
    mapping(bytes32 => bool) public usedRelease;

    /// @notice Funded and not yet settled or refunded. Belongs to buyers.
    uint256 public totalEscrowed;
    /// @notice Credited and not yet withdrawn. Belongs to sellers and the treasury.
    uint256 public totalOwed;

    /**
     * @dev Identical field order and name to the server's `TYPES.Hint`. The
     *      referee signs this under THIS contract's domain — the same message
     *      under `LootGridActions` would be a different digest, which is the
     *      point of domain separation.
     */
    bytes32 private constant HINT_TYPEHASH =
        keccak256("Hint(bytes32 hintHash,bytes32 zoneId,uint8 tier,uint16 reliabilityBps,uint256 deadline)");

    /**
     * @dev The referee's authority to move this buyer's money to this seller.
     *      `buyer` is signed so a release minted for one trade cannot be pointed
     *      at another; `hintHash` is signed so it cannot be pointed at a
     *      different hint under the same id.
     */
    bytes32 private constant RELEASE_TYPEHASH =
        keccak256("Release(bytes32 tradeId,bytes32 hintHash,address buyer,uint256 deadline)");

    event Funded(
        bytes32 indexed tradeId,
        address indexed buyer,
        address indexed seller,
        bytes32 hintHash,
        uint256 amount,
        uint64 expiresAt
    );
    event Settled(bytes32 indexed tradeId, address indexed seller, uint256 toSeller, uint256 rake);
    event Refunded(bytes32 indexed tradeId, address indexed buyer, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event LimitsChanged(Limits limits);
    event PausedSet(bool paused);
    event TreasuryChanged(address indexed previous, address indexed next);
    event VouchAttestorChanged(address indexed previous, address indexed next);
    event ReleaseAttestorChanged(address indexed previous, address indexed next);
    event GuardianChanged(address indexed previous, address indexed next);
    event OwnershipTransferStarted(address indexed previous, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    error NotOwner();
    error NotPendingOwner();
    error NotGuardian();
    error ZeroAddress();
    error ZeroAmount();
    error Paused();
    error TradeExists();
    error NoSuchTrade();
    error NotFunded();
    error SelfTrade();
    error BelowMinimum();
    error ExceedsTradeCap();
    error BadExpiry();
    error TradeExpired();
    error NotExpired();
    error AttestationExpired();
    error AttestationAlreadyUsed();
    error BadVouch();
    error BadRelease();
    error WrongHint();
    error NotYetWithdrawable();
    error NothingOwed();
    error RakeTooHigh();

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
        address initialVouchAttestor,
        address initialReleaseAttestor,
        address initialGuardian,
        Limits memory limits
    ) EIP712("HintEscrow", "1") {
        if (
            token_ == address(0) || initialOwner == address(0) || initialTreasury == address(0)
                || initialVouchAttestor == address(0) || initialReleaseAttestor == address(0)
                || initialGuardian == address(0)
        ) revert ZeroAddress();

        token = IERC20(token_);
        owner = initialOwner;
        treasury = initialTreasury;
        vouchAttestor = initialVouchAttestor;
        releaseAttestor = initialReleaseAttestor;
        guardian = initialGuardian;

        _setLimits(limits);

        emit OwnershipTransferred(address(0), initialOwner);
        emit TreasuryChanged(address(0), initialTreasury);
        emit VouchAttestorChanged(address(0), initialVouchAttestor);
        emit ReleaseAttestorChanged(address(0), initialReleaseAttestor);
        emit GuardianChanged(address(0), initialGuardian);
    }

    // ─────────────────────────── funding ───────────────────────────

    /**
     * @notice Escrow payment for one hint, against the referee's vouch for it.
     *
     * The caller is the buyer. `tradeId` is chosen off chain and is single-use:
     * a second `fund` under the same id reverts, so a retry after a lost
     * response cannot pay twice.
     *
     * @dev The vouch is deliberately NOT consumed. Information copies rather
     *      than moves, so the same hint is expected to back many concurrent
     *      trades — burning the vouch on first use would make a hint sellable
     *      exactly once, which is not the market this is for. Replay of the
     *      *trade* is what matters, and `tradeId` prevents that.
     */
    function fund(
        bytes32 tradeId,
        address seller,
        uint256 amount,
        uint64 expiresAt,
        Vouch calldata vouch,
        bytes calldata vouchSignature
    ) external whenNotPaused nonReentrant {
        if (seller == address(0)) revert ZeroAddress();
        // A wash trade with yourself launders nothing here — the rake still
        // applies — but it fabricates trade history, which phase 9 reads as
        // reputation. Refuse it at the cheapest possible place.
        if (seller == msg.sender) revert SelfTrade();
        if (amount < minTradeAmount || amount == 0) revert BelowMinimum();
        if (amount > perTradeCap) revert ExceedsTradeCap();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + maxTradeTtl) {
            revert BadExpiry();
        }
        if (trades[tradeId].status != Status.None) revert TradeExists();

        if (block.timestamp > vouch.deadline) revert AttestationExpired();
        if (ECDSA.recover(vouchDigest(vouch), vouchSignature) != vouchAttestor) revert BadVouch();

        trades[tradeId] = Trade({
            buyer: msg.sender,
            seller: seller,
            amount: uint128(amount),
            expiresAt: expiresAt,
            status: Status.Funded,
            hintHash: vouch.hintHash
        });
        totalEscrowed += amount;

        token.safeTransferFrom(msg.sender, address(this), amount);

        emit Funded(tradeId, msg.sender, seller, vouch.hintHash, amount, expiresAt);
    }

    // ─────────────────────────── settlement ───────────────────────────

    /**
     * @notice Release an escrowed trade to its seller, less the rake.
     *
     * Callable by anyone holding a valid release — normally the seller, who
     * wants paying, but a buyer impatient for delivery may pay the gas instead.
     * The money goes where the trade said either way.
     *
     * Credits balances rather than transferring: see {withdraw}.
     */
    function settle(
        bytes32 tradeId,
        bytes32 hintHash,
        address buyer,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused nonReentrant {
        Trade memory trade = trades[tradeId];
        if (trade.status == Status.None) revert NoSuchTrade();
        if (trade.status != Status.Funded) revert NotFunded();
        // Past expiry the money is the buyer's again. Without this a stale
        // release could outrun a refund that is already due.
        if (block.timestamp > trade.expiresAt) revert TradeExpired();
        if (block.timestamp > deadline) revert AttestationExpired();
        // Both are inside the signature already; checking them against storage
        // is what stops a release for one trade being aimed at another.
        if (hintHash != trade.hintHash) revert WrongHint();
        if (buyer != trade.buyer) revert BadRelease();

        bytes32 digest = releaseDigest(tradeId, hintHash, buyer, deadline);
        if (usedRelease[digest]) revert AttestationAlreadyUsed();
        if (ECDSA.recover(digest, signature) != releaseAttestor) revert BadRelease();

        uint256 amount = trade.amount;
        uint256 rake = rakeFor(amount);
        uint256 toSeller = amount - rake;

        usedRelease[digest] = true;
        trades[tradeId].status = Status.Settled;
        totalEscrowed -= amount;
        totalOwed += amount;

        _credit(trade.seller, toSeller);
        if (rake > 0) _credit(treasury, rake);

        emit Settled(tradeId, trade.seller, toSeller, rake);
    }

    /**
     * @notice Return an expired, unsettled trade to its buyer.
     *
     * Permissionless and **not pausable**, on purpose — the escape hatch. The
     * money can only ever go back to the buyer who funded it, so opening this up
     * to anyone willing to pay the gas costs nothing and removes every way for
     * the house to hold a buyer hostage.
     */
    function refund(bytes32 tradeId) external nonReentrant {
        Trade memory trade = trades[tradeId];
        if (trade.status == Status.None) revert NoSuchTrade();
        if (trade.status != Status.Funded) revert NotFunded();
        if (block.timestamp <= trade.expiresAt) revert NotExpired();

        uint256 amount = trade.amount;
        trades[tradeId].status = Status.Refunded;
        totalEscrowed -= amount;

        token.safeTransfer(trade.buyer, amount);

        emit Refunded(tradeId, trade.buyer, amount);
    }

    /**
     * @notice Move a credited balance to its owner.
     *
     * Permissionless and always pays the named account, so the house can push a
     * payout to a seller who cannot afford the gas, and nobody can redirect it.
     * The treasury's rake accrues here too and is swept in one transaction
     * rather than one per trade — which is the only way a fraction-of-a-cent
     * fee is worth collecting at all.
     */
    function withdraw(address account) external whenNotPaused nonReentrant {
        uint256 amount = owed[account];
        if (amount == 0) revert NothingOwed();
        if (block.timestamp < withdrawableAt[account]) revert NotYetWithdrawable();

        owed[account] = 0;
        totalOwed -= amount;
        token.safeTransfer(account, amount);

        emit Withdrawn(account, amount);
    }

    function _credit(address account, uint256 amount) private {
        owed[account] += amount;
        // The window restarts on every new credit: the guardian's time to react
        // must cover the newest obligation, not the oldest.
        //
        // Consequence worth stating plainly, because it is easy to meet in
        // production and confusing to diagnose: an account credited more often
        // than once per window never becomes withdrawable. A busy seller — and
        // the treasury, which is credited on every rake-bearing trade — will sit
        // on a balance until trading pauses. That is why {challengeWindow} is
        // configurable and why it should be SHORT here: individual trades are
        // worth cents, so the reaction time this buys is worth far less than it
        // is on a prize pot.
        withdrawableAt[account] = uint64(block.timestamp) + challengeWindow;
    }

    // ─────────────────────────── views ───────────────────────────

    /**
     * @notice Rake on a trade of this size. Zero below the waiver threshold.
     *
     * Rounds down, so the fraction that cannot be represented stays with the
     * seller rather than with the house.
     */
    function rakeFor(uint256 amount) public view returns (uint256) {
        if (amount < rakeWaiverAmount) return 0;
        return (amount * rakeBps) / 10_000;
    }

    function vouchDigest(Vouch calldata vouch) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    HINT_TYPEHASH,
                    vouch.hintHash,
                    vouch.zoneId,
                    vouch.tier,
                    vouch.reliabilityBps,
                    vouch.deadline
                )
            )
        );
    }

    function releaseDigest(bytes32 tradeId, bytes32 hintHash, address buyer, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(RELEASE_TYPEHASH, tradeId, hintHash, buyer, deadline)));
    }

    /// @notice Tokens held beyond what is escrowed or owed. Should be zero.
    function unencumberedBalance() external view returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        uint256 spokenFor = totalEscrowed + totalOwed;
        return balance > spokenFor ? balance - spokenFor : 0;
    }

    // ─────────────────────────── admin ───────────────────────────

    function setLimits(Limits calldata limits) external onlyOwner {
        _setLimits(limits);
    }

    function _setLimits(Limits memory limits) private {
        if (limits.rakeBps > MAX_RAKE_BPS) revert RakeTooHigh();
        if (limits.minTradeAmount == 0 || limits.perTradeCap == 0) revert ZeroAmount();
        // A cap below the minimum makes every trade revert, in a way that looks
        // like a bug in the client rather than a misconfiguration here.
        if (limits.perTradeCap < limits.minTradeAmount) revert ExceedsTradeCap();
        // An unbounded TTL is a way to lock a buyer's money forever without ever
        // settling it — the refund would exist but never become due.
        if (limits.maxTradeTtl == 0) revert BadExpiry();

        rakeBps = limits.rakeBps;
        minTradeAmount = limits.minTradeAmount;
        perTradeCap = limits.perTradeCap;
        rakeWaiverAmount = limits.rakeWaiverAmount;
        challengeWindow = limits.challengeWindow;
        maxTradeTtl = limits.maxTradeTtl;

        emit LimitsChanged(limits);
    }

    /// @notice Rotate the vouch signer — the routine move after a suspected leak.
    function setVouchAttestor(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit VouchAttestorChanged(vouchAttestor, next);
        vouchAttestor = next;
    }

    function setReleaseAttestor(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit ReleaseAttestorChanged(releaseAttestor, next);
        releaseAttestor = next;
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
     * @notice Halt funding, settlement and withdrawals. Refunds keep working.
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
}
