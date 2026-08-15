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
      'SELECT * FROM reveals WHERE zone_id = ? AND epoch = ? AND r = ? AND c = ?',
    ),
    // ON CONFLICT DO NOTHING makes a concurrent double-open idempotent; the
    // caller checks `changes` and refunds the energy if it lost the race.
    addReveal: db.prepare(`
      INSERT INTO reveals (zone_id, epoch, r, c, type, player_id, handle, at)
      VALUES (@zoneId, @epoch, @r, @c, @type, @playerId, @handle, @at)
      ON CONFLICT (zone_id, epoch, r, c) DO NOTHING
    `),
    revealsFor: db.prepare('SELECT * FROM reveals WHERE zone_id = ? AND epoch = ?'),
    revealCount: db.prepare(
      'SELECT COUNT(*) AS n FROM reveals WHERE zone_id = ? AND epoch = ?',
    ),
    archiveSeed: db.prepare(`
      INSERT INTO zone_seed_history (zone_id, epoch, seed_secret, seed_commit, revealed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (zone_id, epoch) DO NOTHING
    `),
    history: db.prepare(
      'SELECT * FROM zone_seed_history WHERE zone_id = ? ORDER BY epoch DESC',
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

export function insert(z: Zone, rotatesAt: number | null, now = Date.now()): void {
  s().insert.run({ ...z, rotatesAt, createdAt: now });
}

export function getReveal(zoneId: string, epoch: number, r: number, c: number): Reveal | undefined {
  const row = s().getReveal.get(zoneId, epoch, r, c) as RevealRow | undefined;
  return row ? toReveal(row) : undefined;
}

/** Returns false when the cell was already open — the caller refunds the energy. */
export function addReveal(
  zoneId: string,
  epoch: number,
  reveal: Reveal & { playerId: string },
): boolean {
  const res = s().addReveal.run({
    zoneId,
    epoch,
    r: reveal.r,
    c: reveal.c,
    type: reveal.type,
    playerId: reveal.playerId,
    handle: reveal.byHandle,
    at: reveal.at,
  });
  return res.changes > 0;
}

export function revealsFor(zoneId: string, epoch: number): Reveal[] {
  return (s().revealsFor.all(zoneId, epoch) as RevealRow[]).map(toReveal);
}

export function revealCount(zoneId: string, epoch: number): number {
  return (s().revealCount.get(zoneId, epoch) as { n: number }).n;
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
