// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Treasury
 * @notice Holds the house float and lets an agent propose what to do with it,
 *         inside limits it cannot change.
 *
 * ─────────────────────────── the agent proposes, this disposes ──────────────
 *
 * Phase 10 puts a model in charge of sizing an economy. That is a strictly
 * larger blast radius than phase 7's player agent — a compromised player agent
 * spends one player's allowance, a compromised treasury agent could try to
 * spend everybody's prizes. So the shape is the same and the limits are
 * tighter: the agent may only *propose*, and every rule is checked twice, once
 * when the proposal is made and again when it executes.
 *
 * The second check is the one that matters. A proposal that was legal when it
 * was made and illegal by the time it runs must not run — balances move, caps
 * get lowered, and the whole point of a delay is that somebody might act during
 * it.
 *
 * ─────────────────────────── the reserve is not allocatable ─────────────────
 *
 * `reserveFloor` is money the agent cannot reach at any price. It exists so
 * that payouts never wait on an allocation decision: an escrow that cannot pay
 * a winner because the treasury agent moved the float into something else has
 * failed at the only job the treasury has.
 *
 * Note what it is NOT: it is not a cap on outflow, it is a floor under the
 * balance. Every allocation is checked against `balance - amount >= floor`, so
 * the reserve survives any sequence of individually-legal proposals — which a
 * per-transaction cap alone would not guarantee.
 *
 * ─────────────────────────── owner outranks everything ──────────────────────
 *
 * The owner can veto, pause, retune and withdraw, and none of those can be
 * blocked by a proposal in flight or by the agent. As in `AgentVault`, a
 * treasury whose operator has to ask permission to leave is not a treasury.
 */
