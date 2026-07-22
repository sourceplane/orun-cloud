import { handleCreateSecret } from "@config-worker/handlers/create-secret";
import { handleRotateSecret } from "@config-worker/handlers/rotate-secret";
import { handleRevokeSecret } from "@config-worker/handlers/revoke-secret";
import { parseSecretMetadataPublicId, secretMetadataPublicId } from "@config-worker/ids";
import { route } from "@config-worker/router";
import type { Env } from "@config-worker/env";
import type { ActorContext } from "@config-worker/router";
import type { Scope, SecretMetadata, ConfigResult, CreateSecretMetadataInput } from "@saas/db/config";
import type {
  AppendEventWithAuditInput,
  EventsResult,
  StoredEvent,
  StoredAuditEntry,
} from "@saas/db/events";

// ── Local types ────────────────────────────────────────────
type SecretView = {
  id: string;
  secretKey: string;
  status: string;
  version: number;
  value?: unknown;
  plaintext?: unknown;
  ciphertext?: unknown;
  ciphertextEnvelope?: unknown;
  hash?: unknown;
};
type ErrorEnvelope = {
  code: string;
  message?: string;
  details?: { fields?: Record<string, unknown> };
};
type JsonResp = {
  data: { secret: SecretView };
  error: ErrorEnvelope;
};

type EventPayload = {
  operation?: string;
  key?: string;
  value?: unknown;
  plaintext?: unknown;
  ciphertext?: unknown;
  hash?: unknown;
  [k: string]: unknown;
};

const unusedConfigFailure = <T>(): Promise<ConfigResult<T>> =>
  Promise.resolve({ ok: false, error: { kind: "internal", message: "unused stub" } });

const PLACEHOLDER_EVENT: StoredEvent = {
  id: "evt_placeholder",
  type: "test.placeholder",
  version: 1,
  source: "config-worker-tests",
  occurredAt: new Date("2026-05-01T00:00:00Z"),
  actorType: "user",
  actorId: "usr_aabbccdd",
  actorSessionId: null,
  actorIp: null,
  orgId: "11111111-1111-1111-1111-111111111111",
  projectId: null,
  environmentId: null,
  subjectKind: "test",
  subjectId: "placeholder",
  subjectName: null,
  requestId: "req_placeholder",
  correlationId: null,
  causationId: null,
  idempotencyKey: null,
  payload: {},
  redactPaths: [],
  createdAt: new Date("2026-05-01T00:00:00Z"),
};

const PLACEHOLDER_AUDIT: StoredAuditEntry = {
  id: "aud_placeholder",
  eventId: "evt_placeholder",
  orgId: "11111111-1111-1111-1111-111111111111",
  projectId: null,
  environmentId: null,
  actorType: "user",
  actorId: "usr_aabbccdd",
  eventType: "test.placeholder",
  eventVersion: 1,
  source: "config-worker-tests",
  subjectKind: "test",
  subjectId: "placeholder",
  subjectName: null,
  category: "test",
  description: "placeholder",
  occurredAt: new Date("2026-05-01T00:00:00Z"),
  requestId: "req_placeholder",
  correlationId: null,
  payload: {},
  redactPaths: [],
  createdAt: new Date("2026-05-01T00:00:00Z"),
};

// ── Constants ──────────────────────────────────────────────
const TEST_ORG_UUID = "11111111-1111-1111-1111-111111111111";
const TEST_PROJECT_UUID = "22222222-2222-2222-2222-222222222222";
const TEST_ENV_UUID = "44444444-4444-4444-4444-444444444444";
// Public actor id `usr_<32 hex>` decodes to TEST_USER_UUID for the
// created_by UUID column.
const TEST_USER_ID = "usr_" + "ab".repeat(16);
const TEST_USER_UUID = "abababab-abab-abab-abab-abababababab";
const FIXED_NOW = new Date("2026-05-01T00:00:00Z");
const FIXED_ID = "deadbeef01234567";
const SECRET_UUID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const ACTOR: ActorContext = { subjectId: TEST_USER_ID, subjectType: "user" };
const ORG_SCOPE: Scope = { kind: "organization", orgId: TEST_ORG_UUID };
const PRJ_SCOPE: Scope = { kind: "project", orgId: TEST_ORG_UUID, projectId: TEST_PROJECT_UUID };
const ENV_SCOPE: Scope = { kind: "environment", orgId: TEST_ORG_UUID, projectId: TEST_PROJECT_UUID, environmentId: TEST_ENV_UUID };

const FAKE_ENV = {} as Env;

const TEST_ORG_PUBLIC = "org_11111111111111111111111111111111";
const TEST_PRJ_PUBLIC = "prj_22222222222222222222222222222222";
const TEST_ENV_PUBLIC = "env_44444444444444444444444444444444";

