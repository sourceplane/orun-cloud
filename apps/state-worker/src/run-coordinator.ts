// RunCoordinator Durable Object (BM2b — coordination-api.md §3). The durable,
// single-threaded shell around the pure deciders (@saas/contracts): it folds its
// append-only event log, calls the deciders for claim/heartbeat/complete/cancel,
// appends the resulting events, and runs the lease sweep on an alarm. One DO per
// run ⇒ in-memory serialization ⇒ exactly-one-winner claims with no shared-row
// contention. Postgres is fed asynchronously from this log (the projector); the
// DO is the authority for live coordination state.

import { DurableObject } from "cloudflare:workers";
import {
  COORDINATION_EVENT_TYPES as K,
  reduce,
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

interface InitBody {
  runId: string;
  plan: CoordinationPlan;
  planDigest: string;
  sourceHash: string;
  environment?: string | null;
  actor?: CoordinationActor;
}

export class RunCoordinator extends DurableObject {
  private async log(): Promise<CoordinationEvent[]> {
    return (await this.ctx.storage.get<CoordinationEvent[]>("log")) ?? [];
  }

  private async plan(): Promise<CoordinationPlan> {
    return (await this.ctx.storage.get<CoordinationPlan>("plan")) ?? { jobs: {} };
  }

  private async state(): Promise<RunFoldState> {
    return reduce(await this.log(), await this.plan());
  }

  /** Finalize append intents into events (assign seq/at/actor/key) and persist. */
  private async appendAll(
    intents: AppendIntent[],
    actor: CoordinationActor,
    runId: string,
  ): Promise<number> {
    if (intents.length === 0) return (await this.ctx.storage.get<number>("seq")) ?? 0;
    const log = await this.log();
    let seq = (await this.ctx.storage.get<number>("seq")) ?? 0;
    const now = new Date().toISOString();
    for (const intent of intents) {
      seq += 1;
      const jobId = "jobId" in intent ? intent.jobId : undefined;
      log.push({
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
    await this.ctx.storage.put("log", log);
    await this.ctx.storage.put("seq", seq);
    return seq;
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
      const events = (await this.log()).filter((e) => e.seq > from);
      return json({ events });
    }
    return new Response("not found", { status: 404 });
  }

  private async init(body: InitBody): Promise<Response> {
    const existing = await this.ctx.storage.get<string>("planDigest");
    if (existing !== undefined) {
      if (existing !== body.planDigest) return json({ error: "run_exists_different_plan" }, 409);
      return json({ runId: body.runId, head: { seq: (await this.ctx.storage.get<number>("seq")) ?? 0 } });
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
    await this.ctx.storage.put("log", [created]);
    await this.ctx.storage.put("seq", seq);
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
      return json({ claimed: true, leaseEpoch: job.leaseEpoch, leaseExpiresAt: job.leaseExpiresAt, leaseSeconds: DEFAULT_LEASE_SECONDS, heartbeatIntervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS });
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
    if (!d.ok) return json({ claimed: false, reason: d.reason });
    await this.appendAll(d.appends, body.actor ?? SYSTEM_ACTOR, runId);
    await this.ensureAlarm();
    if (d.cached) return json({ claimed: false, cached: true, resultDigest: body.memoResultDigest });
    const after = (await this.state()).jobs[body.jobId]!;
    return json({ claimed: true, leaseEpoch: after.leaseEpoch, leaseExpiresAt: after.leaseExpiresAt, attempt: after.attempt, leaseSeconds: DEFAULT_LEASE_SECONDS, heartbeatIntervalSeconds: DEFAULT_HEARTBEAT_INTERVAL_SECONDS });
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
    reason?: string;
    errorText?: string;
    actor?: CoordinationActor;
  }): Promise<Response> {
    const state = await this.state();
    const job = state.jobs[body.jobId];
    // Idempotent: a job already in the requested terminal state is a no-op.
    if (job && (job.phase === "succeeded" || job.phase === "memoized" || job.phase === "failed" || job.phase === "timed_out")) {
      return json({ ok: true });
    }
    const d = decideComplete(state, {
      jobId: body.jobId,
      runnerId: body.runnerId,
      leaseEpoch: body.leaseEpoch,
      outcome: body.outcome,
      ...(body.resultDigest !== undefined ? { resultDigest: body.resultDigest } : {}),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.errorText !== undefined ? { errorText: body.errorText } : {}),
    });
    if (!d.ok) return json({ error: d.reason }, d.reason === "lease_lost" ? 409 : 400);
    await this.appendAll(d.appends, body.actor ?? SYSTEM_ACTOR, state.runId);
    return json({ ok: true });
  }

  private async cancel(body: { actor?: CoordinationActor }): Promise<Response> {
    const state = await this.state();
    const d = decideCancel(state);
    if (!d.ok) return json({ error: d.reason }, 409);
    await this.appendAll(d.appends, body.actor ?? SYSTEM_ACTOR, state.runId);
    return json({ ok: true });
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
