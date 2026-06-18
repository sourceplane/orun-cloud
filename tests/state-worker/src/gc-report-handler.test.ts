// OV9 — the object GC report endpoint (report-only). Verifies the project-scoped
// read returns the computed report, resource-hides as 404 on policy denial, and
// is reachable through route() under the /state/ project plane. A synthetic
// store + executor stand in for R2/DB; nothing is deleted.

import { handleGetStateGcReport } from "@state-worker/handlers/gc-report";
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
function createEnv(allow = true): Env {
  return { ENVIRONMENT: "test", PLATFORM_DB: {}, MEMBERSHIP_WORKER: membershipFetcher(), POLICY_WORKER: policyFetcher(allow) } as unknown as Env;
}

const ROOT = `sha256:${"a".repeat(64)}`;
const ORPHAN = `sha256:${"d".repeat(64)}`;

function gcExecutor(): SqlExecutor {
  return {
    execute<T extends SqlRow = SqlRow>(text: string): Promise<SqlExecutorResult<T>> {
      if (text.includes("UNION")) return Promise.resolve({ rows: [{ digest: ROOT }] as unknown as T[], rowCount: 1 });
      if (text.includes("SELECT digest, size_bytes FROM state.objects")) {
        const rows = [
          { digest: ROOT, size_bytes: 100 },
          { digest: ORPHAN, size_bytes: 4096 },
        ];
        return Promise.resolve({ rows: rows as unknown as T[], rowCount: rows.length });
      }
      return Promise.resolve({ rows: [] as T[], rowCount: 0 });
    },
  } as unknown as SqlExecutor;
}
// ROOT is a leaf blob here (no children), so ORPHAN is unreachable.
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

function url(): string {
  return `https://state.test/v1/organizations/${ORG_PUBLIC}/projects/${PROJECT_PUBLIC}/state/gc/report`;
}

describe("GET …/state/gc/report (OV9, report-only)", () => {
  it("returns the project's reclaimable-storage report", async () => {
    const res = await handleGetStateGcReport(new Request(url()), createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), {
      executor: gcExecutor(),
      fetcher,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { report: { totalObjects: number; reclaimableBytes: number; capped: boolean } } };
    expect(body.data.report.totalObjects).toBe(2);
    expect(body.data.report.reclaimableBytes).toBe(4096); // the orphan
    expect(body.data.report.capped).toBe(false);
  });

  it("404s (resource-hiding) when policy denies", async () => {
    const res = await handleGetStateGcReport(new Request(url()), createEnv(false), "req_2", ACTOR, asUuid(ORG), asUuid(PROJECT), {
      executor: gcExecutor(),
      fetcher,
    });
    expect(res.status).toBe(404);
  });
});

describe("route() — GC report endpoint is reachable", () => {
  it("dispatches …/state/gc/report to the handler, not Route-not-found", async () => {
    // No contract-version header — a missing header is tolerated by the /state/
    // gate, so the request reaches the GC route.
    const request = new Request(url(), {
      headers: {
        "x-actor-subject-id": ACTOR.subjectId,
        "x-actor-subject-type": ACTOR.subjectType,
      },
    });
    // Policy denies → 404 ("Not found"), proving the route reached the handler.
    const res = await route(request, createEnv(false));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? "").not.toContain("Route not found");
  });
});
