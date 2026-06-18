// OV9 — the org state-plane storage endpoint. Verifies the STOCK aggregates are
// projected to the public response shape, a policy denial resource-hides as 404,
// and the org-scoped route is reachable at the top level (no project segment, so
// it must NOT live under the `/state/`-gated project plane).

import { handleGetOrgStateStorage } from "@state-worker/handlers/state-usage";
import { route } from "@state-worker/router";
import type { Env } from "@state-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_PUBLIC = `org_${ORG.replace(/-/g, "")}`;
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
function createEnv(allow = true): Env {
  return { ENVIRONMENT: "test", PLATFORM_DB: {}, MEMBERSHIP_WORKER: membershipFetcher(), POLICY_WORKER: policyFetcher(allow) } as unknown as Env;
}

function storageExecutor(): SqlExecutor {
  return {
    execute<T extends SqlRow = SqlRow>(text: string): Promise<SqlExecutorResult<T>> {
      const row = text.includes("FROM state.objects")
        ? { count: "150", bytes: "1048576" }
        : text.includes("FROM state.log_chunks")
          ? { count: "8", bytes: "4096" }
          : {};
      return Promise.resolve({ rows: [row] as unknown as T[], rowCount: 1 });
    },
  } as unknown as SqlExecutor;
}

function req(): Request {
  return new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/state/usage`);
}

describe("GET /v1/organizations/{orgId}/state/usage (OV9)", () => {
  it("returns the org's current object + log storage footprint", async () => {
    const res = await handleGetOrgStateStorage(req(), createEnv(), "req_1", ACTOR, asUuid(ORG), { executor: storageExecutor() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { usage: { objects: { count: number; bytes: number }; logs: { count: number; bytes: number } } } };
    expect(body.data.usage.objects).toEqual({ count: 150, bytes: 1048576 });
    expect(body.data.usage.logs).toEqual({ count: 8, bytes: 4096 });
  });

  it("404s (resource-hiding) when policy denies", async () => {
    const res = await handleGetOrgStateStorage(req(), createEnv(false), "req_2", ACTOR, asUuid(ORG), { executor: storageExecutor() });
    expect(res.status).toBe(404);
  });
});

describe("route() — org state-usage endpoint is reachable", () => {
  it("dispatches /v1/organizations/{org}/state/usage to the handler, not Route-not-found", async () => {
    const request = new Request(`https://state.test/v1/organizations/${ORG_PUBLIC}/state/usage`, {
      headers: { "x-actor-subject-id": ACTOR.subjectId, "x-actor-subject-type": ACTOR.subjectType },
    });
    // Policy denies → 404 ("Not found"), which still PROVES the route reached the
    // handler (vs the router's "Route not found: <path>" fall-through).
    const res = await route(request, createEnv(false));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? "").not.toContain("Route not found");
  });
});
