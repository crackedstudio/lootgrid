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

    // ---- commitments ----
    putCommitment: db.prepare(`
      INSERT INTO hint_commitments (hunt_id, zone_id, epoch, commitment, version, committed_at)
      VALUES (@huntId, @zoneId, @epoch, @commitment, @version, @committedAt)
      ON CONFLICT (hunt_id) DO NOTHING
    `),
    getCommitment: db.prepare('SELECT * FROM hint_commitments WHERE hunt_id = ?'),
    // Idempotent, and never moves an existing timestamp: the first reveal is the
    // one that counts, and a later write must not appear to backdate it.
    reveal: db.prepare(
      'UPDATE hint_commitments SET revealed_at = ? WHERE hunt_id = ? AND revealed_at IS NULL',
    ),
    liveInZone: db.prepare(`
      SELECT * FROM hint_commitments
      WHERE zone_id = ? AND revealed_at IS NULL
      ORDER BY committed_at DESC LIMIT ?
    `),
    revealedInZone: db.prepare(`
      SELECT * FROM hint_commitments
      WHERE zone_id = ? AND revealed_at IS NOT NULL
      ORDER BY revealed_at DESC LIMIT ?
    `),
  };
}

export interface CommitmentRow {
  huntId: string;
  zoneId: string;
  epoch: number;
  commitment: string;
  version: string;
  committedAt: number;
  revealedAt: number | null;
}

interface RawCommitment {
  hunt_id: string;
  zone_id: string;
  epoch: number;
  commitment: string;
  version: string;
  committed_at: number;
  revealed_at: number | null;
}

const toCommitment = (r: RawCommitment): CommitmentRow => ({
  huntId: r.hunt_id,
  zoneId: r.zone_id,
  epoch: r.epoch,
  commitment: r.commitment,
  version: r.version,
  committedAt: r.committed_at,
  revealedAt: r.revealed_at,
});
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

// ─────────────────────────── commitments ───────────────────────────

export function putCommitment(
  huntId: string,
  zoneId: string,
  epoch: number,
  commitment: string,
  version: string,
  now = Date.now(),
): void {
  s().putCommitment.run({ huntId, zoneId, epoch, commitment, version, committedAt: now });
}

export function getCommitment(huntId: string): CommitmentRow | null {
  const row = s().getCommitment.get(huntId) as RawCommitment | undefined;
  return row ? toCommitment(row) : null;
}

/** Marks a hunt's hint set publicly checkable. Returns false if already revealed. */
export function reveal(huntId: string, now = Date.now()): boolean {
  return s().reveal.run(now, huntId).changes > 0;
}

/** Live hunts: the commitment is public, the contents are not. */
export function liveCommitments(zoneId: string, limit = 100): CommitmentRow[] {
  return (s().liveInZone.all(zoneId, limit) as RawCommitment[]).map(toCommitment);
}

export function revealedCommitments(zoneId: string, limit = 100): CommitmentRow[] {
  return (s().revealedInZone.all(zoneId, limit) as RawCommitment[]).map(toCommitment);
}
