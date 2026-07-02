// Break-glass reveal handler (saas-secret-manager SEC7, pairs orun-secrets SD-3).
//
// The ONE human value-returning route: elevated (secret.reveal) + audited. These
// tests assert the value round-trips on the happy path, that the mandatory reason
// is enforced, that deny → 403 / unknown → 404, and — the security invariant —
// that the emitted secret.revealed event + audit carry the reason but NEVER the
// value.

import { handleRevealSecret } from "@config-worker/handlers/reveal-secret";
import { route } from "@config-worker/router";
import { secretMetadataPublicId } from "@config-worker/ids";
import type { Env } from "@config-worker/env";
import type { ActorContext } from "@config-worker/router";
import type { Scope, SecretMetadata, ConfigResult } from "@saas/db/config";
import type { PolicyResource } from "@saas/contracts/policy";
import type {
  AppendEventWithAuditInput,
  EventsResult,
  StoredEvent,
  StoredAuditEntry,
} from "@saas/db/events";

// ── Constants ──────────────────────────────────────────────
const TEST_ORG_UUID = "11111111-1111-1111-1111-111111111111";
const TEST_PROJECT_UUID = "22222222-2222-2222-2222-222222222222";
const TEST_USER_ID = "usr_" + "ab".repeat(16);
const FIXED_NOW = new Date("2026-07-02T00:00:00Z");
const FIXED_ID = "deadbeef01234567";
const SECRET_UUID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PLAINTEXT = "super-secret-value";

const ACTOR: ActorContext = { subjectId: TEST_USER_ID, subjectType: "user" };
const ORG_SCOPE: Scope = { kind: "organization", orgId: TEST_ORG_UUID };
const PRJ_SCOPE: Scope = { kind: "project", orgId: TEST_ORG_UUID, projectId: TEST_PROJECT_UUID };
const FAKE_ENV = {} as Env;

const TEST_ORG_PUBLIC = "org_11111111111111111111111111111111";

// ── Placeholders for the events fake ───────────────────────
const PLACEHOLDER_EVENT = { id: "evt_x" } as unknown as StoredEvent;
const PLACEHOLDER_AUDIT = { id: "aud_x" } as unknown as StoredAuditEntry;