function makeJsonRequest(body: unknown, method = "POST"): Request {
  return new Request("https://config-worker/test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeBadRequest(): Request {
  return new Request("https://config-worker/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
}

function makeEmptyRequest(method = "POST"): Request {
  return new Request("https://config-worker/test", { method });
}

function makeDeleteRequest(): Request {
  return new Request("https://config-worker/test", { method: "DELETE" });
}

// ── Fake SecretMetadata ──────────────────────────────────────
function fakeSecret(overrides?: Partial<SecretMetadata>): SecretMetadata {
  return {
    id: SECRET_UUID,
    orgId: TEST_ORG_UUID,
    projectId: null,
    environmentId: null,
    scopeKind: "organization",
    secretKey: "API_KEY",
    displayName: "API Key",
    status: "active",
    version: 1,
    rotationPolicy: null,
    lastRotatedAt: null,
    expiresAt: null,
    createdBy: TEST_USER_ID,
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
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

// ── Fake repos ─────────────────────────────────────────────
type FakeEventsRepo = {
  calls: AppendEventWithAuditInput[];
  appendEventWithAudit: (
    input: AppendEventWithAuditInput,
  ) => Promise<EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>>;
};

function fakeEventsRepo(): FakeEventsRepo {
  const calls: AppendEventWithAuditInput[] = [];
  return {
    calls,
    appendEventWithAudit(input) {
      calls.push(input);
      return Promise.resolve({
        ok: true as const,
        value: { event: PLACEHOLDER_EVENT, audit: PLACEHOLDER_AUDIT },
      });
    },
  };
}

function failingEventsRepo(): FakeEventsRepo {
  const calls: AppendEventWithAuditInput[] = [];
  return {
    calls,
    appendEventWithAudit(_input) {
      return Promise.resolve({ ok: false as const, error: { kind: "internal" as const, message: "event store down" } });
    },
  };
}

// ═══════════════════════════════════════════════════════════
// handleCreateSecret tests
// ═══════════════════════════════════════════════════════════
describe("handleCreateSecret", () => {
  it("returns 400 for invalid JSON", async () => {
    const res = await handleCreateSecret(makeBadRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
    });
    expect(res.status).toBe(400);
  });

  it("returns 422 for missing secretKey", async () => {
    const res = await handleCreateSecret(makeJsonRequest({ displayName: "test" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as JsonResp;
    expect(body.error.details?.fields?.secretKey).toBeDefined();
  });

  it("returns 422 for invalid secretKey pattern", async () => {
    const res = await handleCreateSecret(makeJsonRequest({ secretKey: "123bad" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
    });
    expect(res.status).toBe(422);
  });

  it("rejects secret material fields (value, plaintext, secret, ciphertext, hash, etc.)", async () => {
    // NOTE: "value" is now accepted for write-only encrypted storage (task-0065)
    const forbiddenFields = ["plaintext", "secret", "ciphertext", "ciphertextEnvelope", "ciphertext_envelope", "hash", "token", "password", "credential"];
    for (const field of forbiddenFields) {
      const body = { secretKey: "API_KEY", [field]: "should_be_rejected" };
      const res = await handleCreateSecret(makeJsonRequest(body), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
        repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
      });
      expect(res.status).toBe(422);
      const respBody = (await res.json()) as JsonResp;
      expect(respBody.error.details?.fields?.[field]).toBeDefined();
    }
  });

  it("creates secret metadata successfully", async () => {
    const secret = fakeSecret();
    const eventsRepo = fakeEventsRepo();
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY", displayName: "API Key" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: true as const, value: secret }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { secret: { secretKey: string; id: string; status: string } } };
    expect(body.data.secret.secretKey).toBe("API_KEY");
    expect(body.data.secret.id).toMatch(/^sec_/);
    expect(body.data.secret.status).toBe("active");
    expect(eventsRepo.calls).toHaveLength(1);
  });

  it("decodes the public actor id to a UUID for created_by", async () => {
    let captured: CreateSecretMetadataInput | undefined;
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: (input: CreateSecretMetadataInput) => {
            captured = input;
            return Promise.resolve({ ok: true as const, value: fakeSecret() });
          },
        },
        eventsRepo: fakeEventsRepo(),
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(201);
    // created_by is a UUID column — must be the decoded form, not `usr_...`.
    expect(captured?.createdBy).toBe(TEST_USER_UUID);
  });

  it("returns 422 for a malformed actor id", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY" }),
      FAKE_ENV, "req1", { subjectId: "usr_short", subjectType: "user" }, ORG_SCOPE,
      {
        repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
        eventsRepo: fakeEventsRepo(),
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(422);
  });

  it("returns 409 on conflict", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "dup.key" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: false as const, error: { kind: "conflict" as const, entity: "secret_metadata" } }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(409);
  });

  it("event payload contains metadata only, no secret material", async () => {
    const secret = fakeSecret();
    const eventsRepo = fakeEventsRepo();
    await handleCreateSecret(
      makeJsonRequest({ secretKey: "DB_PASSWORD", displayName: "DB Pass" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: true as const, value: secret }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    const eventCall = eventsRepo.calls[0]!;
    const payload = eventCall.event.payload as EventPayload;
    expect(payload.operation).toBe("create");
    expect(payload.key).toBe("DB_PASSWORD");
    // Ensure no secret material in event
    expect(payload.value).toBeUndefined();
    expect(payload.plaintext).toBeUndefined();
    expect(payload.ciphertext).toBeUndefined();
    expect(payload.hash).toBeUndefined();
    // Ensure audit description is safe
    const auditDesc = eventCall.audit.description;
    expect(auditDesc).toContain("DB_PASSWORD");
    expect(auditDesc).not.toContain("secret_value");
  });

  it("returns 503 when event append fails", async () => {
    const secret = fakeSecret();
    const eventsRepo = failingEventsRepo();
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: true as const, value: secret }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(503);
  });

  it("response never contains plaintext/ciphertext/hash fields", async () => {
    const secret = fakeSecret();
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: true as const, value: secret }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    const body = (await res.json()) as JsonResp;
    const s = body.data.secret;
    expect(s.value).toBeUndefined();
    expect(s.plaintext).toBeUndefined();
    expect(s.ciphertext).toBeUndefined();
    expect(s.ciphertextEnvelope).toBeUndefined();
    expect(s.hash).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// handleRotateSecret tests
// ═══════════════════════════════════════════════════════════
describe("handleRotateSecret", () => {
  it("rotates secret metadata successfully", async () => {
    const existing = fakeSecret();
    const rotated = fakeSecret({ version: 2, lastRotatedAt: FIXED_NOW });
    const eventsRepo = fakeEventsRepo();
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: existing }),
          rotateSecretMetadata: () => Promise.resolve({ ok: true as const, value: rotated }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { secret: { version: number } } };
    expect(body.data.secret.version).toBe(2);
    expect(eventsRepo.calls).toHaveLength(1);
    const eventCall = eventsRepo.calls[0]!;
    expect((eventCall.event.payload as EventPayload).operation).toBe("rotate");
  });

  it("returns 404 when secret not found", async () => {
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when org route targets project-scoped secret (scope mismatch)", async () => {
    const projectSecret = fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID });
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: projectSecret }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when project route targets org-scoped secret", async () => {
    const orgSecret = fakeSecret();
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, PRJ_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: orgSecret }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when project route has mismatched projectId", async () => {
    const OTHER_PROJECT = "33333333-3333-3333-3333-333333333333";
    const projectSecret = fakeSecret({ scopeKind: "project", projectId: OTHER_PROJECT });
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, PRJ_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: projectSecret }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when environment route targets project-scoped secret", async () => {
    const projectSecret = fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID });
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, ENV_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: projectSecret }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("rejects secret material in rotate request body", async () => {
    // NOTE: "value" is now accepted for write-only encrypted storage (task-0065).
    // Test with a different forbidden field instead.
    const res = await handleRotateSecret(
      makeJsonRequest({ plaintext: "new_secret_value" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(422);
  });

  it("succeeds when project route matches project-scoped secret", async () => {
    const projectSecret = fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID });
    const rotated = fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID, version: 2 });
    const eventsRepo = fakeEventsRepo();
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, PRJ_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: projectSecret }),
          rotateSecretMetadata: () => Promise.resolve({ ok: true as const, value: rotated }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════
// handleRevokeSecret tests
// ═══════════════════════════════════════════════════════════
describe("handleRevokeSecret", () => {
  it("revokes secret metadata successfully", async () => {
    const existing = fakeSecret();
    const revoked = fakeSecret({ status: "revoked" });
    const eventsRepo = fakeEventsRepo();
    const res = await handleRevokeSecret(
      makeDeleteRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: existing }),
          revokeSecretMetadata: () => Promise.resolve({ ok: true as const, value: revoked }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { secret: { status: string } } };
    expect(body.data.secret.status).toBe("revoked");
    expect(eventsRepo.calls).toHaveLength(1);
    const eventCall = eventsRepo.calls[0]!;
    expect(eventCall.event.payload.operation).toBe("revoke");
  });

  it("returns 404 when secret not found", async () => {
    const res = await handleRevokeSecret(
      makeDeleteRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } }),
          revokeSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when org route targets project-scoped secret", async () => {
    const projectSecret = fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID });
    const res = await handleRevokeSecret(
      makeDeleteRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: projectSecret }),
          revokeSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when project route has mismatched projectId", async () => {
    const OTHER_PROJECT = "33333333-3333-3333-3333-333333333333";
    const projectSecret = fakeSecret({ scopeKind: "project", projectId: OTHER_PROJECT });
    const res = await handleRevokeSecret(
      makeDeleteRequest(), FAKE_ENV, "req1", ACTOR, PRJ_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: projectSecret }),
          revokeSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("event payload is safe (no secret material)", async () => {
    const existing = fakeSecret();
    const revoked = fakeSecret({ status: "revoked" });
    const eventsRepo = fakeEventsRepo();
    await handleRevokeSecret(
      makeDeleteRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: existing }),
          revokeSecretMetadata: () => Promise.resolve({ ok: true as const, value: revoked }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    const eventCall = eventsRepo.calls[0]!;
    expect(eventCall.event.payload.operation).toBe("revoke");
    expect(eventCall.event.payload.key).toBe("API_KEY");
    expect(eventCall.event.payload.value).toBeUndefined();
    expect(eventCall.event.payload.plaintext).toBeUndefined();
    expect(eventCall.event.subjectKind).toBe("secret");
  });
});

