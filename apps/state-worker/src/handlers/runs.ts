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
  CreateRunResponse,
  GetRunResponse,
  ListJobsResponse,
  ListRunsResponse,
  Run as PublicRun,
  RunJob as PublicRunJob,
  RunnableJobsResponse,
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
import { authorizeRun, authorizeOrg } from "../authz.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_JOBS_PER_RUN,
  MAX_PAGE_LIMIT,
} from "../constants.js";
import { ensureEnvironmentRegistered } from "../env-registration.js";
import { orgPublicId, projectPublicId, parseProjectPublicId } from "../ids.js";
import {
  initCoordinator,
  projectorReady,
  planFromJobs,
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
  // Soft per-run cap (BM5): the coordination shard's storage scales with the
  // job count (event log, snapshots, in-memory fold). Reject runaway plans at
  // the edge before allocating any DO storage. The cap is generous enough to
  // accommodate real workflows; if a legitimate plan exceeds it, raise it in
  // `constants.ts` with the understanding that every shard pays proportionally.
  else if (planJobs.length > MAX_JOBS_PER_RUN) {
    fields.jobs = [`Plan exceeds the per-run cap of ${MAX_JOBS_PER_RUN} jobs (got ${planJobs.length}); split the run or contact support to raise the cap`];
  }

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

    // ── Fail-fast cutover guard. If this environment routes coordination to the
    //    DO but the projector can't sync it into Postgres (migration 350 →
    //    state.runs.last_seq missing), a created run could never be claimed — the
    //    native verbs have no non-DO fallback, so every :claim 404s and the runner
    //    hangs ~2 min — and its read model would freeze at creation. Refuse the
    //    run LOUDLY with a 503 (before writing any row) instead of returning a 201
    //    for a run that can never make progress. On a correctly-migrated env this
    //    is a single cached probe and never trips. ──
    if (useDoCoordination(env) && !(await projectorReady(executor))) {
      console.error(
        `[coordination] createRun ${runId}: COORDINATION_BACKEND=do but projector not ready ` +
          `(state.runs.last_seq missing — apply migration 350); refusing run with 503`,
      );
      return errorResponse("internal_error", "Coordination backend not ready", 503, requestId);
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
      // Projector-readiness is already asserted by the fail-fast guard above, so
      // seeding here is unconditional: a created run is ALWAYS shard-backed, which
      // is what makes the native claim path (its only claim surface) reachable.
      const seededPlan = planFromJobs(planJobs ?? []);
      const initRes = await initCoordinator(env, run.runUlid, {
        plan: seededPlan,
        planDigest,
        sourceHash: gitCommit ?? planDigest,
        environment,
        actor: { id: actor.subjectId, type: actor.subjectType },
      });
      if (initRes.status >= 300) {
        return errorResponse("internal_error", "Coordinator init failed", 503, requestId);
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

// ── GET /v1/organizations/{orgId}/state/runs?project=&environment=&status=&branch=&source=&cursor= ──
//
// The ORG-GLOBAL runs feed (the console "Activities" surface). Mirrors the
// org-global catalog browser: one merged feed across every project in the org,
// each row carrying its provenance (project, environment, git ref). `project`
// narrows to a single repo; the rest are facets. Org-scoped policy
// (state.run.read on the organization); no project segment in the path.

export async function handleListOrgRuns(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: RunHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, STATE_POLICY_ACTIONS.RUN_READ);
  if (!authz.ok) return authz.response;

  const url = new URL(request.url);
  const projectParam = url.searchParams.get("project") ?? undefined;
  const environment = url.searchParams.get("environment") ?? undefined;
  const statusParam = url.searchParams.get("status") ?? undefined;
  const branch = url.searchParams.get("branch") ?? undefined;
  const sourceParam = url.searchParams.get("source") ?? undefined;
  const cursorParam = url.searchParams.get("cursor");

  const validStatuses = new Set(["pending", "running", "succeeded", "failed", "canceled"]);
  if (statusParam && !validStatuses.has(statusParam)) {
    return validationError(requestId, { status: ["Invalid run status"] });
  }
  if (sourceParam && !VALID_SOURCES.has(sourceParam)) {
    return validationError(requestId, { source: ["Invalid run source"] });
  }
  // The `project` filter is an opaque public id (prj_…); a malformed one is a
  // validation error, an unknown-but-well-formed one simply matches no rows.
  let projectId: Uuid | undefined;
  if (projectParam) {
    const parsed = parseProjectPublicId(projectParam);
    if (!parsed) return validationError(requestId, { project: ["Invalid project id"] });
    projectId = parsed;
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
    const query: {
      projectId?: Uuid;
      environment?: string;
      status?: RunStatus;
      branch?: string;
      source?: "cli" | "ci";
    } = {};
    if (projectId) query.projectId = projectId;
    if (environment) query.environment = environment;
    if (statusParam) query.status = statusParam as RunStatus;
    if (branch) query.branch = branch;
    if (sourceParam) query.source = sourceParam as "cli" | "ci";
    const result = await repo.listOrgRuns(orgId, { limit: DEFAULT_PAGE_LIMIT, cursor }, query);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const runs: PublicRun[] = [];
    for (const run of result.value.items) {
      // Job counts are scoped per (org, project) — use the run's own project,
      // since this feed spans every repo in the org.
      const counts = await repo.getRunJobCounts(orgId, asUuid(run.projectId), asUuid(run.id));
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


export { MAX_PAGE_LIMIT };
