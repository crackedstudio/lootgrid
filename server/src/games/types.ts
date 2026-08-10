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
}

/**
 * One game = one module. The referee, transport, race resolution and settlement
 * know nothing about any specific game, so adding Math Dash / Sequence / Memory
 * later means writing a module and registering it — nothing else moves.
 */
export interface GameModule<Spec = unknown, Secret = unknown, State = unknown, Input = unknown> {
  type: GameType;

  /** Deterministic from the block's seed: same block, same game, every time. */
  generate(seed: string, difficulty: Difficulty): GeneratedGame<Spec, Secret>;

  /**
   * What the client is allowed to see at the start. Takes `secret` so a game can
   * derive a safe projection of it — Math Dash sends question 1 without its
   * answer — but must never return the secret itself.
   */
  publicSpec(spec: Spec, secret: Secret): unknown;

  /** Fresh per-player runtime state. */
  init(spec: Spec): State;

  /** Validate exactly one input. May mutate `ctx.state`. */
  step(ctx: StepContext<Spec, Secret, State>, input: Input): StepResult;

  /** 0–100, drives the rival bars. */
  progress(state: State, spec: Spec): number;
}

export type AnyGameModule = GameModule<any, any, any, any>;
