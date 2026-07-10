// RelayCore — the per-session attach relay logic (saas-agents-live AL6), pure
// and storage-injectable so it is jest-testable with an in-memory double (the
// deps-injection discipline the worker uses everywhere). The DurableObject
// shell (relay-do.ts) is a thin wrapper that hands it `state.storage` and the
// live SSE writers.
//
// Contract: the relay is a RELAY, not a supervisor (saas-agents §4.2). It
// receives orun's ordered event frames (dedupe by seq), mirrors them for
// durable console reads, fans them out to attached heads, and carries the
// head→body input return-queue. It holds no authority over the agent.
//
// Frames are attach v1 (@saas/contracts/agents-attach) — byte-identical to the
// Go body's, proven by the shared golden fixtures.

import {
  type AttachFrame,
  type AttachHead,
  byeFrame,
  helloFrame,
  liveFrame,
  presenceFrame,
  ackFrame,
  ATTACH_ACK_REASONS,
} from "@saas/contracts/agents-attach";

/** The subset of DurableObjectStorage the relay needs (async KV). Tests pass
 * an in-memory map; the DO passes `state.storage`. */
export interface RelayStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
  delete(key: string): Promise<boolean>;
}

/** A live head connection the core fans frames out to. The DO backs this with
 * an SSE ReadableStream writer; tests back it with an array collector. */
export interface HeadSink {
  readonly id: string;
  readonly principal: string;
  readonly surface: string;
  /** Deliver one frame to this head. Never throws; a dead sink is dropped. */
  send(frame: AttachFrame): void;
  /** Close the head feed (bye already sent). */
  close(): void;
}

/** Session metadata the relay carries in its hello frame. */
export interface RelaySessionInfo {
  sessionId: string;
  briefId?: string;
  agentType?: string;
  task?: string;
  runKind?: string;
  harness?: string;
  model?: string;
}

/** A queued head→body input frame awaiting the body's long-poll, plus the
 * resolver for the head's synchronous ack. */
interface QueuedInput {
  seq: number;
  frame: AttachFrame;
}

const EVT_PREFIX = "e:"; // e:<paddedSeq> → sealed event frame (durable mirror)
const META_KEY = "meta"; // session info + state
const INPUT_PREFIX = "i:"; // i:<paddedSeq> → queued head input frame

function padSeq(seq: number): string {
  return String(seq).padStart(12, "0");
}

/**
 * RelayCore folds the session's event stream, serves attach (replay → live),
 * mirrors sealed events durably, and bridges the input return-queue.
 */
export class RelayCore {
  private info: RelaySessionInfo;
  private state = "running";
  private latestSeq = -1;
  private events: AttachFrame[] = []; // in-memory mirror for fast replay
  private heads = new Map<string, HeadSink>();
  private inputs: QueuedInput[] = []; // head inputs awaiting the body poll
  private inputSeq = 0;
  private acks = new Map<string, AttachFrame>(); // ref → ack (body → head)
  private closed = false;

  constructor(
    private storage: RelayStorage,
    info: RelaySessionInfo,
  ) {
    this.info = info;
  }

