import { getDb } from '../index';

let cache: ReturnType<typeof build> | null = null;
function build() {
  const db = getDb();
  return {
    claim: db.prepare(`
      INSERT INTO request_nonces (player_id, nonce, seen_at) VALUES (?, ?, ?)
      ON CONFLICT (player_id, nonce) DO NOTHING
    `),
    prune: db.prepare('DELETE FROM request_nonces WHERE seen_at < ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM request_nonces'),
  };
}
const s = () => (cache ??= build());

export function resetStatements(): void {
  cache = null;
}

/**
 * Returns true if this nonce is fresh. A conflict means the exact same signed
 * request has been seen before — that is a replay, not a retry, because the
 * nonce is part of what was signed.
 */
export function claim(playerId: string, nonce: string, now = Date.now()): boolean {
  return s().claim.run(playerId, nonce, now).changes > 0;
}

/** Nonces only need to outlive the skew window; anything older is unreachable. */
export function prune(olderThan: number): number {
  return s().prune.run(olderThan).changes;
}

export function count(): number {
  return (s().count.get() as { n: number }).n;
}
