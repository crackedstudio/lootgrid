import { z } from 'zod';

const hexAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed address');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(8787),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    /** SQLite file. A path on the VPS — no service to run, back it up by copying it. */
    DATABASE_PATH: z.string().default('./data/lootgrid.db'),

    /** Comma-separated origins, or `*`. Locked down in production (see refine below). */
    CORS_ORIGINS: z.string().default('*'),

    /**
     * `chain` verifies session keys against PlayerRegistry on Celo.
     * `dev` trusts the claimed player id — refused in production.
     */
    AUTH_MODE: z.enum(['chain', 'dev']).default('dev'),
    CHAIN: z.enum(['celo', 'celoSepolia']).default('celoSepolia'),
    RPC_URL: z.string().url().optional(),
    PLAYER_REGISTRY_ADDRESS: hexAddress.optional(),
    /** How long a registry lookup is cached before re-reading the chain. */
    REGISTRY_CACHE_MS: z.coerce.number().int().positive().default(60_000),

    /** Signed requests older than this are rejected as replays. */
    REQUEST_MAX_SKEW_MS: z.coerce.number().int().positive().default(30_000),

    RATE_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(600),
    RATE_TILE_PER_MIN: z.coerce.number().int().positive().default(120),
    RATE_ATTEMPT_PER_MIN: z.coerce.number().int().positive().default(30),
    WS_MAX_CONNECTIONS_PER_PLAYER: z.coerce.number().int().positive().default(3),
    WS_MAX_MESSAGE_BYTES: z.coerce.number().int().positive().default(8_192),
    WS_HEARTBEAT_MS: z.coerce.number().int().positive().default(30_000),

    METRICS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform(v => v === 'true'),
    /** If set, /metrics requires `Authorization: Bearer <token>`. */
    METRICS_TOKEN: z.string().min(16).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.AUTH_MODE === 'chain') {
      if (!v.PLAYER_REGISTRY_ADDRESS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PLAYER_REGISTRY_ADDRESS'],
          message: 'required when AUTH_MODE=chain',
        });
      }
      if (!v.RPC_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RPC_URL'],
          message: 'required when AUTH_MODE=chain',
        });
      }
    }

    // Guard rails that exist to stop a catastrophic deploy, not to be clever.
    if (v.NODE_ENV === 'production') {
      if (v.AUTH_MODE === 'dev') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_MODE'],
          message: 'refusing to start: AUTH_MODE=dev trusts any claimed player id',
        });
      }
      if (v.CORS_ORIGINS === '*') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGINS'],
          message: 'refusing to start: set explicit origins in production',
        });
      }
      if (v.METRICS_ENABLED && !v.METRICS_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['METRICS_TOKEN'],
          message: 'required in production when METRICS_ENABLED=true',
        });
      }
    }
  });

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    // Fail loudly at boot rather than mysteriously at request time.
    console.error(`Invalid environment:\n${lines.join('\n')}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

export function corsOrigins(): true | string[] {
  if (env.CORS_ORIGINS.trim() === '*') return true;
  return env.CORS_ORIGINS.split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
