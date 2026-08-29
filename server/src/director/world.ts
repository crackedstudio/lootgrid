import { z } from 'zod';
import { hashInt } from '../hash';
import { logger } from '../logger';
import * as metrics from '../metrics';
import { complete } from '../agents/inference';

/**
 * The weather over a zone.
 *
 * ─────────────────────────── why this is the cheap way to be dynamic ────────
 *
 * The expensive way to make agents feel alive is to let each one think more.
 * That runs straight into the throughput wall: `runtime.MAX_IN_FLIGHT` gates
 * every provider call in the process, and per-agent spontaneity multiplies
 * against it.
 *
 * This is the other direction, and it borrows the Director's best property. A
 * directive is computed **once per round and broadcast identically to every
 * racer**; a condition is computed once per zone per epoch and broadcast to
 * everyone in the zone. One call, one minute and a half, however many players
 * and agents are standing in it. Cost does not scale with population — which is
 * exactly the shape the seat budget can afford.
 *
 * ─────────────────────────── the same four constraints ──────────────────────
 *
 * Inherited deliberately from `director/index.ts`, because they are what make it
 * safe to put a model near live play at all:
 *
 *   1. **Typed output.** {@link conditionSchema} is strict. A hijacked model
 *      picks one of five words and a number from 1 to 3.
 *   2. **Per-epoch and broadcast.** Write-once per (zone, epoch). Two players
 *      looking at the same zone at the same moment cannot see different weather.
 *   3. **Pipelined.** Epoch N+1 is chosen during epoch N.
 *   4. **Nothing waits.** {@link conditionFor} is synchronous, for the reason
 *      `directiveFor` is: a promise here would put a model in the path of a
 *      screen refresh, and somebody would later widen the timeout.
 *
 * ─────────────────────────── what it may and may not touch ──────────────────
 *
 * A condition changes how **agents behave**. It does not change energy, prices,
 * payouts, tile distribution or the odds of anything — and it must not learn to.
 * The reason is the one `types.ts` gives about blinding the Director: a model
 * that can move money is a payout-manipulation surface whose abuse is
 * indistinguishable from variance, and no amount of enum-typing fixes that.
 *
 * So the blast radius of a fully hijacked world model is: the agents in one zone
 * act somewhat bolder or somewhat quieter for ninety seconds, each still inside
 * its own owner's spending ceiling, which the vault enforces on chain regardless.
 * That is a mood, not an economy.
 */

/**
 * The five weathers. A closed set, and `calm` is the commonest by design —
 * a zone where something dramatic is always happening has a baseline, not an
 * event, and players stop reading it within a session.
 */
export const CONDITIONS = ['calm', 'goldrush', 'fogbank', 'hush', 'scramble'] as const;
export type ConditionKind = (typeof CONDITIONS)[number];

export const conditionSchema = z
  .object({
    kind: z.enum(CONDITIONS),
    /** How strongly it bites, 1–3. Bounded so a bad answer is a small one. */
    intensity: z.number().int().min(1).max(3),
  })
  .strict();

export type Condition = z.infer<typeof conditionSchema>;

/**
 * How long one weather lasts.
 *
 * Long enough that a player notices it and can name it, short enough that a dull
 * one is over before it becomes the zone's personality. Ninety seconds is also
 * eighteen agent ticks, so an agent with the most patient persona still acts
 * several times inside a single condition.
 */
export const EPOCH_MS = 90_000;

export const epochOf = (now: number): number => Math.floor(now / EPOCH_MS);

/**
 * The weather a zone has when nobody asked a model.
 *
 * Deterministic from the zone and the epoch, so every process computes the same
 * one without coordinating, and anybody can recompute last hour's weather from
 * the two numbers that produced it. `calm` takes half the draw.
 */
export function fallbackCondition(zoneId: string, epoch: number): Condition {
  const roll = hashInt(zoneId, `world:${epoch}`);
  if (roll % 2 === 0) return { kind: 'calm', intensity: 1 };

  return {
    kind: CONDITIONS[hashInt(zoneId, `worldpick:${epoch}`) % CONDITIONS.length]!,
    intensity: 1 + (hashInt(zoneId, `worldint:${epoch}`) % 3),
  };
}

/**
 * What the world model is allowed to see.
 *
 * Counts and totals only — the same blinding rule the Director follows. There is
 * no field here for a handle, an address or a balance, so a condition cannot be
 * aimed at a player even by a model actively trying to.
 */
export interface ZonePulse {
  /** Players and agents present. A count, never a roster. */
  population: number;
  /** Hunts currently open in the zone. */
  openHunts: number;
  /** Racers across those hunts. Bustle, cheaply — one indexed count per hunt. */
  activeChasers: number;
}

interface ZoneState {
  issued: Map<number, Condition>;
  ready: Map<number, Condition>;
  inFlight: Set<number>;
}

const zones = new Map<string, ZoneState>();

function stateOf(zoneId: string): ZoneState {
  let s = zones.get(zoneId);
  if (!s) {
    s = { issued: new Map(), ready: new Map(), inFlight: new Set() };
    zones.set(zoneId, s);
  }
  return s;
}

