import { isProd } from './env';

/**
 * Errors carry a stable machine-readable `code` — clients switch on that, never
 * on prose. `expose` decides whether the message is safe to send outward.
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    code: string,
    statusCode: number,
    message?: string,
    opts: { details?: unknown; expose?: boolean } = {},
  ) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = opts.details;
    this.expose = opts.expose ?? statusCode < 500;
  }
}

export const badRequest = (code: string, msg?: string, details?: unknown) =>
  new AppError(code, 400, msg, { details });
export const unauthorized = (code = 'unauthorized', msg?: string) => new AppError(code, 401, msg);
export const forbidden = (code = 'forbidden', msg?: string) => new AppError(code, 403, msg);
export const notFound = (code = 'not_found', msg?: string) => new AppError(code, 404, msg);
export const conflict = (code: string, msg?: string, details?: unknown) =>
  new AppError(code, 409, msg, { details });
export const tooManyRequests = (code = 'rate_limited', msg?: string) =>
  new AppError(code, 429, msg);
export const internal = (code = 'internal_error', msg?: string) =>
  new AppError(code, 500, msg, { expose: false });
/**
 * A dependency we need is not answering. Exposed, unlike {@link internal},
 * because the caller's correct response is to try again — and a 500 tells them
 * the opposite.
 */
export const unavailable = (code = 'unavailable', msg?: string) =>
  new AppError(code, 503, msg);

export interface WireError {
  error: string;
  message?: string;
  details?: unknown;
}

/**
 * Everything that leaves the process goes through here. An unexpected error
 * becomes a bare `internal_error` in production — stack traces and driver
 * messages are for the logs, not for the client.
 */
export function toWireError(err: unknown): { status: number; body: WireError } {
  if (err instanceof AppError) {
    return {
      status: err.statusCode,
      body: err.expose
        ? { error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }
        : { error: err.code },
    };
  }

  if (!isProd && err instanceof Error) {
    return { status: 500, body: { error: 'internal_error', message: err.message } };
  }

  return { status: 500, body: { error: 'internal_error' } };
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
