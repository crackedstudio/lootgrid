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
    /**
     * Market writes per identity per minute.
     *
     * Tighter than gameplay: each one signs an attestation or reads the chain,
     * and an order book is the cheapest surface on which to be noisy.
     */
    RATE_MARKET_PER_MIN: z.coerce.number().int().positive().default(60),
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
    // RELAY_BATCH_SIZE was removed with the reveal relay. `recordRevealBatch`
    // was the only multi-row call the contract offers, so there is nothing left
    // to batch — the relay now sends one transaction per action, always. A
    // stale value in an env file is ignored rather than rejected.
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

    /**
     * HintEscrow, which holds a buyer's money while a hint changes hands.
     *
     * Also the EIP-712 verifying contract for the `Hint` vouch, so setting it is
     * what makes vouches signable at all — a vouch bound to no address would
     * verify against nothing.
     */
    HINT_ESCROW_ADDRESS: hexAddress.optional(),
    HINT_BOND_ADDRESS: hexAddress.optional(),
    /**
     * Open the hint market.
     *
     * Off by default. Unlike entry fees this is not legally gated — players
     * trading information with each other is not the house charging admission —
     * but it moves real money between wallets, so it stays deliberate.
     */
    HINT_MARKET_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform(v => v === 'true'),
    /**
     * How long a funded trade waits for its release before the buyer may refund.
     *
     * Short on purpose: the money is idle for this long in the worst case, and a
     * hint's value decays with its hunt. Must be under the contract's own
     * `maxTradeTtl` or every `fund` reverts BadExpiry.
     */
    HINT_TRADE_TTL_SEC: z.coerce.number().int().min(60).max(86_400).default(900),
    /**
     * Settlement token for the market — must be the `token` HintEscrow was
     * deployed against. Only ever used to build the buyer's `approve` call.
     */
    HINT_TOKEN_ADDRESS: hexAddress.optional(),
    /** Settlement token decimals for the market. cUSD/USDm 18, USDC/USDT 6. */
    HINT_TOKEN_DECIMALS: z.coerce.number().int().min(2).max(24).default(18),

    /**
     * Charge an entry fee for rewarded hunts.
     *
     * DEFAULT FALSE AND MUST STAY FALSE IN PRODUCTION until the legal review
     * returns. Pay-to-enter for a cash prize is the gambling definition in many
     * jurisdictions, and this build compounds it: the house charges admission,
     * issues the hints, and may deliberately falsify them. See
     * docs/AGENTIC_ARCHITECTURE.md §10.
     */
    ENTRY_FEES_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform(v => v === 'true'),
    /** Where entry fees are collected. */
    ENTRY_FEE_PAY_TO: hexAddress.optional(),
    /**
     * API key for the Celo x402 facilitator.
     *
     * Goes to the facilitator and nowhere else — never to a buyer, never into
     * the client bundle. Optional: the facilitator may serve unauthenticated
     * traffic at a lower rate limit.
     */
    X402_API_KEY: z.string().min(8).optional(),

    // ─────────────────────────── player agents ───────────────────────────

    /**
     * Derives every agent's signing key. **The most dangerous secret on the box
     * after the escrow treasury.**
     *
     * A leak is every agent's spending rights at once — bounded, per player, by
     * their vault's per-transaction and daily caps, their allowlist, and their
     * kill switch. It cannot withdraw, raise a limit, or block an owner leaving.
     *
     * Keep it out of the game database and out of backups. Rotating it re-derives
     * every agent address, so every player must re-bind: their transaction, not
     * ours. See agents/identity.ts.
     */
    AGENT_MASTER_KEY: z.string().min(32).optional(),
    /** AgentVaultFactory. The only agent address the server needs to be told. */
    AGENT_VAULT_FACTORY_ADDRESS: hexAddress.optional(),
    /** The token vaults hold. Usually the same as the hint market's. */
    AGENT_TOKEN_ADDRESS: hexAddress.optional(),
    /**
     * Run player agents. Off by default: this is the feature that puts a model
     * in charge of a wallet, and it should never switch itself on.
     */
    AGENTS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform(v => v === 'true'),

    /**
     * DeepSeek key for the hosted inference pool.
     *
     * Players do not bring their own, so the house pays and meters it per vault.
     * It must never reach a client bundle or an agent's config — see
     * agents/inference.ts.
     */
    /**
     * Concurrent provider calls across ALL agents.
     *
     * The binding constraint at a hundred seats — see runtime.ts. Set it below
     * the provider's per-account concurrency limit, which is a fact about the
     * plan rather than about this code, and alert on rejections rather than
     * discovering the ceiling from a queue that stopped draining.
     *
     * ─────────────────────────── 4 → 8, and still provisional ───────────────
     *
     * The old default of 4 was sized for a handful of demo accounts and sat
     * BELOW the ~6.5 calls/sec that a hundred seats need (see runtime.ts). It
     * was the binding constraint on everything agents do, which is why raising
     * it came before making agents livelier — spontaneity behind a 4-wide gate
     * is just a longer queue.
     *
     * 8 is a starting point, not an answer. The answer is a fact about our
     * DeepSeek plan, and `lootgrid_agent_queue_wait_seconds` is how to find it:
     * raise this until the upper percentiles sit clear of a turn deadline, and
     * alert there rather than on the depth gauge, which stays flat right up
     * until it does not.
     */
    AGENT_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(256).default(8),

    /**
     * Funded seats — how many agents the house will pay inference for.
     *
     * NOT a cap on how many may play. AGENT_TIER.md §2: anything a player must
     * buy in order to compete for a cash prize is an entry fee with extra
     * steps, so an unseated agent enters the same hunts and wins the same
     * prizes, playing its deterministic line instead of a model's.
     */
    /**
     * Where seat money goes. Seats are sold only when this is set, and the check
     * is deliberately independent of ENTRY_FEES_ENABLED — see x402.seatsEnabled.
     */
    AGENT_SEAT_PAY_TO: hexAddress.optional(),
    AGENT_SEAT_CAP: z.coerce.number().int().min(0).max(10_000).default(100),
    /** Price of a seat, in cents. */
    AGENT_SEAT_PRICE_CENTS: z.coerce.number().int().min(1).max(100_000).default(100),
    /**
     * Inference mills a seat buys. Priced against a cap rather than usage so the
     * house's exposure is knowable before anyone is charged — §5.1.
     */
    AGENT_SEAT_MILLS: z.coerce.number().int().min(1).max(10_000_000).default(50_000),
    /**
     * House-funded thinking one agent may draw in a day, in mills.
     *
     * ─────────────────────────── whose money is whose ───────────────────────
     *
     * `config.dailyBudgetCents` is the PLAYER's ceiling and governs hints, which
     * move the player's funds. This is the HOUSE's ceiling and governs
     * inference, which the house pays for and meters back (AGENT_TIER.md §5.1).
     *
     * They were one number until seats landed, and the comment justifying that
     * — "inference is cost of goods sold against the same deposit that buys
     * hints" — stopped being true the moment the house started paying. Sharing a
     * ceiling meant a player who raised their budget to buy more hints silently
     * authorised more of our spending on thinking, which is AGENTS_BYO §7.5(4).
     *
     * This is a RATE limit, not the exposure bound. The seat is the prepaid
     * total and remains what caps what the house can lose; this stops one
     * looping agent drinking a whole seat in an afternoon.
     *
     * 20,000 mills is roughly 57 hunts a day at the measured ~350 mills a hunt
     * costs on flash — generous for one agent, and about two and a half days of
     * a 50,000-mill seat. Deliberately set ABOVE the easy tier's per-hunt prize
     * ceiling (6,000 mills): a daily cap tighter than the per-hunt cap would
     * make the per-hunt one unreachable and silently dead.
     */
    AGENT_HOUSE_DAILY_MILLS: z.coerce.number().int().min(1).max(1_000_000).default(20_000),
    DEEPSEEK_API_KEY: z.string().min(8).optional(),
    DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
    /** `deepseek-v4-flash` is ~3x cheaper than pro and ample for these games. */
    DEEPSEEK_MODEL: z.string().default('deepseek-v4-flash'),

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

    if (v.HINT_MARKET_ENABLED) {
      // The market needs both signers: one to say a hint is genuine, one to
      // release the money. Neither alone completes a trade.
      for (const [key, val] of [
        ['HINT_ESCROW_ADDRESS', v.HINT_ESCROW_ADDRESS],
        ['HINT_BOND_ADDRESS', v.HINT_BOND_ADDRESS],
        ['HINT_TOKEN_ADDRESS', v.HINT_TOKEN_ADDRESS],
        ['ATTESTOR_PRIVATE_KEY', v.ATTESTOR_PRIVATE_KEY],
        ['ESCROW_PRIVATE_KEY', v.ESCROW_PRIVATE_KEY],
        ['RPC_URL', v.RPC_URL],
      ] as const) {
        if (!val) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'required when HINT_MARKET_ENABLED=true',
          });
        }
      }

      // Trades settle to wallet addresses. Under AUTH_MODE=dev a player id is a
      // made-up string, so a "seller" would be paid at an address that is not one.
      if (v.AUTH_MODE !== 'chain') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['HINT_MARKET_ENABLED'],
          message: 'requires AUTH_MODE=chain — dev player ids are not addresses',
        });
      }
    }

    if (v.AGENTS_ENABLED) {
      for (const [key, val] of [
        ['AGENT_MASTER_KEY', v.AGENT_MASTER_KEY],
        ['AGENT_VAULT_FACTORY_ADDRESS', v.AGENT_VAULT_FACTORY_ADDRESS],
        ['AGENT_TOKEN_ADDRESS', v.AGENT_TOKEN_ADDRESS],
        ['PLAYER_REGISTRY_ADDRESS', v.PLAYER_REGISTRY_ADDRESS],
        ['DEEPSEEK_API_KEY', v.DEEPSEEK_API_KEY],
        ['RPC_URL', v.RPC_URL],
      ] as const) {
        if (!val) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'required when AGENTS_ENABLED=true',
          });
        }
      }

      // Agent addresses are derived from wallet addresses and bound as session
      // keys. Under AUTH_MODE=dev a player id is a made-up string, so there is
      // nothing to derive from and nothing to bind against.
      if (v.AUTH_MODE !== 'chain') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AGENTS_ENABLED'],
          message: 'requires AUTH_MODE=chain — dev player ids are not addresses',
        });
      }
    }

    // One secret deriving every agent key must not also be a key that signs
    // anything else: a leak would then cross two trust boundaries at once.
    for (const [name, other] of [
      ['ATTESTOR_PRIVATE_KEY', v.ATTESTOR_PRIVATE_KEY],
      ['ESCROW_PRIVATE_KEY', v.ESCROW_PRIVATE_KEY],
      ['ESCROW_TREASURY_PRIVATE_KEY', v.ESCROW_TREASURY_PRIVATE_KEY],
      ['RELAY_PRIVATE_KEY', v.RELAY_PRIVATE_KEY],
    ] as const) {
      if (v.AGENT_MASTER_KEY && other && v.AGENT_MASTER_KEY.toLowerCase() === other.toLowerCase()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AGENT_MASTER_KEY'],
          message: `must differ from ${name}`,
        });
      }
    }

    if (v.ENTRY_FEES_ENABLED && !v.ENTRY_FEE_PAY_TO) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENTRY_FEE_PAY_TO'],
        message: 'required when ENTRY_FEES_ENABLED=true',
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
