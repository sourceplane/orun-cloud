/**
 * Materialization provenance (saas-secret-manager SM5) — handler + route tests.
 *
 * Covers: POST record (resolves secretKey -> secret, emits secret.sync.recorded
 * with NO value in the payload), the unknown-key 404, GET list filtering
 * (entityRef/status), and the Layer-1 RBAC activation (secret.write on record,
 * secret.read on list — the action string asserted on the policy client mock).
 */
import { handleRecordSecretSync } from "@config-worker/handlers/record-secret-sync";
import { handleListSecretSyncs } from "@config-worker/handlers/list-secret-syncs";
import { route } from "@config-worker/router";
import type { Env } from "@config-worker/env";
import type { ActorContext } from "@config-worker/router";
import type {
  ConfigResult,
  ListSecretSyncsFilter,
  PageQueryParams,
  Scope,
  SecretMetadata,
  SecretSync,
} from "@saas/db/config";
import type { AppendEventWithAuditInput, EventsResult, StoredEvent, StoredAuditEntry } from "@saas/db/events";

// ── Constants ──────────────────────────────────────────────
const ORG = "11111111-1111-1111-1111-111111111111";
const PRJ = "22222222-2222-2222-2222-222222222222";
const ENV_UUID = "44444444-4444-4444-4444-444444444444";
const SECRET = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const SYNC = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TEST_USER_ID = "usr_" + "ab".repeat(16);

const ORG_PUBLIC = "org_11111111111111111111111111111111";
const PRJ_PUBLIC = "prj_22222222222222222222222222222222";
const ENV_PUBLIC = "env_44444444444444444444444444444444";

const ACTOR: ActorContext = { subjectId: TEST_USER_ID, subjectType: "user" };
const ENV_SCOPE: Scope = { kind: "environment", orgId: ORG, projectId: PRJ, environmentId: ENV_UUID };
const FAKE_ENV = {} as Env;

const SECRET_VALUE = "super-secret-db-url";

function fakeSecret(over?: Partial<SecretMetadata>): SecretMetadata {
  return {
    id: SECRET,
    orgId: ORG,
    projectId: PRJ,
    environmentId: ENV_UUID,
    scopeKind: "environment",
    secretKey: "DATABASE_URL",
    displayName: null,
    status: "active",
    version: 7,
    rotationPolicy: null,
    lastRotatedAt: null,
    expiresAt: null,
    createdBy: "abababab-abab-abab-abab-abababababab",
    personalOwner: null,
    source: "static" as const,
    bindingProvider: null,
    bindingConnectionId: null,
    bindingTemplate: null,
    rotationProvider: null,
    rotationConnectionId: null,
    rotationTemplate: null,
    rotationParams: null,
    rotationGraceSeconds: null,
    rotationDeliverTarget: null,
    overridable: true,
    lastUsedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...over,
  };
}

function fakeSync(over?: Partial<SecretSync>): SecretSync {
  return {
    id: SYNC,
    secretId: SECRET,
    orgId: ORG,
    projectId: PRJ,
    environmentId: ENV_UUID,
    version: 7,
    target: "cloudflare-worker",
    entityRef: "Resource/worker-api-prod",
    runId: "01JRUNULID",
    status: "synced",
    syncedAt: new Date("2026-07-02T00:00:00Z"),
    ...over,
  };
}

function jsonRequest(body: unknown, method = "POST"): Request {
  return new Request("http://config-worker/v1/x/config/secrets/syncs", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const okEvent: EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }> = {
  ok: true,
  value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry },
};