/**
 * The condition over a zone right now. **Synchronous, always.**
 *
 * Write-once per epoch: two callers a moment apart get the identical object, so
 * the weather cannot differ between two players looking at the same zone.
 */
export function conditionFor(zoneId: string, pulse: ZonePulse, now = Date.now()): Condition {
  const epoch = epochOf(now);
  const state = stateOf(zoneId);

  const already = state.issued.get(epoch);
  if (already) return already;

  const prefetched = state.ready.get(epoch);
  const condition = prefetched ?? fallbackCondition(zoneId, epoch);

  state.issued.set(epoch, condition);
  state.ready.delete(epoch);
  metrics.worldConditionIssued.inc({
    source: prefetched ? 'model' : 'fallback',
    kind: condition.kind,
  });

  // Choose the next epoch while this one runs. Not awaited — this is the
  // pipeline, and awaiting here would put the model back on the read path.
  void prefetch(zoneId, epoch + 1, pulse);

  // Old epochs are never asked for again; a long-lived zone would otherwise
  // accumulate one entry per ninety seconds forever.
  prune(state, epoch);

  return condition;
}

/** How long a prefetch may take before its answer is stale rather than early. */
export const BUDGET_MS = 2_000;

/**
 * Choose an epoch ahead of time. Never throws, never blocks.
 *
 * A failure leaves the cache empty, which the next {@link conditionFor} reads as
 * "use the fallback" — the same outcome as never having tried.
 */
export async function prefetch(zoneId: string, epoch: number, pulse: ZonePulse): Promise<void> {
  const state = stateOf(zoneId);
  if (state.issued.has(epoch) || state.ready.has(epoch) || state.inFlight.has(epoch)) return;

  state.inFlight.add(epoch);
  const fallback = fallbackCondition(zoneId, epoch);

  try {
    const started = Date.now();
    const response = await complete({
      system:
        'You set the mood over one zone of a treasure-hunt game. Reply with one JSON object and nothing else.',
      user: promptFor(pulse, fallback),
      maxTokens: 60,
    });

    if (Date.now() - started > BUDGET_MS) {
      metrics.worldConditionDropped.inc({ reason: 'too_slow' });
      return;
    }
    if (!response.ok) {
      metrics.worldConditionDropped.inc({ reason: response.reason });
      return;
    }

    const parsed = parseCondition(response.text);
    if (!parsed) {
      // Containment working as intended: a model that emitted something other
      // than a legal condition contributes nothing at all.
      metrics.worldConditionDropped.inc({ reason: 'not_a_condition' });
      return;
    }

    if (!state.issued.has(epoch)) state.ready.set(epoch, parsed);
  } catch (err) {
    logger.warn({ err, zoneId, epoch }, 'world prefetch failed');
    metrics.worldConditionDropped.inc({ reason: 'error' });
  } finally {
    state.inFlight.delete(epoch);
  }
}

/** Tolerant of markdown fencing, unforgiving about everything else. */
export function parseCondition(text: string): Condition | null {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const result = conditionSchema.safeParse(JSON.parse(trimmed));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function promptFor(pulse: ZonePulse, fallback: Condition): string {
  return [
    'You are choosing the atmosphere over one zone for the next 90 seconds.',
    `${pulse.population} players present. ${pulse.openHunts} hunts open. ${pulse.activeChasers} racing.`,
    'A busy zone can afford a livelier mood; a quiet one usually wants calm.',
    'Reply with one JSON object and nothing else:',
    '{"kind":"calm|goldrush|fogbank|hush|scramble","intensity":1-3}',
    `If unsure, reply exactly: ${JSON.stringify(fallback)}`,
  ].join('\n');
}

/**
 * How a condition bends the agents standing in it.
 *
 * Multipliers rather than absolutes, and every one of them lands on a persona
 * trait — which is itself clamped to the owner's configured ceiling by
 * `persona.effective`. So the chain is: weather bends temperament, temperament
 * bends how much of the owner's budget gets used, and the owner's budget is
 * still the ceiling. Weather can make an agent keen. It cannot make it rich.
 */
export function moodFor(condition: Condition): { boldness: number; chattiness: number } {
  const k = condition.intensity / 3;
  switch (condition.kind) {
    // Everyone piles in and talks over each other.
    case 'goldrush':
      return { boldness: 1 + 0.4 * k, chattiness: 1 + 0.3 * k };
    // Nobody can see much, so nobody commits.
    case 'fogbank':
      return { boldness: 1 - 0.3 * k, chattiness: 1 - 0.1 * k };
    // The market goes quiet without anyone getting shy about hunting.
    case 'hush':
      return { boldness: 1, chattiness: 1 - 0.6 * k };
    // Restless: lots of chatter, no more appetite for risk.
    case 'scramble':
      return { boldness: 1 - 0.1 * k, chattiness: 1 + 0.5 * k };
    case 'calm':
    default:
      return { boldness: 1, chattiness: 1 };
  }
}

/** Keeps only the current and next epoch — the only two anyone can ask for. */
function prune(state: ZoneState, epoch: number): void {
  for (const key of state.issued.keys()) if (key < epoch) state.issued.delete(key);
  for (const key of state.ready.keys()) if (key < epoch) state.ready.delete(key);
}

/** Test-only: forgets every zone. */
export function reset(): void {
  zones.clear();
}
