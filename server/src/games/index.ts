import { hashInt } from '../hash';
import type { GameType, HuntKind, ZoneKind } from '../types';
import { crackModule } from './crack';
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
  crack: crackModule,
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
 * One way to win money, and it is not tapping speed.
 *
 * This was `['tap', 'math', 'sequence']` — reflex and arithmetic games where
 * the prize went to whoever was fastest. Every deep competitive game has
 * exactly one way to win (poker: best hand; chess: checkmate) and puts all its
 * variety upstream of that. The variety here is the map, the hints and the
 * market; the decision is The Crack.
 *
 * The four reflex modules are not deleted. They move to puzzle hunts, where
 * they guard XP — flavour that costs nobody a prize when their phone stutters.
 */
const HUMAN_CASH_GAMES: GameType[] = ['crack'];

/**
 * XP games. Reflexes and arithmetic, where losing to a slow phone costs pride.
 *
 * Memory is here rather than in any cash pool for the reason it always was: the
 * client must be told the sequence in order to play it back, so it is the
 * easiest of the four to automate.
 */
const PUZZLE_GAMES: GameType[] = ['tap', 'math', 'sequence', 'memory'];

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
  // apply and a HUMAN zone happily shares the reflex pool. Drawn from the salt
  // like everything else about a block, rather than hardcoded to `memory` —
  // three of the four modules had never once been served since the cash pool
  // stopped drawing them.
  //
  // ─────────────────────── but not on an agent zone ───────────────────────
  //
  // That reasoning is about CHEATING, and it is right: a script that aces a tap
  // race costs nobody money. It says nothing about PLAYABILITY, and on an agent
  // zone the two come apart completely — the audience is machines, and a
  // machine cannot play a reflex game at all.
  //
  // The consequence was severe and silent. `CASH_PER_ZONE` hunts drew agent
  // games and the other twenty-three drew tap/math/memory, so an agent zone
  // offered its entire audience ONE playable hunt. Once that hunt was taken the
  // tier stopped, the zone could not restock (it was full), and the driver swept
  // 1,087 consecutive idle ticks looking perfectly healthy.
  //
  // An agent zone draws agent games throughout. The prize still separates the
  // two kinds — cash hunts pay money, puzzle hunts pay XP — which is the
  // distinction that actually mattered.
  if (huntKind === 'puzzle' && zoneKind !== 'agent') {
    return PUZZLE_GAMES[hashInt(salt, huntId, 'puzzlegame') % PUZZLE_GAMES.length]!;
  }

  const pool = cashGamesFor(zoneKind);
  if (pool.length === 0) {
    throw new Error(
      `no game modules registered for ${zoneKind} zones — cannot create hunt "${huntId}"`,
    );
  }

  // Separate salt tags so a zone's puzzle hunts do not mirror its cash ones
  // game-for-game.
  const tag = huntKind === 'puzzle' ? 'agentpuzzle' : 'gametype';
  return pool[hashInt(salt, huntId, tag) % pool.length]!;
}
