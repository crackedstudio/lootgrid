/**
 * Standalone migration runner: `npm run migrate:dev`.
 *
 * Deliberately a separate entry point. Migrations also run automatically during
 * `store.bootstrap()`, so this is only for inspecting or pre-applying schema
 * changes by hand.
 */
import { logger } from '../logger';
import { closeDb, openDb } from './index';
import { migrate } from './migrate';

openDb();
const applied = migrate();
logger.info({ applied }, 'migrations complete');
closeDb();
process.exit(0);
