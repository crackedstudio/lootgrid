import { logger } from '../logger';
import * as metrics from '../metrics';
import type { Difficulty } from '../types';
import { complete } from '../agents/inference';
import { fallbackDirective, promptFor } from './fallback';
import { Transcript } from './transcript';
import { blind, parseDirective, type BlindState, type Directive } from './types';

/**
 * The Director: picks each round while the hunt runs.
 *
 * ─────────────────────────── four constraints ───────────────────────────
 *
 * Architecture §4 lists them, and every one is structural here rather than a
 * rule to remember:
 *
 *   1. **Typed output.** `types.ts` rejects anything that is not a legal
 *      directive, extra fields included. A hijacked model picks a number.
 *   2. **Per-round and broadcast.** A directive is computed once per round and
 *      cached; every racer in that round is handed the identical object, or it
 *      is not a race. A round already issued can never be overwritten.
 *   3. **Pipelined.** Round N+1 is chosen during round N.
 *   4. **Gameplay never waits.** {@link directiveFor} is *synchronous*. Not
 *      "usually fast" — it cannot await, so there is no code path on which a
 *      slow model delays a round. Past the budget the deterministic fallback
 *      supplies it and the pipeline catches up on the next round.
 *
 * Making (4) a type-level property rather than a timeout is the load-bearing
 * decision in this file. A promise-returning `directiveFor` with a 200ms race
 * inside would satisfy the letter of the constraint and leave a `await` sitting
 * in the critical path for somebody to widen later.
 *
 * ─────────────────────────── blind by construction ───────────────────────────
 *
 * The Director never sees who is playing. Its only input is a {@link BlindState}
 * — a sorted progress array, a count and a clock — and there is no field in that
 * type to put an identity in. A Director that knew who was winning and could
 * raise the difficulty would be a payout-manipulation surface, and one whose
 * abuse would be indistinguishable from bad luck.
 *
 * ─────────────────────────── no wallet, no writes, no HTTP ──────────────────
 *
 * This module imports the inference seam, the logger, metrics and its own pure
 * helpers. It imports no signer, no repository, no chain client. `director.test`
 * asserts that against the source, because "we did not give it a wallet" is the
 * kind of property that quietly stops being true.
 */

export interface HuntContext {
  huntId: string;
  salt: string;
  difficulty: Difficulty;
}

/**
 * How long a prefetch may take before its answer is discarded.
 *
 * Architecture §4 says ~200ms. It applies to the *prefetch*, not to gameplay:
 * by the time a round needs its directive the answer is either cached or it is
 * not, and nothing waits either way. A late answer is dropped rather than used,
 * because a directive that arrived after its round started would break the
 * broadcast guarantee — some racers would have seen the fallback.
 */
export const BUDGET_MS = 200;

interface Session {
  context: HuntContext;
  transcript: Transcript;
  /** round → the directive issued for it. Write-once. */
  issued: Map<number, Directive>;
  /** round → a directive fetched ahead of time, not yet issued. */
  ready: Map<number, Directive>;
  inFlight: Set<number>;
}

const sessions = new Map<string, Session>();

/** Begin directing a hunt. Idempotent — a second call keeps the existing chain. */
export function open(context: HuntContext): void {
  if (sessions.has(context.huntId)) return;
  sessions.set(context.huntId, {
    context,
    transcript: new Transcript(context.huntId, context.salt),
    issued: new Map(),
    ready: new Map(),
    inFlight: new Set(),
  });
}

export function close(huntId: string): void {
  sessions.delete(huntId);
}

export const transcriptOf = (huntId: string) => sessions.get(huntId)?.transcript ?? null;

/**
 * The directive for a round. **Synchronous, always.**
 *
 * Returns the prefetched directive if one landed in time, otherwise the
 * deterministic fallback — and either way records it in the transcript and
 * starts choosing the next round.
 *
 * The same round asked twice returns the same object: a directive is issued
 * once, so two racers reaching a round a moment apart cannot be handed
 * different games.
 */
export function directiveFor(
  huntId: string,
  round: number,
  state: BlindState,
  now = Date.now(),
): Directive {
  const session = sessions.get(huntId);
  if (!session) {
    // Not being directed. Callers should have opened a session, but a missing
    // one must degrade to the old behaviour rather than throw mid-hunt.
    return fallbackDirective('', huntId, round, 'med');
  }

  const already = session.issued.get(round);
  if (already) return already;

  const prefetched = session.ready.get(round);
  const directive =
    prefetched ??
    fallbackDirective(session.context.salt, huntId, round, session.context.difficulty);

  // Write-once, before anything else can observe it.
  session.issued.set(round, directive);
  session.ready.delete(round);
  session.transcript.append(round, directive, now);

  metrics.directiveIssued.inc({ source: prefetched ? 'model' : 'fallback' });

  // Choose the NEXT round while this one plays. Deliberately not awaited — this
  // is the pipeline, and awaiting it here would put the model back in the
  // critical path it was moved out of.
  void prefetch(huntId, round + 1, state);

  return directive;
}

/**
 * Choose a round ahead of time.
 *
 * Never throws and never blocks a caller. A failure leaves the cache empty,
 * which the next `directiveFor` reads as "use the fallback" — the same outcome
 * as never having tried.
 */
export async function prefetch(huntId: string, round: number, state: BlindState): Promise<void> {
  const session = sessions.get(huntId);
  if (!session) return;
  if (session.issued.has(round) || session.ready.has(round) || session.inFlight.has(round)) return;

  session.inFlight.add(round);
  const fallback = fallbackDirective(
    session.context.salt,
    huntId,
    round,
    session.context.difficulty,
  );

  try {
    const started = Date.now();
    const response = await complete({
      system: 'You set the difficulty of one round. Reply with one JSON object and nothing else.',
      user: promptFor({ ...state, round }, fallback),
      maxTokens: 80,
    });
    const took = Date.now() - started;

    if (took > BUDGET_MS) {
      // Too late to be trusted. Using it now would mean some racers had already
      // been handed the fallback for this round.
      metrics.directiveDropped.inc({ reason: 'too_slow' });
      return;
    }
    if (!response.ok) {
      metrics.directiveDropped.inc({ reason: response.reason });
      return;
    }

    const parsed = parseDirective(response.text);
    if (!parsed.ok) {
      // The containment working as intended: a model that emitted something
      // other than a legal directive contributes nothing at all.
      metrics.directiveDropped.inc({ reason: parsed.reason });
      return;
    }

    // Still unissued? A round can be reached while its prefetch is in flight.
    if (!session.issued.has(round)) session.ready.set(round, parsed.directive);
  } catch (err) {
    logger.warn({ err, huntId, round }, 'director prefetch failed');
    metrics.directiveDropped.inc({ reason: 'error' });
  } finally {
    session.inFlight.delete(round);
  }
}

/**
 * Build the Director's view of a hunt.
 *
 * Takes progress values already separated from their owners: the caller cannot
 * hand this an attempt object, which is what keeps identity out by construction
 * rather than by discipline.
 */
export const stateFrom = blind;

/** Test-only: forgets every hunt. */
export function reset(): void {
  sessions.clear();
}
