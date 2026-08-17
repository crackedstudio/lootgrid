import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from './appTypes';
import * as attestor from './chain/attestor';
import * as escrowChain from './chain/escrow';
import { env } from './env';
import { registerRoutes } from './http';
import * as referee from './referee';
import * as store from './store';
import { anyHunt, freshWorld, makeVeteran, teardownWorld } from './testing/harness';

/**
 * The prize path, end to end.
 *
 * Phase 3's question is "does the money path work end to end?", and for a while
 * the honest answer was no: the referee could sign a payout, but nothing served
 * that signature to a winner and nothing turned it into a transaction. An
 * attestation nobody can present is not a payout.
 *
 * So these tests are about reachability as much as about authorisation — that a
 * winner can obtain a claim they can actually send, and that nobody else can.
 */

const WINNER = '0x00000000000000000000000000000000000000a1';
const LOSER = '0x00000000000000000000000000000000000000b0';

const ESCROW = '0x00000000000000000000000000000000000000e5';
const ESCROW_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';

const mut = env as {
  ESCROW_PRIVATE_KEY?: string;
  LOOTGRID_ESCROW_ADDRESS?: string;
  RPC_URL?: string;
  CHAIN: 'celo' | 'celoSepolia';
};

const original = { ...mut };

let app: App;

function buildApp(): App {
  const a = Fastify({ logger: false }) as unknown as App;
  registerRoutes(a);
  return a;
}

/** Run a hunt to a finish with `winner` first past the post. */
function winHunt(winner: string) {
  const hunt = anyHunt();
  const player = makeVeteran(winner, '@winner');
  const opened = referee.openAttempt(player, hunt);
  if (!opened.ok) throw new Error(`could not open an attempt: ${opened.error}`);

  store.setHuntStatus(store.getHunt(hunt.id)!, 'resolved', player.id);
  return store.getHunt(hunt.id)!;
}

beforeEach(async () => {
  freshWorld();
  mut.ESCROW_PRIVATE_KEY = ESCROW_KEY;
  mut.LOOTGRID_ESCROW_ADDRESS = ESCROW;
  mut.RPC_URL = 'http://localhost:0';
  mut.CHAIN = 'celoSepolia';
  attestor.reset();

  app = buildApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
  Object.assign(mut, original);
  attestor.reset();
  escrowChain.setBalanceReaderForTests(null);
  teardownWorld();
});

const as = (player: string) => ({ 'x-player': player });

describe('claiming a prize', () => {
  it('hands the winner a claim they can send', async () => {
    const hunt = winHunt(WINNER);

    const res = await app.inject({
      method: 'POST',
      url: `/hunts/${hunt.id}/attestations/payout`,
      headers: as(WINNER),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('payout');
    expect(body.signature).toMatch(/^0x/);
    // The half that was missing: calldata, aimed at the escrow, ready to send.
    expect(body.call.to).toBe(ESCROW);
    expect(body.call.data).toMatch(/^0x/);
    expect(body.withdraw.to).toBe(ESCROW);
  });

  it('refuses everyone but the winner', async () => {
    const hunt = winHunt(WINNER);
    makeVeteran(LOSER, '@loser');

    const res = await app.inject({
      method: 'POST',
      url: `/hunts/${hunt.id}/attestations/payout`,
      headers: as(LOSER),
    });

    // The contract would happily accept whoever pays the gas, so this is the
    // only thing standing between a loser and a signed claim on the pot.
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_the_winner');
  });

  it('refuses a hunt that is still running', async () => {
    const hunt = anyHunt();
    const player = makeVeteran(WINNER, '@winner');
    referee.openAttempt(player, hunt);

    const res = await app.inject({
      method: 'POST',
      url: `/hunts/${hunt.id}/attestations/payout`,
      headers: as(WINNER),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('hunt_not_resolved');
  });

  it('is off when no payout key is configured', async () => {
    const hunt = winHunt(WINNER);
    mut.ESCROW_PRIVATE_KEY = undefined;
    attestor.reset();

    const res = await app.inject({
      method: 'POST',
      url: `/hunts/${hunt.id}/attestations/payout`,
      headers: as(WINNER),
    });

    // Absent key means the feature is off, not that it half works.
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('payouts_disabled');
  });

  it('signs the referee’s numbers, not the request’s', async () => {
    const hunt = winHunt(WINNER);

    const res = await app.inject({
      method: 'POST',
      url: `/hunts/${hunt.id}/attestations/payout`,
      headers: as(WINNER),
      payload: { racers: 9_999, elapsedMs: 1 },
    });

    // Nothing in the body reaches the signature: the numbers come from the
    // referee's own record of the race.
    expect(res.json().racers).toBe(store.racerCount(hunt.id));
  });
});

describe('collecting a prize', () => {
  it('reports nothing owed before a claim lands', async () => {
    makeVeteran(WINNER, '@winner');
    escrowChain.setBalanceReaderForTests(async () => ({ owed: 0n, withdrawableAt: 0 }));

    const res = await app.inject({ method: 'GET', url: '/escrow/balance', headers: as(WINNER) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ owed: '0', withdrawable: false });
  });

  it('holds the prize back until the challenge window elapses', async () => {
    makeVeteran(WINNER, '@winner');
    const soon = Math.floor(Date.now() / 1000) + 3_600;
    escrowChain.setBalanceReaderForTests(async () => ({ owed: 10n ** 18n, withdrawableAt: soon }));

    const res = await app.inject({ method: 'GET', url: '/escrow/balance', headers: as(WINNER) });

    // Credited but not collectable. That gap is the guardian's chance to stop a
    // payout signed by a leaked key, so the UI must show it rather than offer a
    // button that reverts.
    expect(res.json()).toMatchObject({ owed: '1000000000000000000', withdrawable: false });
    expect(res.json().withdrawableAt).toBe(soon);
  });

  it('offers the withdrawal once the window has passed', async () => {
    makeVeteran(WINNER, '@winner');
    const past = Math.floor(Date.now() / 1000) - 1;
    escrowChain.setBalanceReaderForTests(async () => ({ owed: 500n, withdrawableAt: past }));

    const res = await app.inject({ method: 'GET', url: '/escrow/balance', headers: as(WINNER) });

    expect(res.json().withdrawable).toBe(true);
    expect(res.json().call.to).toBe(ESCROW);
  });

  it('reports the balance as a string, not a number', async () => {
    // 18dp base units exceed Number's safe range, and a prize quietly rounded
    // in transit is a solvency bug rather than a display one.
    makeVeteran(WINNER, '@winner');
    const huge = 12_345_678_901_234_567_890n;
    escrowChain.setBalanceReaderForTests(async () => ({ owed: huge, withdrawableAt: 0 }));

    const res = await app.inject({ method: 'GET', url: '/escrow/balance', headers: as(WINNER) });
    expect(res.json().owed).toBe(huge.toString());
  });
});
