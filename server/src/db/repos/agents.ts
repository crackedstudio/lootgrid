import { getDb } from '../index';
import { configSchema, defaultConfig, type AgentConfig, type AgentStatus } from '../../agents/config';

/**
 * Storage for player agents.
 *
 * Two rules this repo keeps, both load-bearing:
 *
 *   * **No key material, ever.** An agent's signing key is derived from a server
 *     secret (see `agents/identity.ts`), so there is nothing here that can move
 *     money — which matters because this database is backed up by copying a file.
 *
 *   * **Nothing here is authoritative over spending.** The vault enforces its own
 *     caps on chain. These rows are the cheap first check, so an agent that would
 *     be refused never gets as far as a transaction. If the two disagree, the
 *     contract is right.
 */

export interface Agent {
  /** The agent's address, and its bound session key. */
  id: string;
  playerId: string;
  /** AgentVault address, read back from the factory. Null until deployed. */
  vault: string | null;
  status: AgentStatus;
  createdAt: number;
  updatedAt: number;
}

export type SpendKind = 'hint' | 'inference';

export interface SpendRow {
  id: number;
  agentId: string;
  kind: SpendKind;
  amountMills: number;
  huntId: string | null;
  tradeRef: string | null;
  spentAt: number;
}

interface AgentRaw {
  id: string;
  player_id: string;
  vault: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface ConfigRaw {
  agent_id: string;
  aggression: number;
  max_hint_price_cents: number;
  daily_budget_cents: number;
  inference_mills_per_hunt: number;
  zones: string;
  min_reliability_bps: number;
  updated_at: number;
}

const toAgent = (r: AgentRaw): Agent => ({
  id: r.id,
  playerId: r.player_id,
  vault: r.vault,
  status: r.status as AgentStatus,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Rehydrate a stored config through the same parser untrusted input uses.
 *
 * A row that no longer validates — hand-edited, or written before a bound
 * changed — falls back to defaults rather than being trusted. The alternative is
 * an agent running with a spending limit nobody ever chose.
 */
function toConfig(r: ConfigRaw): AgentConfig {
  let zones: unknown = [];
  try {
    zones = JSON.parse(r.zones);
  } catch {
    zones = [];
  }

  const parsed = configSchema.safeParse({
    aggression: r.aggression,
    maxHintPriceCents: r.max_hint_price_cents,
    dailyBudgetCents: r.daily_budget_cents,
    inferenceMillsPerHunt: r.inference_mills_per_hunt,
    zones,
    minReliabilityBps: r.min_reliability_bps,
  });
  return parsed.success ? parsed.data : defaultConfig();
}

let cache: ReturnType<typeof build> | null = null;

function build() {
  const db = getDb();
  return {
    insert: db.prepare(`
      INSERT INTO agents (id, player_id, vault, status, created_at, updated_at)
      VALUES (@id, @playerId, @vault, @status, @now, @now)
      ON CONFLICT (player_id) DO NOTHING
    `),
    get: db.prepare('SELECT * FROM agents WHERE id = ?'),
    ofPlayer: db.prepare('SELECT * FROM agents WHERE player_id = ?'),
    setVault: db.prepare('UPDATE agents SET vault = ?, updated_at = ? WHERE id = ?'),
    setStatus: db.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?'),
    // Agents the driver should wake. A vault is required: one without has
    // nothing to spend and nothing to protect.
    allActive: db.prepare(
      "SELECT * FROM agents WHERE status = 'active' AND vault IS NOT NULL ORDER BY created_at",
    ),

    putConfig: db.prepare(`
      INSERT INTO agent_config (agent_id, aggression, max_hint_price_cents, daily_budget_cents,
                                inference_mills_per_hunt, zones, min_reliability_bps, updated_at)
      VALUES (@agentId, @aggression, @maxHintPriceCents, @dailyBudgetCents,
              @inferenceMillsPerHunt, @zones, @minReliabilityBps, @now)
      ON CONFLICT (agent_id) DO UPDATE SET
        aggression = @aggression,
        max_hint_price_cents = @maxHintPriceCents,
        daily_budget_cents = @dailyBudgetCents,
        inference_mills_per_hunt = @inferenceMillsPerHunt,
        zones = @zones,
        min_reliability_bps = @minReliabilityBps,
        updated_at = @now
    `),
    getConfig: db.prepare('SELECT * FROM agent_config WHERE agent_id = ?'),

    addSpend: db.prepare(`
      INSERT INTO agent_spend (agent_id, kind, amount_mills, hunt_id, trade_ref, spent_at)
      VALUES (@agentId, @kind, @amountMills, @huntId, @tradeRef, @spentAt)
    `),
    // The two questions the ledger exists to answer.
    spentSince: db.prepare(
      'SELECT COALESCE(SUM(amount_mills), 0) AS total FROM agent_spend WHERE agent_id = ? AND spent_at >= ?',
    ),
    spentOnHunt: db.prepare(
      'SELECT COALESCE(SUM(amount_mills), 0) AS total FROM agent_spend WHERE agent_id = ? AND hunt_id = ? AND kind = ?',
    ),
    recentSpend: db.prepare(
      'SELECT * FROM agent_spend WHERE agent_id = ? ORDER BY spent_at DESC LIMIT ?',
    ),
  };
}

const s = () => (cache ??= build());

export function resetStatements(): void {
  cache = null;
}

// ─────────────────────────── agents ───────────────────────────

export function create(id: string, playerId: string, now = Date.now()): Agent {
  s().insert.run({ id, playerId, vault: null, status: 'active', now });
  return ofPlayer(playerId)!;
}

export function get(id: string): Agent | null {
  const row = s().get.get(id) as AgentRaw | undefined;
  return row ? toAgent(row) : null;
}

export function ofPlayer(playerId: string): Agent | null {
  const row = s().ofPlayer.get(playerId) as AgentRaw | undefined;
  return row ? toAgent(row) : null;
}

/** Every agent the driver should consider this tick. */
export function allActive(): Agent[] {
  return (s().allActive.all() as AgentRaw[]).map(toAgent);
}

export function setVault(id: string, vault: string, now = Date.now()): void {
  s().setVault.run(vault, now, id);
}

export function setStatus(id: string, status: AgentStatus, now = Date.now()): void {
  s().setStatus.run(status, now, id);
}

// ─────────────────────────── config ───────────────────────────

export function putConfig(agentId: string, config: AgentConfig, now = Date.now()): void {
  s().putConfig.run({
    agentId,
    aggression: config.aggression,
    maxHintPriceCents: config.maxHintPriceCents,
    dailyBudgetCents: config.dailyBudgetCents,
    inferenceMillsPerHunt: config.inferenceMillsPerHunt,
    zones: JSON.stringify(config.zones),
    minReliabilityBps: config.minReliabilityBps,
    now,
  });
}

/** The stored config, or defaults. Never undefined — an agent always has limits. */
export function getConfig(agentId: string): AgentConfig {
  const row = s().getConfig.get(agentId) as ConfigRaw | undefined;
  return row ? toConfig(row) : defaultConfig();
}

// ─────────────────────────── spend ───────────────────────────

export function addSpend(
  agentId: string,
  kind: SpendKind,
  amountMills: number,
  opts: { huntId?: string | null; tradeRef?: string | null } = {},
  now = Date.now(),
): void {
  s().addSpend.run({
    agentId,
    kind,
    amountMills,
    huntId: opts.huntId ?? null,
    tradeRef: opts.tradeRef ?? null,
    spentAt: now,
  });
}

/** Everything spent since a timestamp, in mills. Both kinds — see the migration. */
export function spentSince(agentId: string, since: number): number {
  return (s().spentSince.get(agentId, since) as { total: number }).total;
}

export function spentOnHunt(agentId: string, huntId: string, kind: SpendKind): number {
  return (s().spentOnHunt.get(agentId, huntId, kind) as { total: number }).total;
}

export function recentSpend(agentId: string, limit = 50): SpendRow[] {
  const rows = s().recentSpend.all(agentId, limit) as Array<{
    id: number;
    agent_id: string;
    kind: string;
    amount_mills: number;
    hunt_id: string | null;
    trade_ref: string | null;
    spent_at: number;
  }>;
  return rows.map(r => ({
    id: r.id,
    agentId: r.agent_id,
    kind: r.kind as SpendKind,
    amountMills: r.amount_mills,
    huntId: r.hunt_id,
    tradeRef: r.trade_ref,
    spentAt: r.spent_at,
  }));
}
