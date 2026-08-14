import { decodePaymentSignatureHeader, HTTPFacilitatorClient } from '@x402/core/http';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { createPublicClient, getAddress, http, parseAbi, type Address, type Hex } from 'viem';
import { randomHex } from '../hash';
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
 * ─────────────────────────── the client signs, and holds no library ─────────
 *
 * Payment is an EIP-3009 `transferWithAuthorization`: the buyer signs an
 * authorisation and the *token contract* moves the funds, so nobody custodies
 * anything and the facilitator sponsors the gas.
 *
 * The signing payload is built **here** and handed to the browser ready to sign,
 * exactly as the attestor hands it ready-made calldata. That keeps the wallet's
 * job down to one `eth_signTypedData_v4` call and keeps web3 dependencies off
 * the client entirely. It also means the thing the facilitator's guide warns
 * against — hand-assembling the on-the-wire payload — is done once, on the
 * server, against the library's own types, with a test that cross-checks our
 * EIP-712 domain against a payload the library itself produced.
 *
 * The envelope handed back is complete except for `payload.signature`. The
 * client fills that in, base64-encodes it, and sends it as `X-PAYMENT`.
 *
 * ─────────────────────────── never trust the echo ───────────────────────────
 *
 * The client returns the envelope we gave it, so every field in it is
 * attacker-controlled by the time it comes back. {@link settleEntry} re-derives
 * the requirements from the server's own terms and checks the authorisation
 * against them — payer, recipient, amount — before the facilitator is asked
 * anything. A client that edits the amount downward gets a rejection, not a
 * cheap hunt.
 *
 * ─────────────────────────── mainnet only, for now ──────────────────────────
 *
 * `@x402/evm` maps network names to chain ids and **has no entry for Celo
 * Sepolia** — only `celo`. There is no way to sign for a chain the library
 * cannot name, so {@link enabled} returns false off mainnet rather than
 * discovering it at request time. See {@link SUPPORTED_CHAIN}.
 *
 * ─────────────────────────── legal ───────────────────────────
 *
 * Pay-to-enter for a cash prize is the gambling definition in many
 * jurisdictions, and this build compounds it: the house charges admission,
 * issues the hints, and may deliberately falsify them. ENTRY_FEES_ENABLED
 * defaults to false and must stay false in production until a lawyer says
 * otherwise. See docs/AGENTIC_ARCHITECTURE.md §10.
 */

/** The only Celo network `@x402/evm` knows a chain id for. */
export const SUPPORTED_CHAIN = 'celo' as const;

/**
 * x402 v2 network identifier: CAIP-2, not a friendly name.
 *
 * v1 used `"celo"`; v2 requires `eip155:<chainId>` and validates it. Passing the
 * v1 spelling here is accepted by TypeScript and rejected by the facilitator,
 * which is exactly the kind of mistake that only shows up against production.
 */
export const X402_NETWORK = 'eip155:42220' as const;

/** The scheme this integration speaks. `exact` = pay exactly this, once. */
export const SCHEME = 'exact';

export const X402_VERSION = 2;

/**
 * How long a signed authorisation stays valid.
 *
 * Short: it is a bearer instrument against the payer's balance, and the only
 * thing it needs to survive is one wallet round trip plus settlement.
 */
export const AUTH_TIMEOUT_SECONDS = 120;

