// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {AgentVaultFactory} from "../src/AgentVaultFactory.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * AgentVault.
 *
 * These tests assume the agent is hostile. Not because it is, but because it is
 * an LLM reading messages written by its rivals, and the only useful question
 * about such a thing is what it costs when it is eventually talked into
 * emptying the vault.
 *
 * The plan's gate for this phase names three properties, and each has a test
 * here that fails loudly if it stops holding:
 *
 *   * the vault cannot be drained beyond one capped transaction
 *   * the agent address can never equal the player address
 *   * withdrawal cannot be blocked by the agent
 */
contract AgentVaultTest is Test {
    AgentVault vault;
    MockERC20 token;

    address player = address(0xA11CE);
    address agent = address(0xA6E17);
    address market = address(0x4A2E7); // an allowlisted counterparty
    address attacker = address(0xBAD);

    uint256 constant PER_TX = 1e18; // $1
    uint256 constant PER_DAY = 5e18; // $5
    uint256 constant DEPOSIT = 100e18;

    bytes32 constant REF = keccak256("trade-1");

    function setUp() public {
        token = new MockERC20();
        vault = new AgentVault(address(token), player, agent, PER_TX, PER_DAY);

        token.mint(player, DEPOSIT);
        vm.startPrank(player);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(DEPOSIT);
        vault.setTarget(market, true);
        vm.stopPrank();

        vm.warp(1_700_000_000);
    }

    function spendAs(address who, address target, uint256 amount) internal {
        vm.prank(who);
        vault.spend(target, amount, REF);
    }

    // ── the happy path ───────────────────────────────────────────────────────

    function test_agentSpendsWithinItsAllowance() public {
        spendAs(agent, market, 0.5e18);
        assertEq(token.balanceOf(market), 0.5e18);
        assertEq(vault.remainingToday(), PER_DAY - 0.5e18);
    }

    function test_ownerDepositsAndWithdraws() public {
        vm.prank(player);
        vault.withdraw(player, 10e18);
        assertEq(token.balanceOf(player), 10e18);
    }

    /// Anyone may fund someone else's agent — it takes nothing from them.
    function test_depositIsOpen() public {
        token.mint(attacker, 1e18);
        vm.startPrank(attacker);
        token.approve(address(vault), 1e18);
        vault.deposit(1e18);
        vm.stopPrank();
        assertEq(token.balanceOf(address(vault)), DEPOSIT + 1e18);
    }

    // ── the blast radius ─────────────────────────────────────────────────────

    /**
     * THE test for this phase. A fully compromised agent, spending as fast as
     * it can, at an address the player did approve.
     */
    function test_compromisedAgentCannotDrainBeyondTheCaps() public {
        // It tries for everything, repeatedly, all day.
        for (uint256 i = 0; i < 20; i++) {
            vm.prank(agent);
            try vault.spend(market, PER_TX, REF) {} catch {}
        }

        // One day's cap. Not one deposit.
        assertEq(token.balanceOf(market), PER_DAY);
        assertEq(token.balanceOf(address(vault)), DEPOSIT - PER_DAY);
        assertEq(vault.remainingToday(), 0);
    }

    function test_spend_rejectsAbovePerTxCap() public {
        vm.prank(agent);
        vm.expectRevert(AgentVault.ExceedsPerTxCap.selector);
        vault.spend(market, PER_TX + 1, REF);
    }

    function test_spend_rejectsAbovePerDayCap() public {
        for (uint256 i = 0; i < 5; i++) {
            spendAs(agent, market, PER_TX);
        }

        vm.prank(agent);
        vm.expectRevert(AgentVault.ExceedsPerDayCap.selector);
        vault.spend(market, 1, REF);
    }

    function test_dailyCapRollsOver() public {
        for (uint256 i = 0; i < 5; i++) {
            spendAs(agent, market, PER_TX);
        }
        assertEq(vault.remainingToday(), 0);

        vm.warp(block.timestamp + 1 days);
        assertEq(vault.remainingToday(), PER_DAY);
        spendAs(agent, market, PER_TX);
        assertEq(token.balanceOf(market), PER_DAY + PER_TX);
    }

    /**
     * The allowlist is the control that matters most, because paying the wrong
     * address is the one mistake no cap can undo.
     */
    function test_spend_rejectsAnAddressTheOwnerNeverApproved() public {
        vm.prank(agent);
        vm.expectRevert(AgentVault.TargetNotAllowed.selector);
        vault.spend(attacker, 1, REF);
    }

    function test_freshVaultCanPayNobody() public {
        AgentVault fresh = new AgentVault(address(token), player, agent, PER_TX, PER_DAY);
        token.mint(address(fresh), 10e18);

        // An agent that can spend before its owner has said where would have an
        // unbounded blast radius on the day it is created.
        vm.prank(agent);
        vm.expectRevert(AgentVault.TargetNotAllowed.selector);
        fresh.spend(market, 1, REF);
    }

    function test_ownerCanRevokeATarget() public {
        vm.prank(player);
        vault.setTarget(market, false);

        vm.prank(agent);
        vm.expectRevert(AgentVault.TargetNotAllowed.selector);
        vault.spend(market, 1, REF);
    }

    // ── the agent is a spender, never a key holder ───────────────────────────

    function test_agentCannotWithdraw() public {
        vm.prank(agent);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.withdraw(agent, 1);

        vm.prank(agent);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.withdrawAll();
    }

    function test_agentCannotRaiseItsOwnLimits() public {
        vm.startPrank(agent);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setCaps(type(uint256).max, type(uint256).max);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setTarget(attacker, true);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setSpender(attacker);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.transferOwnership(attacker);
        vm.stopPrank();
    }

    function test_strangersCannotSpend() public {
        vm.prank(attacker);
        vm.expectRevert(AgentVault.NotSpender.selector);
        vault.spend(market, 1, REF);
    }

    // ── the invariant the caps rest on ───────────────────────────────────────

    function test_constructor_rejectsAgentEqualToPlayer() public {
        // If these were the same address every cap above would be decorative:
        // the agent would simply withdraw.
        vm.expectRevert(AgentVault.SpenderIsOwner.selector);
        new AgentVault(address(token), player, player, PER_TX, PER_DAY);
    }

    function test_setSpender_rejectsTheOwner() public {
        vm.prank(player);
        vm.expectRevert(AgentVault.SpenderIsOwner.selector);
        vault.setSpender(player);
    }

    function test_ownershipCannotBeHandedToTheAgent() public {
        vm.prank(player);
        vm.expectRevert(AgentVault.SpenderIsOwner.selector);
        vault.transferOwnership(agent);
    }

    function test_ownershipCannotBeAcceptedByTheCurrentAgent() public {
        // The gap that a constructor check alone would miss: propose to a third
        // party, rotate the agent to that same address, then accept.
        address newOwner = address(0xC0FFEE);
        vm.prank(player);
        vault.transferOwnership(newOwner);

        vm.prank(player);
        vault.setSpender(newOwner);

        vm.prank(newOwner);
        vm.expectRevert(AgentVault.SpenderIsOwner.selector);
        vault.acceptOwnership();
    }

    function test_ownershipTransferIsTwoStep() public {
        address newOwner = address(0xC0FFEE);
        vm.prank(player);
        vault.transferOwnership(newOwner);
        assertEq(vault.owner(), player, "ownership must not move on the offer alone");

        vm.prank(newOwner);
        vault.acceptOwnership();
        assertEq(vault.owner(), newOwner);
    }

    // ── incident response ────────────────────────────────────────────────────

    function test_killRevokesInstantly() public {
        vm.prank(player);
        vault.kill();

        assertEq(vault.spender(), address(0));
        vm.prank(agent);
        vm.expectRevert(AgentVault.NoSpender.selector);
        vault.spend(market, 1, REF);
    }

    function test_killLeavesTheMoneyWhereItIs() public {
        vm.prank(player);
        vault.kill();
        assertEq(token.balanceOf(address(vault)), DEPOSIT);

        // And the owner can still get it out afterwards.
        vm.prank(player);
        vault.withdrawAll();
        assertEq(token.balanceOf(player), DEPOSIT);
    }

    function test_killIsOwnerOnly() public {
        vm.prank(agent);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.kill();
    }

    function test_lowerCapsBiteImmediately() public {
        spendAs(agent, market, PER_TX);

        // A player who has just watched their agent do something stupid should
        // not have to wait for a UTC boundary to stop it happening again.
        vm.prank(player);
        vault.setCaps(0.1e18, 0.1e18);

        vm.prank(agent);
        vm.expectRevert(AgentVault.ExceedsPerDayCap.selector);
        vault.spend(market, 0.1e18, REF);
    }

    /**
     * Withdrawal has no dependency on the agent, the runtime, or anything the
     * agent can influence. A vault whose owner must ask permission to leave is
     * custody, and this is deliberately not custody.
     */
    function test_withdrawalCannotBeBlocked() public {
        // Agent mid-spree, daily cap exhausted, vault as busy as it ever gets.
        for (uint256 i = 0; i < 5; i++) {
            spendAs(agent, market, PER_TX);
        }

        vm.prank(player);
        vault.withdrawAll();
        assertEq(token.balanceOf(player), DEPOSIT - PER_DAY);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    // ── arithmetic ───────────────────────────────────────────────────────────

    function test_spend_rejectsMoreThanTheVaultHolds() public {
        vm.prank(player);
        vault.withdraw(player, DEPOSIT - 0.1e18);

        vm.prank(agent);
        vm.expectRevert(AgentVault.InsufficientBalance.selector);
        vault.spend(market, 0.5e18, REF);
    }

    function test_withdraw_rejectsMoreThanTheVaultHolds() public {
        vm.prank(player);
        vm.expectRevert(AgentVault.InsufficientBalance.selector);
        vault.withdraw(player, DEPOSIT + 1);
    }

    function testFuzz_neverPaysMoreThanTheDailyCap(uint256[8] calldata amounts) public {
        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 amount = bound(amounts[i], 1, PER_TX);
            vm.prank(agent);
            try vault.spend(market, amount, REF) {} catch {}
        }
        assertLe(token.balanceOf(market), PER_DAY);
    }

    function test_zeroAmountsAreRefusedEverywhere() public {
        vm.prank(agent);
        vm.expectRevert(AgentVault.ZeroAmount.selector);
        vault.spend(market, 0, REF);

        vm.startPrank(player);
        vm.expectRevert(AgentVault.ZeroAmount.selector);
        vault.withdraw(player, 0);
        vm.expectRevert(AgentVault.ZeroAmount.selector);
        vault.deposit(0);
        vm.stopPrank();
    }

    /**
     * Celo's stablecoins are not uniform: some revert on failure, some return
     * false. A token that quietly returns false must not look like a payment.
     */
    function test_spend_revertsWhenTheTokenReturnsFalse() public {
        token.setReturnsFalse(true);
        vm.prank(agent);
        vm.expectRevert();
        vault.spend(market, 0.1e18, REF);
    }
}

