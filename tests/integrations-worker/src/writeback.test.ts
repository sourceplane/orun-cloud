// IG9.2 outbound write-back service. The service resolves a repo's active App
// installation, mints a SCOPED checks/statuses:write token, posts the
// run/PR result back to GitHub, and audits — never logging the token. It is
// fail-soft: an unlinked repo, a missing write grant, or a GitHub error all
// resolve to a benign "skipped"/"failed" outcome and NEVER throw. Tests inject
// a scripted SQL executor + a routing fetch (no DB, no network).

import { postCheckRun, postCommitStatus } from "@integrations-worker/writeback";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const PROJECT_UUID = "44444444-4444-4444-8444-444444444444";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const INSTALLATION_ID = 9912345;
const REPO_EXTERNAL_ID = "777001";
const OWNER_REPO = "acme/storefront";
const NOW = new Date("2026-06-11T10:00:00Z");

type QueryRecord = { text: string; params: unknown[] };

function fakeExecutor(
  respond: (text: string, params: unknown[]) => Record<string, unknown>[] | null,
): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      const rows = (respond(text, params ?? []) ?? []) as unknown as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { executor, queries };
}

let TEST_PRIVATE_KEY_PEM = "";
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const bytes = new Uint8Array(der);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}, 30_000); // RSA keygen can crawl under full-workspace test parallelism

function createEnv(overrides?: Partial<Record<string, unknown>>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    GITHUB_APP_ID: "4242",
    GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
    ...overrides,
  } as unknown as Env;
}

function linkRow(): Record<string, unknown> {
  return {
    id: "ln1",
    org_id: ORG_UUID,
    project_id: PROJECT_UUID,
    connection_id: CONNECTION_UUID,
    repo_external_id: REPO_EXTERNAL_ID,
    repo_full_name: OWNER_REPO,
    default_branch: "main",
    branch_env_map: {},
    status: "active",
    created_by: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function installationRow(permissions: Record<string, string>): Record<string, unknown> {
  return {
    id: "inst1",
    connection_id: CONNECTION_UUID,
    installation_id: String(INSTALLATION_ID),
    account_login: "acme",
    account_id: "42",
    account_type: "Organization",
    repository_selection: "selected",
    permissions,
    events: ["push"],
    suspended_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

// Scripted executor for the happy path: repo → link → installation, with the
// audit insert resolving to a synthetic event/audit row.
function linkedExecutor(permissions: Record<string, string>) {
  return fakeExecutor((text) => {
    if (text.includes("FROM integrations.repo_links")) return [linkRow()];
    if (text.includes("FROM integrations.github_installations")) return [installationRow(permissions)];
    return [{ _event: {}, _audit: {} }];
  });
}

interface GhCall {
  url: string;
  method: string;
  body: unknown;
}

// Routes the two GitHub calls a write-back makes: the scoped-token mint, then
// the check-run/commit-status POST. `mintToken` lets a test simulate a failure.
function githubFetch(
  calls: GhCall[],
  opts?: { posted?: Record<string, unknown>; postStatus?: number; mintStatus?: number },
): (u: string, i?: RequestInit) => Promise<Response> {
  return (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    if (url.includes("/access_tokens")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ token: "ghs_scoped_secret", expires_at: "2026-06-11T11:00:00Z", permissions: { checks: "write" } }),
          { status: opts?.mintStatus ?? 201 },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(opts?.posted ?? { id: 555, html_url: "https://github.com/acme/storefront/runs/555" }), {
        status: opts?.postStatus ?? 201,
      }),
    );
  };
}

const CHECK_RUN = {
  name: "orun / affected components",
  headSha: "abc123def456",
  status: "completed" as const,
  conclusion: "success",
  detailsUrl: "https://app.orun.dev/runs/r1",
  title: "2 components affected",
  summary: "api, web",
};

describe("postCheckRun (IG9.2)", () => {
  it("resolves the install, mints a checks:write-scoped token, posts, and audits without the token", async () => {
    const ghCalls: GhCall[] = [];
    const { executor, queries } = linkedExecutor({ checks: "write", contents: "read" });

    const outcome = await postCheckRun(
      createEnv(),
      { orgId: asUuid(ORG_UUID), repoExternalId: REPO_EXTERNAL_ID, checkRun: CHECK_RUN },
      { executor, fetchImpl: githubFetch(ghCalls) },
    );

    expect(outcome.kind).toBe("posted");
    expect(outcome).toEqual({ kind: "posted", resource: { id: 555, url: "https://github.com/acme/storefront/runs/555" } });

    // Token mint was scoped down to this repo + checks:write only.
    const mint = ghCalls.find((c) => c.url.includes("/access_tokens"))!;
    expect(mint.url).toContain(`/app/installations/${INSTALLATION_ID}/access_tokens`);
    expect(mint.body).toEqual({ repository_ids: [777001], permissions: { checks: "write" } });

    // The check run POST hit the right repo with the mapped body.
    const post = ghCalls.find((c) => c.url.endsWith("/check-runs"))!;
    expect(post.url).toBe(`https://api.github.com/repos/${OWNER_REPO}/check-runs`);
    expect(post.method).toBe("POST");
    expect((post.body as Record<string, unknown>).head_sha).toBe("abc123def456");
    expect((post.body as Record<string, unknown>).conclusion).toBe("success");

    // Audited — never the token.
    const audit = queries.find((q) => q.text.includes("events.event_log"));
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit!.params)).not.toContain("ghs_scoped_secret");
  });

  it("skips when the repo is not App-linked", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.repo_links")) return [];
      return [];
    });
    const ghCalls: GhCall[] = [];
    const outcome = await postCheckRun(
      createEnv(),
      { orgId: asUuid(ORG_UUID), repoExternalId: REPO_EXTERNAL_ID, checkRun: CHECK_RUN },
      { executor, fetchImpl: githubFetch(ghCalls) },
    );
    expect(outcome).toEqual({ kind: "skipped", reason: "repo_not_app_linked" });
    expect(ghCalls).toHaveLength(0); // never touched GitHub
  });

  it("skips when the App lacks the checks:write grant (deny-by-default)", async () => {
    const ghCalls: GhCall[] = [];
    const { executor } = linkedExecutor({ contents: "read" }); // no checks grant
    const outcome = await postCheckRun(
      createEnv(),
      { orgId: asUuid(ORG_UUID), repoExternalId: REPO_EXTERNAL_ID, checkRun: CHECK_RUN },
      { executor, fetchImpl: githubFetch(ghCalls) },
    );
    expect(outcome).toEqual({ kind: "skipped", reason: "checks_write_not_granted" });
    expect(ghCalls).toHaveLength(0); // grant checked before any GitHub call
  });

  it("fails (never throws) when GitHub rejects the post", async () => {
    const ghCalls: GhCall[] = [];
    const { executor } = linkedExecutor({ checks: "write" });
    const outcome = await postCheckRun(
      createEnv(),
      { orgId: asUuid(ORG_UUID), repoExternalId: REPO_EXTERNAL_ID, checkRun: CHECK_RUN },
      { executor, fetchImpl: githubFetch(ghCalls, { postStatus: 403 }) },
    );
    expect(outcome).toEqual({ kind: "failed", reason: "github_rejected" });
  });

  it("skips when the App credential is not configured", async () => {
    const ghCalls: GhCall[] = [];
    const { executor } = linkedExecutor({ checks: "write" });
    const outcome = await postCheckRun(
      createEnv({ GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined }),
      { orgId: asUuid(ORG_UUID), repoExternalId: REPO_EXTERNAL_ID, checkRun: CHECK_RUN },
      { executor, fetchImpl: githubFetch(ghCalls) },
    );
    expect(outcome.kind).toBe("skipped");
    expect(ghCalls).toHaveLength(0);
  });

  it("fails fast when no DB is available", async () => {
    const outcome = await postCheckRun(
      createEnv({ PLATFORM_DB: undefined }),
      { orgId: asUuid(ORG_UUID), repoExternalId: REPO_EXTERNAL_ID, checkRun: CHECK_RUN },
      // no executor in deps → must read env.PLATFORM_DB
    );
    expect(outcome).toEqual({ kind: "failed", reason: "db_unavailable" });
  });
});