// ═══════════════════════════════════════════════════════════
// parseSecretMetadataPublicId tests
// ═══════════════════════════════════════════════════════════
describe("parseSecretMetadataPublicId", () => {
  it("parses valid sec_ ID", () => {
    const uuid = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const publicId = secretMetadataPublicId(uuid);
    expect(parseSecretMetadataPublicId(publicId)).toBe(uuid);
  });

  it("returns null for wrong prefix", () => {
    expect(parseSecretMetadataPublicId("stg_cccccccccccccccccccccccccccccccc")).toBeNull();
  });

  it("returns null for malformed hex", () => {
    expect(parseSecretMetadataPublicId("sec_xyz")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// Router integration tests for secret routes
// ═══════════════════════════════════════════════════════════
describe("config-worker router - secret mutations", () => {
  const SECRET_PUBLIC = secretMetadataPublicId(SECRET_UUID);

  function routerRequest(path: string, method: string, body?: unknown): Request {
    const init: RequestInit = {
      method,
      headers: {
        "x-request-id": "req_test",
        "x-actor-subject-id": TEST_USER_ID,
        "x-actor-subject-type": "user",
      },
    };
    if (body !== undefined) {
      (init.headers as Record<string, string>)["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return new Request(`https://config-worker${path}`, init);
  }

  // POST create
  it("routes POST to org secrets (create) — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets`, "POST", { secretKey: "API_KEY" });
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  it("routes POST to project secrets (create) — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/config/secrets`, "POST", { secretKey: "API_KEY" });
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  it("routes POST to environment secrets (create) — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/environments/${TEST_ENV_PUBLIC}/config/secrets`, "POST", { secretKey: "API_KEY" });
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  // POST rotate
  it("routes POST to org secret rotate — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}/rotate`, "POST");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  it("routes POST to project secret rotate — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/config/secrets/${SECRET_PUBLIC}/rotate`, "POST");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  it("routes POST to environment secret rotate — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/environments/${TEST_ENV_PUBLIC}/config/secrets/${SECRET_PUBLIC}/rotate`, "POST");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  // DELETE revoke
  it("routes DELETE to org secret (revoke) — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}`, "DELETE");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  it("routes DELETE to project secret (revoke) — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/config/secrets/${SECRET_PUBLIC}`, "DELETE");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  it("routes DELETE to environment secret (revoke) — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/environments/${TEST_ENV_PUBLIC}/config/secrets/${SECRET_PUBLIC}`, "DELETE");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  // Method restrictions
  it("returns 405 for GET on secret item route", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}`, "GET");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(405);
  });

  it("routes PATCH on the secret item route to repoint (brokered-orphan-safety, Feature 7)", async () => {
    // PATCH is now a live verb (repoint a brokered binding), not method-not-
    // allowed. An empty body reaches the repoint handler and fails validation
    // (400), proving the route resolved rather than returning 405.
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}`, "PATCH");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(400);
  });

  it("returns 405 for GET on rotate route", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}/rotate`, "GET");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(405);
  });

  it("returns 404 for malformed secret ID in route", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/bad_id`, "DELETE");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(404);
  });

  it("returns 401 for DELETE without actor headers", async () => {
    const req = new Request(
      `https://config-worker/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}`,
      { method: "DELETE" },
    );
    const res = await route(req, {} as Env);
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════
// Brokered secrets (saas-integration-hub IH7)
// ═══════════════════════════════════════════════════════════

const CONN_PUBLIC = "int_" + "cd".repeat(16);
const CONN_UUID = "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd";
const BROKERED_POINTER = JSON.stringify({
  v: "brokered",
  provider: { connectionId: CONN_PUBLIC, template: "workers-deploy", params: { accountId: "acc-1" } },
});

function brokeredSecret(overrides?: Partial<SecretMetadata>): SecretMetadata {
  return fakeSecret({
    secretKey: "CF_TOKEN",
    source: "brokered",
    bindingProvider: "cloudflare",
    bindingConnectionId: CONN_UUID,
    bindingTemplate: "workers-deploy",
    ...overrides,
  });
}

const allowedUnlimited = () =>
  Promise.resolve({
    kind: "decision" as const,
    decision: {
      allowed: true as const,
      orgId: TEST_ORG_PUBLIC,
      entitlementKey: "limit.brokered_secrets",
      valueType: "quantity" as const,
      limitValue: null,
      source: "plan" as const,
      subscriptionId: null,
    },
  });

const validationOk = () =>
  Promise.resolve({ ok: true as const, provider: "cloudflare", maxTtlSeconds: 900, supportedModes: ["brokered", "rotated"] as const });

const throwingAdapter = {
  encrypt: () => {
    throw new Error("the encryption adapter must not run for a brokered create");
  },
};

describe("handleCreateSecret — brokered binding (IH7)", () => {
  it("persists the binding pointer + facts, skips encryption, and emits SECRET_BINDING_CREATED", async () => {
    let captured: CreateSecretMetadataInput | undefined;
    const eventsRepo = fakeEventsRepo();
    const res = await handleCreateSecret(
      makeJsonRequest({
        secretKey: "CF_TOKEN",
        binding: { connectionId: CONN_PUBLIC, template: "workers-deploy", params: { accountId: "acc-1" } },
      }),
      FAKE_ENV, "req_b1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: (input: CreateSecretMetadataInput) => {
            captured = input;
            return Promise.resolve({ ok: true as const, value: brokeredSecret() });
          },
        },
        eventsRepo,
        encryptionAdapter: throwingAdapter,
        checkEntitlement: allowedUnlimited,
        validateBinding: validationOk,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(201);
    // The persisted row is a brokered head: pointer envelope, binding facts.
    expect(captured?.source).toBe("brokered");
    expect(captured?.bindingProvider).toBe("cloudflare");
    expect(captured?.bindingConnectionId).toBe(CONN_UUID);
    expect(captured?.bindingTemplate).toBe("workers-deploy");
    expect(captured?.ciphertextEnvelope).toBe(BROKERED_POINTER);
    // Public projection carries source + display-only binding, never params.
    const body = (await res.json()) as { data: { secret: { source?: string; binding?: { provider: string; connectionId: string; template: string } } } };
    expect(body.data.secret.source).toBe("brokered");
    expect(body.data.secret.binding).toEqual({ provider: "cloudflare", connectionId: CONN_PUBLIC, template: "workers-deploy" });
    // Both events: the existing secrets.updated AND the binding announcement.
    expect(eventsRepo.calls).toHaveLength(2);
    expect(eventsRepo.calls[0]!.event.type).toBe("secrets.updated");
    const bindingEvt = eventsRepo.calls[1]!;
    expect(bindingEvt.event.type).toBe("integration.secret_binding.created");
    expect(bindingEvt.event.payload).toEqual({
      key: "CF_TOKEN",
      scope: "organization",
      provider: "cloudflare",
      connectionId: CONN_PUBLIC,
      template: "workers-deploy",
    });
    expect(JSON.stringify(bindingEvt)).not.toContain("acc-1"); // NEVER params
    expect(bindingEvt.audit.description).toContain("CF_TOKEN");
    expect(bindingEvt.audit.description).toContain("cloudflare/workers-deploy");
  });

  it("omits the params key from the pointer when params are empty", async () => {
    let captured: CreateSecretMetadataInput | undefined;
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "CF_TOKEN", binding: { connectionId: CONN_PUBLIC, template: "workers-deploy", params: {} } }),
      FAKE_ENV, "req_b2", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: (input: CreateSecretMetadataInput) => {
            captured = input;
            return Promise.resolve({ ok: true as const, value: brokeredSecret() });
          },
        },
        checkEntitlement: allowedUnlimited,
        validateBinding: validationOk,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(201);
    expect(captured?.ciphertextEnvelope).toBe(
      JSON.stringify({ v: "brokered", provider: { connectionId: CONN_PUBLIC, template: "workers-deploy" } }),
    );
  });

  it("rejects binding + value as mutually exclusive (422)", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "CF_TOKEN", value: "v", binding: { connectionId: CONN_PUBLIC, template: "workers-deploy" } }),
      FAKE_ENV, "req_b3", ACTOR, ORG_SCOPE,
      { repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() } },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as JsonResp;
    expect(body.error.details?.fields?.binding).toBeDefined();
  });

  it("rejects binding + personal (400: a personal secret cannot be brokered)", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "CF_TOKEN", personal: true, binding: { connectionId: CONN_PUBLIC, template: "workers-deploy" } }),
      FAKE_ENV, "req_b4", ACTOR, ENV_SCOPE,
      { repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as JsonResp;
    expect(body.error.message).toBe("A personal secret cannot be brokered");
  });

  it("rejects malformed binding shapes (connectionId, template, params) with 422", async () => {
    const badBindings = [
      "not-an-object",
      { connectionId: "bogus", template: "workers-deploy" },
      { connectionId: CONN_PUBLIC, template: "Not_A_Template!" },
      { connectionId: CONN_PUBLIC, template: "workers-deploy", params: ["not", "an", "object"] },
      { connectionId: CONN_PUBLIC, template: "workers-deploy", params: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i])) },
    ];
    for (const binding of badBindings) {
      const res = await handleCreateSecret(
        makeJsonRequest({ secretKey: "CF_TOKEN", binding }),
        FAKE_ENV, "req_b5", ACTOR, ORG_SCOPE,
        { repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() } },
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as JsonResp;
      expect(body.error.details?.fields?.binding).toBeDefined();
    }
  });

  it("returns 412 limit_reached when live brokered bindings meet the plan limit", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "CF_TOKEN", binding: { connectionId: CONN_PUBLIC, template: "workers-deploy" } }),
      FAKE_ENV, "req_b6", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          countBrokeredSecrets: () => Promise.resolve({ ok: true as const, value: 1 }),
        },
        checkEntitlement: () =>
          Promise.resolve({
            kind: "decision" as const,
            decision: {
              allowed: true as const,
              orgId: TEST_ORG_PUBLIC,
              entitlementKey: "limit.brokered_secrets",
              valueType: "quantity" as const,
              limitValue: 1,
              source: "plan" as const,
              subscriptionId: null,
            },
          }),
        validateBinding: validationOk,
      },
    );
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { code: string; details: { reason: string; entitlementKey: string; limit: number } } };
    expect(body.error.code).toBe("precondition_failed");
    expect(body.error.details.reason).toBe("limit_reached");
    expect(body.error.details.entitlementKey).toBe("limit.brokered_secrets");
    expect(body.error.details.limit).toBe(1);
  });

  it("returns 412 with the billing reason when the entitlement is denied", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "CF_TOKEN", binding: { connectionId: CONN_PUBLIC, template: "workers-deploy" } }),
      FAKE_ENV, "req_b7", ACTOR, ORG_SCOPE,
      {
        repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
        checkEntitlement: () =>
          Promise.resolve({
            kind: "decision" as const,
            decision: {
              allowed: false as const,
              orgId: TEST_ORG_PUBLIC,
              entitlementKey: "limit.brokered_secrets",
              reason: "disabled" as const,
            },
          }),
        validateBinding: validationOk,
      },
    );
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { details: { reason: string; entitlementKey: string } } };
    expect(body.error.details.reason).toBe("disabled");
    expect(body.error.details.entitlementKey).toBe("limit.brokered_secrets");
  });

  it("returns 503 on a billing service error and when the entitlement seam is missing", async () => {
    const serviceError = await handleCreateSecret(
      makeJsonRequest({ secretKey: "CF_TOKEN", binding: { connectionId: CONN_PUBLIC, template: "workers-deploy" } }),
      FAKE_ENV, "req_b8", ACTOR, ORG_SCOPE,
      {
        repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
        checkEntitlement: () => Promise.resolve({ kind: "service_error" as const }),
        validateBinding: validationOk,
      },
    );
    expect(serviceError.status).toBe(503);

    // Fail closed: a brokered create with no entitlement seam cannot proceed.
    const noSeam = await handleCreateSecret(
      makeJsonRequest({ secretKey: "CF_TOKEN", binding: { connectionId: CONN_PUBLIC, template: "workers-deploy" } }),
      FAKE_ENV, "req_b9", ACTOR, ORG_SCOPE,
      { repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() } },
    );
    expect(noSeam.status).toBe(503);
  });

  it("maps validate-binding failures: connection_not_found → 404, connection_inactive → 412, template_unknown → 422", async () => {
    const cases: Array<{ reason: string; status: number }> = [
      { reason: "connection_not_found", status: 404 },
      { reason: "connection_inactive", status: 412 },
      { reason: "template_unknown", status: 422 },
      { reason: "params_invalid", status: 422 },
      { reason: "capability_not_supported", status: 422 },
    ];
    for (const c of cases) {
      const res = await handleCreateSecret(
        makeJsonRequest({ secretKey: "CF_TOKEN", binding: { connectionId: CONN_PUBLIC, template: "workers-deploy" } }),
        FAKE_ENV, "req_b10", ACTOR, ORG_SCOPE,
        {
          repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
          checkEntitlement: allowedUnlimited,
          validateBinding: () => Promise.resolve({ ok: false as const, status: c.status, reason: c.reason }),
        },
      );
      expect(res.status).toBe(c.status);
    }
  });
});

