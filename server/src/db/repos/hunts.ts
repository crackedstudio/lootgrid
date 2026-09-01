import type { BlockGame, Difficulty, GameType, Hunt, HuntKind, ZoneKind } from '../../types';
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
  recipe: string | null;
  recipe_author: string | null;
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
    // Parsed permissively: a recipe is validated against the module's schema at
    // the moment it is used, not here. A row that will not parse must not stop
    // the hunt loading — it falls back to the salt like an absent one does.
    recipe: r.recipe ? safeJson(r.recipe) : null,
    recipeAuthor: (r.recipe_author as Hunt['recipeAuthor']) ?? null,
    publicAt: r.public_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
    /**
     * Write a recipe, but only onto a hunt that has neither one nor a generated
     * game yet.
     *
     * Both halves of that predicate are load-bearing. Overwriting a recipe
     * would change the puzzle under whoever is already reasoning about it, and
     * `game_type IS NULL` is what proves nobody has been served the block yet —
     * `blockGame` persists the game the first time anyone opens an attempt, so
     * a row with a game is a row whose puzzle is already public.
     */
    saveRecipe: db.prepare(
      'UPDATE hunts SET recipe = ?, recipe_author = ? WHERE id = ? AND recipe IS NULL AND game_type IS NULL',
    ),
    /**
     * Who authored the puzzles, counted by game and by author.
     *
     * Across every epoch on purpose. The question this answers is "has the
     * model been writing puzzles, or silently falling back since inference
     * broke?", and scoping it to the live epoch would answer that only for the
     * last few hours.
     */
    recipeAuthorship: db.prepare(`
      SELECT game_type AS game, recipe_author AS author, COUNT(*) AS n
      FROM hunts
      WHERE recipe_author IS NOT NULL
      GROUP BY game_type, recipe_author
    `),
    /**
     * Live hunts still waiting for an author, oldest first.
     *
     * Joins the zone for its kind, which the caller needs in order to work out
     * which module the block will draw — and joining here is what keeps the
     * author out of `store`, whose own imports would otherwise close a cycle
     * back through the game registry.
     */
    listUnauthored: db.prepare(`
      SELECT h.*, z.kind AS zone_kind FROM hunts h
      JOIN zones z ON z.id = h.zone_id
      WHERE h.recipe IS NULL AND h.game_type IS NULL AND h.status = 'live'
      ORDER BY h.created_at ASC LIMIT ?
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

/**
 * Record who chose this block's puzzle, and what they chose.
 *
 * Returns whether the write landed. It does not when the hunt already has a
 * recipe or has already been played — both are ordinary races rather than
 * errors, because authoring runs in the background and a player can always get
 * there first.
 */
export function saveRecipe(huntId: string, recipe: unknown, author: 'model' | 'salt'): boolean {
  const res = s().saveRecipe.run(JSON.stringify(recipe), author, huntId);
  return res.changes > 0;
}

export interface AuthorshipRow {
  /** Null until the block has been played — the game is drawn lazily. */
  game: GameType | null;
  author: 'model' | 'salt';
  n: number;
}

/** How many blocks each author has written, per game. */
export function recipeAuthorship(): AuthorshipRow[] {
  return s().recipeAuthorship.all() as AuthorshipRow[];
}

/** Live hunts nobody has authored a recipe for and nobody has played yet. */
export function listUnauthored(limit: number): Array<{ hunt: Hunt; zoneKind: ZoneKind }> {
  return (s().listUnauthored.all(limit) as Array<Row & { zone_kind: string }>).map(r => ({
    hunt: toDomain(r),
    zoneKind: r.zone_kind as ZoneKind,
  }));
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