describe("postCommitStatus (IG9.2)", () => {
  it("mints a statuses:write token and posts to /statuses/{sha}", async () => {
    const ghCalls: GhCall[] = [];
    const { executor, queries } = linkedExecutor({ statuses: "write" });
    const outcome = await postCommitStatus(
      createEnv(),
      {
        orgId: asUuid(ORG_UUID),
        repoExternalId: REPO_EXTERNAL_ID,
        status: { sha: "deadbeefcafe", state: "success", context: "orun", description: "ok", targetUrl: "https://app.orun.dev/runs/r1" },
      },
      { executor, fetchImpl: githubFetch(ghCalls, { posted: { id: 99, url: "https://api.github.com/x/99" } }) },
    );
    expect(outcome).toEqual({ kind: "posted", resource: { id: 99, url: "https://api.github.com/x/99" } });

    const mint = ghCalls.find((c) => c.url.includes("/access_tokens"))!;
    expect(mint.body).toEqual({ repository_ids: [777001], permissions: { statuses: "write" } });

    const post = ghCalls.find((c) => c.url.includes("/statuses/"))!;
    expect(post.url).toBe(`https://api.github.com/repos/${OWNER_REPO}/statuses/deadbeefcafe`);
    expect(post.body).toEqual({ state: "success", context: "orun", description: "ok", target_url: "https://app.orun.dev/runs/r1" });

    const audit = queries.find((q) => q.text.includes("events.event_log"));
    expect(audit).toBeDefined();
  });

  it("skips when the App lacks the statuses:write grant", async () => {
    const ghCalls: GhCall[] = [];
    const { executor } = linkedExecutor({ checks: "write" }); // statuses not granted
    const outcome = await postCommitStatus(
      createEnv(),
      { orgId: asUuid(ORG_UUID), repoExternalId: REPO_EXTERNAL_ID, status: { sha: "s", state: "pending", context: "orun" } },
      { executor, fetchImpl: githubFetch(ghCalls) },
    );
    expect(outcome).toEqual({ kind: "skipped", reason: "statuses_write_not_granted" });
    expect(ghCalls).toHaveLength(0);
  });
});