export interface PaymentTerms {
  /** What is being paid for. */
  resource: string;
  /** Price in cents, converted to a token amount below. */
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

/**
 * The token's EIP-712 domain fields.
 *
 * `name` is the token's NAME, not its symbol — USDT signs as "Tether USD" —
 * and Celo is absent from the library's default-asset table, so this must be
 * passed explicitly or the scheme throws at request time.
 */
export const USDC_EIP712 = { name: 'USDC', version: '2' } as const;

export const FACILITATOR_URL = {
  celo: 'https://api.x402.celo.org',
  celoSepolia: 'https://api.x402.sepolia.celo.org',
} as const;

/** Price in token base units, as a decimal string. Never a number, never a float. */
export function baseUnits(priceCents: number): string {
  return (BigInt(priceCents) * 10n ** BigInt(USDC_DECIMALS - 2)).toString();
}

/**
 * The EIP-3009 struct, field for field.
 *
 * Consensus with the token contract and with `@x402/evm`. A reordering here
 * produces a signature the facilitator rejects and nothing else — which is why
 * `x402.test.ts` recovers a library-built authorisation through this definition
 * rather than trusting it to stay right.
 *
 * That test guards the *shape*: field order, primary type, how the domain is
 * assembled. It cannot guard {@link USDC_EIP712}, because the library reads
 * those values out of the requirements this file produces, so a wrong name or
 * version agrees with itself. Only the token knows — see
 * {@link checkTokenDomain}.
 */
export const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export function enabled(): boolean {
  return Boolean(env.ENTRY_FEES_ENABLED && env.ENTRY_FEE_PAY_TO && env.CHAIN === SUPPORTED_CHAIN);
}

/**
 * Why the feature is off, for `/ready` and for whoever is confused at 3am.
 * Null when it is on.
 */
export function disabledReason(): string | null {
  if (!env.ENTRY_FEES_ENABLED) return 'ENTRY_FEES_ENABLED is false';
  if (!env.ENTRY_FEE_PAY_TO) return 'ENTRY_FEE_PAY_TO is unset';
  if (env.CHAIN !== SUPPORTED_CHAIN) return `@x402/evm has no chain id for ${env.CHAIN}`;
  return null;
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
 * What the facilitator is asked to enforce.
 *
 * Rebuilt from the server's own terms on every call — including when a payment
 * comes back — so the requirements a payment is judged against can never be the
 * ones a client sent us.
 */
export function requirementsFor(terms: PaymentTerms): PaymentRequirements {
  return {
    scheme: SCHEME,
    network: X402_NETWORK,
    amount: baseUnits(terms.priceCents),
    asset: USDC_ADDRESS[env.CHAIN],
    payTo: terms.payTo,
    maxTimeoutSeconds: AUTH_TIMEOUT_SECONDS,
    extra: { ...USDC_EIP712 },
  };
}

export interface Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  /** bytes32. Decimal strings elsewhere: uint256 fields cross JSON as strings. */
  nonce: Hex;
}

export interface PaymentChallenge {
  requirements: PaymentRequirements;
  authorization: Authorization;
  /** Ready for `eth_signTypedData_v4`. Every uint is a decimal string. */
  typedData: {
    domain: { name: string; version: string; chainId: number; verifyingContract: Address };
    types: typeof AUTHORIZATION_TYPES;
    primaryType: 'TransferWithAuthorization';
    message: Authorization;
  };
  /**
   * Complete but for `payload.signature`. The client fills it and base64s it.
   *
   * `accepted` carries the requirements the payment is against — v2 embeds them
   * in the payload rather than naming a scheme and network at the top level.
   * They are re-derived server-side before settlement regardless; what the
   * client sends back is never what a payment is judged against.
   */
  envelope: {
    x402Version: number;
    accepted: PaymentRequirements;
    payload: { authorization: Authorization; signature: null };
  };
}

/**
 * Everything the payer needs to sign, and nothing they could spend elsewhere.
 *
 * The nonce is generated here rather than by the client. It is a replay guard
 * the token enforces, so the only thing that matters is that it is unpredictable
 * and unused — and a client that picks its own gains nothing by it.
 */
export function challengeFor(
  terms: PaymentTerms,
  payer: Address,
  now: number = Date.now(),
): PaymentChallenge {
  const requirements = requirementsFor(terms);
  const nowSec = Math.floor(now / 1000);

  const authorization: Authorization = {
    from: getAddress(payer),
    to: getAddress(terms.payTo as Address),
    value: requirements.amount,
    // Valid immediately. `validBefore` is what bounds the window.
    validAfter: '0',
    validBefore: String(nowSec + AUTH_TIMEOUT_SECONDS),
    nonce: randomHexBytes32(),
  };

  return {
    requirements,
    authorization,
    typedData: {
      domain: {
        name: USDC_EIP712.name,
        version: USDC_EIP712.version,
        chainId: CHAIN_IDS[env.CHAIN],
        verifyingContract: getAddress(requirements.asset as Address),
      },
      types: AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: authorization,
    },
    envelope: {
      x402Version: X402_VERSION,
      accepted: requirements,
      payload: { authorization, signature: null },
    },
  };
}

function randomHexBytes32(): Hex {
  return `0x${randomHex(32)}`;
}

// ─────────────────────────── the domain, checked on chain ──────────────────

const TOKEN_ABI = parseAbi(['function name() view returns (string)', 'function version() view returns (string)']);

export interface DomainCheck {
  ok: boolean;
  expected: { name: string; version: string };
  actual?: { name: string; version: string };
  error?: string;
}

/**
 * Ask the token what its EIP-712 domain actually is.
 *
 * This is the one thing no offline test can establish. `AUTHORIZATION_TYPES` is
 * cross-checked against the library, but {@link USDC_EIP712} is read *by* that
 * library out of the requirements built here — so a wrong name or version
 * agrees with itself all the way to production, where it becomes "every payment
 * is rejected" with nothing in the logs to say why. `name` is the token's name
 * and not its symbol, which is exactly the sort of thing that gets typed wrong
 * once and never noticed.
 *
 * Called at boot when entry fees are on. Never throws: an RPC that is briefly
 * unreachable must not stop the game, and the answer is logged loudly enough to
 * find.
 */
export async function checkTokenDomain(): Promise<DomainCheck> {
  const expected = { ...USDC_EIP712 };
  if (!env.RPC_URL) return { ok: false, expected, error: 'RPC_URL is unset' };

  try {
    const client = createPublicClient({ transport: http(env.RPC_URL) });
    const token = { address: getAddress(USDC_ADDRESS[env.CHAIN]), abi: TOKEN_ABI } as const;
    const [name, version] = await Promise.all([
      client.readContract({ ...token, functionName: 'name' }),
      client.readContract({ ...token, functionName: 'version' }),
    ]);

    const actual = { name, version };
    const ok = name === expected.name && version === expected.version;
    if (!ok) {
      logger.error(
        { expected, actual, asset: USDC_ADDRESS[env.CHAIN] },
        'x402 token domain mismatch — every entry payment will be rejected until this is fixed',
      );
    }
    return { ok, expected, actual };
  } catch (err) {
    logger.warn({ err }, 'could not read the x402 token domain');
    return { ok: false, expected, error: String(err).slice(0, 200) };
  }
}

// ─────────────────────────── settlement ───────────────────────────

let facilitator: HTTPFacilitatorClient | null = null;

function client(): HTTPFacilitatorClient {
  if (!facilitator) {
    facilitator = new HTTPFacilitatorClient({
      url: FACILITATOR_URL[env.CHAIN],
      // The API key goes to the facilitator and nowhere else — never to a buyer
      // and never into the browser bundle.
      ...(env.X402_API_KEY
        ? {
            createAuthHeaders: async () => ({
              verify: { 'X-API-Key': env.X402_API_KEY as string },
              settle: { 'X-API-Key': env.X402_API_KEY as string },
              supported: { 'X-API-Key': env.X402_API_KEY as string },
            }),
          }
        : {}),
    });
  }
  return facilitator;
}

/**
 * Verify then settle a returned payment.
 *
 * Two calls on purpose: `verify` is the facilitator's dry run, so a malformed
 * or underfunded authorisation is refused before anything is broadcast. Settling
 * without verifying first turns every client mistake into a failed transaction.
 */
const facilitatorSettler: SettleFn = async (terms, paymentData) => {
  if (!paymentData) return { ok: false, reason: 'missing_payment' };

  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(paymentData);
  } catch {
    return { ok: false, reason: 'invalid_payment' };
  }

