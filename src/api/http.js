import { API_URL, REQUEST_TIMEOUT_MS } from './config';
import { signRequest } from './sign';

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

  // Signed before the timer matters: the body must be serialised exactly once
  // and the SAME string both hashed and sent, or the hash will not match.
  const payload = body ? JSON.stringify(body) : undefined;
  let auth;
  try {
    auth = await signRequest(method, path, payload);
  } catch {
    clearTimeout(timer);
    throw new ApiError('unauthenticated', 401, null);
  }

  let res;
  try {
    res = await fetch(API_URL + path, {
      method,
      signal: controller.signal,
      headers: {
        ...auth,
        ...(body ? { 'content-type': 'application/json' } : {}),
        // The x402 retry: same URL, same method, one extra header. Not signed —
        // the server treats it as a bearer credential in its own right.
        ...(payment ? { 'x-payment': payment } : {}),
      },
      body: payload,
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
export const put = (path, body) => api(path, { method: 'PUT', body });
export const del = path => api(path, { method: 'DELETE' });
