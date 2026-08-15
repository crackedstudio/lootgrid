import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { x402Client } from '@x402/core/client';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../env';
import * as x402 from './x402';

/**
 * Entry payments.
 *
 * The risk this file is aimed at is not fraud, it is silence. Everything the
 * server builds here is signed by a wallet and judged by a facilitator we
 * cannot reach from a test — so a wrong EIP-712 domain, a v1 network name, or a
 * reordered struct produces a signature that verifies against nothing, with no
 * symptom until a real player's payment is rejected in production.
 *
 * So the load-bearing test is a cross-check: a payload built by `@x402/evm`
 * itself, recovered through OUR typed-data definition. If the two have drifted
 * by so much as a field order, recovery returns the wrong address.
 */

const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const PAY_TO = '0x00000000000000000000000000000000000000f0';

const mut = env as {
  ENTRY_FEES_ENABLED: boolean;
  ENTRY_FEE_PAY_TO?: string;
  CHAIN: 'celo' | 'celoSepolia';
};

const original = { ...mut };

beforeEach(() => {
  mut.ENTRY_FEES_ENABLED = true;
  mut.ENTRY_FEE_PAY_TO = PAY_TO;
  mut.CHAIN = 'celo';
  x402.setSettlerForTests(null);
});

afterEach(() => {
  Object.assign(mut, original);
  x402.setSettlerForTests(null);
});

const terms = () => x402.termsFor('ridge-1-3x4-aaa', 10);
const payer = privateKeyToAccount(PAYER_KEY);