  const requirements = requirementsFor(terms);
  const mismatch = checkAuthorization(payload, requirements);
  if (mismatch) {
    logger.warn({ mismatch, resource: terms.resource }, 'payment does not match its terms');
    return { ok: false, reason: 'invalid_payment' };
  }

  const verified = await client().verify(payload, requirements);
  if (!verified.isValid) {
    logger.info({ reason: verified.invalidReason, resource: terms.resource }, 'payment rejected');
    return { ok: false, reason: 'invalid_payment' };
  }

  const settled = await client().settle(payload, requirements);
  if (!settled.success) {
    logger.warn({ reason: settled.errorReason, resource: terms.resource }, 'settlement failed');
    return { ok: false, reason: 'settlement_failed' };
  }

  return {
    ok: true,
    payer: settled.payer ?? authorizationOf(payload)?.from ?? '',
    reference: settled.transaction ?? '',
  };
};

function authorizationOf(payload: PaymentPayload): Authorization | null {
  const auth = (payload as { payload?: { authorization?: unknown } }).payload?.authorization;
  return auth && typeof auth === 'object' ? (auth as Authorization) : null;
}

/**
 * The returned envelope against the server's own terms.
 *
 * Everything here came back from the client, so none of it is trusted. The
 * facilitator would catch most of it, but an amount check that happens on our
 * side is one that cannot be skipped by a facilitator outage or a lenient
 * scheme.
 */