  /** Rehydrate from durable storage after a DO eviction (cold start). */
  async load(): Promise<void> {
    const meta = await this.storage.get<{ info: RelaySessionInfo; state: string; latestSeq: number }>(META_KEY);
    if (meta) {
      this.info = meta.info;
      this.state = meta.state;
      this.latestSeq = meta.latestSeq;
    }
    const stored = await this.storage.list<AttachFrame>({ prefix: EVT_PREFIX });
    this.events = [...stored.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, f]) => f);
    const queued = await this.storage.list<QueuedInput>({ prefix: INPUT_PREFIX });
    this.inputs = [...queued.values()].sort((a, b) => a.seq - b.seq);
    this.inputSeq = this.inputs.reduce((m, q) => Math.max(m, q.seq), 0);
  }

  /**
   * ingestEvents folds a batch of body→relay event frames: dedupe by seq,
   * mirror durably, track state, fan out to attached heads. Returns the count
   * newly accepted. This is the shipped `/events` ingest, now frame-shaped.
   */
  async ingestEvents(frames: AttachFrame[]): Promise<number> {
    let accepted = 0;
    for (const f of frames) {
      if (f.t === "hello" || f.t === "live") {
        // hello/live carry no seq to store; they are re-synthesized per head
        // on attach, so the relay ignores them on ingest.
        continue;
      }
      if (f.t === "bye") {
        await this.close(f.reason || ATTACH_ACK_REASONS.terminal);
        continue;
      }
      if (f.t !== "event" || typeof f.seq !== "number") continue;
      if (f.seq <= this.latestSeq) continue; // dedupe: already have it
      this.latestSeq = f.seq;
      this.events.push(f);
      await this.storage.put(EVT_PREFIX + padSeq(f.seq), f);
      if (f.kind === "state_changed" && typeof f.payload?.state === "string") {
        this.state = f.payload.state as string;
      }
      this.fanOut(f);
      accepted++;
    }
    await this.persistMeta();
    return accepted;
  }

  /** Fan a wire-only delta out to heads (never stored). */
  fanOutDelta(frame: AttachFrame): void {
    this.fanOut(frame);
  }

  /**
   * attach connects a head: hello, replay of events with seq > from, live
   * marker, then live fan-out. Presence is announced to all heads.
   */
  attach(sink: HeadSink, from: number): void {
    sink.send(helloFrame(this.info, this.state, this.latestSeq));
    for (const f of this.events) {
      if (typeof f.seq === "number" && f.seq > from) sink.send(f);
    }
    sink.send(liveFrame(from));
    this.heads.set(sink.id, sink);
    this.announcePresence();
    if (this.closed) {
      sink.send(byeFrame(ATTACH_ACK_REASONS.terminal));
      sink.close();
      this.heads.delete(sink.id);
    }
  }

  /** detach removes a head; the session continues. */
  detach(id: string): void {
    if (this.heads.delete(id)) this.announcePresence();
  }

  /**
   * enqueueInput accepts a head→body input frame (steer/verdict/interrupt/end)
   * for the body's long-poll. Returns the ack once the body resolves it (or a
   * terminal ack immediately if the session is over). The DO awaits this to
   * answer the head's POST synchronously.
   */
  async enqueueInput(frame: AttachFrame, principal: string): Promise<AttachFrame> {
    const ref = frame.ref || "";
    if (this.closed) {
      return ackFrame(ref, false, ATTACH_ACK_REASONS.terminal);
    }
    // Stamp the edge-authenticated principal into the frame envelope so the
    // body logs it (the relay is the trust boundary; a head never self-declares).
    const stamped: AttachFrame = { ...frame };
    stamped.payload = { ...(frame.payload ?? {}), principal };
    this.inputSeq++;
    const q: QueuedInput = { seq: this.inputSeq, frame: stamped };
    this.inputs.push(q);
    await this.storage.put(INPUT_PREFIX + padSeq(q.seq), q);
    return this.waitForAck(ref);
  }

  /** pollInputs returns queued inputs with seq > cursor (the body's return
   * queue). The body advances its cursor past what it consumed. */
  pollInputs(cursor: number): { items: AttachFrame[]; cursor: number } {
    const items = this.inputs.filter((q) => q.seq > cursor).map((q) => q.frame);
    return { items, cursor: this.inputSeq };
  }

  /** resolveAck records the body's ack for a head input and wakes the head's
   * pending POST. */
  resolveAck(ack: AttachFrame): void {
    const ref = ack.ref || "";
    this.acks.set(ref, ack);
    const waiter = this.ackWaiters.get(ref);
    if (waiter) {
      waiter(ack);
      this.ackWaiters.delete(ref);
    }
  }

  /** close ends the relay: every head gets a bye. Idempotent. */
  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const sink of this.heads.values()) {
      sink.send(byeFrame(reason));
      sink.close();
    }
    this.heads.clear();
    await this.persistMeta();
    // Fail any pending ack waiters so their heads unblock.
    for (const [ref, waiter] of this.ackWaiters) {
      waiter(ackFrame(ref, false, ATTACH_ACK_REASONS.terminal));
    }
    this.ackWaiters.clear();
  }

  /** headCount reports attached heads (test/inspection). */
  headCount(): number {
    return this.heads.size;
  }

  /** isClosed reports terminal state. */
  isClosed(): boolean {
    return this.closed;
  }

  // ── internals ──────────────────────────────────────────────

  private ackWaiters = new Map<string, (ack: AttachFrame) => void>();

  private waitForAck(ref: string): Promise<AttachFrame> {
    const existing = this.acks.get(ref);
    if (existing) {
      this.acks.delete(ref);
      return Promise.resolve(existing);
    }
    return new Promise<AttachFrame>((resolve) => {
      this.ackWaiters.set(ref, resolve);
    });
  }

  private fanOut(frame: AttachFrame): void {
    for (const sink of this.heads.values()) {
      sink.send(frame);
    }
  }

  private announcePresence(): void {
    const heads: AttachHead[] = [...this.heads.values()]
      .map((h) => ({ principal: h.principal, surface: h.surface }))
      .sort((a, b) => (a.principal < b.principal ? -1 : a.principal > b.principal ? 1 : a.surface < b.surface ? -1 : 1));
    const frame = presenceFrame(heads);
    this.fanOut(frame);
  }

  private async persistMeta(): Promise<void> {
    await this.storage.put(META_KEY, { info: this.info, state: this.state, latestSeq: this.latestSeq });
  }
}
