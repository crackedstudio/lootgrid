import { env } from '../env';
import { logger } from '../logger';
import * as metrics from '../metrics';

/**
 * x402 entry payments.
 *
 * ─────────────────────────── the protocol ───────────────────────────
 *
 * x402 activates HTTP 402. The client requests a resource, the server answers
 * `402 Payment Required` with the terms, the client signs a payment and retries
 * with an `X-PAYMENT` header, the server settles and delivers. It is
 * client-pays-server by construction, which is why it fits entry fees and is the
 * wrong shape for prize payouts — a winner is not buying anything. Payouts go
 * through LootGridEscrow instead.
 *
 * ─────────────────────────── why there is a seam here ───────────────────────
 *
 * Celo runs a hosted facilitator (https://x402.celo.org) which sponsors
 * settlement gas and never custodies funds — EIP-3009 `transferWithAuthorization`
 * moves stablecoins buyer → seller inside the token contract. That is the
 * intended integration, and it needs the v2 scoped `@x402/*` packages.
 *
 * **It cannot be wired here yet, for a concrete reason: there is no Fastify
 * adapter.** The facilitator ships `@x402/hono` and `@x402/express` only, and
 * its own guide says "do not hand-assemble payment payloads — the middleware
 * builds the correct on-the-wire shape for you". Rolling our own against
 * `@x402/core` would be doing exactly what it warns against, on the code path
 * that moves money.
 *
 * So the settlement call sits behind {@link SettleFn} — the same transport-seam
 * pattern the relayer and escrow worker use. Everything that is genuinely ours
 * (the terms, the gate, the free route, the EV telemetry) is testable today, and
 * wiring the real protocol later is one function.
 *
 * ─────────────────────────── to finish the wiring ───────────────────────────
 *
 *   npm i @x402/express @x402/core @x402/evm      # or @x402/hono
 *
 * Mount the paid route through that middleware (Fastify can host an Express or
 * Hono sub-app), then replace `settleFn`. Verified specifics from the
 * facilitator's own SKILL.md, which should be re-read before writing the code:
 *
 *   - The legacy `x402-express` / `x402-fetch` packages have NO Celo entry in
 *     their network enum and will not work. Use the scoped v2 packages.
 *   - Celo is absent from the packages' default-asset table, so a bare
 *     `price: "$0.01"` type-checks and then throws at request time. Always pass
 *     the explicit object below.
 *   - `extra.name` is the token's EIP-712 NAME, not its symbol. USDT signs as
 *     "Tether USD". Using the symbol fails verification.
 *   - The API key goes to the facilitator only, via
 *     `HTTPFacilitatorClient({ createAuthHeaders })` as `X-API-Key`. Never to a
 *     buyer or the browser.
 *   - `payTo` is our own receiving wallet, not the facilitator's.
 *
 * ─────────────────────────── legal ───────────────────────────
 *
 * Pay-to-enter for a cash prize is the gambling definition in many
 * jurisdictions, and this build compounds it: the house charges admission,
 * issues the hints, and may deliberately falsify them. ENTRY_FEES_ENABLED
 * defaults to false and must stay false in production until a lawyer says
 * otherwise. See docs/AGENTIC_ARCHITECTURE.md §10.
 */

export interface PaymentTerms {
  /** What is being paid for. */
  resource: string;
  /** Price in cents, converted to a token amount by the facilitator. */
  priceCents: number;
  payTo: string;
  chainId: number;
  /** Machine-readable description, surfaced in the 402 body. */
  description: string;
}

export type SettleResult =
  | { ok: true; payer: string; reference: string }
  | { ok: false; reason: 'missing_payment' | 'invalid_payment' | 'settlement_failed' };

/** The one call that touches the payment network. Swapped in tests. */
export type SettleFn = (terms: PaymentTerms, paymentData: string | null) => Promise<SettleResult>;

const CHAIN_IDS = { celo: 42_220, celoSepolia: 11_142_220 } as const;

