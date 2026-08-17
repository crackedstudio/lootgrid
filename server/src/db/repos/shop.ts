import { getDb } from '../index';

export interface PurchaseRow {
  id: string;
  playerId: string;
  sku: string;
  priceCents: number;
  paymentRef: string | null;
  createdAt: number;
}

export interface Entitlement {
  kind: string;
  remaining: number;
  expiresAt: number | null;
  targetId: string | null;
}

let cache: ReturnType<typeof build> | null = null;
function build() {
  const db = getDb();
  return {
    insertPurchase: db.prepare(`
      INSERT INTO purchases (id, player_id, sku, price_cents, payment_ref, created_at)
      VALUES (@id, @playerId, @sku, @priceCents, @paymentRef, @createdAt)
    `),
    purchasesOf: db.prepare(
      'SELECT * FROM purchases WHERE player_id = ? ORDER BY created_at DESC LIMIT ?',
    ),
    /** Revenue by SKU. The numerator side of the published payout ratio. */
    revenueBySku: db.prepare(`
      SELECT sku, COUNT(*) AS orders, SUM(price_cents) AS cents
        FROM purchases
       WHERE created_at >= ?
       GROUP BY sku
    `),

    get: db.prepare('SELECT * FROM entitlements WHERE player_id = ? AND kind = ?'),
    all: db.prepare('SELECT * FROM entitlements WHERE player_id = ?'),
    /**
     * Extend rather than replace.
     *
     * A second Cycle Pass pushes the expiry out from wherever it already is; a
     * second Compass adds charges. Buying something twice must never be worth
     * less than buying it twice, which a naive INSERT OR REPLACE would make it.
     */
    upsert: db.prepare(`
      INSERT INTO entitlements (player_id, kind, remaining, expires_at, target_id, updated_at)
      VALUES (@playerId, @kind, @remaining, @expiresAt, @targetId, @updatedAt)
      ON CONFLICT (player_id, kind) DO UPDATE SET
        remaining  = entitlements.remaining + excluded.remaining,
        expires_at = MAX(COALESCE(entitlements.expires_at, @updatedAt), COALESCE(excluded.expires_at, @updatedAt)),
        target_id  = COALESCE(excluded.target_id, entitlements.target_id),
        updated_at = excluded.updated_at
    `),
    setRemaining: db.prepare(
      'UPDATE entitlements SET remaining = ?, updated_at = ? WHERE player_id = ? AND kind = ?',
    ),
    setTarget: db.prepare(
      'UPDATE entitlements SET target_id = ?, updated_at = ? WHERE player_id = ? AND kind = ?',
    ),
    clear: db.prepare('DELETE FROM entitlements WHERE player_id = ? AND kind = ?'),
  };
}
const s = () => (cache ??= build());

export function resetStatements(): void {
  cache = null;
}

const toEntitlement = (r: {
  kind: string;
  remaining: number;
  expires_at: number | null;
  target_id: string | null;
}): Entitlement => ({
  kind: r.kind,
  remaining: r.remaining,
  expiresAt: r.expires_at,
  targetId: r.target_id,
});

export function recordPurchase(row: PurchaseRow): void {
  s().insertPurchase.run(row);
}

export function purchasesOf(playerId: string, limit = 50): PurchaseRow[] {
  return (s().purchasesOf.all(playerId, limit) as Array<Record<string, unknown>>).map(r => ({
    id: r.id as string,
    playerId: r.player_id as string,
    sku: r.sku as string,
    priceCents: r.price_cents as number,
    paymentRef: (r.payment_ref as string | null) ?? null,
    createdAt: r.created_at as number,
  }));
}

export function revenueBySku(since = 0): Array<{ sku: string; orders: number; cents: number }> {
  return s().revenueBySku.all(since) as Array<{ sku: string; orders: number; cents: number }>;
}

/** An entitlement, or null when absent or expired. Expiry is read, never swept. */
export function entitlement(playerId: string, kind: string, now = Date.now()): Entitlement | null {
  const row = s().get.get(playerId, kind) as Parameters<typeof toEntitlement>[0] | undefined;
  if (!row) return null;
  const e = toEntitlement(row);
  if (e.expiresAt !== null && e.expiresAt <= now) return null;
  return e;
}

export function activeFor(playerId: string, now = Date.now()): Entitlement[] {
  return (s().all.all(playerId) as Array<Parameters<typeof toEntitlement>[0]>)
    .map(toEntitlement)
    .filter(e => e.expiresAt === null || e.expiresAt > now);
}

export function grant(
  playerId: string,
  kind: string,
  opts: { remaining?: number; expiresAt?: number | null; targetId?: string | null },
  now = Date.now(),
): void {
  s().upsert.run({
    playerId,
    kind,
    remaining: opts.remaining ?? 0,
    expiresAt: opts.expiresAt ?? null,
    targetId: opts.targetId ?? null,
    updatedAt: now,
  });
}

export function setRemaining(playerId: string, kind: string, n: number, now = Date.now()): void {
  s().setRemaining.run(n, now, playerId, kind);
}

export function setTarget(playerId: string, kind: string, targetId: string | null, now = Date.now()): void {
  s().setTarget.run(targetId, now, playerId, kind);
}

export function clear(playerId: string, kind: string): void {
  s().clear.run(playerId, kind);
}
