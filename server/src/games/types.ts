import type { z } from 'zod';
import type { Directive } from '../director/types';
import type { Difficulty, GameType } from '../types';

export interface Timing {
  /**
   * SERVER-measured ms since the spec was sent. Authoritative — this is what
   * hard limits and race scoring use, and a client cannot influence it.
   */
  sinceStart: number;
  /**
   * CLIENT-derived ms since the previous input; null for the first.
   *
   * It has to be client-derived: the client batches inputs, so several taps
   * arrive in one frame and server-side resolution between them is zero. That
   * means a bot can forge plausible jitter here. The checks that cannot be
   * forged are the server-side bounds above.
   */
  sinceLast: number | null;
  /** Every accepted interval so far, in order. */
  intervals: number[];
}

export type StepResult =
  /** `emit` is forwarded to this player only — how a sequential game issues its next challenge. */
  | { kind: 'progress'; emit?: unknown }
  | { kind: 'complete'; emit?: unknown }
  /**
   * `fatal` fails the whole attempt. Almost every rejection should be fatal:
   * silently dropping an implausible input lets a bot spam at 1000/sec and keep
   * whichever taps happen to clear the floor.
   */
  | { kind: 'reject'; reason: string; fatal: boolean };

/**
 * What a module may know about the block beyond its seed.
 *
 * Added for The Crack, which is the first module whose answer must BE the
 * hunt's cell rather than a puzzle derived from the salt — hints describe the
 * treasure's real position, so a door that is some other cell makes every hint
 * noise. Optional, and every other module ignores it: `deduction` and `search`
 * deliberately invent their own targets, because for them the block is a puzzle
 * that happens to sit on a tile.
 */
export interface GenerateContext {
  /** Where the treasure actually is. */
  cell: { r: number; c: number };
  /**
   * This block's puzzle recipe — the choices that make one hunt's puzzle
   * different from another's. See {@link RecipeSpec}.
   *
   * Optional, and a module that declares a recipe must still work without one:
   * `generate` falls back to {@link RecipeSpec.fromSalt}, which is what it gets
   * on every hunt created before the author ran, and every hunt whose author
   * was unavailable. Absent is a normal state, never an error.
   */
  recipe?: unknown;
}

/**
 * The per-hunt puzzle choices a module exposes.
 *
 * ─────────────────────────── why this type exists ───────────────────────────
 *
 * `generate` was deterministic in the salt and produced a spec with no degrees
 * of freedom, so every hunt of a given difficulty posed a byte-identical
 * puzzle: measured at ONE distinct spec across 500 salts for `deduction` and
 * `search`, and five for `negotiation`. Only the answer moved. An agent playing
 * an agent zone was re-solving one board with the treasure shuffled, which is
 * not a reasoning game — it is a lookup with extra steps.
 *
 * A recipe is the space the puzzle may vary in. Two things fill it:
 *
 *   1. {@link fromSalt} — deterministic, derived from the block's salt, and so
 *      fixed before anyone enters and checkable once the salt is revealed. This
 *      is the floor, and it is always available.
 *   2. An author (see `games/author.ts`) — a model choosing within the same
 *      space, when one is reachable. Its output goes through {@link schema} and
 *      nothing else.
 *
 * ─────────────────────────── the same containment as the Director ───────────
 *
 * A recipe shapes a contest with money attached, so it is written on the
 * assumption that a model will eventually be talked into saying something it
 * should not. The containment is `director/types.ts`'s, unchanged: **a closed
 * vocabulary, a strict schema, and no free-text field, ever.** A fully hijacked
 * author can emit a legal recipe — a different board, a different price list —
 * and that is the ceiling of the damage. It cannot emit an instruction, a URL
 * or an address, because none of those parse.
 *
 * ─────────────────────────── winnable is not optional ───────────────────────
 *
 * A schema that accepts an unwinnable puzzle is a schema that lets an author
 * take a prize off the board. Every module's schema therefore bounds the space
 * so that the guarantee its config documents still holds at every point in it,
 * and each module's tests assert that by SOLVING every recipe the space can
 * produce rather than by trusting the bound. See `deduction.test.ts` and
 * `search.test.ts`.
 */
