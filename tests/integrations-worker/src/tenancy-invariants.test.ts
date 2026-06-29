// IT6 — the scope-aware split-brain guard for saas-integration-tenancy.
//
// A consolidated suite asserting the cross-cutting tenancy invariants that
// IT1–IT8 must uphold together, so a future change to one handler cannot quietly
// half-resolve the model. Each test states the invariant it pins.
//
//   credential resolves UP   — the broker mints against the account connection,
//                              resolved by id, authorized by repo-link ownership.
//   events project DOWN      — the drain emits to the owning workspace's org.
//   admission gates BEFORE   — 'granted' denies a non-admitted workspace.
//   fail closed              — unlinked repos never leak into a workspace.
//   uninstall CASCADES       — a revoked shared connection denies every workspace.
//   private NEVER resolves up — a workspace-private connection stays put.

import { handleIssueGithubToken } from "@integrations-worker/handlers/token-broker";
import { processDelivery } from "@integrations-worker/drain";
import { createIntegrationsRepository, type InboundDelivery } from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import type { ActorContext } from "@integrations-worker/router";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";

const ACCOUNT_UUID = "11111111-1111-4111-8111-111111111111"; // parent / account org
const WORKSPACE_UUID = "22222222-2222-4222-8222-222222222222"; // a child workspace org
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const PROJECT_UUID = "44444444-4444-4444-8444-444444444444";
const DELIVERY_UUID = "55555555-5555-4555-8555-555555555555";
const INSTALLATION_ID = 9912345;
const NOW = new Date("2026-06-11T10:00:00Z");

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

function jsonFetcher(body: unknown): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json(body)),
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

type QueryRecord = { text: string; params: unknown[] };
type SqlResponder = (text: string, params: unknown[]) => Record<string, unknown>[] | null;

function fakeExecutor(respond: SqlResponder): { executor: SqlExecutor; queries: QueryRecord[] } {
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

const ACTOR: ActorContext = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

function createEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    GITHUB_APP_ID: "4242",
    GITHUB_APP_SLUG: "sourceplane-test",
    GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
    MEMBERSHIP_WORKER: jsonFetcher({
      data: {
        memberships: [
          { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: WORKSPACE_UUID } },
        ],
      },
    }),
    POLICY_WORKER: jsonFetcher({ data: { allow: true, reason: "org_admin" } }),
    BILLING_WORKER: jsonFetcher({
      data: { allowed: true, orgId: "org_x", entitlementKey: "feature.integrations.github" },
    }),
  } as unknown as Env;
}

/** A shared connection owned by the ACCOUNT (the default account-shared case). */
function accountConnectionRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: CONNECTION_UUID,
    org_id: ACCOUNT_UUID,
    provider: "github",
    status: "active",
    scope: "account",
    share_mode: "auto",
    display_name: "acme",
    external_account_login: "acme",
    external_account_id: "42",
    external_account_type: "Organization",
    created_by: null,
    state_expires_at: null,
    connected_at: NOW.toISOString(),
    suspended_at: null,
    revoked_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

