import type { BlockGame, Difficulty, GameType, Hunt, HuntKind } from '../../types';
import { getDb } from '../index';

interface Row {
  id: string;
  zone_id: string;
  epoch: number;
  r: number;
  c: number;
  salt: string;
  cell_commit: string;
  kind: string;
  owner_id: string | null;
  difficulty: string;
  prize_label: string;
  status: string;
  winner_id: string | null;
  game_type: string | null;
  game_spec: string | null;
  game_secret: string | null;
  game_limit_ms: number | null;
  public_at: number | null;
  expires_at: number | null;
  created_at: number;
  resolved_at: number | null;
}

function toDomain(r: Row): Hunt {
  const game: BlockGame | null = r.game_type
    ? {
        type: r.game_type as GameType,
        spec: r.game_spec ? JSON.parse(r.game_spec) : null,
        secret: r.game_secret ? JSON.parse(r.game_secret) : null,
        limitMs: r.game_limit_ms ?? 0,
      }
    : null;

  return {
    id: r.id,
    zoneId: r.zone_id,
    epoch: r.epoch,
    r: r.r,
    c: r.c,
    salt: r.salt,
    cellCommit: r.cell_commit,
    kind: r.kind as HuntKind,
    ownerId: r.owner_id,
    difficulty: r.difficulty as Difficulty,
    prizeLabel: r.prize_label,
    status: r.status as Hunt['status'],
    winnerId: r.winner_id,
    game,
    publicAt: r.public_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

let cache: ReturnType<typeof build> | null = null;
function build() {
  const db = getDb();
  return {
    get: db.prepare('SELECT * FROM hunts WHERE id = ?'),
    at: db.prepare('SELECT * FROM hunts WHERE zone_id = ? AND epoch = ? AND r = ? AND c = ?'),
    listIn: db.prepare('SELECT * FROM hunts WHERE zone_id = ? AND epoch = ?'),
    // 'resolving' still counts as open — it is a race being settled, and it has
    // to stay visible until a winner is recorded. 'expired' does not: nobody
    // cracked it, it can never be played again, and leaving it here was quietly
    // fatal. `countOpen` shares the predicate, so an expired hunt was still
    // filling one of the zone's HUNTS_PER_ZONE slots and `replenish` never
    // minted a replacement — a zone would bleed a hunt a day until it had none
    // that could actually be played, while still reporting a full grid.
    // The SHARED map. `owner_id IS NULL` is what keeps a reserved hunt out of
    // everyone else's grid, out of hint targeting, and out of the count that
    // decides whether a zone needs restocking — so an owned hunt is additive
    // rather than something that displaces a real treasure.
    listLive: db.prepare(
      "SELECT * FROM hunts WHERE zone_id = ? AND epoch = ? AND owner_id IS NULL AND status NOT IN ('resolved', 'expired')",
    ),
    /**
     * Every hunt in a given status, across all zones and epochs.
     *
     * Exists for restart recovery: the settlement window is a `setTimeout`, so a
     * process that stops mid-window leaves `resolving` rows nothing will ever
     * settle. See `referee.recoverResolving`.
     */
    listByStatus: db.prepare('SELECT * FROM hunts WHERE status = ?'),
    /**
     * What ONE PLAYER may see of the shared map: everything already public, plus
     * anything they personally dug up during its head start.
     *
     * This is the query `GET /zones/:id` must use. `listLive` returns the whole
     * truth and is for the server's own reasoning — Survey measures against
     * treasures nobody has found yet, hints are generated for them, and
     * `replenish` counts them. Serving `listLive` to a client is the bug
     * migration 019 exists to close, so the two are deliberately different
     * functions with different names rather than one function with a flag.
     */
    listVisible: db.prepare(`
      SELECT h.* FROM hunts h
      WHERE h.zone_id = ? AND h.epoch = ? AND h.owner_id IS NULL
        AND h.status NOT IN ('resolved', 'expired')
        AND (
          (h.public_at IS NOT NULL AND h.public_at <= @now)
          OR EXISTS (
            SELECT 1 FROM hunt_discoveries d
            WHERE d.hunt_id = h.id AND d.player_id = @playerId
          )
        )
    `),
    /** One player's reserved hunts in a zone. Invisible to anyone else. */
    listOwned: db.prepare(
      "SELECT * FROM hunts WHERE zone_id = ? AND epoch = ? AND owner_id = ? AND status NOT IN ('resolved', 'expired')",
    ),
    /** Idempotent: digging the same cell twice does not re-start a head start. */
    addDiscovery: db.prepare(`
      INSERT OR IGNORE INTO hunt_discoveries (hunt_id, player_id, discovered_at)
      VALUES (?, ?, ?)
    `),
    hasDiscovered: db.prepare(
      'SELECT 1 AS found FROM hunt_discoveries WHERE hunt_id = ? AND player_id = ?',
    ),
    /**
     * Only ever pulls the moment FORWARD.
     *
     * The first finder starts the head start; a second finder arriving ten
     * minutes later must not push it back and buy themselves a fresh twenty
     * minutes at the field's expense.
     */
    bringPublicForward: db.prepare(
      'UPDATE hunts SET public_at = ? WHERE id = ? AND (public_at IS NULL OR public_at > ?)',
    ),
    insert: db.prepare(`
      INSERT INTO hunts (id, zone_id, epoch, r, c, salt, cell_commit, kind, owner_id, difficulty,
                         prize_label, status, winner_id, public_at, expires_at, created_at)
      VALUES (@id, @zoneId, @epoch, @r, @c, @salt, @cellCommit, @kind, @ownerId, @difficulty,
              @prizeLabel, @status, NULL, @publicAt, @expiresAt, @createdAt)
    `),
    saveGame: db.prepare(`
      UPDATE hunts SET game_type = ?, game_spec = ?, game_secret = ?, game_limit_ms = ?
      WHERE id = ?
    `),
    setStatus: db.prepare(
      'UPDATE hunts SET status = ?, winner_id = ?, resolved_at = ? WHERE id = ?',
    ),
    /** Must match `listLive`'s predicate exactly — see the note there. */
    countOpen: db.prepare(
      "SELECT COUNT(*) AS n FROM hunts WHERE zone_id = ? AND epoch = ? AND owner_id IS NULL AND status NOT IN ('resolved', 'expired')",
    ),
    /**
     * Open hunts that carry money. Bounds the treasury's burn: a zone holds
     * `CASH_PER_ZONE` of these however many treasures are on it.
     */
    countOpenCash: db.prepare(
      "SELECT COUNT(*) AS n FROM hunts WHERE zone_id = ? AND epoch = ? AND owner_id IS NULL AND kind = 'cash' AND status NOT IN ('resolved', 'expired')",
    ),
    expired: db.prepare(
      "SELECT * FROM hunts WHERE status = 'live' AND expires_at IS NOT NULL AND expires_at < ?",
    ),
  };
}
const s = () => (cache ??= build());

export function resetStatements(): void {
  cache = null;
}

export function get(id: string): Hunt | undefined {
  const row = s().get.get(id) as Row | undefined;
  return row ? toDomain(row) : undefined;
}

export function at(zoneId: string, epoch: number, r: number, c: number): Hunt | undefined {
  const row = s().at.get(zoneId, epoch, r, c) as Row | undefined;
  return row ? toDomain(row) : undefined;
}

export function listIn(zoneId: string, epoch: number): Hunt[] {
  return (s().listIn.all(zoneId, epoch) as Row[]).map(toDomain);
}

export function listLive(zoneId: string, epoch: number): Hunt[] {
  return (s().listLive.all(zoneId, epoch) as Row[]).map(toDomain);
}

export function listByStatus(status: string): Hunt[] {
  return (s().listByStatus.all(status) as Row[]).map(toDomain);
}

export function listOwned(zoneId: string, epoch: number, ownerId: string): Hunt[] {
  return (s().listOwned.all(zoneId, epoch, ownerId) as Row[]).map(toDomain);
}

/** What one player may see of the shared map. See the note on `listVisible`. */
export function listVisible(
  zoneId: string,
  epoch: number,
  playerId: string,
  now: number,
): Hunt[] {
  return (s().listVisible.all(zoneId, epoch, { now, playerId }) as Row[]).map(toDomain);
}

/**
 * Record that this player found this treasure, and start its head start if they
 * are the first. Returns true when the discovery is new.
 */
export function addDiscovery(
  huntId: string,
  playerId: string,
  at: number,
  publicAt: number,
): boolean {
  const inserted = s().addDiscovery.run(huntId, playerId, at).changes > 0;
  if (inserted) s().bringPublicForward.run(publicAt, huntId, publicAt);
  return inserted;
}

export function hasDiscovered(huntId: string, playerId: string): boolean {
  return s().hasDiscovered.get(huntId, playerId) !== undefined;
}

export function insert(h: Hunt): void {
  s().insert.run({
    id: h.id,
    zoneId: h.zoneId,
    epoch: h.epoch,
    r: h.r,
    c: h.c,
    salt: h.salt,
    cellCommit: h.cellCommit,
    kind: h.kind,
    ownerId: h.ownerId ?? null,
    difficulty: h.difficulty,
    prizeLabel: h.prizeLabel,
    status: h.status,
    publicAt: h.publicAt ?? null,
    expiresAt: h.expiresAt,
    createdAt: h.createdAt,
  });
}

/** The block's game is generated once and then immutable — regenerating it mid-race
 *  would change the challenge under players who already started. */
export function saveGame(huntId: string, game: BlockGame): void {
  s().saveGame.run(
    game.type,
    JSON.stringify(game.spec ?? null),
    JSON.stringify(game.secret ?? null),
    game.limitMs,
    huntId,
  );
}

export function setStatus(
  id: string,
  status: Hunt['status'],
  winnerId: string | null = null,
  resolvedAt: number | null = null,
): void {
  s().setStatus.run(status, winnerId, resolvedAt, id);
}

export function countOpen(zoneId: string, epoch: number): number {
  return (s().countOpen.get(zoneId, epoch) as { n: number }).n;
}

export function countOpenCash(zoneId: string, epoch: number): number {
  return (s().countOpenCash.get(zoneId, epoch) as { n: number }).n;
}

export function expired(now = Date.now()): Hunt[] {
  return (s().expired.all(now) as Row[]).map(toDomain);
}
