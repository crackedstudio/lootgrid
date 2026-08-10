import { hashInt } from '../hash';
import type { GameType, HuntKind } from '../types';
import { mathModule } from './math';
import { memoryModule } from './memory';
import { sequenceModule } from './sequence';
import { tapModule } from './tap';
import type { AnyGameModule } from './types';

/** Register a module here and the rest of the system picks it up unchanged. */
export const MODULES: Record<GameType, AnyGameModule> = {
  tap: tapModule,
  math: mathModule,
  sequence: sequenceModule,
  memory: memoryModule,
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
const CASH_GAMES: GameType[] = ['tap', 'math', 'sequence'];

/**
 * The game type is a property of the BLOCK, not of the player — derived from the
 * hunt's salt so it is fixed at creation and verifiable once the salt is
 * revealed. Everyone racing a block plays the same game.
 */
export function gameTypeForBlock(salt: string, huntId: string, kind: HuntKind): GameType {
  if (kind === 'puzzle') return 'memory';
  return CASH_GAMES[hashInt(salt, huntId, 'gametype') % CASH_GAMES.length]!;
}
