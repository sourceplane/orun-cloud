// RunCoordinator Durable Object (BM2b — coordination-api.md §3). The durable,
// single-threaded shell around the pure deciders (@saas/contracts): it folds its
// append-only event log, calls the deciders for claim/heartbeat/complete/cancel,
// appends the resulting events, and runs the lease sweep on an alarm. One DO per
// run ⇒ in-memory serialization ⇒ exactly-one-winner claims with no shared-row
// contention. Postgres is fed asynchronously from this log (the projector); the
// DO is the authority for live coordination state.
//
// Storage layout (BM2 snapshotting): the log is append-only per-event keys
// `e:<paddedSeq>`, never a single rewritten array, so an append is O(events
// appended) writes instead of O(log). The fold is kept in memory (`fold`) and
// advanced incrementally with `reduceFrom`, so a verb never re-reads or re-folds
// the whole log. A periodic `snap` checkpoint bounds cold-start replay to the
// events since the last snapshot. Events are retained (the authoritative stream
// `GET /log?from=` serves), so this is checkpointing, not destructive compaction.

import { DurableObject } from "cloudflare:workers";
import {
  COORDINATION_EVENT_TYPES as K,
  reduce,
  reduceFrom,
  type CoordinationActor,
  type CoordinationEvent,
  type CoordinationPlan,
  type RunFoldState,
} from "@saas/contracts/coordination";
import {
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_LEASE_SECONDS,
  decideCancel,
  decideClaim,
  decideComplete,
  decideHeartbeat,
  sweepLeases,
  type AppendIntent,
} from "@saas/contracts/coordination-core";

const SYSTEM_ACTOR: CoordinationActor = { id: "system:coordinator", type: "system" };

// Events between fold checkpoints. A cold start replays at most this many events
// on top of the last snapshot before the DO is live again.
const SNAPSHOT_EVERY = 64;
const EVT_PREFIX = "e:";

/** A fold checkpoint: the run state through `throughSeq`. */
interface Snapshot {
  state: RunFoldState;
  throughSeq: number;
}

/** Zero-padded so storage.list key order matches seq order. */
function evtKey(seq: number): string {
  return EVT_PREFIX + String(seq).padStart(12, "0");
}

interface InitBody {
  runId: string;
  plan: CoordinationPlan;
  planDigest: string;
  sourceHash: string;
  environment?: string | null;
  actor?: CoordinationActor;
}

export class RunCoordinator extends DurableObject {
  // In-memory fold cache, primed on init or rebuilt from storage (snapshot +
  // tail) on the first access after a cold start. Single-threaded DO ⇒ no lock.
  private loaded = false;
  private fold!: RunFoldState;
  private planCache!: CoordinationPlan;
  private headSeq = 0;
  private snapAt = 0; // throughSeq of the last persisted snapshot

  /** Rebuild the in-memory fold from storage: snapshot + the events after it. */
  private async load(): Promise<void> {
    if (this.loaded) return;
    const plan = (await this.ctx.storage.get<CoordinationPlan>("plan")) ?? { jobs: {} };
    const snap = await this.ctx.storage.get<Snapshot>("snap");
    if (snap) {
      const tail = await this.readEventsAfter(snap.throughSeq);
      this.fold = reduceFrom(snap.state, tail, plan);
      this.snapAt = snap.throughSeq;
    } else {
      let events = await this.readEventsAfter(0);
      if (events.length === 0) {
        // Migrate a pre-snapshot DO that stored the whole log under "log".
        const legacy = await this.ctx.storage.get<CoordinationEvent[]>("log");
        if (legacy && legacy.length > 0) {
          await this.persistEvents(legacy);
          await this.ctx.storage.delete("log");
          events = legacy;
        }
      }
      this.fold = reduce(events, plan);
      this.snapAt = 0;
    }
    this.planCache = plan;
    this.headSeq = (await this.ctx.storage.get<number>("seq")) ?? this.fold.lastSeq;
    this.loaded = true;
  }

  /** Events with seq > `seq`, in ascending seq order. */
  private async readEventsAfter(seq: number): Promise<CoordinationEvent[]> {
    const map = await this.ctx.storage.list<CoordinationEvent>({
      prefix: EVT_PREFIX,
      start: evtKey(seq + 1),
    });
    return [...map.values()];
  }

  /** Append-only write of events under their per-seq keys (batched, O(events)). */
  private async persistEvents(events: CoordinationEvent[]): Promise<void> {
    for (let i = 0; i < events.length; i += 128) {
      const batch: Record<string, CoordinationEvent> = {};
      for (const e of events.slice(i, i + 128)) batch[evtKey(e.seq)] = e;
      await this.ctx.storage.put(batch);
    }
  }