// ═══════════════════════════════════════════════════════════
// POST record
// ═══════════════════════════════════════════════════════════
describe("handleRecordSecretSync", () => {
  it("records the sync and emits secret.sync.recorded with NO value in the payload", async () => {
    const events: AppendEventWithAuditInput[] = [];
    const res = await handleRecordSecretSync(
      jsonRequest({ secretKey: "DATABASE_URL", version: 7, target: "cloudflare-worker", entityRef: "Resource/worker-api-prod", runId: "01JRUNULID" }),
      FAKE_ENV, "req_1", ACTOR, ENV_SCOPE,
      {
        repo: {
          getSecretMetadataByScopeKey: async () => ({ ok: true, value: fakeSecret() }),
          recordSecretSync: async () => ({ ok: true, value: fakeSync() }),
        },
        eventsRepo: { appendEventWithAudit: async (i) => { events.push(i); return okEvent; } },
        generateId: () => "id",
      },
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { sync: { target: string; version: number; entityRef: string; status: string; secretId: string } } };
    expect(json.data.sync.target).toBe("cloudflare-worker");
    expect(json.data.sync.version).toBe(7);
    expect(json.data.sync.entityRef).toBe("Resource/worker-api-prod");
    expect(json.data.sync.status).toBe("synced");
    expect(json.data.sync.secretId).toMatch(/^sec_/);

    expect(events).toHaveLength(1);
    expect(events[0]!.event.type).toBe("secret.sync.recorded");
    const payload = events[0]!.event.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ key: "DATABASE_URL", version: 7, target: "cloudflare-worker", entityRef: "Resource/worker-api-prod", runId: "01JRUNULID" });
    // Invariant: no secret value in the event payload (or anywhere in the event).
    expect(Object.keys(payload)).not.toContain("value");
    expect(JSON.stringify(events[0])).not.toContain(SECRET_VALUE);
  });

  it("404s when the secretKey does not resolve in scope", async () => {
    let recorded = false;
    const res = await handleRecordSecretSync(
      jsonRequest({ secretKey: "MISSING", version: 1, target: "cloudflare-worker", entityRef: "Resource/x", runId: "r" }),
      FAKE_ENV, "req_2", ACTOR, ENV_SCOPE,
      {
        repo: {
          getSecretMetadataByScopeKey: async () => ({ ok: false, error: { kind: "not_found" } }),
          recordSecretSync: async () => { recorded = true; return { ok: true, value: fakeSync() }; },
        },
      },
    );
    expect(res.status).toBe(404);
    expect(recorded).toBe(false);
  });

  it("422s an invalid body (bad version, missing fields, a stray value field)", async () => {
    const neverCalled = {
      getSecretMetadataByScopeKey: async (): Promise<ConfigResult<SecretMetadata>> => { throw new Error("must not resolve"); },
      recordSecretSync: async (): Promise<ConfigResult<SecretSync>> => { throw new Error("must not record"); },
    };
    const res = await handleRecordSecretSync(
      jsonRequest({ secretKey: "DATABASE_URL", version: 0, target: "", entityRef: "Resource/x", runId: "r", value: SECRET_VALUE }),
      FAKE_ENV, "req_3", ACTOR, ENV_SCOPE, { repo: neverCalled },
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { details: { fields: Record<string, string[]> } } };
    expect(json.error.details.fields.version).toBeDefined();
    expect(json.error.details.fields.target).toBeDefined();
    expect(json.error.details.fields.value).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// GET list
// ═══════════════════════════════════════════════════════════
describe("handleListSecretSyncs", () => {
  it("forwards entityRef + status filters to the repository", async () => {
    let seen: ListSecretSyncsFilter | null = null;
    const res = await handleListSecretSyncs(
      new Request("http://config-worker/v1/x/config/secrets/syncs?entityRef=Resource/worker-api-prod&status=synced", { method: "GET" }),
      FAKE_ENV, "req_4", ACTOR, ENV_SCOPE,
      {
        repo: {
          getSecretMetadataByScopeKey: async () => ({ ok: true, value: fakeSecret() }),
          listSecretSyncs: async (_scope: Scope, filter: ListSecretSyncsFilter, _params: PageQueryParams) => {
            seen = filter;
            return { ok: true, value: { items: [fakeSync()], nextCursor: null } };
          },
        },
      },
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual({ entityRef: "Resource/worker-api-prod", status: "synced" });
    const json = (await res.json()) as { data: { syncs: Array<{ id: string; status: string }> } };
    expect(json.data.syncs).toHaveLength(1);
    expect(json.data.syncs[0]!.id).toMatch(/^syn_/);
    expect(json.data.syncs[0]!.status).toBe("synced");
  });

  it("422s an invalid status filter", async () => {
    const res = await handleListSecretSyncs(
      new Request("http://config-worker/v1/x/config/secrets/syncs?status=bogus", { method: "GET" }),
      FAKE_ENV, "req_5", ACTOR, ENV_SCOPE,
      {
        repo: {
          getSecretMetadataByScopeKey: async (): Promise<ConfigResult<SecretMetadata>> => { throw new Error("unused"); },
          listSecretSyncs: async (): Promise<ConfigResult<{ items: SecretSync[]; nextCursor: null }>> => { throw new Error("unused"); },
        },
      },
    );
    expect(res.status).toBe(422);
  });

  it("resolves a secretKey filter to secret_id (per-component view)", async () => {
    let seen: ListSecretSyncsFilter | null = null;
    await handleListSecretSyncs(
      new Request("http://config-worker/v1/x/config/secrets/syncs?secretKey=DATABASE_URL", { method: "GET" }),
      FAKE_ENV, "req_6", ACTOR, ENV_SCOPE,
      {
        repo: {
          getSecretMetadataByScopeKey: async () => ({ ok: true, value: fakeSecret() }),
          listSecretSyncs: async (_s: Scope, filter: ListSecretSyncsFilter) => { seen = filter; return { ok: true, value: { items: [], nextCursor: null } }; },
        },
      },
    );
    expect(seen).toEqual({ secretId: SECRET });
  });
});

// ═══════════════════════════════════════════════════════════
// Router wiring + RBAC action switch (Layer 1 activation)
// ═══════════════════════════════════════════════════════════
describe("config-worker router — SM5 syncs routes + RBAC actions", () => {
  type MockFetcher = Fetcher & { fetchCalls: Array<{ url: string; init: RequestInit }> };

  function createMockFetcher(responseBody: unknown, status = 200): MockFetcher {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    return {
      fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        fetchCalls.push({ url, init: init ?? {} });
        return Promise.resolve(new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } }));
      },
      connect() { throw new Error("not implemented"); },
      fetchCalls,
    } as unknown as MockFetcher;
  }

  function createFakeEnv(): Env & { POLICY_WORKER: MockFetcher } {
    return {
      PLATFORM_DB: { connectionString: "postgres://fake" },
      MEMBERSHIP_WORKER: createMockFetcher({ data: { memberships: [{ kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG } }] } }),
      POLICY_WORKER: createMockFetcher({ data: { allow: true, reason: "org_admin", policyVersion: 1, derivedScope: { orgId: ORG } } }),
      ENVIRONMENT: "test",
    } as unknown as Env & { POLICY_WORKER: MockFetcher };
  }

  function routerRequest(path: string, method: string, body?: unknown): Request {
    const init: RequestInit = {
      method,
      headers: { "x-request-id": "req_test", "x-actor-subject-id": TEST_USER_ID, "x-actor-subject-type": "user" },
    };
    if (body !== undefined) {
      (init.headers as Record<string, string>)["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return new Request(`https://config-worker${path}`, init);
  }

  function policyAction(env: { POLICY_WORKER: MockFetcher }): string {
    expect(env.POLICY_WORKER.fetchCalls).toHaveLength(1);
    const body = JSON.parse(env.POLICY_WORKER.fetchCalls[0]!.init.body as string) as { action: string };
    return body.action;
  }

  const SYNCS_PATH = `/v1/organizations/${ORG_PUBLIC}/projects/${PRJ_PUBLIC}/environments/${ENV_PUBLIC}/config/secrets/syncs`;

  it("POST syncs authorizes with secret.write", async () => {
    const env = createFakeEnv();
    const res = await route(routerRequest(SYNCS_PATH, "POST", { secretKey: "DATABASE_URL", version: 7, target: "cloudflare-worker", entityRef: "Resource/worker-api-prod", runId: "01JRUNULID" }), env);
    expect(res.status).not.toBe(404);
    expect(policyAction(env)).toBe("secret.write");
  });

  it("GET syncs authorizes with secret.read", async () => {
    const env = createFakeEnv();
    const res = await route(routerRequest(`${SYNCS_PATH}?entityRef=Resource/worker-api-prod`, "GET"), env);
    expect(res.status).not.toBe(404);
    expect(policyAction(env)).toBe("secret.read");
  });

  it("routes syncs at all three scopes (503 without a real DB), and 405s PUT", async () => {
    for (const path of [
      `/v1/organizations/${ORG_PUBLIC}/config/secrets/syncs`,
      `/v1/organizations/${ORG_PUBLIC}/projects/${PRJ_PUBLIC}/config/secrets/syncs`,
      SYNCS_PATH,
    ]) {
      const res = await route(routerRequest(path, "GET"), {} as Env);
      expect(res.status).toBe(503);
    }
    const put = await route(routerRequest(SYNCS_PATH, "PUT"), {} as Env);
    expect(put.status).toBe(405);
  });

  it("does NOT shadow the secret item (revoke) route — `syncs` is a reserved sub-path", async () => {
    // A DELETE on a real secret id still reaches the revoke handler (503 without
    // a DB), proving the syncs match did not swallow the {id} catch-all.
    const res = await route(routerRequest(`/v1/organizations/${ORG_PUBLIC}/config/secrets/sec_cccccccccccccccccccccccccccccccc`, "DELETE"), {} as Env);
    expect(res.status).toBe(503);
  });
});

