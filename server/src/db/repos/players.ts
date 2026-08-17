import { ENERGY } from '../../config';
import type { Player } from '../../types';
import { getDb } from '../index';

interface Row {
  id: string;
  handle: string;
  session_key: string | null;
  energy_value: number;
  energy_at: number;
  pass_until: number | null;
  pass_topped_up_at: number | null;
  trust_score: number;
  shadow_banned: number;
  xp: number;
  created_at: number;
  last_seen_at: number;
}

const toDomain = (r: Row): Player => ({
  id: r.id,
  handle: r.handle,
  sessionKey: r.session_key,
  energyValue: r.energy_value,
  energyAt: r.energy_at,
  passUntil: r.pass_until,
  passToppedUpAt: r.pass_topped_up_at,
  trustScore: r.trust_score,
  shadowBanned: r.shadow_banned === 1,
  xp: r.xp,
  createdAt: r.created_at,
});

let cache: ReturnType<typeof build> | null = null;
function build() {
  const db = getDb();
  return {
    get: db.prepare('SELECT * FROM players WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO players (id, handle, session_key, energy_value, energy_at,
                           trust_score, shadow_banned, created_at, last_seen_at)
      VALUES (@id, @handle, @sessionKey, @energyValue, @energyAt, 1.0, 0, @now, @now)
    `),
    saveEnergy: db.prepare('UPDATE players SET energy_value = ?, energy_at = ? WHERE id = ?'),
    setPass: db.prepare('UPDATE players SET pass_until = ? WHERE id = ?'),
    setToppedUp: db.prepare('UPDATE players SET pass_topped_up_at = ? WHERE id = ?'),
    setSessionKey: db.prepare('UPDATE players SET session_key = ? WHERE id = ?'),
    setHandle: db.prepare('UPDATE players SET handle = ? WHERE id = ?'),
    touch: db.prepare('UPDATE players SET last_seen_at = ? WHERE id = ?'),
    setTrust: db.prepare('UPDATE players SET trust_score = ?, shadow_banned = ? WHERE id = ?'),
    // Incremented in SQL rather than read-modify-written, so two awards landing
    // together cannot lose one. XP is cheap, but silently dropping a reward the
    // player watched themselves earn is not.
    addXp: db.prepare('UPDATE players SET xp = xp + ? WHERE id = ?'),
  };
}
const s = () => (cache ??= build());

export function resetStatements(): void {
  cache = null;
}

export function get(id: string): Player | undefined {
  const row = s().get.get(id) as Row | undefined;
  return row ? toDomain(row) : undefined;
}

export function ensure(id: string, handle: string, now = Date.now()): Player {
  const existing = get(id);
  if (existing) return existing;
  s().insert.run({
    id,
    handle,
    sessionKey: null,
    energyValue: ENERGY.start,
    energyAt: now,
    now,
  });
  return get(id)!;
}

/** Energy is the economy — this writes through on every spend, no caching. */
export function saveEnergy(id: string, value: number, at: number): void {
  s().saveEnergy.run(value, at, id);
}

export function setSessionKey(id: string, sessionKey: string | null): void {
  s().setSessionKey.run(sessionKey, id);
}

export function setHandle(id: string, handle: string): void {
  s().setHandle.run(handle, id);
}

export function touch(id: string, now = Date.now()): void {
  s().touch.run(now, id);
}

export function addXp(id: string, amount: number): void {
  if (amount <= 0) return;
  s().addXp.run(amount, id);
}

export function setPass(id: string, until: number | null): void {
  s().setPass.run(until, id);
}

export function setToppedUp(id: string, at: number): void {
  s().setToppedUp.run(at, id);
}

export function setTrust(id: string, score: number, shadowBanned: boolean): void {
  s().setTrust.run(score, shadowBanned ? 1 : 0, id);
}
