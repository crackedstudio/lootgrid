// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AgentVault
 * @notice Holds a player's money and lets their agent spend it, within limits
 *         the player sets and can withdraw from at any time.
 *
 * ─────────────────────────── the one sentence ───────────────────────────
 *
 * **The agent is a spender, never a key holder.**
 *
 * Everything below follows from that. An agent is an LLM reading input written
 * by rivals, by a hint market, and by whatever a model decides a message means.
 * Assume it will one day be talked into trying to send everything to an
 * attacker. The question this contract answers is not whether that happens but
 * what it costs when it does, and the answer is: one capped transaction to an
 * address the player already approved.
 *
 * ─────────────────────────── three addresses ───────────────────────────
 *
 *     PlayerRegistry.sessionKeyOf[player]  →  agent address
 *     AgentVault.owner                     →  player address
 *     AgentVault.spender                   →  agent address
 *
 * The owner deposits and withdraws. The spender may only move funds to
 * allowlisted targets, under a per-transaction cap and a daily cap. It cannot
 * withdraw, cannot change a limit, cannot change the allowlist, and cannot stop
 * the owner doing any of those.
 *
 * **`spender` may never equal `owner`.** If it did, every cap here would be
 * decorative — the agent would simply withdraw. It is checked in the
 * constructor and on every rotation, and `PlayerRegistry` refuses the same
 * equality when binding a session key, so the two ends agree.
 *
 * ─────────────────────────── what a compromised agent can do ────────────────
 *
 * Send up to `perTxCap` to an allowlisted target, up to `perDayCap` in a day,
 * until the owner notices and calls {kill}. What it cannot do: exceed either
 * cap, reach an address the owner never approved, raise its own limits, block a
 * withdrawal, or survive the kill switch by a single block.
 *
 * ─────────────────────────── withdrawal is unconditional ────────────────────
 *
 * {withdraw} has no pause, no timelock, no agent involvement and no failure mode
 * that depends on the agent behaving. A vault whose owner has to ask permission
 * to leave is custody, and this is deliberately not custody.
 */