// ═══════════════════════════════════════════════════════════
// Brokered guard (saas-integration-hub IH7): materialization excluded in v1
// ═══════════════════════════════════════════════════════════

describe("handleRecordSecretSync — brokered guard (IH7)", () => {
  it("rejects recording a sync for a brokered secret with a typed 400", async () => {
    let recorded = 0;
    const res = await handleRecordSecretSync(
      jsonRequest({ secretKey: "DATABASE_URL", version: 7, target: "cloudflare-worker", entityRef: "Resource/worker-api-prod", runId: "01JRUNULID" }),
      FAKE_ENV, "req_br1", ACTOR, ENV_SCOPE,
      {
        repo: {
          getSecretMetadataByScopeKey: async () => ({
            ok: true,
            value: fakeSecret({
              source: "brokered",
              bindingProvider: "cloudflare",
              bindingConnectionId: "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd",
              bindingTemplate: "workers-deploy",
            }),
          }),
          recordSecretSync: async () => {
            recorded++;
            return { ok: true, value: fakeSync() };
          },
        },
        eventsRepo: { appendEventWithAudit: async () => okEvent },
        generateId: () => "id",
      },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; details: { reason: string } } };
    expect(json.error.code).toBe("unsupported");
    expect(json.error.details.reason).toBe("brokered_not_materializable");
    expect(recorded).toBe(0);
  });
});