  private async state(): Promise<RunFoldState> {
    await this.load();
    return this.fold;
  }

  private async plan(): Promise<CoordinationPlan> {
    await this.load();
    return this.planCache;
  }

  private async seqHead(): Promise<number> {
    await this.load();
    return this.headSeq;
  }

  /** Finalize append intents into events (assign seq/at/actor/key), persist the
   * new events, and advance the in-memory fold incrementally. */
  private async appendAll(
    intents: AppendIntent[],
    actor: CoordinationActor,
    runId: string,
  ): Promise<number> {
    await this.load();
    if (intents.length === 0) return this.headSeq;
    const now = new Date().toISOString();
    const events: CoordinationEvent[] = [];
    let seq = this.headSeq;
    for (const intent of intents) {
      seq += 1;
      const jobId = "jobId" in intent ? intent.jobId : undefined;
      events.push({
        seq,
        kind: intent.kind,
        runId,
        jobId,
        actor,
        at: now,
        idempotencyKey: `${jobId ?? runId}:${intent.kind}:${seq}`,
        v: 1,
        payload: intent.payload,
      } as CoordinationEvent);
    }
    await this.persistEvents(events);
    await this.ctx.storage.put("seq", seq);
    this.headSeq = seq;
    this.fold = reduceFrom(this.fold, events, this.planCache);
    await this.maybeSnapshot();
    return seq;
  }

