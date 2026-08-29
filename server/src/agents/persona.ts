import { hashInt } from '../hash';
import { LIMITS, type AgentConfig } from './config';

/**
 * Who an agent is, as distinct from what its owner told it to do.
 *
 * ─────────────────────────── derived, never stored ───────────────────────────
 *
 * A persona is a pure function of the agent's address. Nothing here is written
 * to the database, which is the same decision `fallbackDirective` makes for the
 * same three reasons: there is no migration, there is no drift between two
 * processes reading the same agent, and anyone holding the address can recompute
 * the character and check that it was not quietly tuned in someone's favour.
 *
 * It also means a persona cannot be edited, and that is the point. If a player
 * could set these numbers they would all set them to the same winning numbers,
 * and the variety this module exists to create would last about a week.
 *
 * ─────────────────────────── the owner's config is a ceiling ────────────────
 *
 * This is the rule that keeps personality from becoming a spending exploit, and
 * it is exactly the rule `config.ts` states about the vault: when two limits
 * disagree, the *tighter* one wins and the one holding the money is right.
 *
 * So a persona never widens anything. {@link effective} may only move a value
 * toward zero from what the owner set — a bold agent spends closer to its
 * owner's ceiling, a timid one stops well short, and neither can spend a cent
 * past it. The vault still enforces the real limit on chain; this is a lens over
 * the cheap local check, not a second opinion about what is allowed.
 *
 * ─────────────────────────── no free text, again ────────────────────────────
 *
 * Callsigns come from a fixed house-authored list and traits are bounded
 * integers, for the reason `config.ts` and `protocol.ts` both give: anything a
 * player can type reaches a model that can spend money. A player does not name
 * their agent. The hash does, from words we wrote.
 */

/**
 * The five axes.
 *
 * Chosen so each one visibly changes a decision that already exists in
 * `driver.ts` rather than adding a new one — a trait that does not alter an
 * observable choice is flavour text with a number attached.
 */
export interface Persona {
  /** Display name. House-authored words, never player input. */
  callsign: string;
  /** How marginal a hunt it will still enter. Scales the entry threshold. */
  boldness: number;
  /** How long it sits before acting. Drives the tick offset in {@link readyAt}. */
  patience: number;
  /** How hard it haggles. Scales what it will pay against its owner's ceiling. */
  thrift: number;
  /** How readily it opens a negotiation nobody asked for. */
  chattiness: number;
  /** Willingness to commit on thin evidence rather than probe once more. */
  nerve: number;
}

/**
 * The callsign vocabulary.
 *
 * Deliberately unglamorous and slightly mechanical: these are somebody's bots,
 * not heroes, and a name like RUSTBUCKET sets the right expectation about how
 * well it is about to play. Length is a power of two so the modulo below is
 * unbiased — with 48 entries the first 16 words would be marginally likelier,
 * which is invisible and still wrong.
 */
const CALLSIGNS = [
  'RUSTBUCKET', 'OSSIFRAGE', 'KESTREL', 'DRAGLINE',
  'TINDERBOX', 'HALFPENNY', 'MAGPIE', 'CROWBAR',
  'SALTFLAT', 'PIGIRON', 'NIGHTJAR', 'GRISTLE',
  'COALSACK', 'WIDGEON', 'BRACKET', 'FLINTLOCK',
  'HOGSHEAD', 'CORMORANT', 'TALLOW', 'SPANNER',
  'BILGE', 'FIRECREST', 'MILLSTONE', 'CHANDLER',
  'GANNET', 'TARPAULIN', 'SHRIKE', 'BALLAST',
  'CATSPAW', 'REDPOLL', 'GRUDGE', 'CAPSTAN',
] as const;

/** 0–100 from the agent's address and one axis label. */
function trait(agentId: string, axis: string): number {
  return hashInt(agentId.toLowerCase(), `persona:${axis}`) % 101;
}

/**
 * The persona for an agent. Same address in, same character out, forever.
 *
 * The numeric suffix exists because thirty-two words will collide long before
 * thirty-two agents do, and two agents both called MAGPIE in the same zone is a
 * bug report rather than a coincidence.
 */
export function personaFor(agentId: string): Persona {
  const id = agentId.toLowerCase();
  const word = CALLSIGNS[hashInt(id, 'persona:callsign') % CALLSIGNS.length]!;
  const suffix = hashInt(id, 'persona:suffix') % 100;

  return {
    callsign: `${word}-${String(suffix).padStart(2, '0')}`,
    boldness: trait(id, 'boldness'),
    patience: trait(id, 'patience'),
    thrift: trait(id, 'thrift'),
    chattiness: trait(id, 'chattiness'),
    nerve: trait(id, 'nerve'),
  };
}

/**
 * How much of the owner's ceiling this persona actually uses, 0.55–1.0.
 *
 * Never above 1. The floor is 0.55 rather than 0 because an agent that will only
 * ever spend a twentieth of its budget is not cautious, it is broken — and the
 * owner who set that budget would be right to file it as such.
 */
function appetite(t: number): number {
  return 0.55 + (t / 100) * 0.45;
}

/**
 * The owner's configuration as this particular agent will actually play it.
 *
 * Every field is clamped to the owner's own value, so this can be dropped in
 * anywhere `getConfig` is used today without widening a single limit. The one
 * field deliberately left alone is `zones`: which zones an agent may enter is a
 * permission, not a temperament, and a personality that wandered into a zone its
 * owner excluded would be a bug wearing a costume.
 */
export function effective(config: AgentConfig, persona: Persona): AgentConfig {
  return {
    ...config,
    // A thrifty agent haggles harder, so it walks away from prices a bold one
    // would pay. Both stay under what the owner permitted.
    maxHintPriceCents: atLeastOne(config.maxHintPriceCents * appetite(persona.thrift)),
    dailyBudgetCents: atLeastOne(config.dailyBudgetCents * appetite(persona.boldness)),
    // Aggression is the owner's dial; boldness bends it, within the same bounds.
    aggression: clamp(
      Math.round(config.aggression * appetite(persona.boldness)),
      LIMITS.aggression.min,
      LIMITS.aggression.max,
    ),
  };
}

/**
 * When this agent's next tick is due.
 *
 * ─────────────────────────── the lockstep tell ───────────────────────────
 *
 * Every agent currently acts on the same 5-second tick edge, so a zone full of
 * them moves in one synchronised twitch. Nothing is wrong and it reads as
 * obviously mechanical, which is the one impression this whole workstream exists
 * to remove.
 *
 * A patient agent waits several ticks; an impatient one acts on nearly all of
 * them. The offset is derived from the address so an agent's rhythm is its own
 * and stays stable across restarts — a cadence that reshuffled on every deploy
 * would read as jitter rather than as character.
 *
 * This gates *observable* actions only. Nothing here delays answering a rival's
 * message or finishing an attempt already in flight: a persona may set the pace
 * at which an agent starts things, never the pace at which it honours them.
 */
export function readyAt(agentId: string, persona: Persona, tickIndex: number): boolean {
  // 1 tick (impatient) to 5 ticks (patient), 5s apart — so at most 25s of
  // hesitation before starting something new.
  const period = 1 + Math.floor((persona.patience / 100) * 4);
  const offset = hashInt(agentId.toLowerCase(), 'persona:offset') % period;
  return (tickIndex + offset) % period === 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Ceilings are integers and a ceiling of zero is a disabled agent, not a shy one. */
function atLeastOne(v: number): number {
  return Math.max(1, Math.floor(v));
}
