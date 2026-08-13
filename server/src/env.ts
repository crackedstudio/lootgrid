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
    /**
     * How long a registry lookup is cached before re-reading the chain.
     *
     * Hard-capped: this is the worst-case window in which a revoked session key
     * still authenticates if the event subscription is down. An operator must
     * not be able to widen it to an hour by accident.
     */
    REGISTRY_CACHE_MS: z.coerce.number().int().positive().max(60_000).default(60_000),
    /** Shorter TTL for "this player has no binding" — see registry.ts. */
    REGISTRY_NEGATIVE_CACHE_MS: z.coerce.number().int().positive().max(10_000).default(2_000),

    /** Signed requests older than this are rejected as replays. */
    REQUEST_MAX_SKEW_MS: z.coerce.number().int().positive().default(30_000),

    RATE_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(600),
    /** Per-IP ceiling applied before authentication does any expensive work. */
    RATE_PREAUTH_PER_MIN: z.coerce.number().int().positive().default(60),
    /**
     * Number of reverse-proxy hops in front of the app.
     *
     * MUST match reality. `trustProxy: true` would take the leftmost
     * X-Forwarded-For entry — which the client writes — so any per-IP limit
     * becomes attacker-controlled and unbounded. Trusting a fixed hop count
     * means only the proxy's own appended entry is believed. Default 1 = the
     * Caddy container in docker-compose. Set 0 if nothing fronts the app.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
    RATE_TILE_PER_MIN: z.coerce.number().int().positive().default(120),
    RATE_ATTEMPT_PER_MIN: z.coerce.number().int().positive().default(30),
    WS_MAX_CONNECTIONS_PER_PLAYER: z.coerce.number().int().positive().default(3),
    WS_MAX_MESSAGE_BYTES: z.coerce.number().int().positive().default(8_192),
    WS_HEARTBEAT_MS: z.coerce.number().int().positive().default(30_000),

    /**
     * Publish gameplay to LootGridActions as one transaction per action.
     *
     * Off by default, and off is a perfectly good production configuration —
     * the chain records nothing the server does not already own. Turning it on
     * buys a public, timestamped audit trail and costs relayer gas per action.
     */
    RELAY_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform(v => v === 'true'),
    LOOTGRID_ACTIONS_ADDRESS: hexAddress.optional(),
    /** Hot key. Funded with a small float, rotatable via LootGridActions.setRelayer. */
    RELAY_PRIVATE_KEY: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 0x-prefixed 32-byte key')
      .optional(),
    /** How often the worker drains the outbox. */
    RELAY_POLL_MS: z.coerce.number().int().min(200).max(60_000).default(1_000),
    /** Transactions dispatched per poll, bounded so one tick cannot exhaust the RPC. */
    RELAY_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(200).default(25),
    /**
     * Reveals per transaction. 1 = one transaction per action, which is the
     * point of relaying at all. Raise it only if relayer gas becomes the binding
     * constraint — it trades transaction count for cost, roughly linearly.
     */
    RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(128).default(1),
    /** Give up after this many failures and park the row as `dead` for inspection. */
    RELAY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),

    /**
     * The referee's EIP-712 attestation signing key.
     *
     * Set it to let players publish their own hunt entries and wins, paying
     * their own gas in a Celo fee currency. Leave it unset and the feature is
     * simply off — the relayer keeps publishing everything as before.
     *
     * This key never sends a transaction, so it needs no balance and can sit
     * colder than RELAY_PRIVATE_KEY. It is also the more dangerous of the two:
     * a leak mints entries and winning resolutions that anyone can submit.
     * Its address goes in the contract's ACTIONS_ATTESTOR at deploy time.
     */
    ATTESTOR_PRIVATE_KEY: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 0x-prefixed 32-byte key')
      .optional(),

    /** LootGridEscrow, which holds the prize pots. */
    LOOTGRID_ESCROW_ADDRESS: hexAddress.optional(),
    /**
     * Signs payout claims against LootGridEscrow.
     *
     * Deliberately separate from ATTESTOR_PRIVATE_KEY: that one writes cosmetic
     * game records, this one moves money, and they should not share protection.
     * This is the key to put behind a multisig or threshold signer first.
     */
    ESCROW_PRIVATE_KEY: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 0x-prefixed 32-byte key')
      .optional(),

    /**
     * Fund hunt prizes on chain. Off by default — a hunt with no pot still
     * plays, it simply carries no money.
     */
    ESCROW_FUNDING_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform(v => v === 'true'),
    /**
     * Sends fundHunt. This is the only server key that holds SPENDABLE money —
     * a leak costs whatever balance it carries, and no contract cap can bound
     * that. Keep the float small and top it up on a schedule.
     */
    ESCROW_TREASURY_PRIVATE_KEY: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 0x-prefixed 32-byte key')
      .optional(),
    /** Prize token decimals. cUSD/USDm are 18, USDC/USDT are 6. */
    ESCROW_TOKEN_DECIMALS: z.coerce.number().int().min(2).max(24).default(18),
    ESCROW_POLL_MS: z.coerce.number().int().min(200).max(60_000).default(2_000),
    ESCROW_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(100).default(10),
    ESCROW_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),

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

    // Player self-submission needs the contract address to build the EIP-712
    // domain — without it the signature would verify against nothing.
    if (v.ATTESTOR_PRIVATE_KEY && !v.LOOTGRID_ACTIONS_ADDRESS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOOTGRID_ACTIONS_ADDRESS'],
        message: 'required when ATTESTOR_PRIVATE_KEY is set',
      });
    }

    // Sharing one key would hand the exposed hot wallet the power to mint
    // attestations, collapsing the split that makes a separate attestor useful.
    if (
      v.ATTESTOR_PRIVATE_KEY &&
      v.RELAY_PRIVATE_KEY &&
      v.ATTESTOR_PRIVATE_KEY.toLowerCase() === v.RELAY_PRIVATE_KEY.toLowerCase()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ATTESTOR_PRIVATE_KEY'],
        message: 'must differ from RELAY_PRIVATE_KEY',
      });
    }

    if (v.ESCROW_PRIVATE_KEY && !v.LOOTGRID_ESCROW_ADDRESS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOOTGRID_ESCROW_ADDRESS'],
        message: 'required when ESCROW_PRIVATE_KEY is set',
      });
    }

    // Sharing the key would defeat the separation the escrow's own EIP-712
    // domain exists to provide: one leak would then be worth both.
    if (
      v.ESCROW_PRIVATE_KEY &&
      v.ATTESTOR_PRIVATE_KEY &&
      v.ESCROW_PRIVATE_KEY.toLowerCase() === v.ATTESTOR_PRIVATE_KEY.toLowerCase()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ESCROW_PRIVATE_KEY'],
        message: 'must differ from ATTESTOR_PRIVATE_KEY — payouts and records need separate keys',
      });
    }

    if (v.ESCROW_FUNDING_ENABLED) {
      for (const [key, val] of [
        ['LOOTGRID_ESCROW_ADDRESS', v.LOOTGRID_ESCROW_ADDRESS],
        ['ESCROW_TREASURY_PRIVATE_KEY', v.ESCROW_TREASURY_PRIVATE_KEY],
        ['RPC_URL', v.RPC_URL],
      ] as const) {
        if (!val) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'required when ESCROW_FUNDING_ENABLED=true',
          });
        }
      }
    }

    // The treasury holds the float; the payout signer authorises spending it.
    // One key doing both means a single leak drains everything at once.
    if (
      v.ESCROW_TREASURY_PRIVATE_KEY &&
      v.ESCROW_PRIVATE_KEY &&
      v.ESCROW_TREASURY_PRIVATE_KEY.toLowerCase() === v.ESCROW_PRIVATE_KEY.toLowerCase()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ESCROW_TREASURY_PRIVATE_KEY'],
        message: 'must differ from ESCROW_PRIVATE_KEY — the float and its signer are separate roles',
      });
    }

    if (v.RELAY_ENABLED) {
      if (!v.LOOTGRID_ACTIONS_ADDRESS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['LOOTGRID_ACTIONS_ADDRESS'],
          message: 'required when RELAY_ENABLED=true',
        });
      }
      if (!v.RELAY_PRIVATE_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RELAY_PRIVATE_KEY'],
          message: 'required when RELAY_ENABLED=true',
        });
      }
      if (!v.RPC_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RPC_URL'],
          message: 'required when RELAY_ENABLED=true',
        });
      }
      // Under AUTH_MODE=dev a player id is a made-up string, not an address.
      // Publishing those would write junk to a permanent public log.
      if (v.AUTH_MODE !== 'chain') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RELAY_ENABLED'],
          message: 'requires AUTH_MODE=chain — dev player ids are not addresses',
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
