/**
 * Secret store v3 (saas-secret-manager SM1) — handler + route tests.
 *
 * Covers: the locked-guardrail 409 on create, personal/overridable create
 * fields, the chain read (?chain=true), the version-history route, bulk
 * import (per-key results, single summarizing event, no secret material in
 * any payload), and the Layer-1 RBAC activation (secret.read/secret.write
 * action strings on the policy client).
 */
import { handleCreateSecret } from "@config-worker/handlers/create-secret";
import { handleImportSecrets } from "@config-worker/handlers/import-secrets";
import { handleListSecretChain } from "@config-worker/handlers/list-secret-chain";
import { handleListSecretVersions } from "@config-worker/handlers/list-secret-versions";
import { route } from "@config-worker/router";
import type { Env } from "@config-worker/env";
import type { ActorContext } from "@config-worker/router";
import type {
  ConfigResult,
  CreateSecretMetadataInput,
  ResolveScope,
  Scope,
  SecretMetadata,
  SecretVersion,
} from "@saas/db/config";
import type { MembershipRepository, Organization } from "@saas/db/membership";
import type {
  AppendEventWithAuditInput,
  EventsResult,
  StoredEvent,
  StoredAuditEntry,
} from "@saas/db/events";
import type { CiphertextEnvelope, EncryptionAdapter } from "@config-worker/encryption";

// ── Constants ──────────────────────────────────────────────
const TEST_ORG_UUID = "11111111-1111-1111-1111-111111111111";
const TEST_PROJECT_UUID = "22222222-2222-2222-2222-222222222222";
const TEST_ENV_UUID = "44444444-4444-4444-4444-444444444444";
const TEST_USER_ID = "usr_" + "ab".repeat(16);
const TEST_USER_UUID = "abababab-abab-abab-abab-abababababab";
const OTHER_USER_UUID = "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd";
const ACCOUNT_ORG = "99999999-9999-9999-9999-999999999999";
const SECRET_UUID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const FIXED_NOW = new Date("2026-06-01T00:00:00Z");
const FIXED_ID = "deadbeef01234567";

const ACTOR: ActorContext = { subjectId: TEST_USER_ID, subjectType: "user" };
const ORG_SCOPE: Scope = { kind: "organization", orgId: TEST_ORG_UUID };
const PRJ_SCOPE: Scope = { kind: "project", orgId: TEST_ORG_UUID, projectId: TEST_PROJECT_UUID };
const ENV_SCOPE: Scope = { kind: "environment", orgId: TEST_ORG_UUID, projectId: TEST_PROJECT_UUID, environmentId: TEST_ENV_UUID };

const TEST_ORG_PUBLIC = "org_11111111111111111111111111111111";
const TEST_PRJ_PUBLIC = "prj_22222222222222222222222222222222";
const TEST_ENV_PUBLIC = "env_44444444444444444444444444444444";
const SECRET_PUBLIC = "sec_cccccccccccccccccccccccccccccccc";

const FAKE_ENV = {} as Env;

// ── Fakes ──────────────────────────────────────────────────

const unusedConfigFailure = <T>(): Promise<ConfigResult<T>> =>
  Promise.resolve({ ok: false, error: { kind: "internal", message: "unused stub" } });

function fakeSecret(overrides?: Partial<SecretMetadata>): SecretMetadata {
  return {
    id: SECRET_UUID,
    orgId: TEST_ORG_UUID,
    projectId: null,
    environmentId: null,
    scopeKind: "organization",
    secretKey: "DB_PASSWORD",
    displayName: null,
    status: "active",
    version: 1,
    rotationPolicy: null,
    lastRotatedAt: null,
    expiresAt: null,
    createdBy: TEST_USER_UUID,
    personalOwner: null,
    overridable: true,
    lastUsedAt: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

function fakeVersion(overrides?: Partial<SecretVersion>): SecretVersion {
  return {
    secretId: SECRET_UUID,
    version: 1,
    status: "active",
    createdBy: TEST_USER_UUID,
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

function fakeMembership(opts?: { fail?: boolean }): Pick<MembershipRepository, "getOrganizationById"> {
  return {
    getOrganizationById(id: string) {
      if (opts?.fail) {
        return Promise.resolve({ ok: false as const, error: { kind: "internal" as const, message: "boom" } });
      }
      const org: Organization = {
        id,
        name: "Acme",
        slug: "acme",
        slugLower: "acme",
        publicRef: "ws_TESTTEST",
        status: "active",
        parentOrgId: ACCOUNT_ORG,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      };
      return Promise.resolve({ ok: true as const, value: org });
    },
  };
}

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
        value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry },
      });
    },
  };
}