contract Treasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The float's token. Immutable — a swappable token address is a rug.
    IERC20 public immutable token;

    /// @notice Sets every limit below. Should be a multisig.
    address public owner;
    address public pendingOwner;
    /// @notice The treasury agent. May propose, and may do nothing else.
    address public proposer;
    /// @notice May veto and pause. Never blocks the owner.
    address public guardian;

    bool public paused;

    /// @notice Balance the agent may never allocate below. The payout guarantee.
    uint256 public reserveFloor;
    /// @notice Largest single allocation.
    uint256 public perProposalCap;
    /// @notice Largest total that may EXECUTE in one UTC day.
    uint256 public perDayCap;
    /// @notice How long a proposal waits before it may run. The veto window.
    uint64 public delay;

    /// @notice Where the agent may send money. Empty by default: nowhere.
    mapping(address => bool) public allowedTarget;

    enum State {
        None,
        Pending,
        Executed,
        Vetoed
    }

    struct Proposal {
        address target;
        uint128 amount;
        uint64 readyAt;
        State state;
    }

    mapping(bytes32 => Proposal) public proposals;

    uint64 public spendDay;
    uint256 public spentToday;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event Proposed(bytes32 indexed id, address indexed target, uint256 amount, uint64 readyAt);
    event Executed(bytes32 indexed id, address indexed target, uint256 amount);
    event Vetoed(bytes32 indexed id, address indexed by);
    event LimitsChanged(uint256 reserveFloor, uint256 perProposalCap, uint256 perDayCap, uint64 delay);
    event TargetSet(address indexed target, bool allowed);
    event ProposerChanged(address indexed previous, address indexed next);
    event GuardianChanged(address indexed previous, address indexed next);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed previous, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    error NotOwner();
    error NotProposer();
    error NotGuardian();
    error NotPendingOwner();
    error ZeroAddress();
    error ZeroAmount();
    error Paused();
    error ProposalExists();
    error NoSuchProposal();
    error NotPending();
    error NotReady();
    error TargetNotAllowed();
    error ExceedsProposalCap();
    error ExceedsDayCap();
    error BreachesReserve();
    error InsufficientBalance();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address token_,
        address initialOwner,
        address initialProposer,
        address initialGuardian,
        uint256 initialReserveFloor,
        uint256 initialPerProposalCap,
        uint256 initialPerDayCap,
        uint64 initialDelay
    ) {
        if (token_ == address(0) || initialOwner == address(0) || initialGuardian == address(0)) {
            revert ZeroAddress();
        }
        // The same invariant `AgentVault` rests on, for the same reason: a
        // proposer that is also the owner faces no limits at all.
        if (initialProposer == initialOwner) revert NotProposer();

        token = IERC20(token_);
        owner = initialOwner;
        proposer = initialProposer;
        guardian = initialGuardian;
        reserveFloor = initialReserveFloor;
        perProposalCap = initialPerProposalCap;
        perDayCap = initialPerDayCap;
        delay = initialDelay;

        emit OwnershipTransferred(address(0), initialOwner);
        emit ProposerChanged(address(0), initialProposer);
        emit GuardianChanged(address(0), initialGuardian);
        emit LimitsChanged(initialReserveFloor, initialPerProposalCap, initialPerDayCap, initialDelay);
    }

    // ─────────────────────────── the float ───────────────────────────

    /// @notice Fund the treasury. Open — anyone topping it up takes nothing.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /**
     * @notice Take money out. Owner only, always available.
     *
     * Not pausable and not blockable by a pending proposal. The reserve floor
     * binds the AGENT, not the owner — it exists to stop an allocation
     * stranding a payout, not to trap the operator's own money.
     */
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > token.balanceOf(address(this))) revert InsufficientBalance();

        token.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // ─────────────────────────── proposals ───────────────────────────

    /**
     * @notice Propose an allocation.
     *
     * Checked here so a doomed proposal never enters the queue, and checked
     * again at execution because the world moves in between — that second check
     * is the entire value of the delay.
     */
    function propose(bytes32 id, address target, uint256 amount) external {
        if (msg.sender != proposer) revert NotProposer();
        if (paused) revert Paused();
        if (amount == 0) revert ZeroAmount();
        if (proposals[id].state != State.None) revert ProposalExists();

        _check(target, amount);

        uint64 readyAt = uint64(block.timestamp) + delay;
        proposals[id] =
            Proposal({target: target, amount: uint128(amount), readyAt: readyAt, state: State.Pending});

        emit Proposed(id, target, amount, readyAt);
    }

    /**
     * @notice Run a proposal whose delay has elapsed.
     *
     * Permissionless: the money can only go to a target the owner allowlisted,
     * so opening this up costs nothing and means execution does not depend on
     * the agent still being alive.
     */
    function execute(bytes32 id) external nonReentrant {
        if (paused) revert Paused();

        Proposal memory p = proposals[id];
        if (p.state == State.None) revert NoSuchProposal();
        if (p.state != State.Pending) revert NotPending();
        if (block.timestamp < p.readyAt) revert NotReady();

        // Re-checked, not trusted. A proposal legal when made and illegal now
        // must not run: balances move, caps get lowered, and somebody may have
        // acted during the delay precisely because they meant to stop this.
        _check(p.target, p.amount);
        _chargeDailyCap(p.amount);

        proposals[id].state = State.Executed;
        token.safeTransfer(p.target, p.amount);

        emit Executed(id, p.target, p.amount);
    }

    /// @notice Cancel a pending proposal. The point of the delay.
    function veto(bytes32 id) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardian();
        if (proposals[id].state != State.Pending) revert NotPending();
        proposals[id].state = State.Vetoed;
        emit Vetoed(id, msg.sender);
    }

    /**
     * @dev Every rule an allocation must satisfy, in one place so `propose` and
     *      `execute` cannot drift apart.
     */
    function _check(address target, uint256 amount) private view {
        if (!allowedTarget[target]) revert TargetNotAllowed();
        if (amount > perProposalCap) revert ExceedsProposalCap();

        uint256 balance = token.balanceOf(address(this));
        if (amount > balance) revert InsufficientBalance();
        // A floor under the balance, not a cap on outflow. Checked this way so
        // the reserve survives any sequence of individually-legal proposals.
        if (balance - amount < reserveFloor) revert BreachesReserve();
    }

    function _chargeDailyCap(uint256 amount) private {
        uint64 today = uint64(block.timestamp / 1 days);
        if (today != spendDay) {
            spendDay = today;
            spentToday = 0;
        }
        if (spentToday + amount > perDayCap) revert ExceedsDayCap();
        spentToday += amount;
    }

    /// @notice What the agent could still allocate right now. For the runtime.
    function allocatable() external view returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        if (balance <= reserveFloor) return 0;

        uint256 free = balance - reserveFloor;
        uint256 dayLeft = uint64(block.timestamp / 1 days) != spendDay
            ? perDayCap
            : (spentToday >= perDayCap ? 0 : perDayCap - spentToday);

        uint256 limit = free < dayLeft ? free : dayLeft;
        return limit < perProposalCap ? limit : perProposalCap;
    }

    // ─────────────────────────── admin ───────────────────────────

    function setLimits(uint256 reserveFloor_, uint256 perProposalCap_, uint256 perDayCap_, uint64 delay_)
        external
        onlyOwner
    {
        reserveFloor = reserveFloor_;
        perProposalCap = perProposalCap_;
        perDayCap = perDayCap_;
        delay = delay_;
        emit LimitsChanged(reserveFloor_, perProposalCap_, perDayCap_, delay_);
    }

    function setTarget(address target, bool value) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        allowedTarget[target] = value;
        emit TargetSet(target, value);
    }

    function setProposer(address next) external onlyOwner {
        if (next == owner) revert NotProposer();
        emit ProposerChanged(proposer, next);
        proposer = next;
    }

    function setGuardian(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit GuardianChanged(guardian, next);
        guardian = next;
    }

    /// @notice Halt proposals and executions. Owner withdrawal keeps working.
    function setPaused(bool value) external {
        if (msg.sender != guardian && msg.sender != owner) revert NotGuardian();
        paused = value;
        emit PausedSet(value);
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        if (next == proposer) revert NotProposer();
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        // Re-checked at acceptance: the proposer may have been rotated to this
        // address in between, and the invariant must hold when it starts to
        // matter rather than only when it was proposed.
        if (msg.sender == proposer) revert NotProposer();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}
