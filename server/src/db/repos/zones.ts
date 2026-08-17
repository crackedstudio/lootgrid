import type { Reveal, TileType, Zone, ZoneKind } from '../../types';
import { getDb } from '../index';

interface ZoneRow {
  id: string;
  name: string;
  accent: string;
  kind: string;
  epoch: number;
  seed_secret: string;
  seed_commit: string;
  rotates_at: number | null;
  created_at: number;
}

/**
 * Narrow the stored string to {@link ZoneKind}, defaulting to 'human'.
 *
 * SQLite cannot retroactively enforce a CHECK added by ALTER TABLE, so this is
 * where the column's domain is actually guaranteed. Defaulting rather than
 * throwing is deliberate: an unrecognised value yields the *stricter* zone type,
 * with anti-automation intact, instead of failing open.
 */
function toZoneKind(raw: string): ZoneKind {
  return raw === 'agent' ? 'agent' : 'human';
}

interface RevealRow {
  zone_id: string;
  epoch: number;
  r: number;
  c: number;
  type: string;
  player_id: string;
  handle: string;
  at: number;
}

const toZone = (r: ZoneRow): Zone => ({
  id: r.id,
  name: r.name,
  accent: r.accent,
  kind: toZoneKind(r.kind),
  epoch: r.epoch,
  seedSecret: r.seed_secret,
  seedCommit: r.seed_commit,
  rotatesAt: r.rotates_at,
});

const toReveal = (r: RevealRow): Reveal => ({
  r: r.r,
  c: r.c,
  type: r.type as TileType,
  byHandle: r.handle,
  at: r.at,
});

let cache: ReturnType<typeof build> | null = null;
function build() {
  const db = getDb();
  return {
    get: db.prepare('SELECT * FROM zones WHERE id = ?'),
    list: db.prepare('SELECT * FROM zones ORDER BY rowid'),
    insert: db.prepare(`
      INSERT INTO zones (id, name, accent, kind, epoch, seed_secret, seed_commit, rotates_at, created_at)
      VALUES (@id, @name, @accent, @kind, @epoch, @seedSecret, @seedCommit, @rotatesAt, @createdAt)
    `),
    getReveal: db.prepare(
      'SELECT * FROM reveals WHERE zone_id = ? AND epoch = ? AND player_id = ? AND r = ? AND c = ?',
    ),
    // ON CONFLICT DO NOTHING keeps a double-tap idempotent. Under private fog
    // this can only ever be the SAME player opening the same tile twice — a
    // fast double-click or a retried request — never a race between two
    // players, because they no longer share a key.
    addReveal: db.prepare(`
      INSERT INTO reveals (zone_id, epoch, player_id, r, c, type, handle, at)
      VALUES (@zoneId, @epoch, @playerId, @r, @c, @type, @handle, @at)
      ON CONFLICT (zone_id, epoch, player_id, r, c) DO NOTHING
    `),
    revealsFor: db.prepare(
      'SELECT * FROM reveals WHERE zone_id = ? AND epoch = ? AND player_id = ?',
    ),
    revealCount: db.prepare(
      'SELECT COUNT(*) AS n FROM reveals WHERE zone_id = ? AND epoch = ? AND player_id = ?',
    ),
    archiveSeed: db.prepare(`
      INSERT INTO zone_seed_history (zone_id, epoch, seed_secret, seed_commit, revealed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (zone_id, epoch) DO NOTHING
    `),
    history: db.prepare(
      'SELECT * FROM zone_seed_history WHERE zone_id = ? ORDER BY epoch DESC',
    ),
    rotate: db.prepare(`
      UPDATE zones
         SET epoch = epoch + 1,
             seed_secret = @seedSecret,
             seed_commit = @seedCommit,
             rotates_at = @rotatesAt
       WHERE id = @zoneId
    `),
    // `rotates_at IS NOT NULL` rather than a coalesce: a zone that opts out of
    // rotation must never be swept up by a comparison against a default.
    dueForRotation: db.prepare(
      'SELECT * FROM zones WHERE rotates_at IS NOT NULL AND rotates_at <= ? ORDER BY rowid',
    ),
  };
}
const s = () => (cache ??= build());

export function resetStatements(): void {
  cache = null;
}

export function get(id: string): Zone | undefined {
  const row = s().get.get(id) as ZoneRow | undefined;
  return row ? toZone(row) : undefined;
}

export function list(): Zone[] {
  return (s().list.all() as ZoneRow[]).map(toZone);
}

export function insert(z: Zone, now = Date.now()): void {
  s().insert.run({ ...z, createdAt: now });
}

/**
 * Turn the map over: new epoch, new secret, next rotation scheduled.
 *
 * One statement, so a zone can never be observed holding a new epoch against
 * the old fog. The outgoing secret is archived by the caller *before* this runs
 * — once it is overwritten here it is gone, and with it the ability to prove
 * what last epoch's map was.
 */
export function rotate(
  zoneId: string,
  seedSecret: string,
  seedCommit: string,
  rotatesAt: number | null,
): void {
  s().rotate.run({ zoneId, seedSecret, seedCommit, rotatesAt });
}

/** Zones whose map is due to be reprinted. Null `rotates_at` never comes due. */
export function dueForRotation(now = Date.now()): Zone[] {
  return (s().dueForRotation.all(now) as ZoneRow[]).map(toZone);
}

export function getReveal(
  zoneId: string,
  epoch: number,
  playerId: string,
  r: number,
  c: number,
): Reveal | undefined {
  const row = s().getReveal.get(zoneId, epoch, playerId, r, c) as RevealRow | undefined;
  return row ? toReveal(row) : undefined;
}

/**
 * Record a dig on one player's map.
 *
 * Returns false only when that same player had already opened this tile — a
 * double-tap or a retried request. It is no longer possible to lose a race to
 * another player, because there is no longer a shared key to contend for.
 */
export function addReveal(
  zoneId: string,
  epoch: number,
  reveal: Reveal & { playerId: string },
): boolean {
  const res = s().addReveal.run({
    zoneId,
    epoch,
    playerId: reveal.playerId,
    r: reveal.r,
    c: reveal.c,
    type: reveal.type,
    handle: reveal.byHandle,
    at: reveal.at,
  });
  return res.changes > 0;
}

/** One player's map. There is no longer any such thing as the zone's map. */
export function revealsFor(zoneId: string, epoch: number, playerId: string): Reveal[] {
  return (s().revealsFor.all(zoneId, epoch, playerId) as RevealRow[]).map(toReveal);
}

export function revealCount(zoneId: string, epoch: number, playerId: string): number {
  return (s().revealCount.get(zoneId, epoch, playerId) as { n: number }).n;
}

/** Publishes a finished epoch's seed so the map can be audited after the fact. */
export function archiveSeed(z: Zone, now = Date.now()): void {
  s().archiveSeed.run(z.id, z.epoch, z.seedSecret, z.seedCommit, now);
}

export function seedHistory(zoneId: string): Array<{
  epoch: number;
  seedSecret: string;
  seedCommit: string;
  revealedAt: number;
}> {
  const rows = s().history.all(zoneId) as Array<{
    epoch: number;
    seed_secret: string;
    seed_commit: string;
    revealed_at: number;
  }>;
  return rows.map(r => ({
    epoch: r.epoch,
    seedSecret: r.seed_secret,
    seedCommit: r.seed_commit,
    revealedAt: r.revealed_at,
  }));
}