describe('what the wallet is asked to sign', () => {
  it('recovers a library-built authorisation through our own typed data', async () => {
    // The cross-artifact check. `@x402/evm` builds the payload the way the
    // facilitator expects; if our domain, types or primary type differ at all,
    // this recovers to the wrong address.
    // Default selector: only one option is ever offered here.
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: payer });

    const requirements = x402.requirementsFor(terms());
    const built = await client.createPaymentPayload({
      x402Version: 2,
      resource: { url: 'https://lootgrid.test/hunts/x/attempts' },
      accepts: [requirements],
    });

    const { authorization, signature } = built.payload as unknown as {
      authorization: x402.Authorization;
      signature: `0x${string}`;
    };

    const challenge = x402.challengeFor(terms(), payer.address);
    const recovered = await recoverTypedDataAddress({
      domain: challenge.typedData.domain,
      types: challenge.typedData.types,
      primaryType: 'TransferWithAuthorization',
      message: authorization as never,
      signature,
    });

    expect(recovered).toBe(payer.address);
  });

  it('names the network in CAIP-2, not the v1 spelling', () => {
    // `"celo"` is the v1 name. It type-checks, and the facilitator rejects it.
    expect(x402.X402_NETWORK).toBe('eip155:42220');
    expect(x402.requirementsFor(terms()).network).toContain(':');
  });

  it('binds the signature to the token contract', () => {
    const challenge = x402.challengeFor(terms(), payer.address);
    // The EIP-712 verifying contract is the TOKEN, not our server and not the
    // facilitator — the token is what checks this signature on chain.
    expect(challenge.typedData.domain.verifyingContract.toLowerCase()).toBe(
      x402.USDC_ADDRESS.celo.toLowerCase(),
    );
    expect(challenge.typedData.domain.chainId).toBe(42_220);
    // The token's EIP-712 name, not its symbol. USDT would sign as "Tether USD".
    expect(challenge.typedData.domain.name).toBe('USDC');
  });

  it('can only ever spend the authenticated player’s balance', () => {
    const challenge = x402.challengeFor(terms(), payer.address);
    expect(challenge.authorization.from).toBe(payer.address);
    expect(challenge.authorization.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
  });

  it('prices in base units, as a string', () => {
    // $0.10 at 6dp. A float here would be a rounding error with a wallet on it.
    expect(x402.baseUnits(10)).toBe('100000');
    expect(x402.challengeFor(terms(), payer.address).authorization.value).toBe('100000');
  });

  it('expires quickly, because it is a bearer instrument', () => {
    const now = 1_700_000_000_000;
    const challenge = x402.challengeFor(terms(), payer.address, now);
    expect(Number(challenge.authorization.validBefore)).toBe(
      now / 1000 + x402.AUTH_TIMEOUT_SECONDS,
    );
    expect(x402.AUTH_TIMEOUT_SECONDS).toBeLessThanOrEqual(300);
  });

  it('never repeats a nonce', () => {
    const a = x402.challengeFor(terms(), payer.address).authorization.nonce;
    const b = x402.challengeFor(terms(), payer.address).authorization.nonce;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('hands back an envelope that is complete but unsigned', () => {
    const { envelope } = x402.challengeFor(terms(), payer.address);
    expect(envelope.x402Version).toBe(2);
    expect(envelope.accepted.scheme).toBe('exact');
    // The only thing the client has to supply.
    expect(envelope.payload.signature).toBeNull();
  });
});

describe('the 402 body', () => {
  it('carries everything a browser needs to pay, and no key', () => {
    const t = terms();
    const body = x402.paymentRequiredBody(t, x402.challengeFor(t, payer.address));

    expect(body.error).toBe('payment_required');
    expect(body.payment.price).toBe('$0.10');
    expect(body.payment.typedData.primaryType).toBe('TransferWithAuthorization');
    expect(body.payment.envelope).toBeTruthy();
    // The facilitator API key goes to the facilitator and nowhere else.
    expect(JSON.stringify(body)).not.toContain('X402_API_KEY');
  });
});

describe('a payment coming back', () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

  /** A well-formed envelope, signed for real. */
  async function signedEnvelope(over: Partial<x402.Authorization> = {}) {
    const challenge = x402.challengeFor(terms(), payer.address);
    const authorization = { ...challenge.authorization, ...over };
    const signature = await payer.signTypedData({
      domain: challenge.typedData.domain,
      types: challenge.typedData.types,
      primaryType: 'TransferWithAuthorization',
      message: authorization as never,
    });
    return { ...challenge.envelope, payload: { authorization, signature } };
  }

  it('refuses a missing payment without calling anything', async () => {
    const result = await x402.settleEntry(terms(), null);
    expect(result).toEqual({ ok: false, reason: 'missing_payment' });
  });

  it('refuses a header that is not an envelope', async () => {
    const result = await x402.settleEntry(terms(), 'not-base64-json');
    expect(result.ok).toBe(false);
  });

  it('refuses an amount the client edited downward', async () => {
    // The attack the server-side check exists for: sign for a cent, enter a
    // ten-cent hunt. The facilitator would likely catch it too — but a check
    // that happens here cannot be skipped by a facilitator outage.
    const envelope = await signedEnvelope({ value: '1' });
    const result = await x402.settleEntry(terms(), encode(envelope));
    expect(result).toEqual({ ok: false, reason: 'invalid_payment' });
  });

  it('refuses a payment redirected to another recipient', async () => {
    const envelope = await signedEnvelope({ to: '0x00000000000000000000000000000000000000ba' });
    const result = await x402.settleEntry(terms(), encode(envelope));
    expect(result).toEqual({ ok: false, reason: 'invalid_payment' });
  });

  it('fails closed when entry fees are switched off', async () => {
    // A stub that returned ok would let a player into a rewarded hunt without
    // paying, and the failure would look like success.
    mut.ENTRY_FEES_ENABLED = false;
    const envelope = await signedEnvelope();
    const result = await x402.settleEntry(terms(), encode(envelope));
    expect(result).toEqual({ ok: false, reason: 'settlement_failed' });
  });

  it('never throws — a refused payment is a 402, not a 500', async () => {
    x402.setSettlerForTests(async () => {
      throw new Error('facilitator on fire');
    });
    await expect(x402.settleEntry(terms(), 'anything')).resolves.toEqual({
      ok: false,
      reason: 'settlement_failed',
    });
  });
});

describe('the network gate', () => {
  it('is off on a chain the library cannot name', () => {
    // @x402/evm has no chain id for Celo Sepolia, so there is no way to sign
    // for it. Better to be off than to fail at request time.
    mut.CHAIN = 'celoSepolia';
    expect(x402.enabled()).toBe(false);
    expect(x402.disabledReason()).toContain('celoSepolia');
  });

  it('is on with mainnet, a payee and the flag', () => {
    expect(x402.enabled()).toBe(true);
    expect(x402.disabledReason()).toBeNull();
  });

  it('is off without the flag, whatever else is set', () => {
    mut.ENTRY_FEES_ENABLED = false;
    expect(x402.enabled()).toBe(false);
  });
});
