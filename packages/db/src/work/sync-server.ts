// The work-plane ordering authority (orun-work W1, design §7).
//
// WorkSyncServer is the pure model of the per-project Durable Object: it owns
// the authoritative projection + the ordered event log, assigns the total-order
// seq (via the W0 mutators), fans committed events out to subscribers, and
// replays from a cursor on (re)subscribe. The production Durable Object is a
// thin transport adapter over this logic — WebSocket sockets in place of the
// Subscriber callbacks — so the convergence guarantees proven here hold there
// (Q-2: no DO/WebSocket type leaks into the model).

import { WorkError, WorkProjection, type WorkEvent } from "./model.js";
import { dispatch, type Mutation, type ServerMessage, type Verdict } from "./sync.js";

export type Subscriber = (msg: ServerMessage) => void;

export class WorkSyncServer {
  private readonly state: WorkProjection;
  private readonly log: WorkEvent[] = [];
  /** seq → the `clientMutationId` that produced that event, so replay can
   *  re-attach origin to a reconnecting client (see `subscribe`). */
  private readonly origins = new Map<number, string>();
  private readonly subscribers = new Set<Subscriber>();

  constructor(project: string, prefix: string, mintId?: (p: string) => string) {
    this.state = new WorkProjection(project, prefix, mintId);
  }

  /** The seq of the last committed event (0 when empty). */
  get headSeq(): number {
    return this.log.length === 0 ? 0 : (this.log[this.log.length - 1]?.seq ?? 0);
  }

  /** Events with seq strictly greater than `seq`, in order — the replay tail. */
  eventsSince(seq: number): WorkEvent[] {
    return this.log.filter((e) => e.seq > seq);
  }

  /** Register a subscriber and immediately replay anything it is missing from
   *  its resume cursor. Returns an unsubscribe handle. */
  subscribe(sub: Subscriber, fromSeq = 0): () => void {
    this.subscribers.add(sub);
    const missing = this.eventsSince(fromSeq);
    if (missing.length > 0) {
      sub({
        type: "replay",
        events: missing.map((event) => {
          const clientMutationId = this.origins.get(event.seq);
          return clientMutationId === undefined
            ? { type: "event" as const, event }
            : { type: "event" as const, event, clientMutationId };
        }),
      });
    }
    return () => {
      this.subscribers.delete(sub);
    };
  }

  /** Apply a mutation authoritatively: commit it (assigning seq), broadcast the
   *  event to every subscriber, and return the verdict. A rejected mutation
   *  mutates nothing and returns a structured reject verdict. */
  submit(m: Mutation): Verdict {
    let event: WorkEvent;
    try {
      event = dispatch(this.state, m);
    } catch (err) {
      const code = err instanceof WorkError ? err.kind : "invalid_event";
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, clientMutationId: m.clientMutationId, reason, code };
    }
    this.log.push(event);
    this.origins.set(event.seq, m.clientMutationId);
    for (const sub of this.subscribers) {
      sub({ type: "event", event, clientMutationId: m.clientMutationId });
    }
    return { ok: true, clientMutationId: m.clientMutationId, seq: event.seq };
  }

  /** A stable snapshot for convergence assertions. */
  snapshot() {
    return this.state.projectionSnapshot();
  }
}