/**
 * The factory.
 *
 * Its whole reason for existing is that the *player* is the deployer. If the
 * house could create a vault on someone's behalf, it would be choosing the
 * owner of a contract holding their money — so these tests are mostly about
 * that not being possible.
 */
contract AgentVaultFactoryTest is Test {
    AgentVaultFactory factory;
    MockERC20 token;

    address player = address(0xA11CE);
    address agent = address(0xA6E17);
    address house = address(0x4005E);

    function setUp() public {
        factory = new AgentVaultFactory();
        token = new MockERC20();
    }

    function test_playerOwnsTheVaultTheyCreate() public {
        vm.prank(player);
        AgentVault vault = factory.create(address(token), agent, 1e18, 5e18);

        // Owner is msg.sender and cannot be passed in.
        assertEq(vault.owner(), player);
        assertEq(vault.spender(), agent);
        assertEq(address(factory.vaultOf(player)), address(vault));
        assertTrue(factory.hasVault(player));
    }

    function test_houseCannotCreateAVaultItOwnsForSomeoneElse() public {
        // The closest the house can get is creating a vault for ITSELF, which
        // is not the player's vault and is not where the player's money goes.
        vm.prank(house);
        AgentVault vault = factory.create(address(token), agent, 1e18, 5e18);

        assertEq(vault.owner(), house);
        assertFalse(factory.hasVault(player), "the player still has no vault");
    }

    function test_refusesASecondVault() public {
        vm.startPrank(player);
        factory.create(address(token), agent, 1e18, 5e18);

        // Overwriting would strand the balance in the first vault while every
        // off-chain index pointed at the second. Rotate the spender instead.
        vm.expectRevert(AgentVaultFactory.VaultExists.selector);
        factory.create(address(token), agent, 1e18, 5e18);
        vm.stopPrank();
    }

    function test_refusesAnAgentEqualToThePlayer() public {
        // The invariant survives the extra layer.
        vm.prank(player);
        vm.expectRevert(AgentVault.SpenderIsOwner.selector);
        factory.create(address(token), player, 1e18, 5e18);
    }

    function test_vaultsAreIndependent() public {
        address other = address(0xB0B);
        vm.prank(player);
        AgentVault mine = factory.create(address(token), agent, 1e18, 5e18);
        vm.prank(other);
        AgentVault theirs = factory.create(address(token), agent, 2e18, 9e18);

        assertTrue(address(mine) != address(theirs));
        assertEq(mine.owner(), player);
        assertEq(theirs.owner(), other);

        // One player's kill switch does not touch another's vault.
        vm.prank(player);
        mine.kill();
        assertEq(mine.spender(), address(0));
        assertEq(theirs.spender(), agent);
    }
}
