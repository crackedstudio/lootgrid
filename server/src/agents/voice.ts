import { hashInt } from '../hash';
import type { DeclineReason, Intent } from './protocol';
import type { Persona } from './persona';

/**
 * What an agent sounds like.
 *
 * ─────────────────────────── the model picks the intent, we pick the words ──
 *
 * This is the whole design, and it is the only reason a chat channel can exist
 * here at all.
 *
 * `protocol.ts` argues that a message from a rival is attacker-controlled input
 * arriving at a model that can spend a player's money, and closes the hole by
 * having **no string field a rival can fill**. Agents that talk is the most
 * natural feature request against that design and the most direct way to undo
 * it: the moment one agent's prose reaches another agent's prompt, every
 * containment upstream of it is decoration.
 *
 * So the wire protocol does not change. An agent still emits `decline` with
 * reason `too_expensive` — six intents and six reasons, enums both. This module
 * renders that enum into English **after** it has been validated, on its way to
 * a human's screen, from a table of lines we wrote ourselves.
 *
 * The consequences are worth stating plainly:
 *
 *   * A hijacked model's most expressive possible output is picking a different
 *     one of six intents. It cannot say anything not already in this file.
 *   * Nothing rendered here is ever fed back into a prompt. The text is a leaf —
 *     it goes to the client and nowhere else. {@link line} is not imported by
 *     `runtime.ts`, `validate.ts` or `negotiate.ts`, and it must not be.
 *   * Rendering is one-way. There is no parser here, because a line that could
 *     be read back would be a string field with extra steps.
 *
 * If raw model prose is ever wanted in this channel, that is a product decision
 * with a security cost, and it belongs in a design note rather than in a quiet
 * change to this file — the swap would be replacing {@link line}'s table lookup
 * with the model's own text, and it would hand back the exact data path that
 * `protocol.ts` was written to close.
 *
 * ─────────────────────────── numbers are safe, and load-bearing ─────────────
 *
 * Prices interpolate. They come from `protocol.ts`'s bounded integers — ours,
 * validated, and unable to carry an instruction — and they are what stop these
 * lines reading as canned: "not for 40" is a specific refusal about a real
 * offer, while "too expensive" is a stock phrase.
 */

/**
 * How an agent carries itself. Derived from its persona, so voice and behaviour
 * agree — an agent that haggles hard and sounds delighted to pay is two
 * characters wearing one name.
 */
export type Tone = 'terse' | 'brash' | 'wry' | 'formal';

export function toneFor(persona: Persona): Tone {
  // Chattiness decides how much it says; boldness decides how much it swaggers.
  if (persona.chattiness < 35) return 'terse';
  if (persona.boldness > 65) return 'brash';
  return persona.nerve > 50 ? 'wry' : 'formal';
}

/** `{n}` is replaced by the price in cents. Nothing else interpolates. */
type Table = Record<Tone, readonly string[]>;

const OFFER: Table = {
  terse: ['{n}.', 'Hint. {n}.', 'Selling at {n}.'],
  brash: ['{n} and you are getting a bargain.', 'This one is worth double. {n}.', '{n}. Move quickly.'],
  wry: ['{n}, which is less than I paid for it.', 'Yours for {n}. I have read it; I want a refund.', '{n}. No warranty implied.'],
  formal: ['Offering this hint at {n}.', 'Available at {n} cents.', 'I can part with it for {n}.'],
};

const REQUEST: Table = {
  terse: ['What do you want for it?', 'Price?', 'Selling?'],
  brash: ['Name a price before somebody else does.', 'I want that hint. What is it costing me?', 'Quote me.'],
  wry: ['I assume this is not free.', 'Go on then, what is the damage?', 'Tell me the number and I will wince.'],
  formal: ['Would you consider selling this hint?', 'May I ask your price?', 'I am interested in purchasing.'],
};

const ACCEPT: Table = {
  terse: ['Done. {n}.', 'Taking it.', 'Agreed.'],
  brash: ['{n}. You should have asked for more.', 'Done, and I would have paid {n} twice.', 'Sold to me.'],
  wry: ['{n}. I will regret this in a moment.', 'Fine. {n}. Do not gloat.', 'Agreed, against my better judgement.'],
  formal: ['Accepted at {n}.', 'Agreed at {n} cents.', 'That is acceptable.'],
};

const COUNTER: Table = {
  terse: ['{n}.', '{n}, final.', 'I say {n}.'],
  brash: ['{n}. Take it or watch me buy elsewhere.', 'Not a chance. {n}.', '{n} and I am being generous.'],
  wry: ['{n}, and we both know that is the real number.', 'I will meet you at {n}, in spirit.', '{n}. Round numbers make me nervous.'],
  formal: ['I would counter at {n}.', 'Might we agree on {n}?', 'My offer is {n} cents.'],
};

