import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../db';
import { env } from '../env';
import { freshWorld, teardownWorld } from '../testing/harness';
import * as relayer from './relayer';
import type { Hex } from 'viem';

// env is validated once at import time, so a test that needs the relay on has
// to flip the parsed object. Restored in afterEach.
const mut = env as {
  RELAY_ENABLED: boolean;
  RELAY_BATCH_SIZE: number;
  RELAY_MAX_ATTEMPTS: number;
  RELAY_MAX_IN_FLIGHT: number;
};

const ALICE = '0x00000000000000000000000000000000000000a1' as const;

function reveal(r: number, c: number) {
  return {
    player: ALICE,
    zoneId: relayer.toBytes32Id('ridge'),
    epoch: 1,
    r,
    c,
    tileType: 0,
  };
}

function rows() {
  return getDb()
    .prepare('SELECT id, kind, status, attempts, tx_hash, next_at FROM relay_queue ORDER BY id')
    .all() as Array<{
    id: number;
    kind: string;
    status: string;
    attempts: number;
    tx_hash: string | null;
    next_at: number;
  }>;
}

const HASH = '0xaa' as Hex;

beforeEach(() => {
  freshWorld();
  relayer.reset();
  mut.RELAY_ENABLED = true;
  mut.RELAY_BATCH_SIZE = 1;
  mut.RELAY_MAX_ATTEMPTS = 8;
  mut.RELAY_MAX_IN_FLIGHT = 25;
});

afterEach(() => {
  relayer.stop();
  relayer.reset();
  mut.RELAY_ENABLED = false;
  teardownWorld();
});

