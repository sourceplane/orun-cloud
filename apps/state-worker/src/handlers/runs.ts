// Run coordination plane (OP2 — state-api-contract §2). This is the
// concurrency-critical heart of the platform: create (idempotent by client
// ULID), get, list, claim (a single atomic conditional UPDATE), heartbeat,
// update (idempotent, terminal-sticky, lease-checked), list jobs, the runnable
// frontier, and cancel. The lease sweep that re-queues lapsed claims lives in
// ../sweep.ts and is driven by the scheduled handler.
//
// Every route: enforces Orun-Contract-Version, deny-by-default policy
// (state.run.read on reads, state.run.write on mutations), and scopes by
// (org, project) so cross-tenant access 404s (resource-hiding), never 403s.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type {
  ClaimJobResponse,
  CreateRunResponse,
  GetRunResponse,
  HeartbeatJobResponse,
  ListJobsResponse,
  ListRunsResponse,
  Run as PublicRun,
  RunJob as PublicRunJob,
  RunnableJobsResponse,
  CancelRunResponse,
  CreateRunRequest,
} from "@saas/contracts/state";
import { STATE_EVENT_TYPES, STATE_POLICY_ACTIONS } from "@saas/contracts/state";
import {
  createStateRepository,
  type Run,
  type RunJob,
  type RunJobCounts,
  type RunStatus,
} from "@saas/db/state";
import { createEventsRepository } from "@saas/db/events";
import { createMeteringRepository } from "@saas/db/metering";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { emitUsage, STATE_METRICS } from "../metering.js";
import { asUuid, type Uuid } from "@saas/db/ids";
import { errorResponse, listResponse, successResponse, validationError } from "../http.js";
import { generateUuid, isRunUlid } from "../ids.js";
import { authorizeRun } from "../authz.js";
import {
  DEFAULT_PAGE_LIMIT,
  HEARTBEAT_INTERVAL_SECONDS,
  LEASE_SECONDS,
  MAX_PAGE_LIMIT,
} from "../constants.js";
import { ensureEnvironmentRegistered } from "../env-registration.js";
import { orgPublicId, projectPublicId } from "../ids.js";
import {
  coordinatorCancelOP2,
  coordinatorClaimOP2,
  coordinatorCompleteOP2,
  coordinatorHeartbeatOP2,
  initCoordinator,
  projectorReady,
  planFromJobs,
  projectAfterVerb,
  runIsDoBacked,
  useDoCoordination,
} from "../coordination-route.js";

export interface RunHandlerDeps {
  executor?: SqlExecutor;
}

const VALID_SOURCES = new Set(["cli", "ci"]);

// ── Projections (internal row → safe contract shape) ────────

function actorRef(run: Run | RunJob | { createdBy?: { id: string | null; kind: string | null } }): {
  id: string;
  kind: PublicRun["createdBy"]["kind"];
} {
  const cb = (run as Run).createdBy ?? { id: null, kind: null };
  const kind = cb.kind;
  const safeKind: PublicRun["createdBy"]["kind"] =
    kind === "user" || kind === "service_principal" || kind === "workflow" || kind === "system"
      ? kind
      : "system";
  return { id: cb.id ?? "", kind: safeKind };
}

function toPublicRun(run: Run, counts: RunJobCounts): PublicRun {
  return {
    runId: run.runUlid,
    orgId: orgPublicId(run.orgId),
    projectId: projectPublicId(run.projectId),
    environment: run.environment,
    status: run.status,
    planDigest: run.planDigest,
    source: run.source,
    git: {
      commit: run.gitCommit ?? "",
      ref: run.gitRef ?? "",
      dirty: run.gitDirty,
    },
    createdBy: actorRef(run),
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    jobCounts: counts,
  };
}

function toPublicJob(job: RunJob): PublicRunJob {
  return {
    runId: job.runId,
    jobId: job.jobId,
    orgId: orgPublicId(job.orgId),
    projectId: projectPublicId(job.projectId),
    component: job.component,
    deps: job.deps,
    status: job.status,
    runnerId: job.runnerId,
    leaseExpiresAt: job.leaseExpiresAt ? job.leaseExpiresAt.toISOString() : null,
    attempt: job.attempt,
    errorText: job.errorText,
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
  };
}

function actorKindOf(subjectType: string): "user" | "service_principal" | "workflow" | "system" {
  switch (subjectType) {
    case "user":
    case "service_principal":
    case "workflow":
    case "system":
      return subjectType;
    default:
      return "system";
  }
}

