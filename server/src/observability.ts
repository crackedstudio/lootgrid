import * as attestor from './chain/attestor';
import * as relayer from './chain/relayer';
import * as hints from './hints';
import { logger } from './logger';
import * as metrics from './metrics';
import * as referee from './referee';
import * as store from './store';
import * as agentEarnings from './agents/earnings';

/**
 * Everything that watches the game without being part of it.
 *
 * ─────────────────────────── why this is not in index.ts ────────────────────
 *
 * It was, and that made it untestable. The referee deliberately exposes
 * `observers` rather than importing metrics and the relayer itself, so it stays
 * dependency-light — but the wiring then lived in the process entry point,
 * which no test loads. The consequence was quiet and bad: the funnel metrics
 * could have been reading zero forever and every test would still have passed,
 * because in a test nothing was ever wired at all.
 *
 * A measurement nobody can test is a measurement nobody should trust. Calling
 * `wireObservers()` is now something a test can do, and `funnel.test.ts` does.
 *
 * ─────────────────────────── the rules for handlers here ────────────────────
 *
 * They run inline on the race's critical path. They must not throw and must not
 * block — an observer that fails must cost a data point, never a player's
 * attempt.
 */
export function wireObservers(): void {
  referee.observers.onAttemptOpened = (attempt, hunt) => {
    const held = hints.countForHunt(attempt.playerId, hunt.id);

    // Phase 1's gate metric: did this player hold a hint for the hunt they just
    // entered? If the hinted and unhinted rates never diverge, hints are not
    // changing where people dig and the loop has not earned its next phase.
    metrics.huntsFound.inc({ hinted: held > 0 ? 'yes' : 'no' });

    // The funnel version of the same question, and the one that can actually
    // answer it. Three hints about one treasure is what the whole economy is
    // priced around, and a yes/no cannot tell one from three.
    metrics.hintsHeldAtEntry.observe({ kind: hunt.kind }, held);

    // Taps to first treasure — one sample per player, ever. Counted here because
    // this is the moment a player first reaches a hunt, and the reveals they
    // bought to get there are already on record.
    try {
      if (store.isFirstAttempt(attempt)) {
        metrics.tapsToFirstTreasure.observe(store.digsBefore(attempt.playerId, attempt.startedAt));
      }
    } catch (err) {
      logger.warn({ err, playerId: attempt.playerId }, 'first-treasure sample not taken');
    }

    // When players publish their own entries, relaying it too would emit the
    // record twice and put the operator back on the hook for the gas this change
    // moved to the player. The player's transaction may of course never land —
    // that costs a public record, nothing more.
    if (attestor.enabled()) return;

    // One entry per player per hunt, which the UNIQUE (hunt_id, player_id)
    // constraint already guarantees — so the dedupe key cannot collide.
    relayer.enqueue('entry', `entry:${hunt.id}:${attempt.playerId}`, {
      player: attempt.playerId as `0x${string}`,
      huntId: relayer.toBytes32Id(hunt.id),
      gameType: relayer.gameTypeCode(attempt.gameType),
    });
  };

  referee.observers.onAttemptFinished = (attempt, outcome) => {
    metrics.attemptsFinished.inc({ game_type: attempt.gameType, outcome });
    if (outcome === 'failed' && attempt.failReason) {
      metrics.attemptFailures.inc({ game_type: attempt.gameType, reason: attempt.failReason });
    }
  };

  referee.observers.onHuntResolved = (hunt, winner, racers) => {
    metrics.raceResolutions.inc();
    metrics.winnerElapsed.observe(winner.elapsedMs ?? 0);
    metrics.raceRacers.observe(racers);

    // Above the early return on purpose. An agent's prize is recorded whether or
    // not the result is published on chain by us — those are unrelated
    // questions, and putting this below the line would mean the ledger silently
    // emptied the day attestations were switched on.
    agentEarnings.onHuntResolved(hunt, winner, racers);

    // As above: the winner publishes their own result when attestations are on.
    if (attestor.enabled()) return;

    relayer.enqueue('resolution', `resolution:${hunt.id}`, {
      winner: winner.playerId as `0x${string}`,
      huntId: relayer.toBytes32Id(hunt.id),
      elapsedMs: winner.elapsedMs ?? 0,
      // uint16 on chain. A race with 65k entrants is impossible under the energy
      // cost, but clamping is cheaper than a silently truncated record.
      racers: Math.min(racers, 65_535),
    });
  };

}
