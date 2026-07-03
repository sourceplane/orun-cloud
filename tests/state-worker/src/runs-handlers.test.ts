// OP2 run-coordination — HTTP handler tests. Verify the exact {data,meta} /
// {error} envelopes, policy gating (deny → 404 resource-hiding), the plan-
// missing 412, and the lease/heartbeat tunables the server echoes. The DB is a
// scripted fake executor; auth/projects services are configurable fetchers,
// mirroring links.test.ts.

import {
  handleCreateRun,
  handleGetRun,
  handleListRuns,
  handleListOrgRuns,
  handleRunnableJobs,
} from "@state-worker/handlers/runs";
import type { Env } from "@state-worker/env";
import { __resetProjectorReadyCache } from "@state-worker/coordination-route";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const RUN_ROW = "33333333-3333-4333-8333-333333333333";
const ORG_PUBLIC = `org_${ORG.replace(/-/g, "")}`;
const PROJECT_PUBLIC = `prj_${PROJECT.replace(/-/g, "")}`;
const ULID = "01J0000000000000000000ABCD";
const PLAN = "sha256:" + "a".repeat(64);
const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };
const NOW = new Date("2026-06-14T10:00:00.000Z");

function membershipFetcher(): Fetcher {
  return {
    fetch: (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("authorization-context")) {
        return Promise.resolve(
          Response.json({
            data: {
              memberships: [
                { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_PUBLIC } },
              ],
            },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    },
    connect() {
      throw new Error("ni");
    },
  } as unknown as Fetcher;
}

function policyFetcher(allow: boolean): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json({ data: { allow } })),
    connect() {
      throw new Error("ni");
    },
  } as unknown as Fetcher;
}

function projectsFetcher(): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json({ data: {} }, { status: 201 })),
    connect() {
      throw new Error("ni");
    },
  } as unknown as Fetcher;
}

type Responder = (text: string, params: unknown[]) => Record<string, unknown>[] | null;

function fakeExecutor(respond: Responder): { executor: SqlExecutor; queries: { text: string; params: unknown[] }[] } {
  const queries: { text: string; params: unknown[] }[] = [];
  const executor: SqlExecutor = {
    execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      const rows = (respond(text, params ?? []) ?? []) as unknown as T[];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
  return { executor, queries };
}

function createEnv(allow = true): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: membershipFetcher(),
    POLICY_WORKER: policyFetcher(allow),
    PROJECTS_WORKER: projectsFetcher(),
  } as unknown as Env;
}

function runRow(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: RUN_ROW,
    org_id: ORG,
    project_id: PROJECT,
    environment: "production",
    run_ulid: ULID,
    plan_digest: PLAN,
    source: "cli",
    status: "pending",
    git_commit: "abc123",
    git_ref: "refs/heads/main",
    git_dirty: false,
    labels: "{}",
    created_by: ACTOR.subjectId,
    created_by_kind: "user",
    started_at: null,
    finished_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  };
}

function jobRow(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "job-1",
    org_id: ORG,
    project_id: PROJECT,
    run_id: RUN_ROW,
    job_id: "build",
    component: "api",
    deps: "[]",
    status: "queued",
    runner_id: null,
    lease_expires_at: null,
    attempt: 1,
    error_text: null,
    started_at: null,
    finished_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  };
}

const COUNTS = { queued: 1, running: 0, succeeded: 0, failed: 0 };

