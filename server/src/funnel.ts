import { getDb } from './db/index';
import { logger } from './logger';
import * as metrics from './metrics';

/**
 * The five numbers, and nothing else.
 *
 * ─────────────────────────── why this file is small ─────────────────────────
 *
 * The review's instruction is a discipline, not a starting point: *"Nothing
 * else until those five are trustworthy."* Forty-odd metrics already existed
 * before this phase and every one of them measured the system — escrow queue
 * depth, inference failures, realised rake. Not one measured a player, and six
 * phases of game design were built on top of that silence.
 *
 * The temptation with instrumentation is to add everything cheap, which
 * produces a dashboard nobody trusts because nobody knows which numbers are
 * load-bearing. These five are load-bearing. Anything added here should
 * displace one of them or wait.
 *
 * ─────────────────────────── events versus cohorts ──────────────────────────
 *
 * Three of the five are events and are counted where they happen: taps to first
 * treasure, hints held at entry, energy-empty moments. They accumulate.
 *
 * The other two are **cohort** questions — of the people who joined on Tuesday,
 * how many came back on Wednesday; of everyone who ever played, how many ever
 * paid — and a cohort cannot be accumulated as it happens, because the answer
 * changes retroactively as time passes. Those are computed from history on a
 * timer, which is what this file does.
 */

const DAY_MS = 86_400_000;

export interface Retention {
  day: number;
  /** Players whose cohort is old enough for this question to have an answer. */
  eligible: number;
  returned: number;
  ratio: number;
}

export interface FunnelReport {
  players: number;
  payingPlayers: number;
  payingRatio: number;
  retention: Retention[];
  /** When this was computed. A stale funnel read as fresh is worse than none. */
  at: number;
}

/**
 * Share of a cohort still around N days after signing up.
 *
 * ─────────────────────────── what "eligible" excludes ───────────────────────
 *
 * Only players whose day N has actually arrived. Someone who joined this
 * morning has not failed to return on day 7 — they have not had the chance —
 * and counting them as a miss would drag every number toward zero and make a
 * healthy game look dying. This is the mistake that makes retention dashboards
 * untrustworthy, and it is one `WHERE` clause.
 */
export function retention(day: number, now = Date.now()): Retention {
  const today = Math.floor(now / DAY_MS);

  // CAST(... AS INTEGER) is load-bearing, not decoration.
  //
  // A bound parameter arrives as REAL, so `created_at / :dayMs` is FLOAT
  // division — 20679.765 rather than 20679 — and every join against an integer
  // day column silently matches nothing. The same expression with the divisor
  // written as a literal gives the integer answer, which is exactly the kind of
  // difference that makes this hard to see: the query is correct-looking, runs
  // without error, and reports that nobody ever came back.
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS eligible,
             COALESCE(SUM(CASE WHEN d.player_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS returned
        FROM players p
        LEFT JOIN player_days d
          ON d.player_id = p.id
         AND d.day = CAST(p.created_at / :dayMs AS INTEGER) + :day
       WHERE CAST(p.created_at / :dayMs AS INTEGER) + :day <= :today
    `,
    )
    .get({ dayMs: DAY_MS, day, today }) as { eligible: number; returned: number };

  return {
    day,
    eligible: row.eligible,
    returned: row.returned,
    ratio: row.eligible === 0 ? 0 : row.returned / row.eligible,
  };
}

/**
 * Share of players who have ever completed a purchase.
 *
 * The single biggest unknown in the business. Whether one-tap payment converts
 * better than an app store would decides break-even at roughly 950 players or
 * roughly 9,500 — a 10x spread, and no argument settles it. This number does.
 *
 * "Ever paid" rather than "paid this month" on purpose: the question at this
 * stage is whether the rails work on this audience at all, not how often.
 */
export function paying(): { players: number; payingPlayers: number; ratio: number } {
  const db = getDb();
  const players = (db.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number }).n;
  const payingPlayers = (
    db.prepare('SELECT COUNT(DISTINCT player_id) AS n FROM purchases').get() as { n: number }
  ).n;

  return { players, payingPlayers, ratio: players === 0 ? 0 : payingPlayers / players };
}

export function report(now = Date.now()): FunnelReport {
  const pay = paying();
  return {
    players: pay.players,
    payingPlayers: pay.payingPlayers,
    payingRatio: pay.ratio,
    retention: [retention(1, now), retention(7, now)],
    at: now,
  };
}

/**
 * Push the cohort numbers into the gauges.
 *
 * Swallows its own errors: a funnel that cannot be computed is a blind spot,
 * and a funnel that takes the server down with it is an outage.
 */
export function refresh(now = Date.now()): void {
  try {
    const r = report(now);
    metrics.payingShare.set(r.payingRatio);
    metrics.playersTotal.set({ paid: 'yes' }, r.payingPlayers);
    metrics.playersTotal.set({ paid: 'no' }, r.players - r.payingPlayers);
    for (const row of r.retention) {
      metrics.retention.set({ day: String(row.day) }, row.ratio);
    }
  } catch (err) {
    logger.warn({ err }, 'funnel refresh failed');
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Recompute periodically.
 *
 * Every five minutes rather than per request: these are full-table aggregates
 * and the answers move on the scale of days. Computing them on a scrape would
 * put a table scan on an endpoint anyone can call.
 */
export function start(intervalMs = 5 * 60_000): void {
  refresh();
  timer = setInterval(() => refresh(), intervalMs);
  timer.unref?.();
}

export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
