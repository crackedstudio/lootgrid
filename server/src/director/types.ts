import { z } from 'zod';

/**
 * What the Director is allowed to say.
 *
 * ─────────────────────────── a hijacked model still plays fair ──────────────
 *
 * The Director picks how hard each round is. That makes it a model whose output
 * shapes a contest with money attached, so the design assumption is that it will
 * eventually be talked into saying something it should not. The containment is
 * the same one used everywhere else in this codebase: **there is no free-text
 * field, and there never may be.**
 *
 * A fully hijacked Director can emit a legal directive. That is the whole
 * ceiling of the damage — a harder round, or an easier one, inside a range the
 * game already supports. It cannot emit an instruction, a URL, a prompt, or a
 * player's name, because none of those parse.
 *
 * ─────────────────────────── strict, not lenient ───────────────────────────
 *
 * Extra fields are a rejection rather than a shrug. A directive that arrived
 * with `{difficulty: 3, payTo: "0x..."}` and was accepted-minus-the-extra-key
 * would be a model discovering that it can smuggle a field past the schema and
 * into whatever reads the object later. Reject the whole thing; the fallback is
 * always available and always legal.
 */

/**
 * How hard the round is, 1–5.
 *
 * Deliberately its own scale rather than the `Difficulty` union used for
 * prizes. Prize difficulty is a property of the block, fixed at creation and
 * committed to; this is a property of a round inside a hunt and moves while the
 * hunt runs. Conflating them would let a live model change what a hunt pays.
 */
export const DIFFICULTY_MIN = 1;
export const DIFFICULTY_MAX = 5;

/** What shape the round takes. A closed set the modules already understand. */
export const ROUND_TYPES = ['standard', 'sprint', 'endurance', 'precision'] as const;

/** One optional complication. `none` is a first-class answer, not a failure. */
export const TWISTS = ['none', 'fog', 'decoys', 'silence', 'haste'] as const;

export type RoundType = (typeof ROUND_TYPES)[number];
export type Twist = (typeof TWISTS)[number];

export const directiveSchema = z
  .object({
    difficulty: z.number().int().min(DIFFICULTY_MIN).max(DIFFICULTY_MAX),
    roundType: z.enum(ROUND_TYPES),
    twist: z.enum(TWISTS),
  })
  .strict();

export type Directive = z.infer<typeof directiveSchema>;

/**
 * What the Director is allowed to see.
 *
 * ─────────────────────────── blind by construction ───────────────────────────
 *
 * **No player identity, ever.** A Director that knows who is winning and can
 * raise the difficulty is a payout-manipulation surface — and one that would be
 * indistinguishable, from the outside, from a Director that merely got unlucky.
 * Architecture §4 says to blind it rather than audit it, and this type is where
 * that happens: there is no field here to put a handle, an address or an
 * attempt id in.
 *
 * `progress` is **sorted**, which is the part that is easy to get wrong. An
 * unsorted array leaks identity through position — the third element is the
 * third player, every round — so two hunts differing only in who is who would
 * produce different directives. Sorting is what makes the blinding test pass
 * for a real reason rather than by accident.
 */
export const stateSchema = z
  .object({
    /** Which round is being chosen. */
    round: z.number().int().min(0),
    /** How many are racing. A count, never a roster. */
    racers: z.number().int().min(0),
    /** Every racer's progress, 0–100, ASCENDING. Order carries no identity. */
    progress: z.array(z.number().int().min(0).max(100)),
    /** Milliseconds since the hunt opened. */
    elapsedMs: z.number().int().min(0),
  })
  .strict();

export type BlindState = z.infer<typeof stateSchema>;

/**
 * Build the Director's view of a hunt from whatever the referee knows.
 *
 * The only supported way to construct a `BlindState`, so that stripping
 * identity is something the type system pushes you towards rather than
 * something to remember. Takes progress values already separated from their
 * owners — the caller cannot hand this an attempt object even by accident.
 */
export function blind(round: number, progress: number[], elapsedMs: number): BlindState {
  return {
    round,
    racers: progress.length,
    // Ascending, so a permutation of the same racers is the same state.
    progress: [...progress].sort((a, b) => a - b),
    elapsedMs,
  };
}

export type ParseResult =
  | { ok: true; directive: Directive }
  | { ok: false; reason: 'not_json' | 'not_a_directive' };

/**
 * Parse a model's response into a directive.
 *
 * Tolerant about markdown fencing — models add it however firmly they are told
 * not to — and unforgiving about everything else.
 */
export function parseDirective(text: string): ParseResult {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: 'not_json' };
  }

  const result = directiveSchema.safeParse(raw);
  return result.success
    ? { ok: true, directive: result.data }
    : { ok: false, reason: 'not_a_directive' };
}

/**
 * Canonical bytes for one directive.
 *
 * Fixed field order, not `JSON.stringify` — key order there is an
 * implementation detail of whichever runtime hashes it, and the transcript's
 * whole value is that somebody else can recompute it in another language. Same
 * rule as `hints/commit.ts`.
 */
export function canonicalDirective(d: Directive): string {
  return `${d.difficulty}|${d.roundType}|${d.twist}`;
}
