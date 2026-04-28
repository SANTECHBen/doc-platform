// In-memory pub/sub for active agent runs.
//
// When the propose endpoint kicks off the agent loop, it creates a bus entry
// for that run id. The SSE endpoint subscribes to receive `tool_call`,
// `tool_result`, `node_emitted`, etc. events. Multiple SSE clients can
// subscribe (e.g. admin reopens the page) — they each get the live tail.
//
// Replay: the bus also keeps an in-memory ring buffer of recent events so a
// reconnecting client (with Last-Event-ID) can catch up without missing
// emissions that happened during the disconnect window.
//
// Single-instance only. For horizontal scaling, swap this for Redis pub/sub.

import { EventEmitter } from 'node:events';

export type AgentEventType =
  | 'tool_call'
  | 'tool_result'
  | 'node_emitted'
  | 'finalize'
  | 'warning'
  | 'error'
  | 'status'
  | 'mux_ready'
  | 'execution_step'
  | 'done';

export interface AgentBusEvent {
  id: number;
  type: AgentEventType;
  data: Record<string, unknown>;
  ts: number;
}

interface BusEntry {
  emitter: EventEmitter;
  history: AgentBusEvent[];
  nextId: number;
  closedAt: number | null;
}

const HISTORY_LIMIT = 500;
const RETENTION_MS = 30 * 60 * 1000; // 30 minutes after close

class AgentBus {
  private entries = new Map<string, BusEntry>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  private ensureCleanup() {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.purge(), 5 * 60 * 1000).unref();
  }

  private get(channel: string): BusEntry {
    let entry = this.entries.get(channel);
    if (!entry) {
      entry = {
        emitter: new EventEmitter(),
        history: [],
        nextId: 0,
        closedAt: null,
      };
      // Don't crash the process if a subscriber's listener throws.
      entry.emitter.setMaxListeners(50);
      this.entries.set(channel, entry);
      this.ensureCleanup();
    }
    return entry;
  }

  publish(channel: string, type: AgentEventType, data: Record<string, unknown>): void {
    const entry = this.get(channel);
    const evt: AgentBusEvent = {
      id: ++entry.nextId,
      type,
      data,
      ts: Date.now(),
    };
    entry.history.push(evt);
    if (entry.history.length > HISTORY_LIMIT) {
      entry.history.splice(0, entry.history.length - HISTORY_LIMIT);
    }
    entry.emitter.emit('event', evt);
  }

  subscribe(
    channel: string,
    handler: (evt: AgentBusEvent) => void,
    sinceId?: number,
  ): () => void {
    const entry = this.get(channel);
    if (typeof sinceId === 'number') {
      for (const evt of entry.history) {
        if (evt.id > sinceId) handler(evt);
      }
    }
    entry.emitter.on('event', handler);
    return () => entry.emitter.off('event', handler);
  }

  /**
   * Mark a channel as closed. Subscribers stay attached but no further
   * events arrive. The entry is purged after RETENTION_MS so reconnects
   * inside that window can replay history.
   */
  close(channel: string): void {
    const entry = this.entries.get(channel);
    if (!entry) return;
    entry.closedAt = Date.now();
  }

  hasHistory(channel: string): boolean {
    return this.entries.has(channel);
  }

  private purge(): void {
    const now = Date.now();
    for (const [channel, entry] of this.entries) {
      if (entry.closedAt && now - entry.closedAt > RETENTION_MS) {
        entry.emitter.removeAllListeners();
        this.entries.delete(channel);
      }
    }
  }
}

export const agentBus = new AgentBus();

export function runChannel(runId: string, kind: 'propose' | 'execute'): string {
  return `${kind}:${runId}`;
}
