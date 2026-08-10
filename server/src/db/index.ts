import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '../env';
import { logger } from '../logger';

export type Db = Database.Database;

let db: Db | null = null;

export function openDb(path = env.DATABASE_PATH): Db {
  if (db) return db;

  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const handle = new Database(path);

  // WAL lets readers run while a write is in flight — the difference between a
  // responsive server and one that stalls every time someone opens a tile.
  handle.pragma('journal_mode = WAL');
  // NORMAL trades a fsync per commit for one per checkpoint. On a crash you can
  // lose the last few commits; you cannot get a corrupt database. For game
  // state that is the right trade.
  handle.pragma('synchronous = NORMAL');
  handle.pragma('foreign_keys = ON');
  handle.pragma('busy_timeout = 5000');

  db = handle;
  logger.info({ path }, 'sqlite opened');
  return handle;
}

export function getDb(): Db {
  if (!db) throw new Error('database not open — call openDb() first');
  return db;
}

export function closeDb(): void {
  if (!db) return;
  // Fold the WAL back into the main file so a copy of DATABASE_PATH is complete.
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* best effort on shutdown */
  }
  db.close();
  db = null;
}

/** Wraps a unit of work in a transaction. Synchronous by design — no awaits inside. */
export function tx<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}
