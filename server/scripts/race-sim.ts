/**
 * Drives a real multi-way race against a running referee.
 *
 *   AUTH_MODE=dev npm run dev        # in one terminal
 *   npx tsx scripts/race-sim.ts
 *
 * Two human-like players race a block, plus one bot that plays at machine
 * timing. Because the game type is a property of the block, the sim plays
 * whichever of the four it is handed — so this doubles as an end-to-end check
 * of every module.
 *
 * Expected: a human wins, and the bot is rejected on timing despite being
 * faster than either of them.
 *
 * Requires AUTH_MODE=dev — it sends an `x-player` header rather than signing
 * requests with a PlayerRegistry session key.
 */
import WebSocket from 'ws';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const FLUSH_MS = 200;

interface Profile {
  name: string;
  address: string;
  /** Multiplier on human-plausible pacing; `bot: true` plays at machine timing. */
  pace: number;
  bot: boolean;
}

/** Fresh identities per run — a player gets exactly one attempt per block. */
const runId = Math.floor(Math.random() * 0xffffff)
  .toString(16)
  .padStart(6, '0');
const addr = (n: number) => `0x${String(n).repeat(2)}${runId}`.padEnd(42, '0');

const PROFILES: Profile[] = [
  { name: 'slower-human', address: addr(11), pace: 1.15, bot: false },
  { name: 'faster-human', address: addr(22), pace: 1.0, bot: false },
  { name: 'bot', address: addr(33), pace: 0.0, bot: true },
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Async inbox so a player can await the server's next message.
 *
 * Deliberately a poll rather than a waiter list: racing a waiter against a
 * timeout leaves the loser registered, and the next message gets handed to
 * nobody and silently dropped.
 */
class Inbox {
  private queue: any[] = [];

  push(msg: any): void {
    this.queue.push(msg);
  }

  async waitFor(type: string, timeoutMs = 5000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const i = this.queue.findIndex(m => m.t === type);
      if (i >= 0) return this.queue.splice(i, 1)[0];
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${type}`);
  }
}

interface Session {
  ws: WebSocket;
  inbox: Inbox;
  log: (m: string) => void;
}

function connect(profile: Profile, huntId: string): Promise<Session> {
  const log = (m: string) => console.log(`  [${profile.name.padEnd(12)}] ${m}`);
  const inbox = new Inbox();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', player: profile.address })));
    ws.on('error', reject);
    ws.on('message', raw => {
      const msg = JSON.parse(String(raw));
      switch (msg.t) {
        case 'ready':
          ws.send(JSON.stringify({ t: 'join', room: `hunt:${huntId}` }));
          resolve({ ws, inbox, log });
          return;
        case 'attempt:failed':
          log(`✗ FAILED — ${msg.reason}`);
          break;
        case 'attempt:complete':
          log(`· finished in ${msg.elapsedMs}ms, awaiting result`);
          break;
        case 'attempt:lost':
          log(`· lost to ${msg.winner}`);
          break;
        case 'hunt:resolved':
          log(`★ ${msg.winner} won in ${msg.elapsedMs}ms`);
          break;
        case 'error':
          log(`! ${msg.error}`);
          break;
      }
      inbox.push(msg);
    });
  });
}

/** Batches inputs the way a real client would, rather than one frame per event. */
class Sender {
  private seq = 0;
  private buffer: Array<Record<string, unknown>> = [];
  private lastFlush = Date.now();
  readonly start = Date.now();

  constructor(private ws: WebSocket, private attemptId: string) {}

  add(kind: string, value?: unknown, force = false): void {
    this.buffer.push({ seq: ++this.seq, kind, t: Date.now() - this.start, value });
    if (force || Date.now() - this.lastFlush >= FLUSH_MS) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    this.ws.send(JSON.stringify({ t: 'input', attemptId: this.attemptId, events: this.buffer }));
    this.buffer = [];
    this.lastFlush = Date.now();
  }
}

/** Human pacing with deterministic-ish jitter; a bot gets none. */
function gap(profile: Profile, humanMs: number, botMs: number): number {
  if (profile.bot) return botMs;
  return humanMs * profile.pace + (Math.random() * 2 - 1) * humanMs * 0.3;
}

async function playTap(s: Session, p: Profile, send: Sender, spec: { target: number }) {
  for (let i = 0; i < spec.target; i++) {
    await sleep(gap(p, 165, 60));
    send.add('tap', undefined, i === spec.target - 1);
  }
}

async function playSequence(s: Session, p: Profile, send: Sender, spec: { n: number }) {
  for (let i = 1; i <= spec.n; i++) {
    await sleep(gap(p, 260, 30));
    send.add('tap', i, i === spec.n);
  }
}

async function playMemory(
  s: Session,
  p: Profile,
  send: Sender,
  spec: { sequence: number[]; playbackMs: number },
) {
  // A bot doesn't wait for the animation — which is exactly what gets it caught.
  await sleep(p.bot ? spec.playbackMs * 0.5 : spec.playbackMs + 250);
  for (let i = 0; i < spec.sequence.length; i++) {
    await sleep(gap(p, 320, 40));
    send.add('pad', spec.sequence[i], i === spec.sequence.length - 1);
  }
}

function solve(q: string): number {
  const [a, op, b] = q.split(' ');
  const x = Number(a);
  const y = Number(b);
  if (op === '+') return x + y;
  if (op === '-') return x - y;
  return x * y;
}

async function playMath(
  s: Session,
  p: Profile,
  send: Sender,
  spec: { count: number; question: { q: string } },
) {
  let question = spec.question.q;
  for (let i = 0; i < spec.count; i++) {
    await sleep(gap(p, 900, 50));
    send.add('answer', solve(question), true);
    if (i === spec.count - 1) break;
    const update = await s.inbox.waitFor('game:update').catch(() => null);
    if (!update) return; // rejected — the failure message already logged
    question = update.data.question.q;
  }
}

async function play(profile: Profile, huntId: string) {
  const session = await connect(profile, huntId);

  const res = await fetch(`${BASE}/hunts/${huntId}/attempts`, {
    method: 'POST',
    headers: { 'x-player': profile.address },
  });
  const attempt = (await res.json()) as {
    attemptId?: string;
    error?: string;
    gameType?: string;
    spec?: any;
  };

  if (!attempt.attemptId) {
    session.log(`could not start: ${attempt.error ?? 'unknown'}`);
    session.ws.close();
    return null;
  }

  const send = new Sender(session.ws, attempt.attemptId);
  const spec = attempt.spec;

  try {
    switch (attempt.gameType) {
      case 'tap':
        await playTap(session, profile, send, spec);
        break;
      case 'sequence':
        await playSequence(session, profile, send, spec);
        break;
      case 'memory':
        await playMemory(session, profile, send, spec);
        break;
      case 'math':
        await playMath(session, profile, send, spec);
        break;
      default:
        session.log(`unknown game type ${attempt.gameType}`);
    }
    send.flush();
  } catch (err) {
    session.log(`stopped: ${(err as Error).message}`);
  }

  return { ws: session.ws, attemptId: attempt.attemptId };
}

// ---- pick a live block ----
const { zones } = (await (await fetch(`${BASE}/zones`)).json()) as { zones: Array<{ id: string }> };

let hunt: { id: string; r: number; c: number; prizeLabel: string } | null = null;
for (const zone of zones) {
  const grid = (await (await fetch(`${BASE}/zones/${zone.id}/grid`)).json()) as {
    hunts: Array<{ id: string; r: number; c: number; prizeLabel: string; status: string }>;
  };
  const candidate = grid.hunts.find(h => h.status === 'live');
  if (candidate) {
    hunt = candidate;
    break;
  }
}
if (!hunt) throw new Error('no live hunt found');

console.log(`\nRacing ${hunt.id} (${hunt.prizeLabel}) at r${hunt.r},c${hunt.c}\n`);

const runners = await Promise.all(PROFILES.map(p => play(p, hunt!.id)));
await sleep(1500); // let the settlement window close and results land

console.log('\n--- server-side result ---');
const token = process.env.METRICS_TOKEN;
const detail = await (
  await fetch(`${BASE}/debug/hunts/${hunt.id}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
).json();
console.log(JSON.stringify(detail, null, 2));

for (const r of runners) r?.ws.close();
process.exit(0);
