import type { BridgeEvent, BridgeKind, EventFilter } from "./types.js";

const MAX_ENTRIES = 500;

class RingBufferEventBus {
  private _entries: BridgeEvent[] = [];
  private _counter = 0;
  private _listeners = new Set<(event: BridgeEvent) => void>();

  publish(event: BridgeEvent): void {
    if (this._entries.length >= MAX_ENTRIES) {
      this._entries = this._entries.slice(-MAX_ENTRIES + 1);
    }
    this._entries.push(event);
    this._notify(event);
  }

  publishPartial(
    partial: Omit<BridgeEvent, "id" | "ts"> & Partial<Pick<BridgeEvent, "ts">>,
  ): BridgeEvent {
    const ts = partial.ts ?? Date.now();
    const event: BridgeEvent = {
      ...partial,
      id: `${ts}-${this._counter++}`,
      ts,
    };
    this.publish(event);
    return event;
  }

  getAll(): BridgeEvent[] {
    return [...this._entries];
  }

  getRecent(filter: EventFilter = {}): { events: BridgeEvent[]; nextCursor: string | null } {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    let pool = this._entries;

    if (filter.since) {
      const idx = pool.findIndex((e) => e.id === filter.since);
      pool = idx >= 0 ? pool.slice(idx + 1) : pool;
    }
    if (filter.source) pool = pool.filter((e) => e.source === filter.source);
    if (filter.level) pool = pool.filter((e) => e.level === filter.level);
    if (filter.kind) pool = pool.filter((e) => e.kind === filter.kind);

    const events = pool.slice(-limit);
    const nextCursor = events.length > 0 ? events[events.length - 1].id : null;
    return { events, nextCursor };
  }

  /**
   * Long-poll: resolves with up-to `limit` events matching `kinds`,
   * waiting up to `maxWaitMs` for the first match. Returns immediately
   * if matches already exist in the buffer.
   */
  tail(kinds: BridgeKind[], maxWaitMs: number, limit = 20): Promise<{ events: BridgeEvent[]; truncated: boolean }> {
    const wait = Math.min(Math.max(maxWaitMs, 1), 30000);
    return new Promise((resolve) => {
      const tagBefore = this._entries.length > 0 ? this._entries[this._entries.length - 1].id : "";
      const matches = (e: BridgeEvent) => kinds.includes(e.kind);

      const drainBuffer = (): BridgeEvent[] => {
        const found: BridgeEvent[] = [];
        for (let i = this._entries.length - 1; i >= 0; i--) {
          const e = this._entries[i];
          if (e.id === tagBefore) break;
          if (matches(e)) found.unshift(e);
          if (found.length >= limit) break;
        }
        return found;
      };

      let finished = false;
      const finish = (collected: BridgeEvent[], truncated: boolean) => {
        if (finished) return;
        finished = true;
        unsubscribe();
        clearTimeout(timer);
        resolve({ events: collected, truncated });
      };

      const listener = (e: BridgeEvent) => {
        if (!matches(e)) return;
        const collected = drainBuffer();
        finish(collected, collected.length >= limit);
      };
      const unsubscribe = this.subscribe(listener);

      const timer = setTimeout(() => finish([], false), wait);
    });
  }

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  clear(): void {
    this._entries = [];
  }

  get entryCount(): number {
    return this._entries.length;
  }

  private _notify(event: BridgeEvent): void {
    for (const fn of this._listeners) {
      try {
        fn(event);
      } catch {
        /* listener errors must not crash the bus */
      }
    }
  }
}

export const eventBus = new RingBufferEventBus();
export type { RingBufferEventBus };
