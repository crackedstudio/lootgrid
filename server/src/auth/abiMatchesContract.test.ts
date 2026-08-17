import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toEventSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { ABI } from './registry';

/**
 * Cross-artifact drift guard.
 *
 * The server subscribes to contract events by signature. topic0 is the keccak of
 * that signature, so ANY change to a parameter list — including adding
 * `indexed`, which reorders nothing — produces a different topic and the
 * subscription silently receives nothing. No error, no log, no failure.
 *
 * This drift already happened once: `SessionKeyCleared` gained an
 * `indexed sessionKey` parameter, the server ABI was not updated, and
 * `clear()`-based revocation quietly regressed to being TTL-bound while
 * `SessionKeyBound` kept working. Each artifact was internally consistent, so
 * neither test suite caught it.
 *
 * NOTE: the first version of this guard regex-matched the server file for
 * `(^|\s)event\s+` — which never matches `'event Foo(...)'` inside a quoted ABI
 * string, so it compared an empty set and passed vacuously. It is now driven off
 * the parsed ABI object the production code actually subscribes with, and
 * compares real topic0 hashes rather than text.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SOLIDITY = join(here, '../../../contracts/src/PlayerRegistry.sol');

/** `event Foo(address indexed a, uint64 b);` → `Foo(address,uint64)` */
function canonicaliseSolidity(decl: string): string {
  const match = decl.match(/event\s+(\w+)\s*\(([\s\S]*?)\)/);
  if (!match) throw new Error(`unparseable event: ${decl}`);
  const [, name, params] = match;
  const types = (params ?? '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => p.split(/\s+/)[0]);
  return `${name}(${types.join(',')})`;
}

/** Every `event ...;` declaration in the Solidity source, multi-line tolerant. */
function contractEvents(): Map<string, string> {
  const source = readFileSync(SOLIDITY, 'utf8');
  const out = new Map<string, string>();
  for (const decl of source.matchAll(/\bevent\s+\w+\s*\([\s\S]*?\)\s*;/g)) {
    const sig = canonicaliseSolidity(decl[0]);
    out.set(sig.slice(0, sig.indexOf('(')), sig);
  }
  return out;
}

/** Every event the server actually subscribes with, from the live ABI object. */
function serverEvents(): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of ABI) {
    if (item.type !== 'event') continue;
    const types = item.inputs.map(i => i.type).join(',');
    out.set(item.name, `${item.name}(${types})`);
  }
  return out;
}

describe('server ABI matches the deployed contract', () => {
  const onChain = contractEvents();
  const onServer = serverEvents();

  it('parses events from both artifacts', () => {
    // Guards against the failure mode this file itself had: comparing nothing.
    expect(onChain.size, 'no events parsed from PlayerRegistry.sol').toBeGreaterThan(0);
    expect(onServer.size, 'no events found in the server ABI').toBeGreaterThan(0);
  });

  it('subscribes to signatures that exist in the contract', () => {
    for (const [name, sig] of onServer) {
      expect(onChain.has(name), `contract has no event named ${name}`).toBe(true);
      expect(sig, `${name} signature drifted between contract and server ABI`).toBe(
        onChain.get(name),
      );
    }
  });

  it('computes identical topic0 for every subscribed event', () => {
    // The property that actually matters — a mismatch here is a dead subscription.
    for (const [name, sig] of onServer) {
      expect(
        toEventSelector(`event ${sig}`),
        `${name} topic0 differs; the subscription would match nothing`,
      ).toBe(toEventSelector(`event ${onChain.get(name)!}`));
    }
  });

  it('subscribes to both revocation signals', () => {
    // Missing either means a rotation or a clear goes unnoticed and the cached
    // binding survives for the full TTL.
    expect(onServer.has('SessionKeyBound')).toBe(true);
    expect(onServer.has('SessionKeyCleared')).toBe(true);
  });
});