  /** Checkpoint the fold every SNAPSHOT_EVERY events and at a terminal phase, so
   * cold-start replay stays bounded. */
  private async maybeSnapshot(): Promise<void> {
    const s = this.fold;
    const terminal = s.phase === "succeeded" || s.phase === "failed" || s.phase === "canceled";
    if (s.lastSeq - this.snapAt >= SNAPSHOT_EVERY || (terminal && s.lastSeq > this.snapAt)) {
      await this.ctx.storage.put("snap", { state: s, throughSeq: s.lastSeq } satisfies Snapshot);
      this.snapAt = s.lastSeq;
    }
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + DEFAULT_LEASE_SECONDS * 1000);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/init") return this.init(await request.json());
    if (request.method === "POST" && path === "/claim") return this.claim(await request.json());
    if (request.method === "POST" && path === "/heartbeat") return this.heartbeat(await request.json());
    if (request.method === "POST" && path === "/complete") return this.complete(await request.json());
    if (request.method === "POST" && path === "/cancel") return this.cancel(await request.json());
    if (request.method === "GET" && path === "/state") return json(await this.state());
    if (request.method === "GET" && path === "/log") {
      const from = Number(url.searchParams.get("from") ?? "0");
      const events = await this.readEventsAfter(Number.isFinite(from) ? from : 0);
      return json({ events });
    }
    return new Response("not found", { status: 404 });
  }

  private async init(body: InitBody): Promise<Response> {
    const existing = await this.ctx.storage.get<string>("planDigest");
    if (existing !== undefined) {
      if (existing !== body.planDigest) return json({ error: "run_exists_different_plan" }, 409);
      return json({ runId: body.runId, head: { seq: await this.seqHead() } });
    }
    await this.ctx.storage.put("plan", body.plan);
    await this.ctx.storage.put("planDigest", body.planDigest);
    // RunCreated is a run-level event (not an AppendIntent); append it directly.
    const seq = 1;
    const created: CoordinationEvent = {
      seq,
      kind: K.RUN_CREATED,
      runId: body.runId,
      actor: body.actor ?? SYSTEM_ACTOR,
      at: new Date().toISOString(),
      idempotencyKey: body.runId,
      v: 1,
      payload: { planDigest: body.planDigest, sourceHash: body.sourceHash, environment: body.environment ?? null },
    };
    await this.persistEvents([created]);
    await this.ctx.storage.put("seq", seq);
    // Prime the in-memory cache directly — no storage re-read needed.
    this.planCache = body.plan;
    this.fold = reduce([created], body.plan);
    this.headSeq = seq;
    this.snapAt = 0;
    this.loaded = true;
    await this.ensureAlarm();
    return json({ runId: body.runId, head: { seq } });
  }

  private async claim(body: {
    jobId: string;
    runnerId: string;
    hermetic?: boolean;
    memoResultDigest?: string | null;
    actor?: CoordinationActor;
  }): Promise<Response> {
    const state = await this.state();
    const runId = state.runId;
    const job = state.jobs[body.jobId];
    // Idempotent re-claim by the current holder with a live lease.
    if (job && job.phase === "claimed" && job.holder === body.runnerId) {
      return json({ claimed: true, leaseEpoch: job.leaseEpoch, leaseExpiresAt: job.leaseExpiresAt, seq: await this.seqHead(), leaseSeconds: DEFAULT_LEASE_SECONDS, heartbeatIntervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS });
    }
    const d = decideClaim(
      state,
      await this.plan(),
      {
        jobId: body.jobId,
        runnerId: body.runnerId,
        ...(body.hermetic !== undefined ? { hermetic: body.hermetic } : {}),
        ...(body.memoResultDigest != null ? { memoResultDigest: body.memoResultDigest } : {}),
      },
      new Date().toISOString(),
    );
    // §3 claim reject reasons are deps_not_ready | job_held | run_terminal.
    if (!d.ok) return json({ claimed: false, reason: d.reason === "terminal" ? "run_terminal" : d.reason });
    await this.appendAll(d.appends, body.actor ?? SYSTEM_ACTOR, runId);
    await this.ensureAlarm();
    if (d.cached) return json({ claimed: false, cached: true, result: { digest: body.memoResultDigest } });
    const after = (await this.state()).jobs[body.jobId]!;
    return json({ claimed: true, leaseEpoch: after.leaseEpoch, leaseExpiresAt: after.leaseExpiresAt, seq: await this.seqHead(), attempt: after.attempt, leaseSeconds: DEFAULT_LEASE_SECONDS, heartbeatIntervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS });
  }

  private async heartbeat(body: { jobId: string; runnerId: string; leaseEpoch: number; actor?: CoordinationActor }): Promise<Response> {
    const state = await this.state();
    const d = decideHeartbeat(state, { jobId: body.jobId, runnerId: body.runnerId, leaseEpoch: body.leaseEpoch }, new Date().toISOString());
    if (!d.ok) return json({ error: d.reason }, d.reason === "lease_lost" ? 409 : 400);
    await this.appendAll(d.appends, body.actor ?? SYSTEM_ACTOR, state.runId);
    const after = (await this.state()).jobs[body.jobId]!;
    return json({ leaseExpiresAt: after.leaseExpiresAt, leaseSeconds: DEFAULT_LEASE_SECONDS, heartbeatIntervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS });
  }

  private async complete(body: {
    jobId: string;
    runnerId: string;
    leaseEpoch: number;
    outcome: "succeeded" | "failed";
    resultDigest?: string;
    logsDigest?: string;
    reason?: string;
    errorText?: string;
    actor?: CoordinationActor;
  }): Promise<Response> {
    const state = await this.state();
    const job = state.jobs[body.jobId];
    // Idempotent: a job already in the requested terminal state is a no-op.
    if (job && (job.phase === "succeeded" || job.phase === "memoized" || job.phase === "failed" || job.phase === "timed_out")) {
      return json({ seq: await this.seqHead() });
    }
    const d = decideComplete(state, {
      jobId: body.jobId,
      runnerId: body.runnerId,
      leaseEpoch: body.leaseEpoch,
      outcome: body.outcome,
      ...(body.resultDigest !== undefined ? { resultDigest: body.resultDigest } : {}),
      ...(body.logsDigest !== undefined ? { logsDigest: body.logsDigest } : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.errorText !== undefined ? { errorText: body.errorText } : {}),
    });
    if (!d.ok) return json({ error: d.reason }, d.reason === "lease_lost" ? 409 : 400);
    await this.appendAll(d.appends, body.actor ?? SYSTEM_ACTOR, state.runId);
    return json({ seq: await this.seqHead() });
  }

  private async cancel(body: { actor?: CoordinationActor }): Promise<Response> {
    const state = await this.state();
    const d = decideCancel(state);
    if (!d.ok) return json({ error: d.reason }, 409);
    await this.appendAll(d.appends, body.actor ?? SYSTEM_ACTOR, state.runId);
    return json({ seq: await this.seqHead() });
  }

  // Lease sweep on the alarm — re-queues lapsed leases (attempt+1) or times them
  // out at the bound. Reschedules while the run has in-flight work.
  async alarm(): Promise<void> {
    const state = await this.state();
    const intents = sweepLeases(state, new Date().toISOString());
    if (intents.length > 0) await this.appendAll(intents, { id: "system:state-sweep", type: "system" }, state.runId);
    const next = await this.state();
    const active = Object.values(next.jobs).some((j) => j.phase === "claimed" || j.phase === "queued");
    if (active && next.phase !== "canceled") {
      await this.ctx.storage.setAlarm(Date.now() + DEFAULT_LEASE_SECONDS * 1000);
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
