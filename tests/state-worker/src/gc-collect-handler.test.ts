// OV9 — the object GC reclamation endpoint (the deleting path). Verifies the
// layered safety: the env master switch forces dry-run when off, an enabled
// env + explicit dryRun:false actually deletes, policy denial resource-hides,
// validation rejects bad input, and the POST route is reachable.

import { handleCollectStateGc } from "@state-worker/handlers/gc-collect";
import { route } from "@state-worker/router";
import type { Env } from "@state-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const ORG_PUBLIC = `org_${ORG.replace(/-/g, "")}`;
const PROJECT_PUBLIC = `prj_${PROJECT.replace(/-/g, "")}`;
const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

function membershipFetcher(): Fetcher {
  return {
    fetch: (input: RequestInfo | URL) =>
      String(input).includes("authorization-context")
        ? Promise.resolve(
            Response.json({
              data: { memberships: [{ kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_PUBLIC } }] },
            }),
          )
        : Promise.resolve(new Response(null, { status: 404 })),
    connect() {
      throw new Error("ni");
    },
  } as unknown as Fetcher;
}
function policyFetcher(allow: boolean): Fetcher {
  return { fetch: () => Promise.resolve(Response.json({ data: { allow } })), connect() { throw new Error("ni"); } } as unknown as Fetcher;
}
function createEnv(opts?: { allow?: boolean; enabled?: boolean }): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: {},
    MEMBERSHIP_WORKER: membershipFetcher(),
    POLICY_WORKER: policyFetcher(opts?.allow ?? true),
    ...(opts?.enabled ? { STATE_GC_COLLECT_ENABLED: "true" } : {}),
  } as unknown as Env;
}

const ROOT = `sha256:${"a".repeat(64)}`;
const ORPHAN = `sha256:${"d".repeat(64)}`;
const OLD = "2020-01-01T00:00:00.000Z";

function gcExecutor(dbDeletes: string[]): SqlExecutor {
  return {
    execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      if (text.includes("UNION")) return Promise.resolve({ rows: [{ digest: ROOT }] as unknown as T[], rowCount: 1 });
      if (text.includes("DELETE FROM state.objects")) {
        dbDeletes.push(String(params?.[2]));
        return Promise.resolve({ rows: [] as T[], rowCount: 1 });
      }
      if (text.includes("FROM state.objects")) {
        const rows = [
          { digest: ROOT, size_bytes: 100, created_at: OLD },
          { digest: ORPHAN, size_bytes: 4096, created_at: OLD },
        ];
        return Promise.resolve({ rows: rows as unknown as T[], rowCount: rows.length });
      }
      // events / audit append → succeed quietly
      return Promise.resolve({ rows: [] as T[], rowCount: 0 });
    },
  } as unknown as SqlExecutor;
}
// ROOT is a leaf blob → ORPHAN is unreachable.
const enc = new TextEncoder();
const frame = (kind: string, body: string) => {
  const b = enc.encode(body);
  const head = enc.encode(`${kind} ${b.length}`);
  const out = new Uint8Array(head.length + 1 + b.length);
  out.set(head, 0);
  out[head.length] = 0;
  out.set(b, head.length + 1);
  return out;
};
const fetcher = (digest: string) => Promise.resolve(digest === ROOT ? frame("blob", "root") : null);

function req(body: unknown): Request {
  return new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/projects/${PROJECT_PUBLIC}/state/gc/collect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST …/state/gc/collect (OV9)", () => {
  it("forces dry-run when the env master switch is off, even with dryRun:false", async () => {
    const r2: string[] = [];
    const db: string[] = [];
    const res = await handleCollectStateGc(req({ dryRun: false }), createEnv({ enabled: false }), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), {
      executor: gcExecutor(db),
      fetcher,
      deleter: (d) => {
        r2.push(d);
        return Promise.resolve();
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: { dryRun: boolean; candidateObjects: number; deletedObjects: number } } };
    expect(body.data.result.dryRun).toBe(true);
    expect(body.data.result.candidateObjects).toBe(1);
    expect(body.data.result.deletedObjects).toBe(0);
    expect(r2).toEqual([]);
    expect(db).toEqual([]);
  });

  it("with the env switch on AND dryRun:false, reclaims the unreachable orphan", async () => {
    const r2: string[] = [];
    const db: string[] = [];
    const res = await handleCollectStateGc(req({ dryRun: false }), createEnv({ enabled: true }), "req_2", ACTOR, asUuid(ORG), asUuid(PROJECT), {
      executor: gcExecutor(db),
      fetcher,
      deleter: (d) => {
        r2.push(d);
        return Promise.resolve();
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: { dryRun: boolean; deletedObjects: number; deletedBytes: number } } };
    expect(body.data.result.dryRun).toBe(false);
    expect(body.data.result.deletedObjects).toBe(1);
    expect(body.data.result.deletedBytes).toBe(4096);
    expect(r2).toEqual([ORPHAN]);
    expect(db).toEqual([ORPHAN]);
  });

  it("422 on a bad graceDays", async () => {
    const res = await handleCollectStateGc(req({ graceDays: -1 }), createEnv(), "req_3", ACTOR, asUuid(ORG), asUuid(PROJECT), {
      executor: gcExecutor([]),
      fetcher,
      deleter: () => Promise.resolve(),
    });
    expect(res.status).toBe(422);
  });

  it("404s (resource-hiding) when policy denies state.object.write", async () => {
    const res = await handleCollectStateGc(req({}), createEnv({ allow: false }), "req_4", ACTOR, asUuid(ORG), asUuid(PROJECT), {
      executor: gcExecutor([]),
      fetcher,
      deleter: () => Promise.resolve(),
    });
    expect(res.status).toBe(404);
  });
});

describe("route() — GC collect endpoint is reachable (POST)", () => {
  it("dispatches …/state/gc/collect to the handler, not Route-not-found", async () => {
    const request = new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/projects/${PROJECT_PUBLIC}/state/gc/collect`, {
      method: "POST",
      headers: { "x-actor-subject-id": ACTOR.subjectId, "x-actor-subject-type": ACTOR.subjectType },
      body: "{}",
    });
    // Policy denies → 404, proving the route reached the handler.
    const res = await route(request, createEnv({ allow: false }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? "").not.toContain("Route not found");
  });
});
