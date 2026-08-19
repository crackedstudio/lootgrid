import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentRepo from './db/repos/agents';
import { defaultConfig } from './agents/config';
import * as store from './store';
import * as driver from './agents/driver';
import * as vaultChain from './chain/agentVault';
import * as metrics from './metrics';
import { freshWorld, makeAgedPlayer, teardownWorld } from './testing/harness';

/**
 * The agent sweep has to scale.
 *
 * Two properties, and both were broken in ways that only showed up as "agents
 * feel slow": the sweep ran agents one after another behind each other's
 * network calls, and it read the chain for every agent every tick whether or
 * not that agent had anything to do.
 */

const RPC_LATENCY_MS = 20;
let rpcReads = 0;

beforeEach(() => {
  freshWorld();
  metrics.registry.resetMetrics();
  rpcReads = 0;
  // A vault read that costs real wall time, which is what made the old sweep
  // serialise. Returns a live vault so nothing is treated as revoked.
  vaultChain.setTransportForTests(async (owner: string) => {
    rpcReads++;
    await new Promise(r => setTimeout(r, RPC_LATENCY_MS));
    return {
      address: `0x${'c'.repeat(40)}` as `0x${string}`,
      remainingToday: 10n ** 18n,
      perTxCap: 10n ** 18n,
      spender: agentOf(owner) as `0x${string}`,
    };
  }, null);
});

afterEach(() => {
  vaultChain.setTransportForTests(null, null);
  teardownWorld();
});

const agents = new Map<string, string>();
function agentOf(owner: string): string {
  return agents.get(owner.toLowerCase()) ?? '0x0000000000000000000000000000000000000000';
}

/**
 * N agents with vaults, each owned by an aged player.
 *
 * `busy` decides whether they are configured for the agent zone. An agent whose
 * config permits no zone has nothing to enter and is idle by definition — which
 * is a real state worth testing, and useless for timing the sweep.
 */
function seedAgents(n: number, busy = false): void {
  agents.clear();
  const agentZone = store.listZones().find(z => z.kind === 'agent')!;

  for (let i = 0; i < n; i++) {
    const owner = `0x${(i + 1).toString(16).padStart(40, '0')}`;
    const agentId = `0x${(i + 1 + 0xa0000).toString(16).padStart(40, '0')}`;
    makeAgedPlayer(owner);
    agentRepo.create(agentId, owner);
    agentRepo.setVault(agentId, `0x${(i + 1 + 0xb0000).toString(16).padStart(40, '0')}`);
    if (busy) {
      agentRepo.putConfig(agentId, { ...defaultConfig(), zones: [agentZone.id] });
    }
    agents.set(owner.toLowerCase(), agentId);
  }
}

describe('an idle agent costs no network', () => {
  it('does not read the chain when there is nothing to do', async () => {
    // No live attempts, no mail. Whether there is anything to ENTER depends on
    // the seeded world, so this asserts the relationship rather than zero:
    // reads never exceed the agents that were not idle.
    // Configured for no zone, so there is nothing any of them could enter.
    seedAgents(50);
    await driver.tick();

    expect(await counterValue('lootgrid_agent_ticks_total')).toBe(50);
    expect(await counterValue('lootgrid_agent_ticks_idle_total')).toBe(50);
    // Fifty agents, zero network. This is the change.
    expect(rpcReads).toBe(0);
  });

  it('does read the chain for an agent that has work', async () => {
    // Same agent, configured for the agent zone: now it has hunts to consider,
    // so the kill-switch check must still happen before it acts.
    seedAgents(1, true);
    await driver.tick();

    expect(await counterValue('lootgrid_agent_ticks_idle_total')).toBe(0);
    expect(rpcReads).toBe(1);
  });
});

describe('the sweep runs agents concurrently', () => {
  /**
   * The wall this removes.
   *
   * Serialised, 60 agents x 20ms of RPC is 1.2s — and at 50ms it was 3s against
   * a 5s tick, which is how a hundred agents became the ceiling. Concurrent, it
   * is bounded by SWEEP_CONCURRENCY instead of by the agent count.
   */
  it('finishes far faster than one-at-a-time would', async () => {
    seedAgents(60, true);

    const started = Date.now();
    await driver.tick();
    const elapsed = Date.now() - started;

    // Every one of them had work, so every one read the chain.
    expect(rpcReads).toBe(60);

    const serial = 60 * RPC_LATENCY_MS;
    // Bounded by SWEEP_CONCURRENCY rather than by the agent count.
    expect(elapsed).toBeLessThan(serial * 0.5);
  });
});

describe('an overrun is counted, not silent', () => {
  it('records a skipped sweep rather than returning quietly', async () => {
    seedAgents(20, true);
    // Two sweeps at once: the second must not silently vanish.
    await Promise.all([driver.tick(), driver.tick()]);
    expect(await counterValue('lootgrid_agent_sweep_skipped_total')).toBeGreaterThanOrEqual(1);
  });

  it('times every sweep, so a slow one is visible before it skips', async () => {
    seedAgents(5, true);
    await driver.tick();
    expect(await counterValue('lootgrid_agent_sweep_seconds_count')).toBe(1);
  });
});

async function counterValue(name: string): Promise<number> {
  const all = await metrics.registry.getMetricsAsJSON();
  for (const metric of all) {
    for (const v of metric.values ?? []) {
      const sample = (v as { metricName?: string }).metricName ?? metric.name;
      if (sample === name) return v.value;
    }
  }
  return 0;
}