function makeRevealRequest(body: unknown, search = ""): Request {
  return new Request(`https://config-worker/reveal${search}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

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
    version: 3,
    rotationPolicy: null,
    lastRotatedAt: null,
    expiresAt: null,
    createdBy: TEST_USER_ID,
    personalOwner: null,
    overridable: true,
    lastUsedAt: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

type FakeEventsRepo = {
  calls: AppendEventWithAuditInput[];
  appendEventWithAudit: (
    input: AppendEventWithAuditInput,
  ) => Promise<EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>>;
};

function fakeEventsRepo(ok = true): FakeEventsRepo {
  const calls: AppendEventWithAuditInput[] = [];
  return {
    calls,
    appendEventWithAudit(input) {
      calls.push(input);
      return Promise.resolve(
        ok
          ? { ok: true as const, value: { event: PLACEHOLDER_EVENT, audit: PLACEHOLDER_AUDIT } }
          : { ok: false as const, error: { kind: "internal" as const, message: "event store down" } },
      );
    },
  };
}

interface RevealDepsOpts {
  secret?: ConfigResult<SecretMetadata>;
  cipher?: ConfigResult<string>;
  allow?: boolean;
  decrypt?: (envelope: string, orgId: string) => Promise<string>;
  eventsRepo?: FakeEventsRepo;
  authorizeCalls?: { action: string; resource: PolicyResource }[];
}

function makeDeps(opts: RevealDepsOpts = {}) {
  const authorizeCalls = opts.authorizeCalls ?? [];
  return {
    repo: {
      getSecretMetadata: () =>
        Promise.resolve(opts.secret ?? ({ ok: true as const, value: fakeSecret() })),
      getSecretCiphertext: () =>
        Promise.resolve(opts.cipher ?? ({ ok: true as const, value: "envelope-json" })),
    },
    eventsRepo: opts.eventsRepo ?? fakeEventsRepo(),
    authorize: (action: string, resource: PolicyResource) => {
      authorizeCalls.push({ action, resource });
      return Promise.resolve(opts.allow ?? true);
    },
    decrypt: opts.decrypt ?? (() => Promise.resolve(PLAINTEXT)),
    generateId: () => FIXED_ID,
    now: () => FIXED_NOW,
  };
}

describe("handleRevealSecret", () => {
  it("happy path: returns the plaintext value + version", async () => {
    const deps = makeDeps();
    const res = await handleRevealSecret(
      makeRevealRequest({ reason: "prod incident 42" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID, deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { secret: { value: string; version: number } } };
    expect(body.data.secret.value).toBe(PLAINTEXT);
    expect(body.data.secret.version).toBe(3);
  });

  it("honours an explicit ?version= pin", async () => {
    let requestedVersion = -1;
    const deps = makeDeps();
    deps.repo.getSecretCiphertext = ((_id: string, v: number) => {
      requestedVersion = v;
      return Promise.resolve({ ok: true as const, value: "envelope-json" });
    }) as typeof deps.repo.getSecretCiphertext;
    const res = await handleRevealSecret(
      makeRevealRequest({ reason: "rollback check" }, "?version=2"),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID, deps,
    );
    expect(res.status).toBe(200);
    expect(requestedVersion).toBe(2);
    const body = (await res.json()) as { data: { secret: { version: number } } };
    expect(body.data.secret.version).toBe(2);
  });

  it("returns 422 when reason is missing", async () => {
    const res = await handleRevealSecret(
      makeRevealRequest({}),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID, makeDeps(),
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when reason is empty/whitespace", async () => {
    const res = await handleRevealSecret(
      makeRevealRequest({ reason: "   " }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID, makeDeps(),
    );
    expect(res.status).toBe(422);
  });

  it("evaluates the elevated secret.reveal action and returns 403 when denied", async () => {
    const authorizeCalls: { action: string; resource: PolicyResource }[] = [];
    const res = await handleRevealSecret(
      makeRevealRequest({ reason: "attempted access" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      makeDeps({ allow: false, authorizeCalls }),
    );
    expect(res.status).toBe(403);
    // The RBAC action asserted on the policy mock.
    expect(authorizeCalls).toHaveLength(1);
    expect(authorizeCalls[0]!.action).toBe("secret.reveal");
    expect(authorizeCalls[0]!.resource.kind).toBe("organization");
  });

  it("returns 404 for an unknown secret id", async () => {
    const res = await handleRevealSecret(
      makeRevealRequest({ reason: "typo" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      makeDeps({ secret: { ok: false, error: { kind: "not_found" } } }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the org route targets a project-scoped secret (scope mismatch)", async () => {
    const projectSecret = fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID });
    const res = await handleRevealSecret(
      makeRevealRequest({ reason: "wrong scope" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      makeDeps({ secret: { ok: true, value: projectSecret } }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the pinned version has no ciphertext", async () => {
    const res = await handleRevealSecret(
      makeRevealRequest({ reason: "old version" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      makeDeps({ cipher: { ok: false, error: { kind: "not_found" } } }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 503 when decryption fails (never surfaces ciphertext)", async () => {
    const res = await handleRevealSecret(
      makeRevealRequest({ reason: "corrupt envelope" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      makeDeps({ decrypt: () => Promise.reject(new Error("bad key")) }),
    );
    expect(res.status).toBe(503);
  });

  it("returns 503 (and NO value) when the audit append fails", async () => {
    const res = await handleRevealSecret(
      makeRevealRequest({ reason: "audit down" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      makeDeps({ eventsRepo: fakeEventsRepo(false) }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { data?: { secret?: { value?: string } } };
    expect(body.data?.secret?.value).toBeUndefined();
  });

  it("emits a secret.revealed event + audit carrying the reason but NEVER the value", async () => {
    const eventsRepo = fakeEventsRepo();
    await handleRevealSecret(
      makeRevealRequest({ reason: "prod incident 42" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      makeDeps({ eventsRepo }),
    );
    expect(eventsRepo.calls).toHaveLength(1);
    const call = eventsRepo.calls[0]!;
    expect(call.event.type).toBe("secret.revealed");
    expect(call.event.subjectKind).toBe("secret");
    const payload = call.event.payload as Record<string, unknown>;
    expect(payload.key).toBe("API_KEY");
    expect(payload.version).toBe(3);
    expect(payload.reason).toBe("prod incident 42");
    expect(payload.decisionId).toBeDefined();
    // The value NEVER enters the event or audit.
    expect(payload.value).toBeUndefined();
    expect(payload.plaintext).toBeUndefined();
    expect(JSON.stringify(call)).not.toContain(PLAINTEXT);
    // Audit description names the reveal + reason, not the value.
    expect(call.audit.description).toContain("break-glass");
    expect(call.audit.description).toContain("prod incident 42");
    expect(call.audit.description).not.toContain(PLAINTEXT);
  });

  it("builds a project resource for a project-scoped secret", async () => {
    const authorizeCalls: { action: string; resource: PolicyResource }[] = [];
    const projectSecret = fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID });
    const res = await handleRevealSecret(
      makeRevealRequest({ reason: "project reveal" }),
      FAKE_ENV, "req1", ACTOR, PRJ_SCOPE, SECRET_UUID,
      makeDeps({ secret: { ok: true, value: projectSecret }, authorizeCalls }),
    );
    expect(res.status).toBe(200);
    expect(authorizeCalls[0]!.resource.kind).toBe("project");
    expect(authorizeCalls[0]!.resource.projectId).toBe(TEST_PROJECT_UUID);
  });
});

// ── Router integration ─────────────────────────────────────
describe("config-worker router - break-glass reveal", () => {
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

  it("routes POST to the org secret reveal — 503 without DB (matched, not shadowed by {id})", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}/reveal`, "POST", { reason: "x" });
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  it("returns 405 for GET on the reveal route", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}/reveal`, "GET");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(405);
  });

  it("returns 401 for reveal without actor headers", async () => {
    const req = new Request(
      `https://config-worker/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}/reveal`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "x" }) },
    );
    const res = await route(req, {} as Env);
    expect(res.status).toBe(401);
  });
});
