import { pino } from 'pino';
import { env } from './env';

/**
 * JSON to stdout, always — that is what you want shipped to a log collector, and
 * it removes any chance of a pretty-printer being missing in the container.
 * For readable local output: `npm run dev | npx pino-pretty`.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'lootgrid-server' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-signature"]',
      'req.headers["x-session-key"]',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
    ],
    remove: true,
  },
  formatters: {
    level: label => ({ level: label }),
  },
});

export type Logger = typeof logger;
