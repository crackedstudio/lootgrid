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
  hints_used: number | null;
  fail_reason: string | null;
  progress: number;
  intervals: string;
  max_clock_skew_ms: number;
  finished_at: number | null;
  state: string | null;
}

/**
 * `state` is opaque JSON owned by the game module, and it is only ever written
 * for modules that declare themselves durable — the agent games, whose attempts
 * run for minutes and must survive a deploy. Reflex attempts leave it NULL and
 * keep the memory-only path: six seconds of state is not worth a disk write per
 * tap, and losing it to a restart costs nobody anything.
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
    // Rehydrated on the recovery path; null everywhere else, which is what a
    // reflex attempt has always looked like.
    state: r.state === null ? null : (JSON.parse(r.state) as unknown),
    elapsedMs: r.elapsed_ms,
    hintsUsed: r.hints_used,
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
    // Cash entries since a timestamp. This IS the key balance — see keys.ts.
    // Joined against hunts rather than stored on the attempt, so it cannot
    // drift from what actually happened.
    countCashSince: db.prepare(`
      SELECT COUNT(*) AS n
        FROM attempts a
        JOIN hunts h ON h.id = a.hunt_id
       WHERE a.player_id = ? AND h.kind = 'cash' AND a.started_at >= ?
    `),
    countForPlayer: db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE player_id = ?'),
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
             hints_used = @hintsUsed,
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
    // Written after every accepted input on a durable module. Progress and
    // lastSeq ride along because a recovered attempt has to refuse the inputs it
    // already applied — otherwise a replayed sequence would advance it twice.
    saveState: db.prepare(
      'UPDATE attempts SET state = @state, last_seq = @lastSeq, progress = @progress WHERE id = @id',
    ),
    activeWithState: db.prepare(
      "SELECT * FROM attempts WHERE status = 'active' AND state IS NOT NULL",
    ),
    abandonActive: db.prepare(
      "UPDATE attempts SET status = 'abandoned', fail_reason = 'server_restart', finished_at = ? WHERE status = 'active' AND state IS NULL",
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

export function countForPlayer(playerId: string): number {
  return (s().countForPlayer.get(playerId) as { n: number }).n;
}

export function countCashSince(playerId: string, since: number): number {
  return (s().countCashSince.get(playerId, since) as { n: number }).n;
}

export function finish(a: Attempt, now = Date.now()): void {
  s().finish.run({
    id: a.id,
    status: a.status,
    lastSeq: a.lastSeq,
    elapsedMs: a.elapsedMs,
    hintsUsed: a.hintsUsed,
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
 * Snapshot an in-flight durable attempt.
 *
 * Called after every accepted input on an agent game — which sounds expensive
 * and is not: those arrive minutes apart, so this runs orders of magnitude less
 * often than a single human attempt's taps.
 */
export function saveState(a: Attempt): void {
  s().saveState.run({
    id: a.id,
    state: JSON.stringify(a.state),
    lastSeq: a.lastSeq,
    progress: a.progress,
  });
}

/** In-flight attempts that carried state through the restart. */
export function recoverable(): Attempt[] {
  return (s().activeWithState.all() as Row[]).map(toDomain);
}

/**
 * Crash recovery for attempts that cannot be resumed.
 *
 * Anything still `active` with no saved state belongs to a process that no
 * longer exists and can never complete, so it fails closed. Attempts WITH state
 * are left alone and rehydrated instead — see {@link recoverable}. Their
 * deadlines are absolute wall-clock times, so one that expired while the server
 * was down is swept by the referee within a tick of coming back up rather than
 * needing separate handling here.
 */
export function abandonActiveOnBoot(now = Date.now()): number {
  return s().abandonActive.run(now).changes;
}