contract AgentVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The token this vault holds. Immutable — a swappable token is a rug.
    IERC20 public immutable token;

    /// @notice The player. Deposits, withdraws, sets every limit below.
    address public owner;
    address public pendingOwner;

    /**
     * @notice The agent's address. May spend, may never withdraw.
     * @dev Zero once {kill} has run. Zero is the safe state: the vault keeps
     *      working for its owner and does nothing for anyone else.
     */
    address public spender;

    /// @notice Largest single transfer the agent may make.
    uint256 public perTxCap;
    /// @notice Largest total the agent may move in one UTC day.
    uint256 public perDayCap;

    /// @notice Addresses the agent may pay. Empty by default: it can pay nobody.
    mapping(address => bool) public allowed;

    /// @dev UTC day index the running total belongs to.
    uint64 public spendDay;
    uint256 public spentToday;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event Spent(address indexed target, uint256 amount, bytes32 indexed tradeRef);
    event SpenderChanged(address indexed previous, address indexed next);
    event Killed(address indexed previous, uint64 at);
    event CapsChanged(uint256 perTx, uint256 perDay);
    event TargetSet(address indexed target, bool allowed);
    event OwnershipTransferStarted(address indexed previous, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    error NotOwner();
    error NotSpender();
    error NotPendingOwner();
    error ZeroAddress();
    error ZeroAmount();
    error SpenderIsOwner();
    error TargetNotAllowed();
    error ExceedsPerTxCap();
    error ExceedsPerDayCap();
    error InsufficientBalance();
    error NoSpender();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * @param initialSpender The agent. May be zero — a vault with no agent is a
     *        perfectly good vault, and it is the state {kill} returns to.
     */
    constructor(
        address token_,
        address initialOwner,
        address initialSpender,
        uint256 initialPerTxCap,
        uint256 initialPerDayCap
    ) {
        if (token_ == address(0) || initialOwner == address(0)) revert ZeroAddress();
        // The invariant the whole contract rests on. An agent that is also the
        // owner has already won every argument the caps below are having.
        if (initialSpender == initialOwner) revert SpenderIsOwner();

        token = IERC20(token_);
        owner = initialOwner;
        spender = initialSpender;
        perTxCap = initialPerTxCap;
        perDayCap = initialPerDayCap;

        emit OwnershipTransferred(address(0), initialOwner);
        emit SpenderChanged(address(0), initialSpender);
        emit CapsChanged(initialPerTxCap, initialPerDayCap);
    }

    // ─────────────────────────── the owner's money ───────────────────────────

    /**
     * @notice Fund the vault. Open to anyone — a third party topping up a
     *         player's agent takes nothing from them and adds no attack.
     */
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    /**
     * @notice Take money out. Owner only, always available.
     *
     * No pause, no timelock, no agent involvement. Whatever the agent is doing,
     * however wedged the off-chain runtime is, whoever has been compromised —
     * the owner can empty this in one transaction. That is the difference
     * between a spending limit and custody.
     */
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > token.balanceOf(address(this))) revert InsufficientBalance();

        token.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    /// @notice Everything, to the owner. The button you want at 3am.
    function withdrawAll() external onlyOwner nonReentrant {
        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) revert ZeroAmount();
        token.safeTransfer(owner, balance);
        emit Withdrawn(owner, balance);
    }

    // ─────────────────────────── the agent's allowance ──────────────────────

    /**
     * @notice Pay an allowlisted target, within the caps.
     *
     * The only function the agent can call, and the only way money leaves this
     * contract other than the owner withdrawing it.
     *
     * `tradeRef` is an opaque tag the off-chain runtime uses to tie a payment
     * to the trade that caused it — a hint trade id, in practice. It is logged
     * and never interpreted here: this contract does not know what a hint is,
     * and a vault that had to understand the market it funds would need
     * upgrading every time the market changed.
     */
    function spend(address target, uint256 amount, bytes32 tradeRef) external nonReentrant {
        address agent = spender;
        if (agent == address(0)) revert NoSpender();
        if (msg.sender != agent) revert NotSpender();
        if (amount == 0) revert ZeroAmount();

        // Allowlist before caps: paying the wrong address is unrecoverable,
        // while paying too much is merely refused.
        if (!allowed[target]) revert TargetNotAllowed();
        if (amount > perTxCap) revert ExceedsPerTxCap();
        if (amount > token.balanceOf(address(this))) revert InsufficientBalance();

        _chargeDailyCap(amount);

        token.safeTransfer(target, amount);
        emit Spent(target, amount, tradeRef);
    }

    /**
     * @dev Rolls the daily bucket on a UTC boundary and charges it.
     *
     * Fixed days rather than a sliding window, for the same reason
     * `LootGridEscrow` uses them: a sliding window needs stored history and more
     * gas to prove the same property, and this cap exists to bound a bad day's
     * damage rather than to be precise about which twenty-four hours it was.
     */
    function _chargeDailyCap(uint256 amount) private {
        uint64 today = uint64(block.timestamp / 1 days);
        if (today != spendDay) {
            spendDay = today;
            spentToday = 0;
        }
        if (spentToday + amount > perDayCap) revert ExceedsPerDayCap();
        spentToday += amount;
    }

    /// @notice What the agent may still spend today. For the UI and for the runtime.
    function remainingToday() external view returns (uint256) {
        if (uint64(block.timestamp / 1 days) != spendDay) return perDayCap;
        return spentToday >= perDayCap ? 0 : perDayCap - spentToday;
    }

    // ─────────────────────────── the owner's controls ───────────────────────

    /**
     * @notice Revoke the agent immediately.
     *
     * Incident response, and it is one transaction with no arguments on
     * purpose: anything that needs a parameter is something to get wrong while
     * panicking. Afterwards the vault has no spender, the money is untouched,
     * and the owner can withdraw or bind a new agent at their leisure.
     */
    function kill() external onlyOwner {
        address previous = spender;
        if (previous == address(0)) revert NoSpender();
        spender = address(0);
        emit Killed(previous, uint64(block.timestamp));
        emit SpenderChanged(previous, address(0));
    }

    /// @notice Rotate the agent. The routine move after a suspected compromise.
    function setSpender(address next) external onlyOwner {
        if (next == owner) revert SpenderIsOwner();
        emit SpenderChanged(spender, next);
        spender = next;
    }

    /**
     * @notice Set both caps.
     *
     * Lowering one takes effect immediately, including mid-day: a player who
     * has just watched their agent do something stupid should not have to wait
     * for a UTC boundary to stop it happening again.
     */
    function setCaps(uint256 perTx, uint256 perDay) external onlyOwner {
        perTxCap = perTx;
        perDayCap = perDay;
        emit CapsChanged(perTx, perDay);
    }

    /**
     * @notice Allow or forbid a payment target.
     *
     * The list is empty at deployment, so a fresh vault's agent can pay nobody
     * at all. That is the right default: an agent that can spend before its
     * owner has said where is an agent with an unbounded blast radius on day one.
     */
    function setTarget(address target, bool value) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        allowed[target] = value;
        emit TargetSet(target, value);
    }

    /// @notice Set several targets at once, for a UI that configures in one step.
    function setTargets(address[] calldata targets, bool value) external onlyOwner {
        for (uint256 i = 0; i < targets.length; i++) {
            address target = targets[i];
            if (target == address(0)) revert ZeroAddress();
            allowed[target] = value;
            emit TargetSet(target, value);
        }
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        // The new owner must not already be the agent, or accepting would
        // collapse the two roles and silently void every cap.
        if (next == spender) revert SpenderIsOwner();
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        // Re-checked at acceptance: the spender may have been rotated to this
        // address in between, and the invariant has to hold at the moment it
        // starts mattering rather than only when it was proposed.
        if (msg.sender == spender) revert SpenderIsOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}
