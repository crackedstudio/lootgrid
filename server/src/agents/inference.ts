import { env } from '../env';
import { logger } from '../logger';

/**
 * The inference provider, behind one function.
 *
 * ─────────────────────────── the key never leaves ───────────────────────────
 *
 * Players do not bring API keys, so the house pays for thinking and meters it
 * back against each vault (architecture §7). That makes `DEEPSEEK_API_KEY` a
 * shared secret with a per-request cost attached, and it appears in exactly one
 * place: the Authorization header built below. It is never in an agent's config,
 * never in a prompt, never in a response to a client, and there is a test that
 * greps the client bundle for it.
 *
 * ─────────────────────────── one seam, for two reasons ──────────────────────
 *
 * {@link CompleteFn} is swappable, like the relayer's transport and the escrow's
 * reader. The obvious reason is tests. The better one is that everything that
 * makes this system safe — budgets, schema validation, per-tenant isolation —
 * is upstream of this call, so it must be possible to exercise all of it without
 * a network, a key, or a bill.
 *
 * ─────────────────────────── failure is ordinary ───────────────────────────
 *
 * A provider that is slow, down, rate-limited or returning nonsense is the
 * normal case, not the exception, and none of it may reach gameplay. Every
 * failure here resolves to a typed result rather than throwing, and the caller
 * (`validate.ts`) turns anything unusable into a deterministic fallback move.
 * An agent whose provider is down plays badly; it does not stall a hunt.
 */

export interface CompletionRequest {
  /** The fixed instructions. Never contains another tenant's anything. */
  system: string;
  /** The situation, rendered by the caller from validated data. */
  user: string;
  /** Bounded per call — a model that rambles is a model that bills. */
  maxTokens: number;
}

/**
 * What the provider actually charged for, when it says.
 *
 * Read off the response rather than assumed. The budget still has to be checked
 * BEFORE a call — you cannot know a cost before making it — so this does not
 * replace the estimate in `budget.CALL_MILLS`; it reconciles against it.
 *
 * That distinction matters most now that the house holds the DeepSeek account:
 * the estimate is what bounds a looping agent, and this is what tells us whether
 * the estimate is right. A fixed guess cannot notice a prompt that grew.
 */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export type CompletionResult =
  | { ok: true; text: string; usage?: Usage }
  | { ok: false; reason: 'disabled' | 'timeout' | 'http_error' | 'empty' | 'network' };

export type CompleteFn = (req: CompletionRequest) => Promise<CompletionResult>;

/**
 * How long to wait for a move.
 *
 * Generous by gameplay standards and tiny by agent-turn standards: an agent
 * attempt runs for ten minutes, so twenty seconds of thinking is affordable.
 * The limit exists so a hung provider cannot hold a turn open indefinitely.
 */
export const TIMEOUT_MS = 20_000;

export function enabled(): boolean {
  return Boolean(env.AGENTS_ENABLED && env.DEEPSEEK_API_KEY);
}

export const model = (): string => env.DEEPSEEK_MODEL;

/**
 * The real provider. OpenAI-compatible, so the shape below is unsurprising.
 *
 * `response_format: json_object` is requested but never relied on: the schema
 * check in `validate.ts` runs regardless, because a provider that promises JSON
 * and returns prose is exactly the failure that would otherwise reach a wallet.
 */
const deepseek: CompleteFn = async req => {
  if (!enabled()) return { ok: false, reason: 'disabled' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${env.DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        // The only place the key appears.
        authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        max_tokens: req.maxTokens,
        // Deterministic-ish: these are constraint problems with right answers,
        // not creative writing, and a lower temperature means fewer schema
        // violations to retry.
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      // Deliberately not logging the body: a provider error can echo the request,
      // and the request contains one tenant's game state.
      logger.warn({ status: response.status }, 'inference provider returned an error');
      return { ok: false, reason: 'http_error' };
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = body.choices?.[0]?.message?.content;
    if (!text) return { ok: false, reason: 'empty' };

    // Absent on providers that do not report it, which is why `usage` is
    // optional everywhere downstream rather than defaulted to zero — a zero
    // would read as "this call was free" and quietly flatter the reconciliation.
    const u = body.usage;
    const usage =
      typeof u?.prompt_tokens === 'number' && typeof u?.completion_tokens === 'number'
        ? { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens }
        : undefined;

    return { ok: true, text, usage };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    if (!aborted) logger.warn({ err }, 'inference call failed');
    return { ok: false, reason: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
};

let completeFn: CompleteFn = deepseek;

/** Swaps the provider. Tests only — `null` restores the real one. */
export function setProviderForTests(fn: CompleteFn | null): void {
  completeFn = fn ?? deepseek;
}

/** Whether the real provider is installed. Surfaced by `/ready`. */
export const isLive = (): boolean => completeFn === deepseek;

export function complete(req: CompletionRequest): Promise<CompletionResult> {
  return completeFn(req);
}
