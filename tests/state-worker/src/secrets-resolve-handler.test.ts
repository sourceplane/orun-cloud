// POST …/state/runs/{runId}/secrets/resolve (saas-secret-manager SM3). The
// keystone: bearer authz AND a live lease before any value flows. Invariants:
// a lease miss ⇒ 409 lease_lost with NO downstream config/decrypt call; a live
// lease ⇒ the verified actor + server-derived facts are forwarded verbatim.

import { handleResolveRunSecrets, platformFromActorKind } from "@state-worker/handlers/secrets-resolve";
import type { Env } from "@state-worker/env";
import type { ActorContext } from "@state-worker/router";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import type { InternalResolveSecretsRequest } from "@state-worker/config-client";
import { asUuid } from "@saas/db";

const ORG = asUuid("11111111-1111-4111-8111-111111111111");
const PRJ = asUuid("22222222-2222-4222-8222-222222222222");
const RUN = "01J0000000000000000000ABCD";

// A workflow actor bound to (org, project) passes authorizeRun without a
// membership round-trip (OIDC bound scope IS the authorization).
const ACTOR: ActorContext = { subjectId: "wf_1", subjectType: "workflow", boundOrgId: ORG, boundProjectId: PRJ };

const RUN_ROW = {
  id: "33333333-3333-4333-8333-333333333333",
  org_id: ORG,
  project_id: PRJ,
  environment: "prod",
  run_ulid: RUN,
  plan_digest: "sha256:" + "a".repeat(64),
  source: "ci",
  status: "running",
  git_commit: "abc",
  git_ref: "refs/heads/main",
  git_dirty: false,
  labels: {},
  created_by: "wf_1",
  created_by_kind: "workflow",
  started_at: null,
  finished_at: null,
  created_at: "2026-07-02T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
};

function runExecutor(): SqlExecutor {
  return {
    async execute<T extends SqlRow = SqlRow>(): Promise<SqlExecutorResult<T>> {
      return { rows: [RUN_ROW] as unknown as T[], rowCount: 1 };
    },
  };
}

const ENV = {} as Env;

function body(over: Record<string, unknown> = {}) {
  return {
    runnerId: "host-a",
    jobId: "deploy",
    leaseEpoch: 3,
    refs: [`secret://org_${ORG.replace(/-/g, "")}/prj_${PRJ.replace(/-/g, "")}/prod/DATABASE_URL`],
    ...over,
  };
}

function request(b: unknown): Request {
  return new Request(`http://state-worker/v1/organizations/x/projects/y/state/runs/${RUN}/secrets/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });
}

describe("platformFromActorKind (server-derived)", () => {
  it("maps workflow→ci-oidc, user→local-cli, else→service", () => {
    expect(platformFromActorKind("workflow")).toBe("ci-oidc");
    expect(platformFromActorKind("user")).toBe("local-cli");
    expect(platformFromActorKind("service_principal")).toBe("service");
  });
});

describe("lease gate", () => {
  it("returns 409 lease_lost and NEVER calls config-worker when the lease is not live", async () => {
    let configCalled = false;
    const res = await handleResolveRunSecrets(request(body()), ENV, "req_1", ACTOR, ORG, PRJ, RUN, {
      executor: runExecutor(),
      verifyLease: async () => ({ live: false, reason: "lease_lost" }),
      resolveOrgSegment: async () => ORG,
      resolveProjectSlug: async () => PRJ,
      listEnvironments: async () => [{ id: "env-1", slug: "prod", name: "prod", status: "active" }],
      configResolve: async () => {
        configCalled = true;
        return new Response("{}", { status: 200 });
      },
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("lease_lost");
    expect(configCalled).toBe(false);
  });
});

describe("live lease → forwards to config-worker", () => {
  it("forwards the verified actor + server-derived facts and relays the resolve", async () => {
    let forwarded: InternalResolveSecretsRequest | null = null;
    const res = await handleResolveRunSecrets(request(body()), ENV, "req_2", ACTOR, ORG, PRJ, RUN, {
      executor: runExecutor(),
      verifyLease: async () => ({ live: true }),
      resolveOrgSegment: async () => ORG,
      resolveProjectSlug: async () => PRJ,
      listEnvironments: async () => [{ id: "env-1", slug: "prod", name: "prod", status: "active" }],
      configResolve: async (b) => {
        forwarded = b;
        return Response.json({ data: { secrets: { DATABASE_URL: "v" }, resolved: [{ key: "DATABASE_URL", version: 9, scope: "environment", personal: false, decisionId: "dec_1" }] } });
      },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { secrets: Record<string, string>; ttlSeconds: number } };
    expect(json.data.secrets.DATABASE_URL).toBe("v");
    expect(json.data.ttlSeconds).toBe(300);
    expect(forwarded).not.toBeNull();
    expect(forwarded!.environmentId).toBe("env-1");
    expect(forwarded!.environment).toBe("prod");
    expect(forwarded!.platform).toBe("ci-oidc"); // server-derived from workflow actor
    expect(forwarded!.trigger.branch).toBe("main"); // refs/heads/ stripped
    expect(forwarded!.trigger.declared).toBe(true); // source === "ci"
    expect(forwarded!.keys).toEqual([{ key: "DATABASE_URL" }]);
  });

  it("rejects a ref whose environment differs across the batch", async () => {
    const res = await handleResolveRunSecrets(
      request(body({ refs: [
        `secret://org_${ORG.replace(/-/g, "")}/prj_${PRJ.replace(/-/g, "")}/prod/A`,
        `secret://org_${ORG.replace(/-/g, "")}/prj_${PRJ.replace(/-/g, "")}/staging/B`,
      ] })),
      ENV, "req_3", ACTOR, ORG, PRJ, RUN,
      { executor: runExecutor(), verifyLease: async () => ({ live: true }) },
    );
    expect(res.status).toBe(422);
  });
});
