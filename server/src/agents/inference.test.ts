import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../env';
import * as inference from './inference';

/**
 * The provider request itself.
 *
 * Everything else about agents is tested through the {@link inference.CompleteFn}
 * seam, which means the one thing never exercised is the request this module
 * actually puts on the wire. That is precisely where the expensive mistake was.
 */

const mut = env as { AGENTS_ENABLED: boolean; DEEPSEEK_API_KEY?: string; DEEPSEEK_MODEL: string };
const original = { ...mut };

function mockFetch(body: unknown, ok = true) {
  const fn = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  })) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fn);
  return fn as unknown as ReturnType<typeof vi.fn>;
}

const REPLY = {
  choices: [{ message: { content: '{"action":"dig","r":1,"c":2}' } }],
  usage: { prompt_tokens: 100, completion_tokens: 12 },
};

beforeEach(() => {
  mut.AGENTS_ENABLED = true;
  mut.DEEPSEEK_API_KEY = 'sk-test-key-not-real';
  inference.setProviderForTests(null); // use the real deepseek fn, mocked transport
});

afterEach(() => {
  Object.assign(mut, original);
  vi.unstubAllGlobals();
  inference.setProviderForTests(null);
});

describe('the outgoing request', () => {
  /**
   * The regression this file exists for.
   *
   * deepseek-v4 reasons by default and draws reasoning tokens from `max_tokens`
   * before emitting any answer. Measured against real board prompts it burned
   * 200, 800, 4000 and 16,000 tokens on reasoning and returned empty content
   * every time. Empty content is indistinguishable from a bad model: the caller
   * falls back to a deterministic move, play looks normal, and every call is
   * billed in full for thinking that never arrives.
   *
   * If this assertion is ever deleted, that failure comes back silently.
   */
  it('disables reasoning', async () => {
    const f = mockFetch(REPLY);
    await inference.complete({ system: 's', user: 'u', maxTokens: 200 });

    const body = JSON.parse(f.mock.calls[0]![1].body as string);
    expect(body.reasoning_effort).toBe('none');
  });

  it("does not use 'minimal', which was measured to still overrun", async () => {
    const f = mockFetch(REPLY);
    await inference.complete({ system: 's', user: 'u', maxTokens: 200 });

    const body = JSON.parse(f.mock.calls[0]![1].body as string);
    expect(body.reasoning_effort).not.toBe('minimal');
  });

  it('sends the bounded token budget and a low temperature', async () => {
    const f = mockFetch(REPLY);
    await inference.complete({ system: 'sys', user: 'usr', maxTokens: 123 });

    const body = JSON.parse(f.mock.calls[0]![1].body as string);
    expect(body.max_tokens).toBe(123);
    expect(body.temperature).toBeLessThanOrEqual(0.2);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  it('carries the key in the Authorization header and nowhere else', async () => {
    const f = mockFetch(REPLY);
    await inference.complete({ system: 's', user: 'u', maxTokens: 10 });

    const [, init] = f.mock.calls[0]!;
    expect(init.headers.authorization).toBe('Bearer sk-test-key-not-real');
    // A key echoed into the prompt would reach the provider as content and, via
    // any logging of that prompt, reach places a secret must never go.
    expect(init.body as string).not.toContain('sk-test-key-not-real');
  });
});

describe('failure is typed, never thrown', () => {
  it('reports empty content rather than returning a bad move', async () => {
    mockFetch({ choices: [{ message: { content: '' } }] });
    const r = await inference.complete({ system: 's', user: 'u', maxTokens: 10 });
    expect(r).toEqual({ ok: false, reason: 'empty' });
  });

  it('reports an http error without leaking the response body', async () => {
    mockFetch({ error: 'whatever' }, false);
    const r = await inference.complete({ system: 's', user: 'u', maxTokens: 10 });
    expect(r).toEqual({ ok: false, reason: 'http_error' });
  });

  it('is disabled when no key is configured', async () => {
    mut.DEEPSEEK_API_KEY = undefined;
    const r = await inference.complete({ system: 's', user: 'u', maxTokens: 10 });
    expect(r).toEqual({ ok: false, reason: 'disabled' });
  });

  it('passes usage through when the provider reports it', async () => {
    mockFetch(REPLY);
    const r = await inference.complete({ system: 's', user: 'u', maxTokens: 10 });
    expect(r).toMatchObject({ ok: true, usage: { promptTokens: 100, completionTokens: 12 } });
  });

  it('leaves usage undefined rather than zero when it is absent', async () => {
    // A zero would read as "this call was free" and quietly flatter the
    // reconciliation against CALL_MILLS.
    mockFetch({ choices: [{ message: { content: '{}' } }] });
    const r = await inference.complete({ system: 's', user: 'u', maxTokens: 10 });
    expect(r).toMatchObject({ ok: true });
    expect((r as { usage?: unknown }).usage).toBeUndefined();
  });
});