function fakeEncryptionAdapter(): EncryptionAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async encrypt(plaintext: string): Promise<CiphertextEnvelope> {
      calls.push(plaintext);
      return { alg: "AES-256-GCM", v: 1, iv: "dGVzdGl2MTIzNDU2", ct: "ZW5jcnlwdGVk" };
    },
  };
}

function makeJsonRequest(body: unknown, method = "POST"): Request {
  return new Request("https://config-worker/test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(path = "/test"): Request {
  return new Request(`https://config-worker${path}`, { method: "GET" });
}

/** A scope-key lookup fake seeded per scope kind (shared rows only). */
function scopeKeyRepo(rowsByKind: Partial<Record<SecretMetadata["scopeKind"], SecretMetadata>>) {
  return (scope: ResolveScope, _key: string, personalOwner?: string): Promise<ConfigResult<SecretMetadata>> => {
    const row = rowsByKind[scope.kind];
    if (row && personalOwner === undefined) {
      return Promise.resolve({ ok: true as const, value: row });
    }
    return Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } });
  };
}

// ═══════════════════════════════════════════════════════════
// Guardrail write-rejection (create)
// ═══════════════════════════════════════════════════════════
describe("handleCreateSecret — locked-guardrail 409 (SM1)", () => {
  it("rejects a project-scope create over a locked workspace key", async () => {
    let createCalls = 0;
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "DB_PASSWORD" }),
      FAKE_ENV, "req1", ACTOR, PRJ_SCOPE,
      {
        repo: {
          createSecretMetadata: () => {
            createCalls++;
            return unusedConfigFailure<SecretMetadata>();
          },
          getSecretMetadataByScopeKey: scopeKeyRepo({ organization: fakeSecret({ overridable: false }) }),
        },
        membershipRepo: fakeMembership(),
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toBe("Cannot override a locked secret");
    expect(createCalls).toBe(0);
  });

  it("rejects an environment-scope create over a locked account key", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "DB_PASSWORD" }),
      FAKE_ENV, "req1", ACTOR, ENV_SCOPE,
      {
        repo: {
          createSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          getSecretMetadataByScopeKey: scopeKeyRepo({ account: fakeSecret({ scopeKind: "account", overridable: false }) }),
        },
        membershipRepo: fakeMembership(),
      },
    );
    expect(res.status).toBe(409);
  });

  it("allows the create when the key above is overridable", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "DB_PASSWORD" }),
      FAKE_ENV, "req1", ACTOR, PRJ_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: true as const, value: fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID }) }),
          getSecretMetadataByScopeKey: scopeKeyRepo({ organization: fakeSecret({ overridable: true }) }),
        },
        membershipRepo: fakeMembership(),
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(201);
  });
});