export interface RecipeSpec<R = unknown> {
  /**
   * What an author may say. Strict: extra fields are a rejection rather than a
   * shrug, for the reason `directiveSchema` is strict — a recipe accepted
   * minus-the-extra-key is a model discovering it can smuggle a field past the
   * schema into whatever reads the object later.
   */
  schema: z.ZodType<R>;
  /**
   * The block's own recipe, drawn from its salt.
   *
   * Always legal, always winnable, and always available — this is what runs
   * when no author has spoken, which includes every hunt created while
   * inference is down. It is also the reference the authored recipe is
   * validated against, in the sense that both must satisfy the same schema.
   */
  fromSalt(salt: string, difficulty: Difficulty): R;
}

export interface GeneratedGame<Spec, Secret> {
  spec: Spec;
  secret: Secret;
  limitMs: number;
}

export interface StepContext<Spec, Secret, State> {
  spec: Spec;
  secret: Secret;
  state: State;
  timing: Timing;
  /**
   * The Director's directive for the round this step may serve, or null.
   *
   * Null for every module that does not declare {@link GameModule.directedRound}
   * — which is most of them — and null is always a legal value: a module must
   * play exactly as it did before phase 8 when it gets one, because that is the
   * path taken whenever the model is slow, absent or wrong.
   *
   * The directive shapes the round about to be **served**, never the round being
   * judged. An input is always validated against what the player was actually
   * shown, which the module recorded when it emitted it.
   */
  directive: Directive | null;
}

/**
 * One game = one module. The referee, transport, race resolution and settlement
 * know nothing about any specific game, so adding Math Dash / Sequence / Memory
 * later means writing a module and registering it — nothing else moves.
 */
export interface GameModule<
  Spec = unknown,
  Secret = unknown,
  State = unknown,
  Input = unknown,
  Recipe = unknown,
> {
  type: GameType;

  /**
   * The per-hunt variety this module offers, or absent for a module that poses
   * the same puzzle every time.
   *
   * Absent is a real answer rather than a gap to fill later: `crack` already
   * varies 500-for-500 from the salt because its answer IS the treasure cell,
   * and `memory` and `sequence` vary through their own content. A recipe is for
   * modules whose spec was otherwise a constant.
   */
  recipe?: RecipeSpec<Recipe>;

  /**
   * Whether an attempt at this game must survive a process restart.
   *
   * False for the reflex games, and deliberately so: a six-second attempt
   * spanning a deploy is nobody's loss, and persisting state on every tap would
   * put a disk write on the hot path of the one loop that cannot afford it.
   *
   * True for the agent games, where an attempt runs for minutes. Losing those
   * to a deploy would mean the async clock only works between deploys, which is
   * not a clock. `State` must be JSON-serialisable when this is set.
   */
  durable?: boolean;

  /**
   * Deterministic from the block's seed: same block, same game, every time.
   *
   * `ctx` carries facts about the block that are not in the seed. Ignore it
   * unless the game is genuinely about the treasure's location — see
   * {@link GenerateContext}.
   */
  generate(seed: string, difficulty: Difficulty, ctx?: GenerateContext): GeneratedGame<Spec, Secret>;

  /**
   * What the client is allowed to see at the start. Takes `secret` so a game can
   * derive a safe projection of it — Math Dash sends question 1 without its
   * answer — but must never return the secret itself.
   */
  publicSpec(spec: Spec, secret: Secret): unknown;

  /** Fresh per-player runtime state. */
  init(spec: Spec): State;

  /**
   * Which round the next challenge this module serves belongs to.
   *
   * Declaring it is what opts a module into the Director. Absent — the default —
   * means the referee never asks for a directive and hands `step` null, so an
   * undirected module cannot be affected by the Director even accidentally.
   *
   * It returns the round about to be *served* rather than the one being judged,
   * because that is the only round a directive can still shape. Round 0 is never
   * directed: it goes out in {@link publicSpec} before anyone has made progress,
   * and a blind state of all zeros is nothing for a model to read anyway.
   *
   * Returns null when there is no next round — on the last input of an attempt,
   * for instance. A directive issued for a round nobody plays would sit in the
   * transcript as a decision that was never taken, which is worse than useless
   * in a record whose only purpose is to be checked afterwards.
   */
  directedRound?(state: State, spec: Spec): number | null;

  /** Validate exactly one input. May mutate `ctx.state`. */
  step(ctx: StepContext<Spec, Secret, State>, input: Input): StepResult;

  /** 0–100, drives the rival bars. */
  progress(state: State, spec: Spec): number;
}

export type AnyGameModule = GameModule<any, any, any, any, any>;
