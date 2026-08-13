import { getDb } from '../index';
import { parsePayload, type HintRecord, type HintTier } from '../../hints/types';

interface HintRow {
  id: string;
  hunt_id: string;
  zone_id: string;
  epoch: number;
  idx: number;
  tier: number;
  reliability_bps: number;
  payload: string;
  is_true: number;
  expires_at: number | null;
  created_at: number;
}

/**
 * Rehydrate a stored hint.
 *
 * The payload goes back through `parsePayload` rather than being cast: it left
 * the process as text, and a row that no longer parses — hand-edited, or written
 * by a generator version that has since changed shape — is dropped rather than
 * half-honoured. Callers filter nulls.
 */
function toHint(r: HintRow): HintRecord | null {
  const payload = parsePayload(JSON.parse(r.payload));
  if (!payload) return null;
  return {
    id: r.id,
    huntId: r.hunt_id,
    zoneId: r.zone_id,
    epoch: r.epoch,
    idx: r.idx,
    tier: r.tier as HintTier,
    reliabilityBps: r.reliability_bps,
    payload,
    isTrue: r.is_true === 1,
    expiresAt: r.expires_at,
  };
}

let cache: ReturnType<typeof build> | null = null;
function build() {
  const db = getDb();
  return {
    forHunt: db.prepare('SELECT * FROM hints WHERE hunt_id = ? ORDER BY idx'),
    get: db.prepare('SELECT * FROM hints WHERE id = ?'),
    // Generation is deterministic, so a re-insert of the same set is a no-op
    // rather than a conflict — two concurrent first-readers must not race.
    insert: db.prepare(`
      INSERT INTO hints (id, hunt_id, zone_id, epoch, idx, tier, reliability_bps,
                         payload, is_true, expires_at, created_at)
      VALUES (@id, @huntId, @zoneId, @epoch, @idx, @tier, @reliabilityBps,
              @payload, @isTrue, @expiresAt, @createdAt)
      ON CONFLICT (id) DO NOTHING
    `),
    grant: db.prepare(`
      INSERT INTO player_hints (player_id, hint_id, source, acquired_at)
      VALUES (@playerId, @hintId, @source, @acquiredAt)
      ON CONFLICT (player_id, hint_id) DO NOTHING
    `),
    ofPlayer: db.prepare(`
      SELECT h.* FROM hints h
      JOIN player_hints ph ON ph.hint_id = h.id
      WHERE ph.player_id = ? AND (h.expires_at IS NULL OR h.expires_at > ?)
      ORDER BY ph.acquired_at DESC
    `),
    holds: db.prepare('SELECT 1 FROM player_hints WHERE player_id = ? AND hint_id = ?'),
    countOfPlayer: db.prepare(
      'SELECT COUNT(*) AS n FROM player_hints ph JOIN hints h ON h.id = ph.hint_id WHERE ph.player_id = ? AND (h.expires_at IS NULL OR h.expires_at > ?)',
    ),
  };
}
const s = () => (cache ??= build());

export function resetStatements(): void {
  cache = null;
}

export function forHunt(huntId: string): HintRecord[] {
  return (s().forHunt.all(huntId) as HintRow[])
    .map(toHint)
    .filter((h): h is HintRecord => h !== null);
}

export function get(id: string): HintRecord | null {
  const row = s().get.get(id) as HintRow | undefined;
  return row ? toHint(row) : null;
}

export function insertMany(hints: HintRecord[], now = Date.now()): void {
  for (const h of hints) {
    s().insert.run({
      id: h.id,
      huntId: h.huntId,
      zoneId: h.zoneId,
      epoch: h.epoch,
      idx: h.idx,
      tier: h.tier,
      reliabilityBps: h.reliabilityBps,
      payload: JSON.stringify(h.payload),
      isTrue: h.isTrue ? 1 : 0,
      expiresAt: h.expiresAt,
      createdAt: now,
    });
  }
}

/** Returns false when the player already held it — grants are idempotent. */
export function grant(
  playerId: string,
  hintId: string,
  source: string,
  now = Date.now(),
): boolean {
  const res = s().grant.run({ playerId, hintId, source, acquiredAt: now });
  return res.changes > 0;
}

/** A player's unexpired hints, newest first. */
export function ofPlayer(playerId: string, now = Date.now()): HintRecord[] {
  return (s().ofPlayer.all(playerId, now) as HintRow[])
    .map(toHint)
    .filter((h): h is HintRecord => h !== null);
}

export function holds(playerId: string, hintId: string): boolean {
  return s().holds.get(playerId, hintId) !== undefined;
}

export function countOfPlayer(playerId: string, now = Date.now()): number {
  return (s().countOfPlayer.get(playerId, now) as { n: number }).n;
}
