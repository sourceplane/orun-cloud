// IG9.3 internal write-back endpoint. Two layers:
//  • the router guard — POST /internal/github/writeback is service-binding only
//    (x-internal-caller in the allowlist), never a user bearer; and
//  • the handler — validates the body, calls the fail-soft write-back service,
//    and maps its outcome to a 200 response (posted/skipped/failed are DATA, not
//    errors — only a malformed body is a 4xx).
// The handler takes injectable deps (scripted SQL executor + routing fetch) so
// the outcome paths are exercised with no DB and no network.

import { route } from "@integrations-worker/router";
import { handleWritebackInternal } from "@integrations-worker/handlers/writeback-internal";
import { orgPublicId } from "@integrations-worker/ids";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const ORG_PUBLIC = orgPublicId(ORG_UUID);
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const PROJECT_UUID = "44444444-4444-4444-8444-444444444444";
const INSTALLATION_ID = 9912345;
const REPO_EXTERNAL_ID = "777001";
const OWNER_REPO = "acme/storefront";
const NOW = new Date("2026-06-11T10:00:00Z");

function fakeExecutor(
  respond: (text: string, params: unknown[]) => Record<string, unknown>[] | null,
): SqlExecutor {
  return {
    async execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      const rows = (respond(text, params ?? []) ?? []) as unknown as T[];
      return { rows, rowCount: rows.length };
    },
  };
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

function linkedExecutor(permissions: Record<string, string>): SqlExecutor {
  return fakeExecutor((text) => {
    if (text.includes("FROM integrations.repo_links")) return [linkRow()];
    if (text.includes("FROM integrations.github_installations")) return [installationRow(permissions)];
    return [{ _event: {}, _audit: {} }];
  });
}

function githubFetch(opts?: { postStatus?: number }): (u: string, i?: RequestInit) => Promise<Response> {
  return (url: string) => {
    if (url.includes("/access_tokens")) {
      return Promise.resolve(
        new Response(JSON.stringify({ token: "ghs_scoped_secret", expires_at: "2026-06-11T11:00:00Z", permissions: { checks: "write" } }), { status: 201 }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ id: 555, html_url: "https://github.com/acme/storefront/runs/555" }), { status: opts?.postStatus ?? 201 }));
  };
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
}, 30_000);

function createEnv(overrides?: Partial<Record<string, unknown>>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    GITHUB_APP_ID: "4242",
    GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
    ...overrides,
  } as unknown as Env;
}

const CHECK_RUN_BODY = {
  kind: "check_run",
  orgId: ORG_PUBLIC,
  repoExternalId: REPO_EXTERNAL_ID,
  checkRun: { name: "orun / affected", headSha: "abc123", status: "completed", conclusion: "success", title: "t", summary: "s" },
};

function req(body: unknown, headers?: Record<string, string>): Request {
  return new Request("https://worker.test/internal/github/writeback", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function data(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

describe("router guard — POST /internal/github/writeback", () => {
  it("rejects a request with no x-internal-caller as 403", async () => {
    const res = await route(req(CHECK_RUN_BODY), createEnv());
    expect(res.status).toBe(403);
  });

  it("rejects a non-allowlisted caller as 403", async () => {
    const res = await route(req(CHECK_RUN_BODY, { "x-internal-caller": "api-edge" }), createEnv());
    expect(res.status).toBe(403);
  });

  it("rejects GET as 405", async () => {
    const res = await route(
      new Request("https://worker.test/internal/github/writeback", { method: "GET", headers: { "x-internal-caller": "state-worker" } }),
      createEnv(),
    );
    expect(res.status).toBe(405);
  });

  it("returns 503 when the database is not configured", async () => {
    const res = await route(req(CHECK_RUN_BODY, { "x-internal-caller": "state-worker" }), createEnv({ PLATFORM_DB: undefined }));
    expect(res.status).toBe(503);
  });
});

describe("handler validation", () => {
  it("422 on an unknown kind", async () => {
    const res = await handleWritebackInternal(req({ ...CHECK_RUN_BODY, kind: "deploy" }), createEnv(), "req_1");
    expect(res.status).toBe(422);
  });

  it("422 on a missing repo id", async () => {
    const { repoExternalId: _omit, ...rest } = CHECK_RUN_BODY;
    const res = await handleWritebackInternal(req(rest), createEnv(), "req_1");
    expect(res.status).toBe(422);
  });

  it("422 on an invalid org id", async () => {
    const res = await handleWritebackInternal(req({ ...CHECK_RUN_BODY, orgId: "garbage" }), createEnv(), "req_1");
    expect(res.status).toBe(422);
  });

  it("422 when a completed check run omits its conclusion", async () => {
    const body = { ...CHECK_RUN_BODY, checkRun: { name: "n", headSha: "s", status: "completed", title: "t", summary: "s" } };
    const res = await handleWritebackInternal(req(body), createEnv(), "req_1");
    expect(res.status).toBe(422);
    const err = ((await res.json()) as { error: { details: { fields: Record<string, unknown> } } }).error;
    expect(err.details.fields.conclusion).toBeDefined();
  });

  it("400 on a malformed JSON body", async () => {
    const bad = new Request("https://worker.test/internal/github/writeback", { method: "POST", body: "{not json" });
    const res = await handleWritebackInternal(bad, createEnv(), "req_1");
    expect(res.status).toBe(400);
  });
});

describe("handler outcome mapping", () => {
  it("maps a posted check run to 200 { outcome: posted, resource }", async () => {
    const res = await handleWritebackInternal(req(CHECK_RUN_BODY), createEnv(), "req_1", {
      executor: linkedExecutor({ checks: "write" }),
      fetchImpl: githubFetch(),
    });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ outcome: "posted", resource: { id: 555, url: "https://github.com/acme/storefront/runs/555" } });
  });

  it("maps an unlinked repo to 200 { outcome: skipped }", async () => {
    const res = await handleWritebackInternal(req(CHECK_RUN_BODY), createEnv(), "req_1", {
      executor: fakeExecutor(() => []),
      fetchImpl: githubFetch(),
    });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ outcome: "skipped", reason: "repo_not_app_linked" });
  });

  it("maps a GitHub rejection to 200 { outcome: failed }", async () => {
    const res = await handleWritebackInternal(req(CHECK_RUN_BODY), createEnv(), "req_1", {
      executor: linkedExecutor({ checks: "write" }),
      fetchImpl: githubFetch({ postStatus: 403 }),
    });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ outcome: "failed", reason: "github_rejected" });
  });

  it("posts a commit status through the same endpoint", async () => {
    const body = {
      kind: "commit_status",
      orgId: ORG_PUBLIC,
      repoExternalId: REPO_EXTERNAL_ID,
      status: { sha: "deadbeef", state: "success", context: "orun" },
    };
    const res = await handleWritebackInternal(req(body), createEnv(), "req_1", {
      executor: linkedExecutor({ statuses: "write" }),
      fetchImpl: githubFetch(),
    });
    expect(res.status).toBe(200);
    expect((await data(res)).outcome).toBe("posted");
  });
});