describe("handleRotateSecret — brokered guard (SC2)", () => {
  it("rejects a VALUE rotation on a brokered head (scoped credentials have no stored value)", async () => {
    const res = await handleRotateSecret(
      makeJsonRequest({ value: "new-value" }), FAKE_ENV, "req_b11", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: brokeredSecret() }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
        eventsRepo: fakeEventsRepo(),
        encryptionAdapter: { encrypt: () => Promise.resolve({ alg: "AES-256-GCM" as const, v: 1 as const, iv: "aaa", ct: "bbb" }) },
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string; details: { reason: string } } };
    expect(body.error.code).toBe("unsupported");
    expect(body.error.message).toContain("no stored value");
    expect(body.error.details.reason).toBe("brokered");
  });

  it("rotates a scoped credential: rolls the source + stamps, no value required", async () => {
    let touched: { rotationPolicy?: string | null; stampRotation: boolean } | null = null;
    let rotatedConnectionId: string | null = null;
    const head = brokeredSecret();
    const res = await handleRotateSecret(
      makeJsonRequest({ rotationPolicy: "90d" }), FAKE_ENV, "req_b12", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: head }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          touchBrokeredRotation: (_o, _id, input) => {
            touched = input;
            return Promise.resolve({ ok: true as const, value: { ...head, rotationPolicy: "90d" } });
          },
        },
        eventsRepo: fakeEventsRepo(),
        rotateSource: (req) => {
          rotatedConnectionId = req.connectionId;
          return Promise.resolve({ ok: true as const, rotatedAt: "2026-07-18T00:00:00Z" });
        },
      },
    );
    expect(res.status).toBe(200);
    // The source was rolled for the bound connection, and the cadence stamped.
    expect(rotatedConnectionId).toBe(head.bindingConnectionId);
    expect(touched).toEqual({ rotationPolicy: "90d", stampRotation: true });
  });

  it("edits the cadence only when rotate:false — no source roll", async () => {
    let rolled = false;
    const head = brokeredSecret();
    const res = await handleRotateSecret(
      makeJsonRequest({ rotationPolicy: "30d", rotate: false }), FAKE_ENV, "req_b13", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: head }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          touchBrokeredRotation: () => Promise.resolve({ ok: true as const, value: { ...head, rotationPolicy: "30d" } }),
        },
        eventsRepo: fakeEventsRepo(),
        rotateSource: () => {
          rolled = true;
          return Promise.resolve({ ok: true as const, rotatedAt: "x" });
        },
      },
    );
    expect(res.status).toBe(200);
    expect(rolled).toBe(false);
  });

  it("surfaces rotation_unsupported (e.g. a pasted token Orun can't roll) as 400", async () => {
    const head = brokeredSecret();
    const res = await handleRotateSecret(
      makeJsonRequest({}), FAKE_ENV, "req_b14", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: head }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          touchBrokeredRotation: () => unusedConfigFailure<SecretMetadata>(),
        },
        eventsRepo: fakeEventsRepo(),
        rotateSource: () => Promise.resolve({ ok: false as const, status: 400, reason: "rotation_unsupported" }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("rotation_unsupported");
  });
});

