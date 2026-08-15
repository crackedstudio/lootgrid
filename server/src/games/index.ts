import { hashInt } from '../hash';
import type { GameType, HuntKind, ZoneKind } from '../types';
import { deductionModule } from './deduction';
import { mathModule } from './math';
import { memoryModule } from './memory';
import { negotiationModule } from './negotiation';
import { searchModule } from './search';
import { sequenceModule } from './sequence';
import { tapModule } from './tap';
import type { AnyGameModule } from './types';

/** Register a module here and the rest of the system picks it up unchanged. */
export const MODULES: Record<GameType, AnyGameModule> = {
  tap: tapModule,
  math: mathModule,
  sequence: sequenceModule,
  memory: memoryModule,
  deduction: deductionModule,
  negotiation: negotiationModule,
  search: searchModule,
};

export function moduleFor(type: GameType): AnyGameModule {
  const m = MODULES[type];
  if (!m) throw new Error(`no game module registered for "${type}"`);
  return m;
}

/**
 * Memory is deliberately absent. The client has to be told the sequence in
 * order to play it back, so it is the easiest of the four to automate — it
 * guards XP only, never money.
 */
const HUMAN_CASH_GAMES: GameType[] = ['tap', 'math', 'sequence'];

/**
 * Cash games for agent zones — the phase 6 modules, and only those.
 *
 * **The four human modules are deliberately absent and must stay that way.**
 * They test reflexes and arithmetic, which an agent does perfectly, and `tap`
 * additionally rejects any player whose intervals are too regular to be human
 * (`tap.ts`, σ≈0 check). Listing one here would either hand agents a free win or
 * reject them for being what they are.
 *
 * That absence is also why no anti-automation check needs a "disabled" flag: the
 * bot detection lives inside modules that agent zones never select, so it is
 * unreachable by construction rather than switched off by a conditional. A flag
 * could be wrong for a human zone; an empty list cannot be.
 *
 * The reverse holds too, and matters just as much: these three never appear on
 * a human zone. Each runs for ten minutes and expects the player to think
 * between inputs, which is not a game you hand someone on a phone waiting for a
 * bus.
 */
const AGENT_CASH_GAMES: GameType[] = ['deduction', 'negotiation', 'search'];

function cashGamesFor(zoneKind: ZoneKind): GameType[] {
  return zoneKind === 'agent' ? AGENT_CASH_GAMES : HUMAN_CASH_GAMES;
}

/** Whether a zone can currently host a cash hunt. False for agent zones until phase 6. */
export function canHostCashHunt(zoneKind: ZoneKind): boolean {
  return cashGamesFor(zoneKind).length > 0;
}

/**
 * The game type is a property of the BLOCK, not of the player — derived from the
 * hunt's salt so it is fixed at creation and verifiable once the salt is
 * revealed. Everyone racing a block plays the same game.
 *
 * `zoneKind` decides which pool the draw comes from. It defaults to 'human'
 * because that is the stricter branch: a forgotten argument yields reflex
 * modules with their bot checks intact, which fails loudly against an agent
 * rather than quietly admitting one to a cash game.
 */
export function gameTypeForBlock(
  salt: string,
  huntId: string,
  huntKind: HuntKind,
  zoneKind: ZoneKind = 'human',
): GameType {
  // Puzzle hunts guard XP, never money, so the automation argument does not
  // apply and both zone kinds share the module.
  if (huntKind === 'puzzle') return 'memory';

  const pool = cashGamesFor(zoneKind);
  if (pool.length === 0) {
    throw new Error(
      `no cash game modules registered for ${zoneKind} zones — cannot create hunt "${huntId}"`,
    );
  }
  return pool[hashInt(salt, huntId, 'gametype') % pool.length]!;
}
