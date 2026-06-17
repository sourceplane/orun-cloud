// OV4 — the scm.* triggers read endpoint. Verifies the project-scoped activity
// feed projects rows to public ids and resource-hides on policy denial.

import { handleListTriggers } from "@state-worker/handlers/triggers";
import type { Env } from "@state-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "44444444-4444-4444-8444-444444444444";
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

function triggerRow(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "tr1",
    org_id: ORG,
    project_id: PROJECT,
    provider: "github",
    provider_repo_id: "777001",
    repo_full_name: "acme/platform",
    kind: "push",
    action: null,
    ref: "refs/heads/main",
    commit_sha: "aaa111",
    base_sha: null,
    pr_number: null,
    actor_login: "octocat",
    event_id: "evt_1",
    status: "recorded",
    occurred_at: "2026-06-17T10:00:00.000Z",
    created_at: "2026-06-17T10:00:00.000Z",
    ...over,
  };
}

function executor(rows: Record<string, unknown>[]): SqlExecutor {
  return {
    execute<T extends SqlRow = SqlRow>(text: string): Promise<SqlExecutorResult<T>> {
      const out = text.includes("FROM state.triggers") ? rows : [];
      return Promise.resolve({ rows: out as unknown as T[], rowCount: out.length });
    },
  } as unknown as SqlExecutor;
}

function req(): Request {
  return new Request("https://state.test/v1/organizations/x/projects/y/state/triggers");
}

describe("GET …/state/triggers (OV4)", () => {
  it("returns the project-scoped feed with public ids", async () => {
    const res = await handleListTriggers(req(), createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), {
      executor: executor([triggerRow(), triggerRow({ id: "tr2", kind: "pull_request", action: "opened", pr_number: 7, base_sha: "bbb222", event_id: "evt_2" })]),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { triggers: Array<{ orgId: string; projectId: string; kind: string; action: string | null }> } };
    expect(body.data.triggers).toHaveLength(2);
    expect(body.data.triggers[0]!.orgId).toBe(ORG_PUBLIC);
    expect(body.data.triggers[0]!.projectId).toContain("prj_");
    expect(body.data.triggers[1]!.kind).toBe("pull_request");
    expect(body.data.triggers[1]!.action).toBe("opened");
  });

  it("404s (resource-hiding) when policy denies", async () => {
    const res = await handleListTriggers(req(), createEnv(false), "req_2", ACTOR, asUuid(ORG), asUuid(PROJECT), {
      executor: executor([triggerRow()]),
    });
    expect(res.status).toBe(404);
  });
});