describe('id encoding', () => {
  it('packs short ids as readable ASCII', () => {
    // "ridge" right-padded to 32 bytes — decodable in an explorer.
    expect(relayer.toBytes32Id('ridge')).toBe(
      '0x7269646765000000000000000000000000000000000000000000000000000000',
    );
  });

  it('produces a full 32-byte word for a realistic hunt id', () => {
    const id = relayer.toBytes32Id('ridge-1-3x4-a1b2c3');
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('falls back to keccak for ids that will not fit', () => {
    const long = 'z'.repeat(40);
    const encoded = relayer.toBytes32Id(long);
    expect(encoded).toMatch(/^0x[0-9a-f]{64}$/);
    // Distinct long ids must not collide into the same truncated word.
    expect(encoded).not.toBe(relayer.toBytes32Id('z'.repeat(41)));
  });

  it('is injective across the 31-byte boundary', () => {
    const at31 = 'a'.repeat(31);
    const at32 = 'a'.repeat(32);
    expect(relayer.toBytes32Id(at31)).not.toBe(relayer.toBytes32Id(at32));
  });
});

describe('enum codes', () => {
  it('maps known tile and game types to stable codes', () => {
    expect(relayer.tileTypeCode('empty')).toBe(0);
    expect(relayer.tileTypeCode('puzzle')).toBe(4);
    expect(relayer.gameTypeCode('math')).toBe(0);
    expect(relayer.gameTypeCode('tap')).toBe(3);
  });

  it('maps unknown values to 255 rather than throwing', () => {
    // A new tile type shipped before the code table is updated should produce a
    // slightly odd log line, not a dropped record.
    expect(relayer.tileTypeCode('brand-new')).toBe(255);
    expect(relayer.gameTypeCode('brand-new')).toBe(255);
  });
});

describe('enqueue', () => {
  it('writes nothing when the relay is disabled', () => {
    mut.RELAY_ENABLED = false;
    relayer.enqueue('reveal', 'reveal:ridge:1:0:0', reveal(0, 0));
    expect(rows()).toHaveLength(0);
  });

  it('queues one pending row per action', () => {
    relayer.enqueue('reveal', 'reveal:ridge:1:0:0', reveal(0, 0));
    relayer.enqueue('reveal', 'reveal:ridge:1:0:1', reveal(0, 1));
    expect(rows().map(r => r.status)).toEqual(['pending', 'pending']);
  });

  it('ignores a repeated dedupe key', () => {
    // The crash-and-replay case: the same game fact must never produce two
    // on-chain records.
    relayer.enqueue('reveal', 'reveal:ridge:1:0:0', reveal(0, 0));
    relayer.enqueue('reveal', 'reveal:ridge:1:0:0', reveal(0, 0));
    expect(rows()).toHaveLength(1);
  });

  it('never throws when the database is unavailable', () => {
    // Gameplay must not fail because the outbox does. This is the module's
    // single hard rule.
    teardownWorld();
    expect(() => relayer.enqueue('reveal', 'k', reveal(0, 0))).not.toThrow();
    freshWorld();
  });
});

describe('drain', () => {
  it('sends each pending row and confirms it', async () => {
    const send = vi.fn(async () => HASH);
    relayer.setTransportForTests(send, async () => true);

    relayer.enqueue('reveal', 'a', reveal(0, 0));
    relayer.enqueue('reveal', 'b', reveal(0, 1));

    expect(await relayer.drain()).toBe(2);
    await relayer.settle();

    expect(send).toHaveBeenCalledTimes(2);
    expect(rows().map(r => r.status)).toEqual(['confirmed', 'confirmed']);
    expect(rows()[0]!.tx_hash).toBe(HASH);
  });

  it('passes the decoded payload to the transport', async () => {
    const send = vi.fn(async () => HASH);
    relayer.setTransportForTests(send, async () => true);

    relayer.enqueue('entry', 'e', {
      player: ALICE,
      huntId: relayer.toBytes32Id('ridge-1-3x4-abc'),
      gameType: 3,
    });
    await relayer.drain();

    expect(send).toHaveBeenCalledWith('entry', [
      { player: ALICE, huntId: relayer.toBytes32Id('ridge-1-3x4-abc'), gameType: 3 },
    ]);
  });

  it('does nothing when the queue is empty', async () => {
    const send = vi.fn(async () => HASH);
    relayer.setTransportForTests(send, async () => true);
    expect(await relayer.drain()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves a row pending with backoff when the send fails', async () => {
    relayer.setTransportForTests(async () => {
      throw new Error('rpc down');
    }, async () => true);

    relayer.enqueue('reveal', 'a', reveal(0, 0));
    const before = Date.now();
    await relayer.drain();

    const [row] = rows();
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(1);
    // First retry is ~2s out, not immediate — otherwise a dead RPC becomes a
    // spin loop against it.
    expect(row!.next_at).toBeGreaterThanOrEqual(before + 2_000);
  });

  it('does not re-send a row before its backoff expires', async () => {
    const send = vi
      .fn<relayer.SendFn>()
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValue(HASH);
    relayer.setTransportForTests(send, async () => true);

    relayer.enqueue('reveal', 'a', reveal(0, 0));
    await relayer.drain();
    await relayer.drain();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('parks a row as dead once retries are exhausted', async () => {
    mut.RELAY_MAX_ATTEMPTS = 2;
    relayer.setTransportForTests(async () => {
      throw new Error('permanent');
    }, async () => true);

    relayer.enqueue('reveal', 'a', reveal(0, 0));

    await relayer.drain();
    // Skip the backoff rather than sleeping through it.
    getDb().prepare('UPDATE relay_queue SET next_at = 0').run();
    await relayer.drain();

    const [row] = rows();
    expect(row!.status).toBe('dead');
    expect(row!.attempts).toBe(2);
  });

  it('keeps dead rows for inspection instead of deleting them', async () => {
    mut.RELAY_MAX_ATTEMPTS = 1;
    relayer.setTransportForTests(async () => {
      throw new Error('boom: the reason an operator needs');
    }, async () => true);

    relayer.enqueue('reveal', 'a', reveal(0, 0));
    await relayer.drain();

    const row = getDb().prepare('SELECT last_error FROM relay_queue').get() as {
      last_error: string;
    };
    expect(row.last_error).toContain('boom');
  });

  it('requeues a row whose transaction reverted', async () => {
    // The realistic cause is a relayer key rotation mid-flight.
    relayer.setTransportForTests(async () => HASH, async () => false);

    relayer.enqueue('reveal', 'a', reveal(0, 0));
    await relayer.drain();
    await relayer.settle();

    const [row] = rows();
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(1);
  });

  it('requeues a row whose receipt never arrived', async () => {
    relayer.setTransportForTests(async () => HASH, async () => {
      throw new Error('timeout');
    });

    relayer.enqueue('reveal', 'a', reveal(0, 0));
    await relayer.drain();
    await relayer.settle();

    expect(rows()[0]!.status).toBe('pending');
  });

  it('stops the tick after the first send failure so a bad nonce cannot cascade', async () => {
    const send = vi.fn<relayer.SendFn>().mockRejectedValue(new Error('nonce too low'));
    relayer.setTransportForTests(send, async () => true);

    relayer.enqueue('reveal', 'a', reveal(0, 0));
    relayer.enqueue('reveal', 'b', reveal(0, 1));
    await relayer.drain();

    expect(send).toHaveBeenCalledTimes(1);
    expect(rows().map(r => r.status)).toEqual(['pending', 'pending']);
  });

  it('honours RELAY_MAX_IN_FLIGHT', async () => {
    mut.RELAY_MAX_IN_FLIGHT = 2;
    const send = vi.fn(async () => HASH);
    relayer.setTransportForTests(send, async () => true);

    for (let i = 0; i < 5; i++) relayer.enqueue('reveal', `k${i}`, reveal(0, i));
    expect(await relayer.drain()).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('will not run two drains concurrently', async () => {
    let resolve!: (h: Hex) => void;
    relayer.setTransportForTests(
      () => new Promise<Hex>(r => { resolve = r; }),
      async () => true,
    );

    relayer.enqueue('reveal', 'a', reveal(0, 0));
    const first = relayer.drain();
    // Overlapping ticks would hand the same row to the transport twice.
    expect(await relayer.drain()).toBe(0);

    resolve(HASH);
    await first;
  });
});

describe('batching', () => {
  it('sends one transaction per action by default', async () => {
    const send = vi.fn(async () => HASH);
    relayer.setTransportForTests(send, async () => true);

    for (let i = 0; i < 4; i++) relayer.enqueue('reveal', `k${i}`, reveal(0, i));
    await relayer.drain();

    // The whole point of relaying: transaction count tracks action count.
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('groups reveals when RELAY_BATCH_SIZE is raised', async () => {
    mut.RELAY_BATCH_SIZE = 3;
    const send = vi.fn<relayer.SendFn>(async () => HASH);
    relayer.setTransportForTests(send, async () => true);

    for (let i = 0; i < 4; i++) relayer.enqueue('reveal', `k${i}`, reveal(0, i));
    await relayer.drain();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1]).toHaveLength(3);
    expect(send.mock.calls[1]![1]).toHaveLength(1);
  });

  it('never batches across kinds', async () => {
    mut.RELAY_BATCH_SIZE = 8;
    const send = vi.fn<relayer.SendFn>(async () => HASH);
    relayer.setTransportForTests(send, async () => true);

    relayer.enqueue('reveal', 'a', reveal(0, 0));
    relayer.enqueue('entry', 'b', { player: ALICE, huntId: HASH, gameType: 0 });
    relayer.enqueue('reveal', 'c', reveal(0, 1));
    await relayer.drain();

    // Only recordRevealBatch exists on chain; mixing kinds would be unsendable.
    expect(send.mock.calls.map(c => c[0])).toEqual(['reveal', 'entry', 'reveal']);
  });

  it('confirms every row in a batch together', async () => {
    mut.RELAY_BATCH_SIZE = 4;
    relayer.setTransportForTests(async () => HASH, async () => true);

    for (let i = 0; i < 3; i++) relayer.enqueue('reveal', `k${i}`, reveal(0, i));
    await relayer.drain();
    await relayer.settle();

    expect(rows().every(r => r.status === 'confirmed')).toBe(true);
  });

  it('requeues every row in a batch when the batch fails', async () => {
    mut.RELAY_BATCH_SIZE = 4;
    relayer.setTransportForTests(async () => HASH, async () => false);

    for (let i = 0; i < 3; i++) relayer.enqueue('reveal', `k${i}`, reveal(0, i));
    await relayer.drain();
    await relayer.settle();

    expect(rows().map(r => r.attempts)).toEqual([1, 1, 1]);
  });
});

describe('restart recovery', () => {
  it('returns in-flight rows to pending on start', () => {
    relayer.enqueue('reveal', 'a', reveal(0, 0));
    getDb().prepare(`UPDATE relay_queue SET status = 'sent'`).run();

    // A row left `sent` has nobody watching its receipt — it would sit there
    // forever. Republishing risks a duplicate log; losing it is worse.
    relayer.setTransportForTests(async () => HASH, async () => true);
    relayer.start();

    expect(rows()[0]!.status).toBe('pending');
  });

  it('leaves confirmed and dead rows alone on start', () => {
    relayer.enqueue('reveal', 'a', reveal(0, 0));
    relayer.enqueue('reveal', 'b', reveal(0, 1));
    getDb().prepare(`UPDATE relay_queue SET status = 'confirmed' WHERE id = 1`).run();
    getDb().prepare(`UPDATE relay_queue SET status = 'dead' WHERE id = 2`).run();

    relayer.setTransportForTests(async () => HASH, async () => true);
    relayer.start();

    expect(rows().map(r => r.status)).toEqual(['confirmed', 'dead']);
  });

  it('does not start a timer when disabled', () => {
    mut.RELAY_ENABLED = false;
    const spy = vi.spyOn(global, 'setInterval');
    relayer.start();
    expect(spy).not.toHaveBeenCalled();
  });
});
