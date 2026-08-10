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
}

/**
 * Every call carries the player identity. Errors surface as ApiError with the
 * server's machine-readable `code` — the UI switches on that, never on prose.
 */
export async function api(path, { method = 'GET', body } = {}) {
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
export const post = (path, body) => api(path, { method: 'POST', body });