describe("handleRevokeSecret — brokered binding removal (IH7)", () => {
  it("emits SECRET_BINDING_REMOVED alongside secrets.updated when revoking a brokered head", async () => {
    const eventsRepo = fakeEventsRepo();
    const res = await handleRevokeSecret(
      makeDeleteRequest(), FAKE_ENV, "req_b12", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: brokeredSecret() }),
          revokeSecretMetadata: () => Promise.resolve({ ok: true as const, value: brokeredSecret({ status: "revoked" }) }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(200);
    expect(eventsRepo.calls).toHaveLength(2);
    expect(eventsRepo.calls[0]!.event.type).toBe("secrets.updated");
    const removal = eventsRepo.calls[1]!;
    expect(removal.event.type).toBe("integration.secret_binding.removed");
    expect(removal.event.payload).toEqual({
      key: "CF_TOKEN",
      provider: "cloudflare",
      connectionId: CONN_PUBLIC,
      template: "workers-deploy",
    });
  });

  it("does NOT emit a binding-removal event for a static head", async () => {
    const eventsRepo = fakeEventsRepo();
    await handleRevokeSecret(
      makeDeleteRequest(), FAKE_ENV, "req_b13", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: fakeSecret() }),
          revokeSecretMetadata: () => Promise.resolve({ ok: true as const, value: fakeSecret({ status: "revoked" }) }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(eventsRepo.calls).toHaveLength(1);
    expect(eventsRepo.calls[0]!.event.type).toBe("secrets.updated");
  });
});