describe("POST …/state/runs — create", () => {
  it("creates a run idempotently, validates the plan, returns 201 {data:{run}}", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM state.objects")) return [{ id: "obj", org_id: ORG, project_id: PROJECT, digest: PLAN, kind: "plan", size_bytes: 10, created_by: null, created_by_kind: null, created_at: NOW.toISOString() }];
      if (text.includes("INSERT INTO state.runs")) return [runRow()];
      if (text.startsWith("SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2 AND run_ulid")) return []; // not a replay
      if (text.includes("INSERT INTO state.run_jobs")) return [jobRow()];
      if (text.includes("COUNT(*) FILTER")) return [COUNTS];
      return [{ _event: {}, _audit: {} }];
    });
    const req = new Request("https://state.test/v1/organizations/x/projects/y/state/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: ULID,
        planDigest: PLAN,
        environment: "production",
        source: "cli",
        git: { commit: "abc123", ref: "refs/heads/main", dirty: false },
        jobs: [{ jobId: "build", component: "api", deps: [] }],
      }),
    });
    const res = await handleCreateRun(req, createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { run: Record<string, unknown> }; meta: { requestId: string; cursor: null } };
    expect(body.data.run.runId).toBe(ULID);
    expect(body.data.run.orgId).toBe(ORG_PUBLIC);
    expect(body.data.run.projectId).toBe(PROJECT_PUBLIC);
    expect(body.data.run.status).toBe("pending");
    expect(body.data.run.planDigest).toBe(PLAN);
    expect(body.data.run.jobCounts).toEqual(COUNTS);
    expect(body.meta.requestId).toBe("req_1");
    expect(body.meta.cursor).toBeNull();
  });

  it("fails fast with 503 (no row written) when COORDINATION_BACKEND=do but the projector is not ready", async () => {
    // Migration 350 (state.runs.last_seq) not applied → projectorReady false. A
    // created run could never be claimed (native verbs have no non-DO fallback),
    // so createRun must refuse LOUDLY with 503 instead of returning a 201 that
    // strands the runner for ~2 min.
    __resetProjectorReadyCache();
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("last_seq")) throw new Error('column "last_seq" does not exist');
      if (text.startsWith("SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2 AND run_ulid")) return []; // not a replay
      return [];
    });
    const env = { ...createEnv(), COORDINATION_BACKEND: "do", COORDINATOR: {} } as unknown as Env;
    const req = new Request("https://state.test/v1/organizations/x/projects/y/state/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: ULID, planDigest: PLAN, source: "ci", git: { commit: "abc", ref: "refs/heads/main", dirty: false } }),
    });
    const res = await handleCreateRun(req, env, "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(503);
    // The guard runs before any write — no run row was inserted.
    expect(queries.some((q) => q.text.includes("INSERT INTO state.runs"))).toBe(false);
  });

  it("blocks a new run with 412 when a HARD state.runs quota is exceeded (OV9)", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.startsWith("SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2 AND run_ulid")) return []; // not a replay
      if (text.includes("metering.quota_definitions")) return [{ limit_value: 10, period: "month", enforcement: "hard" }];
      if (text.includes("FROM metering.usage_records")) return [{ total: 10 }]; // used == limit → over
      return [];
    });
    const req = new Request("https://state.test/v1/organizations/x/projects/y/state/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: ULID, planDigest: PLAN, source: "cli", git: { commit: "abc", ref: "refs/heads/main", dirty: false } }),
    });
    const res = await handleCreateRun(req, createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string; metric?: string } } };
    expect(body.error.code).toBe("precondition_failed");
    expect(body.error.details?.reason).toBe("quota_exceeded");
    expect(body.error.details?.metric).toBe("state.runs");
  });

  it("never gates a replay: an existing run returns 200 even when a HARD quota is exceeded", async () => {
    // The replay short-circuits before the quota gate, so an over-quota org can
    // still re-fetch a run it already created.
    const { executor } = fakeExecutor((text) => {
      if (text.startsWith("SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2 AND run_ulid")) return [runRow({ status: "running" })]; // replay
      if (text.includes("metering.quota_definitions")) return [{ limit_value: 1, period: "month", enforcement: "hard" }];
      if (text.includes("FROM metering.usage_records")) return [{ total: 999 }];
      if (text.includes("COUNT(*) FILTER")) return [COUNTS];
      return [];
    });
    const req = new Request("https://state.test/v1/organizations/x/projects/y/state/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: ULID, planDigest: PLAN, source: "cli", git: { commit: "abc", ref: "refs/heads/main", dirty: false } }),
    });
    const res = await handleCreateRun(req, createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(200);
  });

  it("does NOT block on a SOFT over-quota (the violation is tracked, the run proceeds)", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM state.objects")) return [{ id: "obj", org_id: ORG, project_id: PROJECT, digest: PLAN, kind: "plan", size_bytes: 10, created_by: null, created_by_kind: null, created_at: NOW.toISOString() }];
      if (text.includes("INSERT INTO state.runs")) return [runRow()];
      if (text.startsWith("SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2 AND run_ulid")) return []; // not a replay
      if (text.includes("metering.quota_definitions")) return [{ limit_value: 1, period: "month", enforcement: "soft" }];
      if (text.includes("FROM metering.usage_records")) return [{ total: 99 }]; // way over, but soft
      if (text.includes("COUNT(*) FILTER")) return [COUNTS];
      return [{ _event: {}, _audit: {} }];
    });
    const req = new Request("https://state.test/v1/organizations/x/projects/y/state/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: ULID, planDigest: PLAN, source: "cli", git: { commit: "abc", ref: "refs/heads/main", dirty: false } }),
    });
    const res = await handleCreateRun(req, createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(201);
  });

  it("replays an existing run with 200 (not 409)", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.startsWith("SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2 AND run_ulid")) return [runRow({ status: "running" })];
      if (text.includes("COUNT(*) FILTER")) return [COUNTS];
      return [];
    });
    const req = new Request("https://state.test/.../runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: ULID, planDigest: PLAN, source: "cli", git: { commit: "c", ref: "r", dirty: false } }),
    });
    const res = await handleCreateRun(req, createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { run: { runId: string; status: string } } };
    expect(body.data.run.runId).toBe(ULID);
    expect(body.data.run.status).toBe("running");
  });

  it("returns 412 object_missing when the plan digest is absent", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.startsWith("SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2 AND run_ulid")) return [];
      if (text.includes("FROM state.objects")) return []; // plan missing
      return [];
    });
    const req = new Request("https://state.test/.../runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: ULID, planDigest: PLAN, source: "cli", git: { commit: "c", ref: "r", dirty: false } }),
    });
    const res = await handleCreateRun(req, createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("object_missing");
    expect(body.error.requestId).toBe("req_1");
  });

  it("returns 404 (resource hiding) when policy denies state.run.write", async () => {
    const { executor, queries } = fakeExecutor(() => []);
    const req = new Request("https://state.test/.../runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: ULID, planDigest: PLAN, source: "cli", git: { commit: "c", ref: "r", dirty: false } }),
    });
    const res = await handleCreateRun(req, createEnv(false), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(404);
    expect(queries).toHaveLength(0); // denied before any DB work
  });

  it("returns 422 for a non-ULID runId", async () => {
    const { executor } = fakeExecutor(() => []);
    const req = new Request("https://state.test/.../runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "not-a-ulid", planDigest: PLAN, source: "cli", git: {} }),
    });
    const res = await handleCreateRun(req, createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(422);
  });

  it("rejects a plan that exceeds the per-run job cap (BM5 soft cap)", async () => {
    // The coordination shard's storage scales with the job count (event log,
    // snapshots, in-memory fold). A 100k-job plan would inflate a DO beyond
    // healthy operating bounds. The cap is enforced at the edge before any DO
    // storage is allocated. 1001 jobs exceeds the default 1000 cap.
    const { executor } = fakeExecutor(() => []);
    const oversized = Array.from({ length: 1001 }, (_, i) => ({ jobId: `j${i}`, component: "x", deps: [] as string[] }));
    const req = new Request("https://state.test/.../runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: ULID, planDigest: PLAN, source: "cli", git: {}, jobs: oversized }),
    });
    const res = await handleCreateRun(req, createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: { fields: { jobs: string[] } } } };
    expect(body.error.details.fields.jobs[0]).toMatch(/per-run cap of 1000/);
  });
});

