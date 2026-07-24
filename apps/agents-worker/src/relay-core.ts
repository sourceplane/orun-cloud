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
  eventFrame,
  helloFrame,
  liveFrame,
  presenceFrame,
  ackFrame,
  ATTACH_ACK_REASONS,
} from "@saas/contracts/agents-attach";
import { IMPLICIT_CONTROL_WINDOW_MS, type ControlMode, type ControlState } from "@saas/contracts/agents";
import { isHumanPrincipal } from "./principal.js";

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

/** Who holds the wheel (SV5). Expiry is kept as ms internally for clock math;
 * the wire/roster surface it as an ISO instant. */
interface ControlHold {
  principal: string;
  mode: ControlMode;
  /** ms epoch the implicit window lapses; absent for explicit holds. */
  expiresMs?: number;
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
  /** Takeover (SV5): who holds the wheel, or undefined when unheld. */
  private control: ControlHold | undefined = undefined;

  constructor(
    private storage: RelayStorage,
    info: RelaySessionInfo,
    /** Injected clock (ms epoch) for the implicit-control window — tests drive
     * it; the DO passes Date.now. */
    private now: () => number = () => Date.now(),
  ) {
    this.info = info;
  }

  /** Rehydrate from durable storage after a DO eviction (cold start). */
  async load(): Promise<void> {
    const meta = await this.storage.get<{
      info: RelaySessionInfo;
      state: string;
      latestSeq: number;
      control?: ControlHold;
    }>(META_KEY);
    if (meta) {
      this.info = meta.info;
      this.state = meta.state;
      this.latestSeq = meta.latestSeq;
      this.control = meta.control;
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
    // Re-sync control (SV5): a joining head learns who holds the wheel, the
    // presence-adjacent way (the transition frames aren't in the seq'd replay).
    if (this.control) {
      const at = new Date(this.now()).toISOString();
      sink.send(eventFrame(this.latestSeq < 0 ? 0 : this.latestSeq, "control_taken", at, {
        principal: this.control.principal,
        mode: this.control.mode,
      }));
    }
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
   * rejoin re-registers a head whose transport survived a DO eviction (a
   * hibernated WebSocket, saas-agents-native AN1). The socket never dropped,
   * so the head gets NO hello/replay/live — it is already live; frames could
   * only have arrived on a wake, and every wake re-registers before ingest.
   * The one AN addition to this class; everything AL6 sealed is untouched.
   */
  rejoin(sink: HeadSink): void {
    if (this.closed) {
      sink.send(byeFrame(ATTACH_ACK_REASONS.terminal));
      sink.close();
      return;
    }
    if (this.heads.has(sink.id)) return;
    this.heads.set(sink.id, sink);
    this.announcePresence();
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

    // ── Takeover gate (SV5, design §5) — server-enforced, not model-politeness.
    // The decision + control mutation are SYNCHRONOUS (seals fan out
    // synchronously) so the input push below stays reachable before the first
    // await — the AL6 sync-poll contract. Persistence is deferred past the push.
    const isSteerOrInterrupt = frame.t === "steer" || frame.t === "interrupt";
    let controlDirty = false;
    if (isSteerOrInterrupt) {
      // Lazily release an implicit window that has lapsed (synchronous decision;
      // the resume marker fans immediately).
      const c = this.control;
      if (c && c.mode === "implicit" && c.expiresMs !== undefined && c.expiresMs <= this.now()) {
        this.control = undefined;
        this.emitControl("control_returned", { principal: c.principal, reason: "expired" });
        controlDirty = true;
      }
      const human = isHumanPrincipal(principal);
      const heldByHuman = !!this.control && isHumanPrincipal(this.control.principal);
      if (!human && heldByHuman) {
        // A dispatcher steer/interrupt while a human holds control is REFUSED
        // at the door — no sealed input event, the honest ack goes back.
        if (controlDirty) await this.persistMeta();
        return ackFrame(ref, false, ATTACH_ACK_REASONS.controlHeld);
      }
      if (human) {
        // A human steer implies control for a sliding window; further human
        // input refreshes it. An explicit hold by the same human is left
        // untouched (no expiry, no downgrade).
        if (this.control && this.control.principal === principal) {
          if (this.control.mode === "implicit") {
            this.control.expiresMs = this.now() + IMPLICIT_CONTROL_WINDOW_MS;
            controlDirty = true;
          }
        } else {
          this.control = { principal, mode: "implicit", expiresMs: this.now() + IMPLICIT_CONTROL_WINDOW_MS };
          this.emitControl("control_taken", { principal, mode: "implicit" });
          controlDirty = true;
        }
      }
    }

    // Stamp the edge-authenticated principal into the frame envelope so the
    // body logs it (the relay is the trust boundary; a head never self-declares).
    const stamped: AttachFrame = { ...frame };
    stamped.payload = { ...(frame.payload ?? {}), principal };
    this.inputSeq++;
    const q: QueuedInput = { seq: this.inputSeq, frame: stamped };
    this.inputs.push(q);
    await this.storage.put(INPUT_PREFIX + padSeq(q.seq), q);
    if (controlDirty) await this.persistMeta();
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
    // Release control on terminal (SV5) — a sealed resume marker before the bye.
    if (this.control) {
      const principal = this.control.principal;
      this.control = undefined;
      this.emitControl("control_returned", { principal, reason: "terminal" });
    }
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

  // ── Takeover / control (SV5) ───────────────────────────────

  /** The current hold as the contracts ControlState, expiring it lazily first.
   * Undefined when unheld. */
  async getControl(): Promise<ControlState | undefined> {
    await this.expireControlIfDue();
    if (!this.control) return undefined;
    return {
      principal: this.control.principal,
      mode: this.control.mode,
      ...(this.control.expiresMs !== undefined
        ? { expiresAt: new Date(this.control.expiresMs).toISOString() }
        : {}),
    };
  }

  /** Take control explicitly (a human pressed Take control). Held until Return,
   * a terminal state, or a new explicit take — no expiry. Sealed. */
  async takeControl(principal: string): Promise<void> {
    if (this.closed) return;
    this.control = { principal, mode: "explicit" };
    this.emitControl("control_taken", { principal, mode: "explicit" });
    await this.persistMeta();
  }

  /** Return control (a human pressed Return control). Only the holder may
   * return it; a no-op otherwise. Sealed with a resume marker. */
  async returnControl(principal: string): Promise<void> {
    if (!this.control || this.control.principal !== principal) return;
    this.control = undefined;
    this.emitControl("control_returned", { principal, reason: "returned" });
    await this.persistMeta();
  }

  /** Lazy expiry of an implicit window (evaluated on the next frame). Releases
   * with a sealed resume marker so a dispatcher steer after silence proceeds. */
  private async expireControlIfDue(): Promise<void> {
    const c = this.control;
    if (c && c.mode === "implicit" && c.expiresMs !== undefined && c.expiresMs <= this.now()) {
      const principal = c.principal;
      this.control = undefined;
      this.emitControl("control_returned", { principal, reason: "expired" });
      await this.persistMeta();
    }
  }

  /** Emit a control transition: fan it to heads as an event frame (synchronous).
   * Relay-authored + presence-adjacent — NOT stored in the body's seq'd mirror
   * (no collision with runtime seqs); the held state survives eviction in meta
   * and re-synthesizes on attach. */
  private emitControl(kind: "control_taken" | "control_returned", payload: Record<string, unknown>): void {
    const at = new Date(this.now()).toISOString();
    this.fanOut(eventFrame(this.latestSeq < 0 ? 0 : this.latestSeq, kind, at, payload));
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
    await this.storage.put(META_KEY, {
      info: this.info,
      state: this.state,
      latestSeq: this.latestSeq,
      ...(this.control ? { control: this.control } : {}),
    });
  }
}