/** A repo link OWNED BY THE WORKSPACE, claimed against the account connection. */
function workspaceLinkRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "ln1",
    org_id: WORKSPACE_UUID,
    project_id: PROJECT_UUID,
    connection_id: CONNECTION_UUID,
    repo_external_id: "777001",
    repo_full_name: "acme/storefront",
    default_branch: "main",
    branch_env_map: {},
    status: "active",
    created_by: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function installationRow(): Record<string, unknown> {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    connection_id: CONNECTION_UUID,
    installation_id: String(INSTALLATION_ID),
    account_login: "acme",
    account_id: "42",
    account_type: "Organization",
    repository_selection: "selected",
    permissions: { checks: "write" },
    events: ["push"],
    suspended_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

const EVENT_ROW = {
  _event: {
    id: "evt", type: "scm.push", version: 1, source: "integrations-worker",
    occurred_at: NOW.toISOString(), actor_type: "system", actor_id: "integrations-worker",
    org_id: WORKSPACE_UUID, subject_kind: "repository", subject_id: "777001",
    request_id: "igd_x", payload: "{}",
  },
  _audit: {
    id: "aud", event_id: "evt", org_id: WORKSPACE_UUID, actor_type: "system",
    actor_id: "integrations-worker", event_type: "scm.push", event_version: 1,
    source: "integrations-worker", subject_kind: "repository", subject_id: "777001",
    category: "integrations", description: "x", occurred_at: NOW.toISOString(),
    request_id: "igd_x", payload: "{}",
  },
};

function deliveryRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: DELIVERY_UUID,
    org_id: null,
    connection_id: null,
    provider: "github",
    delivery_key: "gh-uuid-1",
    event_type: "push",
    action: null,
    payload: {
      ref: "refs/heads/main",
      after: "bbb",
      repository: { id: 777001, full_name: "acme/storefront" },
      installation: { id: INSTALLATION_ID },
      commits: [],
      pusher: { name: "octocat" },
    },
    signature_ok: true,
    status: "received",
    attempts: 0,
    next_attempt_at: null,
    failure_reason: null,
    emitted_event_id: null,
    received_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function mapDelivery(row: Record<string, unknown>): InboundDelivery {
  return {
    id: row.id as string,
    orgId: (row.org_id as string) ?? null,
    connectionId: (row.connection_id as string) ?? null,
    provider: row.provider as string,
    deliveryKey: row.delivery_key as string,
    eventType: row.event_type as string,
    action: (row.action as string) ?? null,
    payload: row.payload as Record<string, unknown>,
    signatureOk: row.signature_ok as boolean,
    status: row.status as InboundDelivery["status"],
    attempts: row.attempts as number,
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at as string) : null,
    failureReason: (row.failure_reason as string) ?? null,
    emittedEventId: (row.emitted_event_id as string) ?? null,
    receivedAt: new Date(row.received_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function drainCtx(respond: SqlResponder) {
  const { executor, queries } = fakeExecutor(respond);
  return {
    ctx: {
      executor,
      repo: createIntegrationsRepository(executor),
      events: createEventsRepository(executor),
      now: () => NOW,
    },
    queries,
  };
}

const githubFetch = (calls: Array<{ url: string; body: unknown }>) =>
  ((input: string, init?: RequestInit) => {
    calls.push({ url: input, body: init?.body ? JSON.parse(init.body as string) : null });
    return Promise.resolve(
      new Response(
        JSON.stringify({ token: "ghs_scoped", expires_at: "2026-06-11T11:00:00Z", permissions: { checks: "write" } }),
        { status: 201 },
      ),
    );
  });

function tokenRequest(body: Record<string, unknown>): Request {
  return new Request("https://worker.test/v1/organizations/x/integrations/github/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("tenancy invariants — the scope-aware split-brain guard (IT6)", () => {
  it("credential resolves UP: a workspace mints against the account connection, by id + ownership", async () => {
    const ghCalls: Array<{ url: string; body: unknown }> = [];
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.repo_links")) return [workspaceLinkRow()];
      if (text.includes("AS admitted")) return [{ admitted: true }];
      if (text.includes("FROM integrations.connections WHERE id")) return [accountConnectionRow()];
      if (text.includes("FROM integrations.connections WHERE org_id"))
        throw new Error("split-brain: broker must not resolve the connection org-scoped");
      if (text.includes("FROM integrations.github_installations")) return [installationRow()];
      return [{ _event: {}, _audit: {} }];
    });
    const res = await handleIssueGithubToken(
      tokenRequest({ repositories: ["777001"], permissions: { checks: "write" } }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(WORKSPACE_UUID), // actor is the workspace, connection lives at the account
      { executor, fetchImpl: githubFetch(ghCalls) },
    );
    expect(res.status).toBe(201);
    expect(ghCalls[0]!.body).toEqual({ repository_ids: [777001], permissions: { checks: "write" } });
    expect(queries.some((q) => q.text.includes("FROM integrations.connections WHERE id"))).toBe(true);
  });

  it("admission gates BEFORE minting: 'granted' denies a non-admitted workspace, no token", async () => {
    const ghCalls: Array<{ url: string; body: unknown }> = [];
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.repo_links")) return [workspaceLinkRow()];
      if (text.includes("AS admitted")) return [{ admitted: false }];
      if (text.includes("FROM integrations.connections WHERE id"))
        return [accountConnectionRow({ share_mode: "granted" })];
      if (text.includes("FROM integrations.github_installations")) return [installationRow()];
      return [];
    });
    const res = await handleIssueGithubToken(
      tokenRequest({ repositories: ["777001"], permissions: { checks: "write" } }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(WORKSPACE_UUID),
      { executor, fetchImpl: githubFetch(ghCalls) },
    );
    expect(res.status).toBe(403);
    expect(ghCalls).toHaveLength(0);
  });

  it("uninstall CASCADES: a revoked shared connection denies every workspace's mint", async () => {
    const ghCalls: Array<{ url: string; body: unknown }> = [];
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.repo_links")) return [workspaceLinkRow()];
      if (text.includes("FROM integrations.connections WHERE id"))
        return [accountConnectionRow({ status: "revoked", revoked_at: NOW.toISOString() })];
      return [];
    });
    const res = await handleIssueGithubToken(
      tokenRequest({ repositories: ["777001"], permissions: { checks: "write" } }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(WORKSPACE_UUID),
      { executor, fetchImpl: githubFetch(ghCalls) },
    );
    expect(res.status).toBe(412); // owning connection is not active
    expect(ghCalls).toHaveLength(0);
  });

  it("events project DOWN: the drain emits to the owning workspace's org, not the account", async () => {
    const { ctx, queries } = drainCtx((text) => {
      if (text.includes("FROM integrations.github_installations WHERE installation_id"))
        return [installationRow()];
      if (text.includes("FROM integrations.connections WHERE id = $1")) return [accountConnectionRow()];
      if (text.includes("FROM integrations.repo_links")) return [workspaceLinkRow()];
      if (text.includes("events.event_log")) return [EVENT_ROW];
      if (text.includes("UPDATE integrations.inbound_deliveries")) return [deliveryRow({ status: "emitted" })];
      return [];
    });
    const outcome = await processDelivery(ctx, mapDelivery(deliveryRow()));
    expect(outcome).toEqual({ kind: "emitted", eventType: "scm.push" });
    const eventInsert = queries.find((q) => q.text.includes("events.event_log"));
    expect(eventInsert!.params[9]).toBe(WORKSPACE_UUID); // owning workspace, not ACCOUNT_UUID
  });

  it("fail closed: an unlinked repo emits account-org-scoped only, never into a workspace", async () => {
    const { ctx, queries } = drainCtx((text) => {
      if (text.includes("FROM integrations.github_installations WHERE installation_id"))
        return [installationRow()];
      if (text.includes("FROM integrations.connections WHERE id = $1")) return [accountConnectionRow()];
      if (text.includes("FROM integrations.repo_links")) return []; // unlinked
      if (text.includes("events.event_log")) return [EVENT_ROW];
      if (text.includes("UPDATE integrations.inbound_deliveries")) return [deliveryRow({ status: "emitted" })];
      return [];
    });
    const outcome = await processDelivery(ctx, mapDelivery(deliveryRow()));
    expect(outcome).toEqual({ kind: "emitted", eventType: "scm.push" });
    const eventInsert = queries.find((q) => q.text.includes("events.event_log"));
    expect(eventInsert!.params[9]).toBe(ACCOUNT_UUID); // account only — never WORKSPACE_UUID
    expect(eventInsert!.params[10]).toBeNull();
  });

  it("uninstall CASCADES: the drain skips deliveries for a revoked shared connection", async () => {
    const { ctx, queries } = drainCtx((text) => {
      if (text.includes("FROM integrations.github_installations WHERE installation_id"))
        return [installationRow()];
      if (text.includes("FROM integrations.connections WHERE id = $1"))
        return [accountConnectionRow({ status: "revoked", revoked_at: NOW.toISOString() })];
      return [];
    });
    const outcome = await processDelivery(ctx, mapDelivery(deliveryRow()));
    expect(outcome).toEqual({ kind: "skipped", reason: "connection_revoked" });
    // No event reached any org.
    expect(queries.some((q) => q.text.includes("events.event_log"))).toBe(false);
  });

  it("private NEVER resolves up: a workspace-private connection's events stay at the workspace", async () => {
    // A workspace-private connection: scope='workspace', owned by the workspace.
    // Its link is the workspace's; the event stays at the workspace org — the
    // seam is not applied to climb to any parent.
    const { ctx, queries } = drainCtx((text) => {
      if (text.includes("FROM integrations.github_installations WHERE installation_id"))
        return [installationRow()];
      if (text.includes("FROM integrations.connections WHERE id = $1"))
        return [accountConnectionRow({ org_id: WORKSPACE_UUID, scope: "workspace" })];
      if (text.includes("FROM integrations.repo_links")) return [workspaceLinkRow()];
      if (text.includes("events.event_log")) return [EVENT_ROW];
      if (text.includes("UPDATE integrations.inbound_deliveries")) return [deliveryRow({ status: "emitted" })];
      return [];
    });
    const outcome = await processDelivery(ctx, mapDelivery(deliveryRow()));
    expect(outcome).toEqual({ kind: "emitted", eventType: "scm.push" });
    const eventInsert = queries.find((q) => q.text.includes("events.event_log"));
    expect(eventInsert!.params[9]).toBe(WORKSPACE_UUID);
  });
});
