// The reference work-plane sync client (orun-work W1, design §7).
//
// This is the contract the SaaS console's store implements: a normalized view
// that applies mutations optimistically, retires them when the authoritative
// event arrives, rebases the remaining optimistic mutations onto each new
// confirmed base, rolls back rejected mutations (surfacing the verdict), and
// replays gaps from a seq cursor after a dropped connection — losing nothing.
//
// It holds the confirmed event log (not a folded projection) so that "rebase"
// is just "reduce(confirmed) then re-apply pending" — the W0 reducer is the one
// source of truth for state, on both client and server.

import { WorkError, WorkProjection, type WorkEvent } from "./model.js";
import { dispatch, type Mutation, type ServerMessage, type Verdict } from "./sync.js";

export class WorkSyncClient {
  private readonly project: string;
  private readonly prefix: string;
  private readonly mintId?: ((p: string) => string) | undefined;

  /** Authoritative events applied in order, contiguous up to `lastSeq`. */
  private readonly confirmed: WorkEvent[] = [];
  /** Optimistic mutations awaiting confirmation, in submission order. */
  private pending: Mutation[] = [];
  /** Out-of-order events held until the gap before them is filled. */
  private readonly hold = new Map<number, ServerMessage & { type: "event" }>();

  /** The highest contiguous seq the client has confirmed. */
  lastSeq = 0;
  /** Reject verdicts surfaced to the UI since last cleared. */
  readonly rejections: Verdict[] = [];

  constructor(project: string, prefix: string, mintId?: (p: string) => string) {
    this.project = project;
    this.prefix = prefix;
    this.mintId = mintId;
  }

  /** The confirmed-only state (no optimistic overlay). */
  confirmedState(): WorkProjection {
    return WorkProjection.reduce(this.project, this.prefix, this.confirmed, this.mintId);
  }

  /** The displayed state: confirmed with the pending mutations rebased on top.
   *  A pending mutation invalidated by newly-confirmed state (e.g. its target
   *  was created with a different key) simply drops out of the view until its
   *  own verdict arrives. */
  view(): WorkProjection {
    const v = WorkProjection.reduce(this.project, this.prefix, this.confirmed, this.mintId);
    for (const m of this.pending) {
      try {
        dispatch(v, m);
      } catch (err) {
        // An optimistic op that no longer applies against the rebased base (its
        // target was created with a different key, already gone, etc.) is a
        // WorkError — omit it until its own verdict arrives. Anything else is a
        // real bug that must surface, not hide as a missing card.
        if (err instanceof WorkError) continue;
        throw err;
      }
    }
    return v;
  }

  /** Record an optimistic mutation. The caller sends the same Mutation to the
   *  server over the transport; the client shows its effect immediately via
   *  view(). */
  mutate(m: Mutation): void {
    this.pending.push(m);
  }

  /** True when a gap is known to exist (events are held above lastSeq+1) — the
   *  signal to request a replay from `lastSeq`. */
  hasGap(): boolean {
    for (const seq of this.hold.keys()) {
      if (seq > this.lastSeq + 1) return true;
    }
    return false;
  }

  /** Feed a server message in. Order-tolerant: out-of-order events are held and
   *  drained once the gap fills; duplicates (seq <= lastSeq) are ignored. */
  receive(msg: ServerMessage): void {
    switch (msg.type) {
      case "replay":
        for (const e of msg.events) this.ingest(e);
        return;
      case "event":
        this.ingest(msg);
        return;
      case "verdict":
        if (!msg.verdict.ok) {
          this.retire(msg.verdict.clientMutationId);
          this.rejections.push(msg.verdict);
        }
        // An accept is informational: the authoritative event (carrying the
        // clientMutationId) is what retires the optimistic copy.
        return;
    }
  }

  private ingest(msg: ServerMessage & { type: "event" }): void {
    const seq = msg.event.seq;
    if (seq <= this.lastSeq) return; // duplicate
    if (seq > this.lastSeq + 1) {
      this.hold.set(seq, msg); // gap — hold until filled
      return;
    }
    this.apply(msg);
    this.drain();
  }

  private apply(msg: ServerMessage & { type: "event" }): void {
    this.confirmed.push(msg.event);
    this.lastSeq = msg.event.seq;
    if (msg.clientMutationId) this.retire(msg.clientMutationId);
  }

  private drain(): void {
    for (;;) {
      const next = this.hold.get(this.lastSeq + 1);
      if (!next) return;
      this.hold.delete(next.event.seq);
      this.apply(next);
    }
  }

  private retire(clientMutationId: string): void {
    this.pending = this.pending.filter((p) => p.clientMutationId !== clientMutationId);
  }

  /** A stable snapshot of the confirmed state for convergence assertions. */
  snapshot() {
    return this.confirmedState().projectionSnapshot();
  }
}