/**
 * Entry fees settle in USDC, and that is not a free choice.
 *
 * The facilitator moves funds with EIP-3009 `transferWithAuthorization`, which
 * only USDC and USDT implement. **USDm/cUSD cannot be used** — Mento's
 * StableTokenV2 implements EIP-2612 `permit` only. So the fee token differs from
 * whatever the escrow holds prizes in, and it has different decimals: USDC is
 * 6dp against cUSD's 18. Anywhere both appear, convert explicitly.
 */
export const USDC_ADDRESS = {
  celo: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
  celoSepolia: '0x01C5C0122039549AD1493B8220cABEdD739BC44E',
} as const;

export const USDC_DECIMALS = 6;

export const FACILITATOR_URL = {
  celo: 'https://api.x402.celo.org',
  celoSepolia: 'https://api.x402.sepolia.celo.org',
} as const;

/**
 * The price object the facilitator requires, in the shape its guide specifies.
 *
 * Amounts are decimal STRINGS in base units — $0.01 is "10000" at 6 decimals,
 * never a number and never a float.
 */
export function priceObjectFor(priceCents: number) {
  return {
    amount: (BigInt(priceCents) * 10n ** BigInt(USDC_DECIMALS - 2)).toString(),
    asset: USDC_ADDRESS[env.CHAIN],
    // EIP-712 domain for EIP-3009. `name` is the token's name, not its symbol.
    extra: { name: 'USDC', version: '2' },
  } as const;
}

export function enabled(): boolean {
  return Boolean(env.ENTRY_FEES_ENABLED && env.ENTRY_FEE_PAY_TO);
}

/**
 * Default settler.
 *
 * Refuses everything, loudly, because settlement is not wired yet. Failing
 * closed is the only safe default: a stub that returned `ok` would let a player
 * into a rewarded hunt without paying, and the failure would look like success.
 */
const unwiredSettler: SettleFn = async () => {
  logger.error(
    'x402 settlement is not wired — install the @x402/* packages and replace this settler before enabling entry fees',
  );
  return { ok: false, reason: 'settlement_failed' };
};

let settleFn: SettleFn = unwiredSettler;

export function setSettlerForTests(fn: SettleFn | null): void {
  settleFn = fn ?? unwiredSettler;
}

/** Whether a real settler has been installed. Surfaced by /ready. */
export function isWired(): boolean {
  return settleFn !== unwiredSettler;
}

export function termsFor(huntId: string, priceCents: number): PaymentTerms {
  return {
    resource: `/hunts/${huntId}/attempts`,
    priceCents,
    payTo: env.ENTRY_FEE_PAY_TO ?? '',
    chainId: CHAIN_IDS[env.CHAIN],
    description: `Entry to hunt ${huntId}`,
  };
}

/**
 * Settle an entry payment.
 *
 * Never throws: a settlement error is a refused entry, not a 500. The caller
 * turns a failure into a 402 with the terms attached, which is what the protocol
 * expects and what lets a client retry with payment.
 */
export async function settleEntry(
  terms: PaymentTerms,
  paymentData: string | null,
): Promise<SettleResult> {
  if (!paymentData) return { ok: false, reason: 'missing_payment' };

  try {
    const result = await settleFn(terms, paymentData);
    if (result.ok) metrics.entryFeesCollected.inc({ result: 'settled' });
    else metrics.entryFeesCollected.inc({ result: result.reason });
    return result;
  } catch (err) {
    logger.warn({ err, resource: terms.resource }, 'entry settlement failed');
    metrics.entryFeesCollected.inc({ result: 'settlement_failed' });
    return { ok: false, reason: 'settlement_failed' };
  }
}

/** The body served with a 402, describing what to pay and where. */
export function paymentRequiredBody(terms: PaymentTerms) {
  return {
    error: 'payment_required',
    message: 'This hunt charges an entry fee, or costs energy instead.',
    payment: {
      scheme: 'x402',
      resource: terms.resource,
      price: `$${(terms.priceCents / 100).toFixed(2)}`,
      payTo: terms.payTo,
      chainId: terms.chainId,
      // CAIP-2, which is how the facilitator identifies networks.
      network: `eip155:${terms.chainId}`,
      asset: priceObjectFor(terms.priceCents),
      facilitator: FACILITATOR_URL[env.CHAIN],
      description: terms.description,
    },
  };
}
