import type { Attempt, AttemptEvent, AttemptStatus, GameType } from '../../types';
import { getDb } from '../index';

interface Row {
  id: string;
  hunt_id: string;
  player_id: string;
  handle: string;
  game_type: string;
  started_at: number;
  deadline_at: number;
  status: string;
  last_seq: number;
  elapsed_ms: number | null;
  fail_reason: string | null;
  progress: number;
  intervals: string;
  max_clock_skew_ms: number;
  finished_at: number | null;
}

/**
 * Note there is no `state` column. Module runtime state is meaningful only while
 * an attempt is in flight, and an in-flight attempt is intentionally lost on a
 * crash — the boot recovery below marks those abandoned and refunds the energy.
 */
function toDomain(r: Row): Attempt {
  return {
    id: r.id,
    huntId: r.hunt_id,
    playerId: r.player_id,
    handle: r.handle,
    gameType: r.game_type as GameType,
    startedAt: r.started_at,
    deadlineAt: r.deadline_at,
    status: r.status as AttemptStatus,
    lastSeq: r.last_seq,
    state: null,
    elapsedMs: r.elapsed_ms,
    failReason: r.fail_reason,
    progress: r.progress,
    intervals: JSON.parse(r.intervals) as number[],
    events: [],
    maxClockSkewMs: r.max_clock_skew_ms,
  };
}

let cache: ReturnType<typeof build> | null = null;
function build() {
  const db = getDb();
  return {
    get: db.prepare('SELECT * FROM attempts WHERE id = ?'),
    ofPlayer: db.prepare('SELECT * FROM attempts WHERE hunt_id = ? AND player_id = ?'),
    forHunt: db.prepare('SELECT * FROM attempts WHERE hunt_id = ?'),
    recentForPlayer: db.prepare(
      'SELECT * FROM attempts WHERE player_id = ? ORDER BY started_at DESC LIMIT ?',
    ),
    insert: db.prepare(`
      INSERT INTO attempts (id, hunt_id, player_id, handle, game_type, started_at,
                            deadline_at, status, last_seq, progress, intervals, max_clock_skew_ms)
      VALUES (@id, @huntId, @playerId, @handle, @gameType, @startedAt,
              @deadlineAt, @status, 0, 0, '[]', 0)
    `),
    finish: db.prepare(`
      UPDATE attempts
         SET status = @status, last_seq = @lastSeq, elapsed_ms = @elapsedMs,
             fail_reason = @failReason, progress = @progress, intervals = @intervals,
             max_clock_skew_ms = @maxClockSkewMs, finished_at = @finishedAt
       WHERE id = @id
    `),
    addEvent: db.prepare(`
      INSERT INTO attempt_events (attempt_id, seq, kind, t_client, t_server)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (attempt_id, seq) DO NOTHING
    `),
    events: db.prepare('SELECT * FROM attempt_events WHERE attempt_id = ? ORDER BY seq'),
    abandonActive: db.prepare(
      "UPDATE attempts SET status = 'abandoned', fail_reason = 'server_restart', finished_at = ? WHERE status = 'active'",
    ),
  };
}
const s = () => (cache ??= build());

export function resetStatements(): void {
  cache = null;
}

export function get(id: string): Attempt | undefined {
  const row = s().get.get(id) as Row | undefined;
  return row ? toDomain(row) : undefined;
}

export function ofPlayer(huntId: string, playerId: string): Attempt | undefined {
  const row = s().ofPlayer.get(huntId, playerId) as Row | undefined;
  return row ? toDomain(row) : undefined;
}

export function forHunt(huntId: string): Attempt[] {
  return (s().forHunt.all(huntId) as Row[]).map(toDomain);
}

export function recentForPlayer(playerId: string, limit = 50): Attempt[] {
  return (s().recentForPlayer.all(playerId, limit) as Row[]).map(toDomain);
}

/** Throws on the UNIQUE (hunt_id, player_id) conflict — one shot per block. */
export function insert(a: Attempt): void {
  s().insert.run({
    id: a.id,
    huntId: a.huntId,
    playerId: a.playerId,
    handle: a.handle,
    gameType: a.gameType,
    startedAt: a.startedAt,
    deadlineAt: a.deadlineAt,
    status: a.status,
  });
}

export function finish(a: Attempt, now = Date.now()): void {
  s().finish.run({
    id: a.id,
    status: a.status,
    lastSeq: a.lastSeq,
    elapsedMs: a.elapsedMs,
    failReason: a.failReason,
    progress: a.progress,
    intervals: JSON.stringify(a.intervals),
    maxClockSkewMs: a.maxClockSkewMs,
    finishedAt: now,
  });
}

/** Written in one transaction when an attempt ends — never on the per-tap path. */
export function saveEvents(attemptId: string, events: AttemptEvent[]): void {
  if (events.length === 0) return;
  const db = getDb();
  const stmt = s().addEvent;
  db.transaction(() => {
    for (const e of events) stmt.run(attemptId, e.seq, e.kind, e.tClient, e.tServer);
  })();
}

export function eventsFor(attemptId: string): AttemptEvent[] {
  const rows = s().events.all(attemptId) as Array<{
    seq: number;
    kind: string;
    t_client: number;
    t_server: number;
  }>;
  return rows.map(r => ({ seq: r.seq, kind: r.kind, tClient: r.t_client, tServer: r.t_server }));
}

/**
 * Crash recovery. Anything still `active` at boot belongs to a process that no
 * longer exists, so it can never complete. Fail closed.
 */
export function abandonActiveOnBoot(now = Date.now()): number {
  return s().abandonActive.run(now).changes;
}