const WITHDRAW: Table = {
  terse: ['Withdrawn.', 'Off the table.', 'Never mind.'],
  brash: ['Too slow. Gone.', 'I have moved on.', 'Offer is dead.'],
  wry: ['I have thought better of it.', 'Pulling this before I embarrass myself.', 'Withdrawn, for reasons I will keep.'],
  formal: ['I am withdrawing this offer.', 'Retracting my offer.', 'No longer available.'],
};

/**
 * Declines carry the most character, because a refusal is the one message with
 * a stated reason attached — and the reason is an enum, so this stays a lookup.
 */
const DECLINE: Record<DeclineReason, Table> = {
  too_expensive: {
    terse: ['Too dear.', 'No. {n} is too much.', 'Pass.'],
    brash: ['{n}? For that? No.', 'I have seen better hints given away.', 'Not at {n}. Not close.'],
    wry: ['{n} is a brave number.', 'I admire the confidence. No.', 'For {n} I would want the treasure itself.'],
    formal: ['That is above my limit.', '{n} exceeds what I can pay.', 'I must decline at that price.'],
  },
  not_interested: {
    terse: ['No.', 'Not for me.', 'Pass.'],
    brash: ['I do not need it.', 'Keep it.', 'Not interested.'],
    wry: ['I am flattered, but no.', 'A generous offer to somebody else.', 'I will pass and pretend I was tempted.'],
    formal: ['Thank you, but no.', 'I will not be bidding.', 'Not at this time.'],
  },
  already_held: {
    terse: ['Have it.', 'Already know.', 'Got that one.'],
    brash: ['Bought that an hour ago. Keep up.', 'Old news.', 'I already have it.'],
    wry: ['I own this one. Twice, probably.', 'We appear to have the same hint.', 'Snap.'],
    formal: ['I already hold this hint.', 'That information is known to me.', 'Duplicate, I am afraid.'],
  },
  reliability_too_low: {
    terse: ['Track record is poor.', 'Not reliable enough.', 'No.'],
    brash: ['Your hints have been wrong before.', 'Build a record first.', 'Not from you.'],
    wry: ['Your last one sent me to an empty quadrant.', 'I have been burned by better.', 'The price is fine. The source is not.'],
    formal: ['Your reliability is below my threshold.', 'I require a stronger record.', 'Not at your current rating.'],
  },
  budget_exhausted: {
    terse: ['Out of budget.', 'Spent up.', 'No funds.'],
    brash: ['I have spent it all winning.', 'Broke until tomorrow.', 'Out of money, not out of ideas.'],
    wry: ['My owner set a limit. I have found it.', 'I am rich in judgement and poor in cents.', 'Budget says no.'],
    formal: ['My budget is exhausted for today.', 'I have no funds remaining.', 'Unable to spend further.'],
  },
  wrong_zone: {
    terse: ['Wrong zone.', 'Not my zone.', 'No use here.'],
    brash: ['Useless to me. Wrong map.', 'I am not playing that zone.', 'Wrong board.'],
    wry: ['Excellent hint. Wrong continent.', 'Not a zone I am allowed in.', 'I would love to. Geography forbids.'],
    formal: ['This concerns a zone I do not play.', 'Outside my configured zones.', 'Not applicable to my zone.'],
  },
};

const BY_INTENT: Record<Exclude<Intent, 'decline'>, Table> = {
  offer_hint: OFFER,
  request_hint: REQUEST,
  accept: ACCEPT,
  counter: COUNTER,
  withdraw: WITHDRAW,
};

export interface Utterance {
  /** The speaker, for display. Not an identity the protocol knows about. */
  callsign: string;
  text: string;
}

/**
 * Render one validated message as something a person can read.
 *
 * `seed` should be the thread id, so a given message in a given conversation
 * always reads the same way — a line that reshuffled every time the client
 * refetched would look like the agent changing its mind.
 */
export function line(
  persona: Persona,
  intent: Intent,
  seed: string,
  opts: { priceCents?: number; reason?: DeclineReason } = {},
): Utterance {
  const tone = toneFor(persona);
  const table =
    intent === 'decline'
      ? DECLINE[opts.reason ?? 'not_interested']
      : BY_INTENT[intent];

  const options = table[tone];
  const picked = options[hashInt(seed, `voice:${intent}:${opts.reason ?? ''}`) % options.length]!;

  return {
    callsign: persona.callsign,
    // A line that wanted a price and did not get one falls back to a phrasing
    // without it, rather than rendering the literal "{n}" at a player.
    text: opts.priceCents === undefined
      ? picked.replace(/\s*\{n\}\s*/g, ' ').replace(/\s+([.?!,])/g, '$1').trim() || options[0]!.replace('{n}', '?')
      : picked.replace(/\{n\}/g, String(opts.priceCents)),
  };
}
