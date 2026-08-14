import { API_URL, REQUEST_TIMEOUT_MS } from './config';
import { getPlayerId } from './session';

export class ApiError extends Error {
  constructor(code, status, body) {
    super(body?.message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.body = body;
  }

  /**
   * A 402 is not a failure, it is the protocol asking for money.
   *
   * Callers that can pay branch on this and retry with an `X-PAYMENT` header;
   * everyone else treats it like any other error. Distinguishing it here rather
   * than at each call site is what stops "payment required" from being reported
   * to a player as "something went wrong".
   */
  get paymentRequired() {
    return this.status === 402 && Boolean(this.body?.payment);
  }

  /** The terms and the ready-to-sign payload, or null. */
  get payment() {
    return this.paymentRequired ? this.body.payment : null;
  }
}

/**
 * Every call carries the player identity. Errors surface as ApiError with the
 * server's machine-readable `code` — the UI switches on that, never on prose.
 */
export async function api(path, { method = 'GET', body, payment } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(API_URL + path, {
      method,
      signal: controller.signal,
      headers: {
        'x-player': getPlayerId(),
        ...(body ? { 'content-type': 'application/json' } : {}),
        // The x402 retry: same URL, same method, one extra header.
        ...(payment ? { 'x-payment': payment } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    clearTimeout(timer);
    // Network failure or timeout — the referee is unreachable, which is fatal
    // rather than something to paper over.
    throw new ApiError(err.name === 'AbortError' ? 'timeout' : 'unreachable', 0, null);
  }
  clearTimeout(timer);

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error || 'request_failed', res.status, json);
  return json;
}

export const get = path => api(path);
export const post = (path, body, opts) => api(path, { method: 'POST', body, ...opts });
export const del = path => api(path, { method: 'DELETE' });