// ═══════════════════════════════════════════════════════════
// Rotated create (provider-rotated-secrets RS1): one deliberate
// purpose:"rotation" mint from the connected parent, encrypted and stored as
// v1; the rotation_* producer stamped for the RS2 engine.
// ═══════════════════════════════════════════════════════════

describe("handleCreateSecret — rotated create (provider-rotated-secrets RS1)", () => {
  const MINT_EXPIRES = "2026-02-15T10:00:00.000Z";

  function rotatedSecret(overrides?: Partial<SecretMetadata>): SecretMetadata {
    return fakeSecret({
      secretKey: "CF_TOKEN",
      rotationPolicy: "30d",
      rotationProvider: "cloudflare",
      rotationConnectionId: CONN_UUID,
      rotationTemplate: "workers-deploy",
      expiresAt: new Date(MINT_EXPIRES),
      ...overrides,
    });
  }

  /** Records the mint request; returns a reveal-once value. */
  function fakeMint(outcome?: { fail?: { status: number; reason: string } }) {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      fn: (req: Record<string, unknown>) => {
        calls.push(req);
        if (outcome?.fail) {
          return Promise.resolve({ ok: false as const, status: outcome.fail.status, reason: outcome.fail.reason });
        }
        return Promise.resolve({
          ok: true as const,
          value: "cf-minted-token-SECRET",
          mintId: "mint_" + "ab".repeat(16),
          provider: "cloudflare",
          template: "workers-deploy",
          expiresAt: MINT_EXPIRES,
        });
      },
    };
  }

  /** Marks the ciphertext so tests can assert the MINTED value was encrypted. */
  const markingAdapter = {
    encrypt: (plaintext: string) =>
      Promise.resolve({ alg: "AES-256-GCM" as const, v: 1 as const, iv: "test-iv", ct: `ENC(${plaintext.length})` }),
  };

  it("mints purpose rotation, encrypts the minted v1, and stamps the producer", async () => {
    let captured: CreateSecretMetadataInput | undefined;
    const mint = fakeMint();
    const eventsRepo = fakeEventsRepo();
    const res = await handleCreateSecret(
      makeJsonRequest({
        secretKey: "CF_TOKEN",
        rotation: { connectionId: CONN_PUBLIC, template: "workers-deploy", params: { accountId: "acc-1" }, deliverTarget: "cloudflare-worker:api-prod" },
      }),
      FAKE_ENV, "req_r1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: (input: CreateSecretMetadataInput) => {
            captured = input;
            return Promise.resolve({ ok: true as const, value: rotatedSecret() });
          },
        },
        eventsRepo,
        encryptionAdapter: markingAdapter,
        validateBinding: validationOk,
        mintRotation: mint.fn as never,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(201);
    // The mint request: purpose rotation, TTL = default 30d interval + 24h grace.
    expect(mint.calls).toHaveLength(1);
    expect(mint.calls[0]!.purpose).toBe("rotation");
    expect(mint.calls[0]!.ttlSeconds).toBe(30 * 86400 + 86400);
    expect(mint.calls[0]!.connectionId).toBe(CONN_PUBLIC);
    // Persisted: static source, ENCRYPTED minted value, the producer columns,
    // the defaulted schedule, and the mint expiry surfaced as expires_at.
    expect(captured?.source ?? "static").toBe("static");
    expect(captured?.ciphertextEnvelope).toBe(
      JSON.stringify({ alg: "AES-256-GCM", v: 1, iv: "test-iv", ct: "ENC(22)" }),
    );
    expect(captured?.rotationProvider).toBe("cloudflare");
    expect(captured?.rotationConnectionId).toBe(CONN_UUID);
    expect(captured?.rotationTemplate).toBe("workers-deploy");
    expect(captured?.rotationParams).toEqual({ accountId: "acc-1" });
    expect(captured?.rotationDeliverTarget).toBe("cloudflare-worker:api-prod");
    expect(captured?.rotationPolicy).toBe("30d");
    expect(captured?.expiresAt?.toISOString()).toBe(MINT_EXPIRES);
    // Reveal-once: the minted value appears NOWHERE outside the envelope.
    const resBody = (await res.json()) as {
      data: { secret: { source?: string; rotation?: Record<string, unknown> } };
    };
    const bodyText = JSON.stringify(resBody);
    expect(bodyText).not.toContain("cf-minted-token-SECRET");
    expect(JSON.stringify(eventsRepo.calls)).not.toContain("cf-minted-token-SECRET");
    // RS4 projection: the rotation producer facts are public display provenance
    // (public connection id, never params); the secret reads as static.
    expect(resBody.data.secret.source ?? "static").toBe("static");
    expect(resBody.data.secret.rotation).toEqual({
      provider: "cloudflare",
      connectionId: CONN_PUBLIC,
      template: "workers-deploy",
      graceSeconds: null,
      deliverTarget: null,
    });
  });

  it("honors an explicit rotationPolicy + graceSeconds in the mint TTL", async () => {
    const mint = fakeMint();
    const res = await handleCreateSecret(
      makeJsonRequest({
        secretKey: "CF_TOKEN",
        rotationPolicy: "7d",
        rotation: { connectionId: CONN_PUBLIC, template: "workers-deploy", graceSeconds: 3600 },
      }),
      FAKE_ENV, "req_r2", ACTOR, ORG_SCOPE,
      {
        repo: { createSecretMetadata: () => Promise.resolve({ ok: true as const, value: rotatedSecret({ rotationPolicy: "7d", rotationGraceSeconds: 3600 }) }) },
        encryptionAdapter: markingAdapter,
        validateBinding: validationOk,
        mintRotation: mint.fn as never,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(201);
    expect(mint.calls[0]!.ttlSeconds).toBe(7 * 86400 + 3600);
  });

  it("rejects rotation + value and rotation + binding as mutually exclusive (422)", async () => {
    for (const extra of [{ value: "v" }, { binding: { connectionId: CONN_PUBLIC, template: "workers-deploy" } }]) {
      const res = await handleCreateSecret(
        makeJsonRequest({ secretKey: "CF_TOKEN", rotation: { connectionId: CONN_PUBLIC, template: "workers-deploy" }, ...extra }),
        FAKE_ENV, "req_r3", ACTOR, ORG_SCOPE,
        { repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() } },
      );
      expect(res.status).toBe(422);
    }
  });

  it("rejects a personal rotated secret (400)", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "CF_TOKEN", personal: true, rotation: { connectionId: CONN_PUBLIC, template: "workers-deploy" } }),
      FAKE_ENV, "req_r4", ACTOR, ENV_SCOPE,
      { repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() } },
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unparseable rotationPolicy on a rotated create (422)", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "CF_TOKEN", rotationPolicy: "monthly", rotation: { connectionId: CONN_PUBLIC, template: "workers-deploy" } }),
      FAKE_ENV, "req_r5", ACTOR, ORG_SCOPE,
      { repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() } },
    );
    expect(res.status).toBe(422);
  });

  it("412s a refused mint and persists NOTHING", async () => {
    let created = false;
    const mint = fakeMint({ fail: { status: 412, reason: "parent_grant_insufficient" } });
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "CF_TOKEN", rotation: { connectionId: CONN_PUBLIC, template: "workers-deploy" } }),
      FAKE_ENV, "req_r6", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => {
            created = true;
            return unusedConfigFailure<SecretMetadata>();
          },
        },
        encryptionAdapter: markingAdapter,
        validateBinding: validationOk,
        mintRotation: mint.fn as never,
      },
    );
    expect(res.status).toBe(412);
    expect(created).toBe(false);
  });

  it("503s a broker outage and persists NOTHING (fail closed)", async () => {
    let created = false;
    const mint = fakeMint({ fail: { status: 503, reason: "unavailable" } });
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "CF_TOKEN", rotation: { connectionId: CONN_PUBLIC, template: "workers-deploy" } }),
      FAKE_ENV, "req_r7", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => {
            created = true;
            return unusedConfigFailure<SecretMetadata>();
          },
        },
        encryptionAdapter: markingAdapter,
        validateBinding: validationOk,
        mintRotation: mint.fn as never,
      },
    );
    expect(res.status).toBe(503);
    expect(created).toBe(false);
  });

  it("fails closed (503) when no rotation minter is available", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "CF_TOKEN", rotation: { connectionId: CONN_PUBLIC, template: "workers-deploy" } }),
      FAKE_ENV, "req_r8", ACTOR, ORG_SCOPE,
      {
        repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
        encryptionAdapter: markingAdapter,
        validateBinding: validationOk,
      },
    );
    expect(res.status).toBe(503);
  });

  it("rejects a rotated create when the provider does not declare `rotated` (SP0b, 400)", async () => {
    let minted = false;
    let created = false;
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "SB_TOKEN", rotation: { connectionId: CONN_PUBLIC, template: "management-access" } }),
      FAKE_ENV, "req_r9", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => {
            created = true;
            return unusedConfigFailure<SecretMetadata>();
          },
        },
        encryptionAdapter: markingAdapter,
        // A brokered-only provider (Supabase) — supportedModes lacks "rotated".
        validateBinding: () =>
          Promise.resolve({ ok: true as const, provider: "supabase", maxTtlSeconds: 3600, supportedModes: ["brokered"] as const }),
        mintRotation: (() => {
          minted = true;
          return unusedConfigFailure<SecretMetadata>();
        }) as never,
      },
    );
    expect(res.status).toBe(400);
    // Rejected BEFORE the mint and BEFORE any DB write.
    expect(minted).toBe(false);
    expect(created).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// Rotate-now for provider-rotated secrets (RS3 break-glass):
