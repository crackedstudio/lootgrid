interface Entry {
  at: number;
  id: string;
  /** Monotonic version, so a superseded entry can be recognised on the way out. */
  v: number;
}

/**
 * One sweeper for every attempt in the process.
 *
 * The prototype ran a `setInterval` per minigame. Ported straight to a server
 * that shape becomes one timer per concurrent attempt, and Node's timer heap
 * becomes the bottleneck long before the game logic does. This is O(expired)
 * per tick instead of O(active).
 *
 * Cancellation and re-scheduling are versioned rather than flagged: a flag
 * cannot distinguish "this id was cancelled" from "this id was cancelled and
 * then re-pushed", which fires the stale entry as well as the new one.
 */
export class TimerWheel {
  private heap: Entry[] = [];
  /** id → the only version currently considered live. */
  private live = new Map<string, number>();
  private seq = 0;

  get size(): number {
    return this.live.size;
  }

  push(id: string, at: number): void {
    const v = ++this.seq;
    this.live.set(id, v);
    this.heap.push({ id, at, v });
    this.bubbleUp(this.heap.length - 1);
  }

  cancel(id: string): void {
    this.live.delete(id);
  }

  /** Every id due at or before `now`, removed from the wheel. */
  drain(now: number): string[] {
    const due: string[] = [];
    while (this.heap.length > 0 && this.heap[0]!.at <= now) {
      const entry = this.pop()!;
      // Cancelled, or superseded by a later push for the same id.
      if (this.live.get(entry.id) !== entry.v) continue;
      this.live.delete(entry.id);
      due.push(entry.id);
    }
    return due;
  }

  private pop(): Entry | undefined {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0 && last) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent]!.at <= this.heap[i]!.at) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.heap.length;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let smallest = i;
      if (l < n && this.heap[l]!.at < this.heap[smallest]!.at) smallest = l;
      if (r < n && this.heap[r]!.at < this.heap[smallest]!.at) smallest = r;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const t = this.heap[a]!;
    this.heap[a] = this.heap[b]!;
    this.heap[b] = t;
  }
}
