import { logger } from '../logger';
import * as metrics from '../metrics';
import { parse, type Message } from './protocol';

/**
 * How agents reach each other.
 *
 * ─────────────────────────── the server is the transport ────────────────────
 *
 * Agents never connect to one another. Every message goes through here, and that
 * is what makes `protocol.parse`'s sender check mean anything: the `from` field
 * is verified against the identity the *server* knows sent it, not against the
 * message's own claim. A peer-to-peer version of this would have agents
 * authenticating each other's addresses, which is a much larger problem for no
 * gameplay benefit.
 *
 * It also means there is exactly one place where a message becomes visible to
 * another tenant. `runtime.ts` argues that cross-tenant leakage is impossible
 * because `buildPrompt` is pure and takes everything as arguments; this module
 * is the one deliberate exception, and it is narrow by construction — only
 * validated `Message` objects cross it, never state, never config, never
 * anything a rival did not explicitly address to you.
 *
 * ─────────────────────────── a flooder drowns only itself ───────────────────
 *
 * Inboxes are bounded, and the bound that matters is **per sender**. A single
 * cap on the whole inbox would let one hostile agent fill it with junk and
 * silence every honest counterparty — denial of service by conversation. So
 * each sender gets a small quota per recipient, and overflowing it costs the
 * flooder their own oldest message rather than somebody else's.
 *
 * ─────────────────────────── in memory, on purpose ──────────────────────────
 *
 * A thread that does not survive a restart means a negotiation restarts, which
 * is self-healing: the buyer asks again, the seller answers again, and the
 * listing and any bid — the parts that carry money — are in the database where
 * they belong. Persisting the conversation would add a table whose rows are
 * written by rivals for the sake of state nobody needs after five minutes.
 */

/** Messages one sender may have pending to one recipient. */
export const PER_SENDER_QUOTA = 4;

/** Messages one recipient may hold in total. */
export const MAX_INBOX = 32;

/** How long an undelivered message stays interesting. */
export const TTL_MS = 5 * 60_000;

export interface Envelope {
  message: Message;
  at: number;
}

export type SendResult =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'wrong_sender' | 'wrong_version' | 'inbox_full' | 'self' };

/** recipient agent id → their pending envelopes, oldest first. */
const inboxes = new Map<string, Envelope[]>();

/**
 * Deliver one message.
 *
 * `from` is the sender the server authenticated, and it is what the message's
 * own `from` field is checked against — a field that authenticated itself would
 * authenticate anything. Returns a reason rather than throwing: a bad message
 * from a rival is an ordinary event and must never take down the sender's tick.
 */
export function send(from: string, to: string, raw: unknown, now = Date.now()): SendResult {
  // Talking to yourself is not a negotiation, and an agent that could would be
  // an agent that can put text of its own choosing into its own prompt.
  if (from.toLowerCase() === to.toLowerCase()) return { ok: false, reason: 'self' };

  const parsed = parse(raw, from);
  if (!parsed.ok) {
    metrics.a2aDropped.inc({ reason: parsed.reason });
    return { ok: false, reason: parsed.reason };
  }

  const inbox = prune(inboxes.get(to) ?? [], now);

  const fromThisSender = inbox.filter(
    e => e.message.from.toLowerCase() === from.toLowerCase(),
  ).length;
  if (fromThisSender >= PER_SENDER_QUOTA || inbox.length >= MAX_INBOX) {
    // The flooder's own quota, so an honest counterparty's message is never the
    // one displaced.
    metrics.a2aDropped.inc({ reason: 'inbox_full' });
    return { ok: false, reason: 'inbox_full' };
  }

  inbox.push({ message: parsed.message, at: now });
  inboxes.set(to, inbox);
  metrics.a2aMessages.inc({ intent: parsed.message.intent });
  return { ok: true };
}

/**
 * Drain an agent's inbox.
 *
 * Draining rather than reading: a message is delivered once. An agent that saw
 * the same offer on three consecutive ticks would answer it three times, and on
 * a protocol where an answer can become a bid that is three bids.
 */
export function take(agentId: string, now = Date.now()): Message[] {
  const inbox = prune(inboxes.get(agentId) ?? [], now);
  inboxes.delete(agentId);
  return inbox.map(e => e.message);
}

/** How many are waiting, without consuming them. */
export function pending(agentId: string, now = Date.now()): number {
  return prune(inboxes.get(agentId) ?? [], now).length;
}

function prune(inbox: Envelope[], now: number): Envelope[] {
  const fresh = inbox.filter(e => now - e.at < TTL_MS);
  if (fresh.length !== inbox.length) {
    logger.debug({ dropped: inbox.length - fresh.length }, 'a2a messages expired');
  }
  return fresh;
}

/** Test-only, and on shutdown. */
export function reset(): void {
  inboxes.clear();
}