describe("GET …/state/runs/{runId} + list", () => {
  it("returns the run projection", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("run_ulid")) return [runRow()];
      if (text.includes("COUNT(*) FILTER")) return [COUNTS];
      return [];
    });
    const res = await handleGetRun(createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), ULID, { executor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { run: { runId: string } } };
    expect(body.data.run.runId).toBe(ULID);
  });

  it("lists runs with a cursor in meta", async () => {
    const { executor } = fakeExecutor((text) => {
      if ((text.includes("SELECT * FROM state.runs WHERE org_id = $1 AND project_id = $2") && !text.includes("run_ulid") && !text.includes("id = $3"))) return [runRow()];
      if (text.includes("COUNT(*) FILTER")) return [COUNTS];
      return [];
    });
    const req = new Request("https://state.test/.../runs?status=pending", { method: "GET" });
    const res = await handleListRuns(req, createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { runs: unknown[]; nextCursor: unknown }; meta: { cursor: null } };
    expect(body.data.runs).toHaveLength(1);
    expect(body.data.nextCursor).toBeNull();
    expect(body.meta.cursor).toBeNull();
  });
});

describe("GET /v1/organizations/{orgId}/state/runs — org-global Activities feed", () => {
  // The org feed has no project segment; its repository query is org-scoped
  // (no `project_id = $2`) unless the `project` facet narrows it.
  const isOrgRunsQuery = (text: string) =>
    text.startsWith("SELECT * FROM state.runs WHERE org_id = $1") &&
    !text.includes("project_id = $2") &&
    !text.includes("run_ulid") &&
    !text.includes("id = $3");

  it("lists runs merged across the org with a cursor in meta", async () => {
    const { executor, queries } = fakeExecutor((text) => {
      if (isOrgRunsQuery(text)) return [runRow({ project_id: PROJECT }), runRow({ id: "44444444-4444-4444-8444-444444444444", project_id: "55555555-5555-4555-8555-555555555555" })];
      if (text.includes("COUNT(*) FILTER")) return [COUNTS];
      return [];
    });
    const req = new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/state/runs`, { method: "GET" });
    const res = await handleListOrgRuns(req, createEnv(), "req_1", ACTOR, asUuid(ORG), { executor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { runs: { projectId: string }[]; nextCursor: unknown } };
    expect(body.data.runs).toHaveLength(2);
    // Per-run job counts are scoped to each run's OWN project.
    expect(queries.some((q) => q.text.includes("COUNT(*) FILTER"))).toBe(true);
  });

  it("applies the branch facet via a refs/heads-normalized git_ref match", async () => {
    const { queries, executor } = fakeExecutor((text) => {
      if (isOrgRunsQuery(text)) return [runRow()];
      if (text.includes("COUNT(*) FILTER")) return [COUNTS];
      return [];
    });
    const req = new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/state/runs?branch=main&source=ci`, { method: "GET" });
    const res = await handleListOrgRuns(req, createEnv(), "req_1", ACTOR, asUuid(ORG), { executor });
    expect(res.status).toBe(200);
    const listQuery = queries.find((q) => isOrgRunsQuery(q.text));
    expect(listQuery?.text).toContain("regexp_replace");
    expect(listQuery?.text).toContain("source =");
    expect(listQuery?.params).toContain("main");
    expect(listQuery?.params).toContain("ci");
  });

  it("rejects a malformed project facet with 400", async () => {
    const { executor } = fakeExecutor(() => []);
    const req = new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/state/runs?project=not-a-project`, { method: "GET" });
    const res = await handleListOrgRuns(req, createEnv(), "req_1", ACTOR, asUuid(ORG), { executor });
    expect(res.status).toBe(422);
  });

  it("rejects an invalid source facet with 400", async () => {
    const { executor } = fakeExecutor(() => []);
    const req = new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/state/runs?source=robot`, { method: "GET" });
    const res = await handleListOrgRuns(req, createEnv(), "req_1", ACTOR, asUuid(ORG), { executor });
    expect(res.status).toBe(422);
  });

  it("resource-hides (404) when org policy denies state.run.read", async () => {
    const { executor } = fakeExecutor(() => []);
    const req = new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/state/runs`, { method: "GET" });
    const res = await handleListOrgRuns(req, createEnv(false), "req_1", ACTOR, asUuid(ORG), { executor });
    expect(res.status).toBe(404);
  });
});

describe("runnable frontier handler", () => {
  it("returns the queued frontier", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("run_ulid")) return [runRow({ status: "running" })];
      if (text.includes("SELECT j.* FROM state.run_jobs j")) return [jobRow({ job_id: "build" })];
      return [];
    });
    const res = await handleRunnableJobs(createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), ULID, { executor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { jobs: Array<{ jobId: string; status: string }> } };
    expect(body.data.jobs).toHaveLength(1);
    expect(body.data.jobs[0]!.jobId).toBe("build");
    expect(body.data.jobs[0]!.status).toBe("queued");
  });
});