async function dispose(executor: SqlExecutor): Promise<void> {
  if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

function isTerminalRun(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

// ── Plan DAG parsing (from the create body's plan jobs) ─────
// The CLI supplies the plan DAG in the create body so the platform can persist
// run_jobs (the plan blob itself lives in the object plane). Each job: a stable
// id, optional component, and deps[]. Absent/empty → a zero-job run (valid).

interface PlanJobInput {
  jobId: string;
  component: string | null;
  deps: string[];
}

function parsePlanJobs(body: Record<string, unknown>): PlanJobInput[] | null {
  const raw = body.jobs ?? (body.plan as Record<string, unknown> | undefined)?.jobs;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const jobs: PlanJobInput[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    const jobId = typeof e.jobId === "string" ? e.jobId : typeof e.id === "string" ? e.id : null;
    if (!jobId || jobId.length === 0 || jobId.length > 256 || seen.has(jobId)) return null;
    seen.add(jobId);
    let deps: string[] = [];
    if (e.deps !== undefined && e.deps !== null) {
      if (!Array.isArray(e.deps) || !e.deps.every((d) => typeof d === "string")) return null;
      deps = e.deps as string[];
    }
    const component = typeof e.component === "string" ? e.component : null;
    jobs.push({ jobId, component, deps });
  }
  return jobs;
}

// ── POST …/state/runs — create (idempotent by client ULID) ──

export async function handleCreateRun(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: RunHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.RUN_WRITE);
  if (!authz.ok) return authz.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  const fields: Record<string, string[]> = {};
  const runId = typeof body.runId === "string" ? body.runId : "";
  if (!runId || !isRunUlid(runId)) fields.runId = ["Required; must be a client-minted ULID (26-char Crockford base32)"];
  const planDigest = typeof body.planDigest === "string" ? body.planDigest : "";
  if (!planDigest || !/^sha256:[0-9a-f]{64}$/.test(planDigest)) {
    fields.planDigest = ["Required; must be 'sha256:<64 hex>'"];
  }
  const source = typeof body.source === "string" ? body.source : "";
  if (!source || !VALID_SOURCES.has(source)) fields.source = ["Required; one of 'cli' | 'ci'"];

  let environment: string | null = null;
  if (body.environment !== undefined && body.environment !== null) {
    if (typeof body.environment !== "string") fields.environment = ["Must be a string when present"];
    else environment = body.environment;
  }

  let labels: Record<string, string> = {};
  if (body.labels !== undefined && body.labels !== null) {
    if (typeof body.labels !== "object" || Array.isArray(body.labels)) {
      fields.labels = ["Must be a string→string map"];
    } else {
      const ok = Object.values(body.labels as Record<string, unknown>).every((v) => typeof v === "string");
      if (!ok) fields.labels = ["All label values must be strings"];
      else labels = body.labels as Record<string, string>;
    }
  }

  const git = (body.git ?? {}) as Record<string, unknown>;
  const gitCommit = typeof git.commit === "string" ? git.commit : null;
  const gitRef = typeof git.ref === "string" ? git.ref : null;
  const gitDirty = git.dirty === true;

  const planJobs = parsePlanJobs(body);
  if (planJobs === null) fields.jobs = ["Must be an array of { jobId, deps?, component? } with unique ids"];

  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);

    // ── Replay short-circuit: a known ULID returns the existing run (200). ──
    const existing = await repo.getRunByUlid(orgId, projectId, runId as string);
    if (existing.ok) {
      const counts = await repo.getRunJobCounts(orgId, projectId, asUuid(existing.value.id));
      const payload: CreateRunResponse = {
        run: toPublicRun(existing.value, counts.ok ? counts.value : zeroCounts()),
      };
      return successResponse(payload, requestId, 200);
    }

    // ── Over-quota gate (OV9, OFF by default). Block a new run ONLY when a HARD
    //    state.runs quota is configured AND exceeded; a soft quota or no quota
    //    passes (the metering-worker records the soft-violation trail). Fail-OPEN
    //    on any error — a quota-check failure must never block a run. Replays
    //    short-circuited above are never gated. ──
    try {
      const quota = await createMeteringRepository(executor).checkQuota(orgPublicId(orgId), STATE_METRICS.RUNS);
      if (quota.ok && !quota.value.allowed && quota.value.enforcement === "hard") {
        return errorResponse(
          "precondition_failed",
          `Run quota reached (${quota.value.used}/${quota.value.limit} per ${quota.value.period}). Upgrade your plan to start more runs.`,
          412,
          requestId,
          {
            reason: "quota_exceeded",
            metric: STATE_METRICS.RUNS,
            limit: quota.value.limit,
            used: quota.value.used,
            period: quota.value.period,
          },
        );
      }
    } catch {
      // Fail-open: never block a run on a quota-check failure.
    }

    // ── Plan-digest existence in the object plane → else 412 object_missing.
    //    (OP3 lands objects; runs created before OP3 will 412 — expected.) ──
    const planObject = await repo.getObject(orgId, projectId, planDigest);
    if (!planObject.ok) {
      return errorResponse(
        "object_missing",
        `Plan object ${planDigest} not found in the object plane`,
        412,
        requestId,
        { digest: planDigest },
      );
    }

    // ── Register + touch the environment on use (OP4/OV9 seam; best-effort).
    //    Bumps last_active_at so an actively-run environment is never archived
    //    by the OV9 stale-archival sweep. ──
    if (environment && env.PROJECTS_WORKER) {
      await ensureEnvironmentRegistered(
        env.PROJECTS_WORKER,
        orgId,
        projectId,
        environment,
        requestId,
      );
    }

    // ── Create the run (idempotent on the ULID unique index). ──
    const runRowId = generateUuid();
    const created = await repo.createRun({
      id: runRowId,
      orgId,
      projectId,
      runUlid: runId as string,
      planDigest,
      source: source as CreateRunRequest["source"],
      environment,
      gitCommit,
      gitRef,
      gitDirty,
      labels,
      createdBy: { id: actor.subjectId, kind: actorKindOf(actor.subjectType) },
    });
    if (!created.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    if (!created.value.created) {
      // Lost the create race to a concurrent replay — return the existing run.
      const counts = await repo.getRunJobCounts(orgId, projectId, asUuid(created.value.run.id));
      const payload: CreateRunResponse = {
        run: toPublicRun(created.value.run, counts.ok ? counts.value : zeroCounts()),
      };
      return successResponse(payload, requestId, 200);
    }

    const run = created.value.run;

    // ── Meter the run (best-effort; feeds the state.runs usage + quota gate).
    //    Idempotent on the ULID, so a replayed create never double-counts. ──
    await emitUsage({
      executor,
      orgPublicId: orgPublicId(orgId),
      projectPublicId: projectPublicId(projectId),
      metric: STATE_METRICS.RUNS,
      quantity: 1,
      idempotencySeed: run.runUlid,
    });

    // ── Persist the plan DAG as run_jobs. ──
    if (planJobs && planJobs.length > 0) {
      for (const j of planJobs) {
        const jobResult = await repo.createRunJob({
          id: generateUuid(),
          orgId,
          projectId,
          runId: asUuid(run.id),
          jobId: j.jobId,
          component: j.component,
          deps: j.deps,
        });
        // A duplicate (run, jobId) is the only conflict; ignore (idempotent).
        if (!jobResult.ok && jobResult.error.kind !== "conflict") {
          return errorResponse("internal_error", "Service unavailable", 503, requestId);
        }
      }
    }

    // ── DO backend (BM4b): initialize the per-run coordination shard with the
    //    plan DAG (idempotent RunCreated). Required on the DO path — claims fail
    //    if the shard was never seeded. The Postgres rows above remain the read
    //    model; the projector reconciles them from the DO log. ──
    if (useDoCoordination(env)) {
      // Fail-closed cutover gate: only seed a DO shard if the projector can keep
      // the read model in sync (migration 350 → state.runs.last_seq applied).
      // Otherwise this run would write to the DO while its read model froze at
      // creation — the silent split-brain. Skip seeding so the run stays on the
      // fully-functional OP2 relational path, and log loudly so the missing
      // migration gets fixed.
      if (await projectorReady(executor)) {
        const initRes = await initCoordinator(env, run.runUlid, {
          plan: planFromJobs(planJobs ?? []),
          planDigest,
          sourceHash: gitCommit ?? planDigest,
          environment,
          actor: { id: actor.subjectId, type: actor.subjectType },
        });
        if (initRes.status >= 300) {
          return errorResponse("internal_error", "Coordinator init failed", 503, requestId);
        }
      } else {
        console.error(
          `[coordination] run ${run.runUlid}: COORDINATION_BACKEND=do but projector not ready ` +
            `(state.runs.last_seq missing — apply migration 350); shard not seeded, run stays on OP2`,
        );
      }
    }

    // ── Emit state.run.created (best-effort audit; never fails the create). ──
    try {
      const events = createEventsRepository(executor);
      await events.appendEventWithAudit({
        event: {
          id: generateUuid(),
          type: STATE_EVENT_TYPES.RUN_CREATED,
          version: 1,
          source: "state-worker",
          occurredAt: new Date(),
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          projectId,
          subjectKind: "run",
          subjectId: run.id,
          subjectName: run.runUlid,
          requestId,
          payload: {
            version: 1,
            runId: run.runUlid,
            orgId: orgPublicId(orgId),
            projectId: projectPublicId(projectId),
            environment: run.environment,
            planDigest: run.planDigest,
            source: run.source,
            jobCount: planJobs ? planJobs.length : 0,
          },
        },
        audit: {
          id: generateUuid(),
          category: "runs",
          description: `Created run ${run.runUlid}`,
          projectId,
        },
      });
    } catch {
      // Best-effort audit.
    }

    const counts = await repo.getRunJobCounts(orgId, projectId, asUuid(run.id));
    const payload: CreateRunResponse = {
      run: toPublicRun(run, counts.ok ? counts.value : zeroCounts()),
    };
    return successResponse(payload, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

function zeroCounts(): RunJobCounts {
  return { queued: 0, running: 0, succeeded: 0, failed: 0 };
}

// ── GET …/state/runs/{runId} (LoadRunState) ─────────────────

export async function handleGetRun(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  deps?: RunHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.RUN_READ);
  if (!authz.ok) return authz.response;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const run = await repo.getRunByUlid(orgId, projectId, runUlid);
    if (!run.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const counts = await repo.getRunJobCounts(orgId, projectId, asUuid(run.value.id));
    const payload: GetRunResponse = {
      run: toPublicRun(run.value, counts.ok ? counts.value : zeroCounts()),
    };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── GET …/state/runs?environment=&status=&cursor= (list) ────

export async function handleListRuns(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  deps?: RunHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.RUN_READ);
  if (!authz.ok) return authz.response;

  const url = new URL(request.url);
  const environment = url.searchParams.get("environment") ?? undefined;
  const statusParam = url.searchParams.get("status") ?? undefined;
  const cursorParam = url.searchParams.get("cursor");

  const validStatuses = new Set(["pending", "running", "succeeded", "failed", "canceled"]);
  if (statusParam && !validStatuses.has(statusParam)) {
    return validationError(requestId, { status: ["Invalid run status"] });
  }
  let cursor: { createdAt: string; id: string } | null = null;
  if (cursorParam) {
    const idx = cursorParam.indexOf("|");
    if (idx <= 0) return validationError(requestId, { cursor: ["Malformed cursor"] });
    cursor = { createdAt: cursorParam.slice(0, idx), id: cursorParam.slice(idx + 1) };
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const query: { environment?: string; status?: RunStatus } = {};
    if (environment) query.environment = environment;
    if (statusParam) query.status = statusParam as RunStatus;
    const result = await repo.listRuns(
      orgId,
      projectId,
      { limit: DEFAULT_PAGE_LIMIT, cursor },
      query,
    );
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const runs: PublicRun[] = [];
    for (const run of result.value.items) {
      const counts = await repo.getRunJobCounts(orgId, projectId, asUuid(run.id));
      runs.push(toPublicRun(run, counts.ok ? counts.value : zeroCounts()));
    }
    const nextCursor = result.value.nextCursor
      ? { createdAt: result.value.nextCursor.createdAt, id: result.value.nextCursor.id }
      : null;
    const payload: ListRunsResponse = { runs, nextCursor };
    const cursorStr = nextCursor ? `${nextCursor.createdAt}|${nextCursor.id}` : null;
    return listResponse(payload, requestId, cursorStr);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── GET …/state/runs/{runId}/jobs (list jobs) ───────────────

export async function handleListJobs(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  deps?: RunHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.RUN_READ);
  if (!authz.ok) return authz.response;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const run = await repo.getRunByUlid(orgId, projectId, runUlid);
    if (!run.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const jobs = await repo.listRunJobs(orgId, projectId, asUuid(run.value.id));
    if (!jobs.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const payload: ListJobsResponse = { jobs: jobs.value.map(toPublicJob) };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── GET …/state/runs/{runId}/runnable (the frontier) ────────

export async function handleRunnableJobs(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  deps?: RunHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.RUN_READ);
  if (!authz.ok) return authz.response;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const run = await repo.getRunByUlid(orgId, projectId, runUlid);
    if (!run.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const jobs = await repo.listRunnableJobs(orgId, projectId, asUuid(run.value.id));
    if (!jobs.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const payload: RunnableJobsResponse = { jobs: jobs.value.map(toPublicJob) };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── POST …/runs/{runId}/jobs/{jobId}/claim ──────────────────

export async function handleClaimJob(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  jobId: string,
  deps?: RunHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.RUN_WRITE);
  if (!authz.ok) return authz.response;

  // DO backend (BM6 facade): :claim over the DO, OP2 { claim: … } envelope.
  // Routes here iff this run is DO-backed (sticky per run), so flipping the flag
  // never breaks an in-flight OP2 run.
  if (useDoCoordination(env) && (await runIsDoBacked(env, runUlid))) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const runnerId = typeof body.runnerId === "string" ? body.runnerId : "";
    if (!runnerId) return validationError(requestId, { runnerId: ["Required; non-empty string"] });
    const out = await coordinatorClaimOP2(env, runUlid, jobId, runnerId, { id: actor.subjectId, type: actor.subjectType });
    await projectAfterVerb(env, deps, { orgId, projectId }, runUlid);
    if (out.kind === "error") return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const payload: ClaimJobResponse =
      out.kind === "claimed"
        ? {
            claim: {
              claimed: true,
              leaseExpiresAt: out.leaseExpiresAt,
              attempt: out.attempt,
              leaseSeconds: LEASE_SECONDS,
              heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
            },
          }
        : { claim: { claimed: false, reason: out.reason } };
    return successResponse(payload, requestId);
  }

  const runnerId = await readRunnerId(request);
  if (!runnerId) return validationError(requestId, { runnerId: ["Required; non-empty string"] });

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const run = await repo.getRunByUlid(orgId, projectId, runUlid);
    if (!run.ok) return errorResponse("not_found", "Not found", 404, requestId);
    if (isTerminalRun(run.value.status)) {
      // A claim against a terminal run can never win; report it as terminal.
      const payload: ClaimJobResponse = { claim: { claimed: false, reason: "terminal" } };
      return successResponse(payload, requestId);
    }

    const outcome = await repo.claimRunJob({
      orgId,
      projectId,
      runId: asUuid(run.value.id),
      jobId,
      runnerId,
      leaseSeconds: LEASE_SECONDS,
    });
    if (!outcome.ok) {
      if (outcome.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    if (outcome.value.claimed) {
      const job = outcome.value.job;
      // First claim flips the run pending→running; reconcile (best-effort).
      if (run.value.status === "pending") {
        await repo.reconcileRunStatus(orgId, projectId, asUuid(run.value.id));
      }
      const payload: ClaimJobResponse = {
        claim: {
          claimed: true,
          leaseExpiresAt: job.leaseExpiresAt!.toISOString(),
          attempt: job.attempt,
          // Echo the lease + heartbeat tunables so the client never hardcodes.
          leaseSeconds: LEASE_SECONDS,
          heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
        },
      };
      return successResponse(payload, requestId);
    }

    const payload: ClaimJobResponse = { claim: { claimed: false, reason: outcome.value.reason } };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── POST …/jobs/{jobId}/heartbeat ───────────────────────────

export async function handleHeartbeatJob(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  jobId: string,
  deps?: RunHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.RUN_WRITE);
  if (!authz.ok) return authz.response;

  // DO backend (BM6 facade): :heartbeat over the DO, OP2 envelope. leaseEpoch is
  // derived from the shard (OP2 has none); a takeover surfaces as the OP2 409.
  if (useDoCoordination(env) && (await runIsDoBacked(env, runUlid))) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const runnerId = typeof body.runnerId === "string" ? body.runnerId : "";
    if (!runnerId) return validationError(requestId, { runnerId: ["Required; non-empty string"] });
    const out = await coordinatorHeartbeatOP2(env, runUlid, jobId, runnerId, { id: actor.subjectId, type: actor.subjectType });
    // No per-heartbeat projection (DB-protection at scale): a heartbeat only
    // renews the DO-owned lease, so a DO fold + Postgres upsert on every beat —
    // ~1000 concurrent jobs each beating periodically — would dominate DB load
    // for no correctness gain. The projection sweep reconciles `leaseExpiresAt`
    // for non-terminal runs; lifecycle verbs still project immediately.
    if (out.kind === "lease_lost") {
      return errorResponse("lease_lost", "Lease lapsed or was reassigned; stop work on this job", 409, requestId);
    }
    if (out.kind === "error") return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const payload: HeartbeatJobResponse = {
      leaseExpiresAt: out.leaseExpiresAt ?? "",
      leaseSeconds: LEASE_SECONDS,
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
    };
    return successResponse(payload, requestId);
  }

  const runnerId = await readRunnerId(request);
  if (!runnerId) return validationError(requestId, { runnerId: ["Required; non-empty string"] });

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const run = await repo.getRunByUlid(orgId, projectId, runUlid);
    if (!run.ok) return errorResponse("not_found", "Not found", 404, requestId);

    const outcome = await repo.heartbeatRunJob({
      orgId,
      projectId,
      runId: asUuid(run.value.id),
      jobId,
      runnerId,
      leaseSeconds: LEASE_SECONDS,
    });
    if (!outcome.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    if (!outcome.value.ok) {
      return errorResponse(
        "lease_lost",
        "Lease lapsed or was reassigned; stop work on this job",
        409,
        requestId,
      );
    }
    const payload: HeartbeatJobResponse = {
      leaseExpiresAt: outcome.value.job.leaseExpiresAt!.toISOString(),
      leaseSeconds: LEASE_SECONDS,
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
    };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── POST …/jobs/{jobId}/update ──────────────────────────────

export async function handleUpdateJob(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  jobId: string,
  deps?: RunHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.RUN_WRITE);
  if (!authz.ok) return authz.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const runnerId = typeof body.runnerId === "string" && body.runnerId.length > 0 ? body.runnerId : null;
  const status = body.status;
  const errorText = typeof body.errorText === "string" ? body.errorText : null;
  const fields: Record<string, string[]> = {};
  if (!runnerId) fields.runnerId = ["Required; non-empty string"];
  if (status !== "succeeded" && status !== "failed") {
    fields.status = ["Required; one of 'succeeded' | 'failed'"];
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  // DO backend (BM6 facade): :update over the DO, OP2 envelope. Terminal-sticky
  // (idempotent re-complete) and lease-checked; an empty body matches OP2.
  if (useDoCoordination(env) && (await runIsDoBacked(env, runUlid))) {
    const out = await coordinatorCompleteOP2(env, runUlid, jobId, runnerId!, status as "succeeded" | "failed", errorText, { id: actor.subjectId, type: actor.subjectType });
    await projectAfterVerb(env, deps, { orgId, projectId }, runUlid);
    if (out.kind === "lease_lost") {
      return errorResponse("lease_lost", "Lease lapsed or was reassigned; this update is rejected", 409, requestId);
    }
    if (out.kind === "error") return errorResponse("internal_error", "Service unavailable", 503, requestId);
    return successResponse({}, requestId);
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const run = await repo.getRunByUlid(orgId, projectId, runUlid);
    if (!run.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const runRowId = asUuid(run.value.id);

    const outcome = await repo.updateRunJob({
      orgId,
      projectId,
      runId: runRowId,
      jobId,
      runnerId: runnerId!,
      status: status as "succeeded" | "failed",
      errorText,
    });
    if (!outcome.ok) {
      if (outcome.error.kind === "not_found") return errorResponse("not_found", "Not found", 404, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    if (!outcome.value.ok) {
      return errorResponse(
        "lease_lost",
        "Lease lapsed or was reassigned; this update is rejected",
        409,
        requestId,
      );
    }

    // ── On a real (non-replayed) transition, emit job.failed + reconcile the
    //    run, emitting run.completed|failed once when it goes terminal. ──
    if (!outcome.value.replayed) {
      if (status === "failed") {
        await emitJobFailed(executor, requestId, actor, orgId, projectId, run.value, outcome.value.job.jobId, errorText);
      }
      const reconciled = await repo.reconcileRunStatus(orgId, projectId, runRowId);
      if (reconciled.ok && reconciled.value.transitioned) {
        await emitRunLifecycle(
          executor,
          requestId,
          actor,
          orgId,
          projectId,
          reconciled.value.run,
          reconciled.value.transitioned,
        );
      }
    }

    return successResponse({}, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── POST …/state/runs/{runId}/cancel ────────────────────────

export async function handleCancelRun(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  deps?: RunHandlerDeps,
): Promise<Response> {
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.RUN_WRITE);
  if (!authz.ok) return authz.response;

  // DO backend (BM6 facade): cancel the shard, project, return the run (OP2 shape).
  if (useDoCoordination(env) && (await runIsDoBacked(env, runUlid))) {
    const ok = await coordinatorCancelOP2(env, runUlid, { id: actor.subjectId, type: actor.subjectType });
    if (!ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    await projectAfterVerb(env, deps, { orgId, projectId }, runUlid);
    const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
    const owned = !deps?.executor;
    try {
      const repo = createStateRepository(executor);
      const run = await repo.getRunByUlid(orgId, projectId, runUlid);
      if (!run.ok) return errorResponse("not_found", "Not found", 404, requestId);
      const counts = await repo.getRunJobCounts(orgId, projectId, asUuid(run.value.id));
      const payload: CancelRunResponse = { run: toPublicRun(run.value, counts.ok ? counts.value : zeroCounts()) };
      return successResponse(payload, requestId);
    } finally {
      if (owned) await dispose(executor);
    }
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const repo = createStateRepository(executor);
    const run = await repo.getRunByUlid(orgId, projectId, runUlid);
    if (!run.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const wasTerminal = isTerminalRun(run.value.status);

    const canceled = await repo.cancelRun(orgId, projectId, asUuid(run.value.id));
    if (!canceled.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    if (!wasTerminal && canceled.value.status === "canceled") {
      // Canceling a non-terminal run is a failed-class lifecycle end.
      await emitRunLifecycle(executor, requestId, actor, orgId, projectId, canceled.value, "canceled");
    }

    const counts = await repo.getRunJobCounts(orgId, projectId, asUuid(canceled.value.id));
    const payload: CancelRunResponse = {
      run: toPublicRun(canceled.value, counts.ok ? counts.value : zeroCounts()),
    };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned) await dispose(executor);
  }
}

// ── Helpers ─────────────────────────────────────────────────

async function readRunnerId(request: Request): Promise<string | null> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  return typeof body.runnerId === "string" && body.runnerId.length > 0 ? body.runnerId : null;
}

async function emitJobFailed(
  executor: SqlExecutor,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  run: Run,
  jobId: string,
  errorText: string | null,
): Promise<void> {
  try {
    const events = createEventsRepository(executor);
    await events.appendEvent({
      id: generateUuid(),
      type: STATE_EVENT_TYPES.JOB_FAILED,
      version: 1,
      source: "state-worker",
      occurredAt: new Date(),
      actorType: actor.subjectType,
      actorId: actor.subjectId,
      orgId,
      projectId,
      subjectKind: "run_job",
      subjectId: `${run.id}:${jobId}`,
      subjectName: jobId,
      requestId,
      payload: {
        version: 1,
        runId: run.runUlid,
        jobId,
        orgId: orgPublicId(orgId),
        projectId: projectPublicId(projectId),
        errorText: errorText ?? null,
      },
    });
  } catch {
    // Best-effort.
  }
}

/** Emit run.completed (succeeded) or run.failed (failed|canceled|timed-out). */
export async function emitRunLifecycle(
  executor: SqlExecutor,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  run: Run,
  terminal: RunStatus,
): Promise<void> {
  const type =
    terminal === "succeeded" ? STATE_EVENT_TYPES.RUN_COMPLETED : STATE_EVENT_TYPES.RUN_FAILED;
  try {
    const events = createEventsRepository(executor);
    await events.appendEventWithAudit({
      event: {
        id: generateUuid(),
        type,
        version: 1,
        source: "state-worker",
        occurredAt: new Date(),
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId,
        subjectKind: "run",
        subjectId: run.id,
        subjectName: run.runUlid,
        requestId,
        payload: {
          version: 1,
          runId: run.runUlid,
          orgId: orgPublicId(orgId),
          projectId: projectPublicId(projectId),
          status: terminal,
        },
      },
      audit: {
        id: generateUuid(),
        category: "runs",
        description: `Run ${run.runUlid} ${terminal}`,
        projectId,
      },
    });
  } catch {
    // Best-effort.
  }
}

export { MAX_PAGE_LIMIT };