// the operator "roll it NOW" runs the same mint→encrypt→append
// path the RS2 engine runs on schedule.
// ═══════════════════════════════════════════════════════════

describe("handleRotateSecret — provider-rotated (RS3 rotate-now)", () => {
  const RS3_MINT_EXPIRES = "2026-02-20T10:00:00.000Z";

  function providerRotatedHead(overrides?: Partial<SecretMetadata>): SecretMetadata {
    return fakeSecret({
      secretKey: "CF_TOKEN",
      rotationPolicy: "30d",
      rotationProvider: "cloudflare",
      rotationConnectionId: CONN_UUID,
      rotationTemplate: "workers-deploy",
      ...overrides,
    });
  }

  function rs3Mint(fail?: { status: number; reason: string }) {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      fn: (req: Record<string, unknown>) => {
        calls.push(req);
        if (fail) return Promise.resolve({ ok: false as const, status: fail.status, reason: fail.reason });
        return Promise.resolve({
          ok: true as const,
          value: "cf-rotate-now-SECRET",
          mintId: "mint_" + "aa".repeat(16),
          provider: "cloudflare",
          template: "workers-deploy",
          expiresAt: RS3_MINT_EXPIRES,
        });
      },
    };
  }

  const rs3Adapter = {
    encrypt: (plaintext: string) =>
      Promise.resolve({ alg: "AES-256-GCM" as const, v: 1 as const, iv: "iv3", ct: `ENC(${plaintext.length})` }),
  };

  it("re-mints (purpose rotation, TTL = interval + grace), appends, and emits secret.rotated with actor attribution", async () => {
    const mint = rs3Mint();
    const eventsRepo = fakeEventsRepo();
    let stored: { envelope: string; expiresAt: Date | null } | undefined;
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req_p1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: providerRotatedHead() }),
          rotateSecretMetadata: () => {
            throw new Error("the static rotate path must not run for a provider-rotated head");
          },
          rotateProviderSecret: (_o, _i, _b, envelope, expiresAt) => {
            stored = { envelope, expiresAt };
            return Promise.resolve({
              ok: true as const,
              value: providerRotatedHead({ version: 2, expiresAt: new Date(RS3_MINT_EXPIRES) }),
            });
          },
        },
        eventsRepo,
        encryptionAdapter: rs3Adapter,
        mintRotation: mint.fn as never,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(200);
    expect(mint.calls[0]!.purpose).toBe("rotation");
    expect(mint.calls[0]!.connectionId).toBe(CONN_PUBLIC);
    expect(mint.calls[0]!.ttlSeconds).toBe(30 * 86400 + 86400);
    expect(mint.calls[0]!.requestedBy).toBe(ACTOR.subjectId);
    expect(stored?.envelope).toBe(JSON.stringify({ alg: "AES-256-GCM", v: 1, iv: "iv3", ct: "ENC(20)" }));
    expect(stored?.expiresAt?.toISOString()).toBe(RS3_MINT_EXPIRES);
    const evt = eventsRepo.calls[0]!;
    expect(evt.event.type).toBe("secret.rotated");
    expect(evt.event.actorId).toBe(ACTOR.subjectId);
    expect(evt.event.payload).toMatchObject({ key: "CF_TOKEN", version: 2, deliveryRequired: false });
    // Reveal-once: the minted value appears nowhere.
    expect(JSON.stringify(await res.json())).not.toContain("cf-rotate-now-SECRET");
    expect(JSON.stringify(eventsRepo.calls)).not.toContain("cf-rotate-now-SECRET");
  });

  it("rejects a caller-supplied value on a provider-rotated head (400)", async () => {
    const res = await handleRotateSecret(
      makeJsonRequest({ value: "v" }, "POST"), FAKE_ENV, "req_p2", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: providerRotatedHead() }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
        encryptionAdapter: rs3Adapter,
      },
    );
    expect(res.status).toBe(400);
  });

  it("rejects a cadence edit on rotate for a provider-rotated head (422)", async () => {
    const res = await handleRotateSecret(
      makeJsonRequest({ rotationPolicy: "7d" }, "POST"), FAKE_ENV, "req_p3", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: providerRotatedHead() }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
        encryptionAdapter: rs3Adapter,
      },
    );
    expect(res.status).toBe(422);
  });

  it("412s a refused mint and stores NOTHING (non-destructive)", async () => {
    const mint = rs3Mint({ status: 412, reason: "parent_grant_insufficient" });
    let storeCalled = false;
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req_p4", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: providerRotatedHead() }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          rotateProviderSecret: () => {
            storeCalled = true;
            return unusedConfigFailure<SecretMetadata>();
          },
        },
        encryptionAdapter: rs3Adapter,
        mintRotation: mint.fn as never,
      },
    );
    expect(res.status).toBe(412);
    expect(storeCalled).toBe(false);
  });

  it("fails closed (503) when no rotation minter is available", async () => {
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req_p5", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: providerRotatedHead() }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          rotateProviderSecret: () => unusedConfigFailure<SecretMetadata>(),
        },
        encryptionAdapter: rs3Adapter,
      },
    );
    expect(res.status).toBe(503);
  });
});