function checkAuthorization(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): string | null {
  if (payload.accepted?.scheme !== requirements.scheme) return 'scheme';
  if (payload.accepted?.network !== requirements.network) return 'network';
  if (payload.accepted?.asset?.toLowerCase() !== requirements.asset.toLowerCase()) return 'asset';

  const auth = authorizationOf(payload);
  if (!auth) return 'authorization';

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(auth.to, requirements.payTo)) return 'payTo';
  // The one that actually costs money if it slips: a client editing the value
  // downward would otherwise buy a hunt at its own price.
  if (auth.value !== requirements.amount) return 'amount';
  return null;
}

/**
 * Default settler.
 *
 * The real one, unless a test swaps it. It still refuses everything when the
 * feature is off — failing closed is the only safe default on a path that
 * admits players to a rewarded hunt.
 */
const gatedSettler: SettleFn = async (terms, paymentData) => {
  if (!enabled()) {
    logger.error({ why: disabledReason() }, 'entry payment attempted while x402 is off');
    return { ok: false, reason: 'settlement_failed' };
  }
  return facilitatorSettler(terms, paymentData);
};

let settleFn: SettleFn = gatedSettler;

export function setSettlerForTests(fn: SettleFn | null): void {
  settleFn = fn ?? gatedSettler;
  facilitator = null;
}

/** Whether the real settler is installed. Surfaced by `/ready`. */
export function isWired(): boolean {
  return settleFn === gatedSettler;
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

/**
 * The body served with a 402.
 *
 * Carries the terms *and* the ready-to-sign payload, which is the difference
 * between a protocol a browser can speak and one it can only read about.
 */
export function paymentRequiredBody(terms: PaymentTerms, challenge: PaymentChallenge) {
  return {
    error: 'payment_required',
    message: 'This hunt charges an entry fee, or costs energy instead.',
    payment: {
      scheme: SCHEME,
      x402Version: X402_VERSION,
      resource: terms.resource,
      price: `$${(terms.priceCents / 100).toFixed(2)}`,
      payTo: terms.payTo,
      chainId: terms.chainId,
      // CAIP-2, which is how the facilitator identifies networks.
      network: `eip155:${terms.chainId}`,
      asset: {
        address: challenge.requirements.asset,
        amount: challenge.requirements.amount,
        decimals: USDC_DECIMALS,
        ...USDC_EIP712,
      },
      facilitator: FACILITATOR_URL[env.CHAIN],
      description: terms.description,
      /** Sign this with `eth_signTypedData_v4`. */
      typedData: challenge.typedData,
      /** Put the signature in `payload.signature`, base64 it, send as X-PAYMENT. */
      envelope: challenge.envelope,
    },
  };
}
