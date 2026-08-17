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
export interface GameModule<Spec = unknown, Secret = unknown, State = unknown, Input = unknown> {
  type: GameType;

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

export type AnyGameModule = GameModule<any, any, any, any>;
