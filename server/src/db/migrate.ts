import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger';
import { getDb, openDb, type Db } from './index';

// Running from source (tsx) this module sits in src/db/; in the production
// bundle everything collapses to dist/index.js, so the .sql files land beside it.
const here = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [join(here, 'migrations'), join(here, 'db', 'migrations')];
const MIGRATIONS_DIR = CANDIDATES.find(existsSync) ?? CANDIDATES[0]!;

/**
 * Forward-only migrations, applied in filename order, each inside a transaction
 * together with its bookkeeping row — so a failure can never leave a migration
 * half-applied but recorded as done.
 */
export function migrate(db: Db = getDb()): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => (r as { name: string }).name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
    })();

    logger.info({ migration: file }, 'migration applied');
    count += 1;
  }

  if (count === 0) logger.debug('no migrations to apply');
  return count;
}

// NOTE: no `import.meta.url === argv[1]` CLI block here. Everything bundles into
// a single dist/index.js, which would make that check true for the *server*
// entry point and exit the process at boot. The CLI lives in migrate-cli.ts.