// ═══════════════════════════════════════════════════════════
// personal / overridable create fields
// ═══════════════════════════════════════════════════════════
describe("handleCreateSecret — personal and overridable (SM1)", () => {
  it("personal: true at environment scope sets personal_owner to the verified actor", async () => {
    let captured: CreateSecretMetadataInput | undefined;
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "MY_TOKEN", personal: true }),
      FAKE_ENV, "req1", ACTOR, ENV_SCOPE,
      {
        repo: {
          createSecretMetadata: (input: CreateSecretMetadataInput) => {
            captured = input;
            return Promise.resolve({ ok: true as const, value: fakeSecret({ scopeKind: "environment", projectId: TEST_PROJECT_UUID, environmentId: TEST_ENV_UUID, personalOwner: TEST_USER_UUID }) });
          },
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(201);
    expect(captured?.personalOwner).toBe(TEST_USER_UUID);
    const body = await res.json() as { data: { secret: { personal: boolean } } };
    expect(body.data.secret.personal).toBe(true);
  });

  it("personal: true outside environment scope is a 400", async () => {
    for (const scope of [ORG_SCOPE, PRJ_SCOPE]) {
      const res = await handleCreateSecret(
        makeJsonRequest({ secretKey: "MY_TOKEN", personal: true }),
        FAKE_ENV, "req1", ACTOR, scope,
        { repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() } },
      );
      expect(res.status).toBe(400);
    }
  });

  it("overridable: false at organization scope is persisted", async () => {
    let captured: CreateSecretMetadataInput | undefined;
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "DB_PASSWORD", overridable: false }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: (input: CreateSecretMetadataInput) => {
            captured = input;
            return Promise.resolve({ ok: true as const, value: fakeSecret({ overridable: false }) });
          },
        },
      },
    );
    expect(res.status).toBe(201);
    expect(captured?.overridable).toBe(false);
  });

  it("overridable: false below organization scope is a 422", async () => {
    for (const scope of [PRJ_SCOPE, ENV_SCOPE]) {
      const res = await handleCreateSecret(
        makeJsonRequest({ secretKey: "DB_PASSWORD", overridable: false }),
        FAKE_ENV, "req1", ACTOR, scope,
        { repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() } },
      );
      expect(res.status).toBe(422);
      const body = await res.json() as { error: { details?: { fields?: Record<string, unknown> } } };
      expect(body.error.details?.fields?.overridable).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// Chain read (?chain=true)
// ═══════════════════════════════════════════════════════════
describe("handleListSecretChain (SM1)", () => {
  /** Rung lists honoring the repo's personal-visibility contract. */
  function chainRepo(rowsByKind: Partial<Record<SecretMetadata["scopeKind"], SecretMetadata[]>>) {
    return {
      listSecretMetadata(scope: ResolveScope, _params: unknown, viewerSubjectId?: string) {
        const rows = (rowsByKind[scope.kind] ?? []).filter((r) =>
          r.personalOwner === null || r.personalOwner === viewerSubjectId,
        );
        return Promise.resolve({ ok: true as const, value: { items: rows, nextCursor: null } });
      },
    };
  }

  function envScope(): Scope & { kind: "environment" } {
    return { kind: "environment", orgId: TEST_ORG_UUID, projectId: TEST_PROJECT_UUID, environmentId: TEST_ENV_UUID };
  }

  const envRow = (key: string, overrides?: Partial<SecretMetadata>) =>
    fakeSecret({ id: SECRET_UUID, scopeKind: "environment", projectId: TEST_PROJECT_UUID, environmentId: TEST_ENV_UUID, secretKey: key, ...overrides });
  const prjRow = (key: string) => fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID, secretKey: key });
  const orgRow = (key: string) => fakeSecret({ scopeKind: "organization", secretKey: key });
  const acctRow = (key: string) => fakeSecret({ scopeKind: "account", orgId: ACCOUNT_ORG, secretKey: key });

  it("serves each key from its most specific rung with servesFrom provenance", async () => {
    const res = await handleListSecretChain(
      makeGetRequest("/chain?chain=true"), FAKE_ENV, "req1", ACTOR, envScope(),
      {
        repo: chainRepo({
          environment: [envRow("A")],
          project: [prjRow("A"), prjRow("B")],
          organization: [orgRow("B"), orgRow("C")],
          account: [acctRow("C"), acctRow("D")],
        }),
        membershipRepo: fakeMembership(),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { secrets: Array<{ secretKey: string; servesFrom: string }> } };
    const byKey = Object.fromEntries(body.data.secrets.map((s) => [s.secretKey, s.servesFrom]));
    expect(byKey).toEqual({ A: "environment", B: "project", C: "workspace", D: "account" });
  });

  it("the viewer's personal overlay beats the shared environment row", async () => {
    const res = await handleListSecretChain(
      makeGetRequest("/chain?chain=true"), FAKE_ENV, "req1", ACTOR, envScope(),
      {
        repo: chainRepo({
          environment: [envRow("A"), envRow("A", { personalOwner: TEST_USER_UUID })],
        }),
        membershipRepo: fakeMembership(),
      },
    );
    const body = await res.json() as { data: { secrets: Array<{ secretKey: string; servesFrom: string; personal: boolean }> } };
    expect(body.data.secrets).toHaveLength(1);
    expect(body.data.secrets[0]!.servesFrom).toBe("personal");
    expect(body.data.secrets[0]!.personal).toBe(true);
  });

  it("someone else's personal overlay never appears for this viewer", async () => {
    const res = await handleListSecretChain(
      makeGetRequest("/chain?chain=true"), FAKE_ENV, "req1", ACTOR, envScope(),
      {
        repo: chainRepo({
          environment: [envRow("A", { personalOwner: OTHER_USER_UUID })],
          organization: [orgRow("A")],
        }),
        membershipRepo: fakeMembership(),
      },
    );
    const body = await res.json() as { data: { secrets: Array<{ secretKey: string; servesFrom: string }> } };
    expect(body.data.secrets).toHaveLength(1);
    expect(body.data.secrets[0]!.servesFrom).toBe("workspace");
  });

  it("revoked rows never serve and never shadow a live row below", async () => {
    const res = await handleListSecretChain(
      makeGetRequest("/chain?chain=true"), FAKE_ENV, "req1", ACTOR, envScope(),
      {
        repo: chainRepo({
          environment: [envRow("A", { status: "revoked" })],
          project: [prjRow("A")],
        }),
        membershipRepo: fakeMembership(),
      },
    );
    const body = await res.json() as { data: { secrets: Array<{ secretKey: string; servesFrom: string }> } };
    expect(body.data.secrets).toHaveLength(1);
    expect(body.data.secrets[0]!.servesFrom).toBe("project");
  });

  it("fail-soft: the account rung is skipped when the org fetch fails", async () => {
    const res = await handleListSecretChain(
      makeGetRequest("/chain?chain=true"), FAKE_ENV, "req1", ACTOR, envScope(),
      {
        repo: chainRepo({ organization: [orgRow("A")], account: [acctRow("Z")] }),
        membershipRepo: fakeMembership({ fail: true }),
      },
    );
    const body = await res.json() as { data: { secrets: Array<{ secretKey: string }> } };
    expect(body.data.secrets.map((s) => s.secretKey)).toEqual(["A"]);
  });

  it("responses carry metadata only — never secret material", async () => {
    const res = await handleListSecretChain(
      makeGetRequest("/chain?chain=true"), FAKE_ENV, "req1", ACTOR, envScope(),
      {
        repo: chainRepo({ environment: [envRow("A")] }),
        membershipRepo: fakeMembership(),
      },
    );
    const body = await res.json() as { data: { secrets: Array<Record<string, unknown>> } };
    for (const s of body.data.secrets) {
      expect(s.value).toBeUndefined();
      expect(s.plaintext).toBeUndefined();
      expect(s.ciphertext).toBeUndefined();
      expect(s.ciphertextEnvelope).toBeUndefined();
      expect(s.personalOwner).toBeUndefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// Version history route
// ═══════════════════════════════════════════════════════════
describe("handleListSecretVersions (SM1)", () => {
  it("returns paged version metadata newest-first", async () => {
    const res = await handleListSecretVersions(
      makeGetRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: fakeSecret({ version: 3 }) }),
          listSecretVersions: () => Promise.resolve({
            ok: true as const,
            value: { items: [fakeVersion({ version: 3 }), fakeVersion({ version: 2 }), fakeVersion({ version: 1 })], nextCursor: null },
          }),
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { versions: Array<Record<string, unknown>> } };
    expect(body.data.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(body.data.versions[0]!.secretId).toBe(SECRET_PUBLIC);
    for (const v of body.data.versions) {
      expect(v.value).toBeUndefined();
      expect(v.ciphertextEnvelope).toBeUndefined();
      expect(v.ciphertext_envelope).toBeUndefined();
    }
  });

  it("returns 404 when the secret is missing", async () => {
    const res = await handleListSecretVersions(
      makeGetRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } }),
          listSecretVersions: () => unusedConfigFailure(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 on a scope mismatch (org route, project secret)", async () => {
    const res = await handleListSecretVersions(
      makeGetRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID }) }),
          listSecretVersions: () => unusedConfigFailure(),
        },
      },
    );
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════
// Bulk import
// ═══════════════════════════════════════════════════════════
describe("handleImportSecrets (SM1)", () => {
  it("imports entries with per-key results and ONE summarizing event", async () => {
    const eventsRepo = fakeEventsRepo();
    const adapter = fakeEncryptionAdapter();
    const created: CreateSecretMetadataInput[] = [];
    const res = await handleImportSecrets(
      makeJsonRequest({ secrets: [
        { secretKey: "A", value: "va" },
        { secretKey: "B", value: "vb", displayName: "Bee" },
      ] }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: (input: CreateSecretMetadataInput) => {
            created.push(input);
            return Promise.resolve({ ok: true as const, value: fakeSecret({ secretKey: input.secretKey }) });
          },
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
        encryptionAdapter: adapter,
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { results: Array<{ secretKey: string; status: string }> } };
    expect(body.data.results).toEqual([
      { secretKey: "A", status: "created" },
      { secretKey: "B", status: "created" },
    ]);
    // Encrypted exactly like create-secret: adapter saw both plaintexts, the
    // repo received envelopes, never raw values.
    expect(adapter.calls).toEqual(["va", "vb"]);
    for (const input of created) {
      expect(input.ciphertextEnvelope).toBeDefined();
      expect(JSON.stringify(input)).not.toContain("va");
    }
    expect(eventsRepo.calls).toHaveLength(1);
    const payload = eventsRepo.calls[0]!.event.payload as Record<string, unknown>;
    expect(payload.operation).toBe("import");
    expect(payload.created).toBe(2);
    expect(payload.requested).toBe(2);
  });

  it("reports conflicts per key without failing the batch", async () => {
    const eventsRepo = fakeEventsRepo();
    const res = await handleImportSecrets(
      makeJsonRequest({ secrets: [
        { secretKey: "EXISTS", value: "v1" },
        { secretKey: "NEW", value: "v2" },
      ] }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: (input: CreateSecretMetadataInput) =>
            input.secretKey === "EXISTS"
              ? Promise.resolve({ ok: false as const, error: { kind: "conflict" as const, entity: "secret_metadata" } })
              : Promise.resolve({ ok: true as const, value: fakeSecret({ secretKey: input.secretKey }) }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { results: Array<{ secretKey: string; status: string }> } };
    expect(body.data.results).toEqual([
      { secretKey: "EXISTS", status: "conflict" },
      { secretKey: "NEW", status: "created" },
    ]);
    expect((eventsRepo.calls[0]!.event.payload as Record<string, unknown>).created).toBe(1);
  });

  it("marks invalid entries without touching the repo", async () => {
    let createCalls = 0;
    const res = await handleImportSecrets(
      makeJsonRequest({ secrets: [
        { secretKey: "123bad", value: "v" },
        { secretKey: "NO_VALUE" },
        { secretKey: "SMUGGLED", value: "v", plaintext: "nope" },
      ] }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => {
            createCalls++;
            return unusedConfigFailure<SecretMetadata>();
          },
        },
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { results: Array<{ status: string }> } };
    expect(body.data.results.map((r) => r.status)).toEqual(["invalid", "invalid", "invalid"]);
    expect(createCalls).toBe(0);
  });

  it("a locked key above the target scope imports as a conflict", async () => {
    const res = await handleImportSecrets(
      makeJsonRequest({ secrets: [{ secretKey: "DB_PASSWORD", value: "v" }] }),
      FAKE_ENV, "req1", ACTOR, PRJ_SCOPE,
      {
        repo: {
          createSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          getSecretMetadataByScopeKey: scopeKeyRepo({ organization: fakeSecret({ overridable: false }) }),
        },
        membershipRepo: fakeMembership(),
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { results: Array<{ status: string }> } };
    expect(body.data.results[0]!.status).toBe("conflict");
  });

  it("rejects more than 100 entries", async () => {
    const secrets = Array.from({ length: 101 }, (_, i) => ({ secretKey: `K${i}`, value: "v" }));
    const res = await handleImportSecrets(
      makeJsonRequest({ secrets }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    expect(res.status).toBe(422);
  });

  it("no value ever appears in the recorded event or audit payloads", async () => {
    const eventsRepo = fakeEventsRepo();
    await handleImportSecrets(
      makeJsonRequest({ secrets: [{ secretKey: "A", value: "super-secret-value" }] }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: true as const, value: fakeSecret({ secretKey: "A" }) }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    expect(eventsRepo.calls).toHaveLength(1);
    const serialized = JSON.stringify(eventsRepo.calls[0]);
    expect(serialized).not.toContain("super-secret-value");
    const payload = eventsRepo.calls[0]!.event.payload as Record<string, unknown>;
    expect(payload.value).toBeUndefined();
    expect(payload.values).toBeUndefined();
  });

  it("skips the event when nothing was created", async () => {
    const eventsRepo = fakeEventsRepo();
    const res = await handleImportSecrets(
      makeJsonRequest({ secrets: [{ secretKey: "EXISTS", value: "v" }] }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: false as const, error: { kind: "conflict" as const, entity: "secret_metadata" } }),
        },
        eventsRepo,
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    expect(res.status).toBe(200);
    expect(eventsRepo.calls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// Router wiring + RBAC action switch (Layer 1 activation)
// ═══════════════════════════════════════════════════════════
describe("config-worker router — secret store v3 routes + RBAC actions", () => {
  type MockFetcher = Fetcher & { fetchCalls: Array<{ url: string; init: RequestInit }> };

  function createMockFetcher(responseBody: unknown, status = 200): MockFetcher {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    return {
      fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        fetchCalls.push({ url, init: init ?? {} });
        return Promise.resolve(new Response(JSON.stringify(responseBody), {
          status,
          headers: { "content-type": "application/json" },
        }));
      },
      connect() { throw new Error("not implemented"); },
      fetchCalls,
    } as unknown as MockFetcher;
  }

  function createFakeEnv(): Env & { POLICY_WORKER: MockFetcher } {
    return {
      PLATFORM_DB: { connectionString: "postgres://fake" },
      MEMBERSHIP_WORKER: createMockFetcher({ data: { memberships: [{ kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: TEST_ORG_UUID } }] } }),
      POLICY_WORKER: createMockFetcher({ data: { allow: true, reason: "org_admin", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
      ENVIRONMENT: "test",
    } as unknown as Env & { POLICY_WORKER: MockFetcher };
  }

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

  function policyAction(env: { POLICY_WORKER: MockFetcher }): string {
    expect(env.POLICY_WORKER.fetchCalls).toHaveLength(1);
    const body = JSON.parse(env.POLICY_WORKER.fetchCalls[0]!.init.body as string) as { action: string };
    return body.action;
  }

  it("list authorizes with secret.read", async () => {
    const env = createFakeEnv();
    const res = await route(routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets`, "GET"), env);
    expect([200, 503]).toContain(res.status);
    expect(policyAction(env)).toBe("secret.read");
  });

  it("create authorizes with secret.write", async () => {
    const env = createFakeEnv();
    const res = await route(routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets`, "POST", { secretKey: "A" }), env);
    expect(res.status).not.toBe(404);
    expect(policyAction(env)).toBe("secret.write");
  });

  it("the chain read authorizes with secret.read", async () => {
    const env = createFakeEnv();
    const res = await route(routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/environments/${TEST_ENV_PUBLIC}/config/secrets?chain=true`, "GET"), env);
    expect(res.status).not.toBe(404);
    expect(policyAction(env)).toBe("secret.read");
  });

  it("the versions route authorizes with secret.read", async () => {
    const env = createFakeEnv();
    const res = await route(routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}/versions`, "GET"), env);
    expect(res.status).not.toBe(404);
    expect(policyAction(env)).toBe("secret.read");
  });

  it("import authorizes with secret.write", async () => {
    const env = createFakeEnv() as Env & { POLICY_WORKER: MockFetcher };
    (env as { SECRET_ENCRYPTION_KEY?: string }).SECRET_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const res = await route(routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/import`, "POST", { secrets: [{ secretKey: "A", value: "v" }] }), env);
    expect(res.status).not.toBe(404);
    expect(policyAction(env)).toBe("secret.write");
  });

  it("routes POST import at all three scopes (503 without a real DB)", async () => {
    for (const path of [
      `/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/import`,
      `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/config/secrets/import`,
      `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/environments/${TEST_ENV_PUBLIC}/config/secrets/import`,
    ]) {
      const res = await route(routerRequest(path, "POST", { secrets: [{ secretKey: "A", value: "v" }] }), {} as Env);
      expect(res.status).toBe(503);
    }
  });

  it("routes GET versions at all three scopes (503 without a real DB)", async () => {
    for (const path of [
      `/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}/versions`,
      `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/config/secrets/${SECRET_PUBLIC}/versions`,
      `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/environments/${TEST_ENV_PUBLIC}/config/secrets/${SECRET_PUBLIC}/versions`,
    ]) {
      const res = await route(routerRequest(path, "GET"), {} as Env);
      expect(res.status).toBe(503);
    }
  });

  it("returns 405 for GET on import and POST on versions", async () => {
    const getImport = await route(routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/import`, "GET"), {} as Env);
    expect(getImport.status).toBe(405);
    const postVersions = await route(routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}/versions`, "POST"), {} as Env);
    expect(postVersions.status).toBe(405);
  });

  it("chain=true outside environment scope falls back to the exact-scope list", async () => {
    const env = createFakeEnv();
    const res = await route(routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets?chain=true`, "GET"), env);
    expect([200, 503]).toContain(res.status);
    expect(policyAction(env)).toBe("secret.read");
  });
});
