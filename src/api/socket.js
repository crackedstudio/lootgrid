import { WS_URL } from './config';
import { signHello } from './sign';

const FLUSH_MS = 200;

/**
 * One socket for the whole app. Rooms are joined/left as the player moves
 * around; every game event arrives here.
 */
class Socket {
  constructor() {
    this.ws = null;
    this.status = 'idle'; // idle | connecting | online | offline
    this.rooms = new Set();
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.retries = 0;
    this.retryTimer = null;
    this.intentionalClose = false;
  }

  onMessage(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    for (const fn of this.statusListeners) fn(status);
  }

  connect() {
    if (this.ws && (this.status === 'online' || this.status === 'connecting')) return;
    this.intentionalClose = false;
    this.setStatus('connecting');

    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = async () => {
      try {
        // Signing is async, so the socket is briefly open and silent. The server
        // waits for a hello rather than assuming one, so that gap is fine.
        ws.send(JSON.stringify(await signHello()));
      } catch {
        // Not authenticated yet. Close rather than sit in a half-open socket
        // the server will drop anyway.
        this.intentionalClose = true;
        ws.close();
      }
    };

    ws.onmessage = e => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      if (msg.t === 'ready') {
        this.retries = 0;
        this.setStatus('online');
        // Re-join whatever we were watching before the drop.
        for (const room of this.rooms) this.send({ t: 'join', room });
        return;
      }

      for (const fn of this.listeners) fn(msg);
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.intentionalClose) return this.setStatus('idle');
      this.setStatus('offline');
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // 'close' always follows; reconnection is handled there.
    };
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    const delay = Math.min(30_000, 500 * 2 ** this.retries);
    this.retries += 1;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  disconnect() {
    this.intentionalClose = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.rooms.clear();
    this.setStatus('idle');
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  join(room) {
    this.rooms.add(room);
    this.send({ t: 'join', room });
  }

  leave(room) {
    this.rooms.delete(room);
    this.send({ t: 'leave', room });
  }
}

export const socket = new Socket();

/**
 * Batches an attempt's inputs the way the server expects: monotonic `seq`, and
 * `t` measured from when the spec arrived.
 *
 * `performance.now()` rather than `Date.now()` deliberately — it is monotonic,
 * so a clock adjustment mid-race cannot make intervals look impossible and get
 * an honest player failed for cheating.
 */
export function createSender(attemptId) {
  let seq = 0;
  let buffer = [];
  let timer = null;
  const start = performance.now();

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (buffer.length === 0) return;
    socket.send({ t: 'input', attemptId, events: buffer });
    buffer = [];
  }

  return {
    add(kind, value, flushNow = false) {
      buffer.push({
        seq: ++seq,
        kind,
        t: Math.round(performance.now() - start),
        ...(value === undefined ? {} : { value }),
      });
      if (flushNow) return flush();
      if (!timer) timer = setTimeout(flush, FLUSH_MS);
    },
    flush,
    dispose() {
      clearTimeout(timer);
      timer = null;
      buffer = [];
    },
  };
}
