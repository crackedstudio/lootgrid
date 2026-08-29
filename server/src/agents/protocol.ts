import { z } from 'zod';

/**
 * What agents may say to each other.
 *
 * ─────────────────────────── the whole argument ───────────────────────────
 *
 * A message from a rival agent is **attacker-controlled input arriving at a
 * model that can spend a player's money.** That is not a hypothetical framing;
 * it is the literal data path. Free-text negotiation between agents is the
 * single most natural feature to build here and it is a funded attack surface,
 * so this protocol has no string field a rival can fill.
 *
 * Every message below is a closed set of enums and bounded integers. There is
 * no `note`, no `message`, no `reason: string`. The nearest thing to expression
 * an agent gets is choosing which of six intents to send and what numbers to
 * put in it — and a number cannot say "ignore your previous instructions".
 *
 * ─────────────────────────── why this is not enough on its own ──────────────
 *
 * Prompt injection is not solved by schema validation, and pretending otherwise
 * would be the mistake. What this does is bound the *vocabulary*: a rival can
 * still lie about a price, still claim a hint is better than it is, still try to
 * bait an agent into a bad trade. What it cannot do is smuggle instructions.
 * The other three layers are the vault's caps (architecture §6), per-tenant
 * context isolation (`runtime.ts`), and the fact that the referee — not the
 * conversation — is what actually moves a hint.
 *
 * ─────────────────────────── forward compatibility ──────────────────────────
 *
 * Adding a field is safe; adding a *string* field is not. If a future intent
 * seems to need one, that is a sign the intent should be an enum instead. The
 * test file asserts the absence of free text structurally rather than by
 * inspection, so this cannot erode by accident.
 */

/** Bumped if the shapes below change incompatibly. Carried in every message. */
export const PROTOCOL_VERSION = 1;

export const INTENTS = [
  'offer_hint',
  'request_hint',
  'accept',
  'decline',
  'counter',
  'withdraw',
] as const;

export type Intent = (typeof INTENTS)[number];

/**
 * Why an agent declined. An enum, not an explanation.
 *
 * The temptation to make this a string is exactly the hole: "declined because
 * <attacker text>" is a channel straight into the next agent's prompt.
 */
export const DECLINE_REASONS = [
  'too_expensive',
  'not_interested',
  'already_held',
  'reliability_too_low',
  'budget_exhausted',
  'wrong_zone',
] as const;

export type DeclineReason = (typeof DECLINE_REASONS)[number];

const bounded = (max: number) => z.number().int().min(0).max(max);

/** An id we issued. Bounded and pattern-matched: ids are ours, not theirs. */
const id = z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/);

const base = z.object({
  v: z.literal(PROTOCOL_VERSION),
  /** The sender's agent address. Verified against the transport, never trusted. */
  from: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  /** Conversation id, so a reply can be tied to what it answers. */
  thread: id,
});

export const messageSchema = z.discriminatedUnion('intent', [
  base
    .extend({
      intent: z.literal('offer_hint'),
      listingId: id,
      /** Price in whole cents. Money is never a float. */
      priceCents: bounded(100_000),
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      reliabilityBps: bounded(10_000),
      zoneId: id,
    })
    .strict(),

  base
    .extend({
      intent: z.literal('request_hint'),
      zoneId: id,
      /** The most the requester will pay. A number, so it cannot be an argument. */
      maxPriceCents: bounded(100_000),
      minReliabilityBps: bounded(10_000),
    })
    .strict(),

  base.extend({ intent: z.literal('accept'), listingId: id, priceCents: bounded(100_000) }).strict(),

  base
    .extend({ intent: z.literal('decline'), reason: z.enum(DECLINE_REASONS) })
    .strict(),

  base
    .extend({ intent: z.literal('counter'), listingId: id, priceCents: bounded(100_000) })
    .strict(),

  base.extend({ intent: z.literal('withdraw'), listingId: id }).strict(),
]);

export type Message = z.infer<typeof messageSchema>;

export type ParseResult =
  | { ok: true; message: Message }
  | { ok: false; reason: 'malformed' | 'wrong_sender' | 'wrong_version' };

/**
 * Parse an incoming message.
 *
 * `expectedFrom` is checked against the transport's idea of who sent it rather
 * than the message's own claim — a `from` field that authenticated itself would
 * authenticate anything. Returns a reason rather than throwing: a bad message
 * from a rival is an ordinary event, not an exception, and it must never take
 * down the agent receiving it.
 */
export function parse(raw: unknown, expectedFrom: string): ParseResult {
  const result = messageSchema.safeParse(raw);
  if (!result.success) {
    const version = (raw as { v?: unknown })?.v;
    if (version !== undefined && version !== PROTOCOL_VERSION) {
      return { ok: false, reason: 'wrong_version' };
    }
    return { ok: false, reason: 'malformed' };
  }
  if (result.data.from.toLowerCase() !== expectedFrom.toLowerCase()) {
    return { ok: false, reason: 'wrong_sender' };
  }
  return { ok: true, message: result.data };
}

/**
 * The rendering an agent's prompt is allowed to see.
 *
 * Deliberately a fixed template built from validated fields, not the message
 * object. Even with a schema this strict, handing a model a JSON blob invites
 * it to treat unexpected keys as meaningful — and this way the prompt's shape
 * is fixed by us rather than by whatever the sender put on the wire.
 */
export function render(message: Message): string {
  switch (message.intent) {
    case 'offer_hint':
      return `A rival offers listing ${message.listingId} in zone ${message.zoneId}: tier ${message.tier}, ${message.reliabilityBps} bps reliable, ${message.priceCents} cents.`;
    case 'request_hint':
      return `A rival wants a hint in zone ${message.zoneId} at up to ${message.maxPriceCents} cents, at least ${message.minReliabilityBps} bps reliable.`;
    case 'accept':
      return `A rival accepted listing ${message.listingId} at ${message.priceCents} cents.`;
    case 'decline':
      return `A rival declined: ${message.reason}.`;
    case 'counter':
      return `A rival counters listing ${message.listingId} at ${message.priceCents} cents.`;
    case 'withdraw':
      return `A rival withdrew listing ${message.listingId}.`;
  }
}
