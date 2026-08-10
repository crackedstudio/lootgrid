export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';
export const WS_URL = API_URL.replace(/^http/, 'ws') + '/ws';

/**
 * How long to wait for the referee before declaring the session dead.
 * There is deliberately no offline fallback: a client that quietly drops back to
 * fake local state is exactly how you end up unable to tell whether the server
 * is working.
 */
export const REQUEST_TIMEOUT_MS = 8000;
