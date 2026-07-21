// Internal lease-verified resolve (saas-secret-manager SM3) — the decrypt
// keystone. Invariants: a served value never appears in any event/audit
// payload; a protected-env / policy deny returns BEFORE any decrypt attempt.

import { handleInternalResolveSecrets, type InternalResolveDeps } from "@config-worker/handlers/internal-resolve-secrets";
import type { BrokeredMintOutcome } from "@config-worker/integrations-client";
import type { Env } from "@config-worker/env";
import type { ActorContext } from "@config-worker/router";
import type { InternalMintCredentialRequest } from "@saas/contracts/integrations";
import type { ConfigResult, SecretMetadata, SecretPolicyRecord } from "@saas/db/config";
import type { AppendEventWithAuditInput, EventsResult, StoredEvent, StoredAuditEntry } from "@saas/db/events";

const ORG = "11111111-1111-1111-1111-111111111111";
const PRJ = "22222222-2222-2222-2222-222222222222";
const ENVID = "33333333-3333-3333-3333-333333333333";
const SECRET_ID = "44444444-4444-4444-4444-444444444444";

const PLAINTEXT = "s3cr3t-VALUE-never-logged";

function head(over: Partial<SecretMetadata> = {}): SecretMetadata {
  return {
    id: SECRET_ID,
    orgId: ORG,
    projectId: PRJ,
    environmentId: ENVID,
    scopeKind: "environment",
    secretKey: "DATABASE_URL",
    displayName: null,
    status: "active",
    version: 9,
    rotationPolicy: null,
    lastRotatedAt: null,
    expiresAt: null,
    createdBy: "00000000-0000-0000-0000-000000000000",
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
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

interface Captured {
  events: AppendEventWithAuditInput[];
  decryptCalls: number;
  touchCalls: number;
}

function makeDeps(over: {
  policies?: SecretPolicyRecord[];
  headResult?: ConfigResult<SecretMetadata>;
  /** Envelope text served by getSecretCiphertext (IH7 brokered-pointer tests). */
  envelope?: string;
  /** Brokered mint injector (IH7). */
  mint?: (req: InternalMintCredentialRequest) => Promise<BrokeredMintOutcome>;
  capture: Captured;
}): InternalResolveDeps {
  const okEvent: EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }> = {
    ok: true,
    value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry },
  };
  return {
    repo: {
      getSecretMetadataByScopeKey: async (scope): Promise<ConfigResult<SecretMetadata>> =>
        scope.kind === "environment" ? (over.headResult ?? { ok: true, value: head() }) : { ok: false, error: { kind: "not_found" } },
      getSecretCiphertext: async (): Promise<ConfigResult<string>> => {
        over.capture.decryptCalls; // no-op — real signal is decrypt() below
        return { ok: true, value: over.envelope ?? JSON.stringify({ alg: "AES-256-GCM", v: 1, iv: "aaa", ct: "bbb" }) };
      },
      touchSecretLastUsed: async (): Promise<ConfigResult<void>> => {
        over.capture.touchCalls++;
        return { ok: true, value: undefined };
      },
      listSecretPolicies: async (): Promise<ConfigResult<SecretPolicyRecord[]>> => ({ ok: true, value: over.policies ?? [] }),
    },
    membershipRepo: {
      getOrganizationById: async () => ({ ok: false, error: { kind: "not_found" } }) as never,
    },
    eventsRepo: {
      appendEventWithAudit: async (input) => {
        over.capture.events.push(input);
        return okEvent;
      },
    },
    decrypt: async () => {
      over.capture.decryptCalls++;
      return PLAINTEXT;
    },
    ...(over.mint ? { mintBrokered: over.mint } : {}),
    generateId: () => "abcdef00-0000-0000-0000-000000000000",
    now: () => new Date("2026-07-02T00:00:00Z"),
  };
}

function req(body: unknown): Request {
  return new Request("http://config-worker/v1/internal/config/secrets/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ACTOR: ActorContext = { subjectId: "usr_aabbccdd", subjectType: "workflow" };
const ENV = {} as Env;

function baseBody(over: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    projectId: PRJ,
    environmentId: ENVID,
    environment: "prod",
    keys: [{ key: "DATABASE_URL" }],
    platform: "ci-oidc",
    trigger: { branch: "main", declared: true },
    runId: "01JRUN",
    jobId: "deploy",
    ...over,
  };
}

const policyDoc = (rules: unknown[]): SecretPolicyRecord => ({
  id: "p1",
  orgId: ORG,
  projectId: PRJ,
  name: "prod-secrets",
  tier: "stack",
  source: "stack:test",
  document: { rules },
  documentHash: "h",
  createdAt: new Date(),
});

describe("internal resolve — success path", () => {
  it("decrypts and returns the value with provenance; stamps last_used", async () => {
    const capture: Captured = { events: [], decryptCalls: 0, touchCalls: 0 };
    const res = await handleInternalResolveSecrets(req(baseBody()), ENV, "req_1", ACTOR, makeDeps({ capture }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { secrets: Record<string, string>; resolved: Array<{ key: string; version: number; scope: string; decisionId: string }>; ttlSeconds: number } };
    expect(json.data.secrets.DATABASE_URL).toBe(PLAINTEXT);
    expect(json.data.resolved[0]!.key).toBe("DATABASE_URL");
    expect(json.data.resolved[0]!.version).toBe(9);
    expect(json.data.resolved[0]!.scope).toBe("environment");
    expect(json.data.resolved[0]!.decisionId).toMatch(/^dec_/);
    expect(json.data.ttlSeconds).toBe(300);
    expect(capture.decryptCalls).toBe(1);
    expect(capture.touchCalls).toBe(1);
  });

  it("emits secret.accessed with the key + version but NEVER the value", async () => {
    const capture: Captured = { events: [], decryptCalls: 0, touchCalls: 0 };
    await handleInternalResolveSecrets(req(baseBody()), ENV, "req_2", ACTOR, makeDeps({ capture }));
    expect(capture.events).toHaveLength(1);
    const evt = capture.events[0]!;
    expect(evt.event.type).toBe("secret.accessed");
    expect(evt.event.payload.key).toBe("DATABASE_URL");
    expect(evt.event.payload.version).toBe(9);
    // The value must not appear anywhere in the serialized event/audit.
    const serialized = JSON.stringify(evt);
    expect(serialized).not.toContain(PLAINTEXT);
  });
});

describe("internal resolve — protected-env deny (before any decrypt)", () => {
  it("returns 403 with a stable reason and NEVER calls decrypt", async () => {
    const capture: Captured = { events: [], decryptCalls: 0, touchCalls: 0 };
    // A concrete prod rule (deny for local-cli) makes prod protected; a ci-oidc
    // caller matches no allow ⇒ deny-by-default.
    const policies = [policyDoc([{ id: "laptops-never-prod", effect: "deny", subjects: ["*authenticated"], scope: { env: "prod", key: "*" }, when: ['platform == "local-cli"'] }])];
    const res = await handleInternalResolveSecrets(req(baseBody()), ENV, "req_3", ACTOR, makeDeps({ capture, policies }));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { details: { reason: string; decisionId: string } } };
    expect(json.error.details.reason).toBe("no-matching-grant");
    expect(json.error.details.decisionId).toMatch(/^dec_/);
    // The decrypt path must not have been touched.
    expect(capture.decryptCalls).toBe(0);
    expect(capture.touchCalls).toBe(0);
    // A secret.denied audit was emitted, key-name + reason only.
    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]!.event.type).toBe("secret.denied");
    expect(JSON.stringify(capture.events[0]!)).not.toContain(PLAINTEXT);
  });
});

describe("internal resolve — unknown reference", () => {
  it("404s (resource-hiding) when the key exists nowhere in the chain", async () => {
    const capture: Captured = { events: [], decryptCalls: 0, touchCalls: 0 };
    const res = await handleInternalResolveSecrets(
      req(baseBody()),
      ENV,
      "req_4",
      ACTOR,
      makeDeps({ capture, headResult: { ok: false, error: { kind: "not_found" } } }),
    );
    expect(res.status).toBe(404);
    expect(capture.decryptCalls).toBe(0);
  });
});

describe("internal resolve — validation", () => {
  it("400s a missing platform", async () => {
    const capture: Captured = { events: [], decryptCalls: 0, touchCalls: 0 };
    const res = await handleInternalResolveSecrets(req(baseBody({ platform: "bogus" })), ENV, "req_5", ACTOR, makeDeps({ capture }));
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════
// Brokered heads (saas-integration-hub IH7): mint at resolve
// ═══════════════════════════════════════════════════════════

const CONNECTION_PUBLIC = "int_" + "ab".repeat(16);
const MINTED = "minted-VALUE-never-logged";
const POINTER = JSON.stringify({
  v: "brokered",
  provider: { connectionId: CONNECTION_PUBLIC, template: "workers-deploy", params: { accountId: "acc-1" } },
});

describe("internal resolve — brokered head (IH7)", () => {
  it("mints through the broker, never touches decrypt, and carries broker provenance", async () => {
    const capture: Captured = { events: [], decryptCalls: 0, touchCalls: 0 };
    let mintReq: InternalMintCredentialRequest | null = null;
    const res = await handleInternalResolveSecrets(
      req(baseBody()),
      ENV,
      "req_b1",
      ACTOR,
      makeDeps({
        capture,
        envelope: POINTER,
        mint: async (r) => {
          mintReq = r;
          return {
            ok: true,
            value: MINTED,
            mintId: "mint_" + "cd".repeat(16),
            provider: "cloudflare",
            template: "workers-deploy",
            expiresAt: "2026-07-02T00:15:00Z",
          };
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        secrets: Record<string, string>;
        resolved: Array<{ key: string; version: number; scope: string; source?: string; mintId?: string; provider?: string; template?: string }>;
      };
    };
    // The minted value lands in the secrets map — indistinguishable from static.
    expect(json.data.secrets.DATABASE_URL).toBe(MINTED);
    // Additive broker provenance on the resolved[] entry.
    const entry = json.data.resolved[0]!;
    expect(entry.source).toBe("broker");
    expect(entry.mintId).toBe("mint_" + "cd".repeat(16));
    expect(entry.provider).toBe("cloudflare");
    expect(entry.template).toBe("workers-deploy");
    expect(entry.version).toBe(9);
    // Decrypt must NEVER run for a brokered head; last_used still stamps.
    expect(capture.decryptCalls).toBe(0);
    expect(capture.touchCalls).toBe(1);
    // The mint request carries the pointer + run attribution, no ttlSeconds.
    expect(mintReq).not.toBeNull();
    expect(mintReq!.orgId).toBe(ORG);
    expect(mintReq!.connectionId).toBe(CONNECTION_PUBLIC);
    expect(mintReq!.template).toBe("workers-deploy");
    expect(mintReq!.params).toEqual({ accountId: "acc-1" });
    expect(mintReq!.purpose).toBe("secret_resolve");
    expect(mintReq!.requestedBy).toBe(ACTOR.subjectId);
    expect(mintReq!.runId).toBe("01JRUN");
    expect(mintReq!.jobId).toBe("deploy");
    expect("ttlSeconds" in mintReq!).toBe(false);
  });

  it("audits the access with the mintId join key — NEVER the minted value", async () => {
    const capture: Captured = { events: [], decryptCalls: 0, touchCalls: 0 };
    await handleInternalResolveSecrets(
      req(baseBody()),
      ENV,
      "req_b2",
      ACTOR,
      makeDeps({
        capture,
        envelope: POINTER,
        mint: async () => ({
          ok: true,
          value: MINTED,
          mintId: "mint_" + "cd".repeat(16),
          provider: "cloudflare",
          template: "workers-deploy",
          expiresAt: "2026-07-02T00:15:00Z",
        }),
      }),
    );
    expect(capture.events).toHaveLength(1);
    const evt = capture.events[0]!;
    expect(evt.event.type).toBe("secret.accessed");
    expect(evt.event.payload.source).toBe("broker");
    expect(evt.event.payload.mintId).toBe("mint_" + "cd".repeat(16));
    expect(evt.event.payload.provider).toBe("cloudflare");
    expect(evt.event.payload.template).toBe("workers-deploy");
    expect(JSON.stringify(evt)).not.toContain(MINTED);
  });

  it("fails the WHOLE resolve 412 binding_unavailable on a mint failure + audits a denial", async () => {
    const capture: Captured = { events: [], decryptCalls: 0, touchCalls: 0 };
    const res = await handleInternalResolveSecrets(
      req(baseBody()),
      ENV,
      "req_b3",
      ACTOR,
      makeDeps({
        capture,
        envelope: POINTER,
        mint: async () => ({ ok: false, status: 502, reason: "provider_error" }),
      }),
    );
    expect(res.status).toBe(412);
    const json = (await res.json()) as { error: { code: string; message: string; details: { key: string; reason: string; brokerReason: string; connectionId: string; decisionId: string } } };
    expect(json.error.code).toBe("precondition_failed");
    expect(json.error.details.reason).toBe("binding_unavailable");
    // The broker's own typed failure slug is carried through — in details for
    // programmatic consumers AND in the message so a CLI that prints only the
    // message still names the exact cause.
    expect(json.error.details.brokerReason).toBe("provider_error");
    expect(json.error.message).toContain("provider_error");
    expect(json.error.details.key).toBe("DATABASE_URL");
    expect(json.error.details.connectionId).toBe(CONNECTION_PUBLIC);
    expect(json.error.details.decisionId).toMatch(/^dec_/);
    // Fail-closed: no decrypt, no last_used stamp, a secret.denied audit.
    expect(capture.decryptCalls).toBe(0);
    expect(capture.touchCalls).toBe(0);
    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]!.event.type).toBe("secret.denied");
    expect(capture.events[0]!.event.payload.reason).toBe("binding_unavailable");
  });

  it("maps a not-active connection to binding_orphaned (brokered-orphan-safety, run-time)", async () => {
    const capture: Captured = { events: [], decryptCalls: 0, touchCalls: 0 };
    const res = await handleInternalResolveSecrets(
      req(baseBody()),
      ENV,
      "req_orphan",
      ACTOR,
      makeDeps({
        capture,
        envelope: POINTER,
        // The broker refuses because the connection is no longer active — the
        // exact signal that the brokered head is orphaned.
        mint: async () => ({ ok: false, status: 412, reason: "connection_inactive" }),
      }),
    );
    expect(res.status).toBe(412);
    const json = (await res.json()) as { error: { code: string; message: string; details: { key: string; reason: string; connectionId: string } } };
    expect(json.error.code).toBe("precondition_failed");
    expect(json.error.details.reason).toBe("binding_orphaned");
    expect(json.error.message).toMatch(/orphaned/i);
    expect(json.error.details.connectionId).toBe(CONNECTION_PUBLIC);
    // Same fail-closed posture: no decrypt, a secret.denied audit naming the reason.
    expect(capture.decryptCalls).toBe(0);
    expect(capture.events[0]!.event.type).toBe("secret.denied");
    expect(capture.events[0]!.event.payload.reason).toBe("binding_orphaned");
  });

  it("a missing connection also maps to binding_orphaned", async () => {
    const capture: Captured = { events: [], decryptCalls: 0, touchCalls: 0 };
    const res = await handleInternalResolveSecrets(
      req(baseBody()),
      ENV,
      "req_orphan2",
      ACTOR,
      makeDeps({
        capture,
        envelope: POINTER,
        mint: async () => ({ ok: false, status: 404, reason: "connection_not_found" }),
      }),
    );
    expect(res.status).toBe(412);
    const json = (await res.json()) as { error: { details: { reason: string } } };
    expect(json.error.details.reason).toBe("binding_orphaned");
  });

  it("static heads are unaffected: no mint call, pre-IH7 provenance shape", async () => {
    const capture: Captured = { events: [], decryptCalls: 0, touchCalls: 0 };
    let mintCalls = 0;
    const res = await handleInternalResolveSecrets(
      req(baseBody()),
      ENV,
      "req_b4",
      ACTOR,
      makeDeps({
        capture,
        mint: async () => {
          mintCalls++;
          return { ok: false, status: 503, reason: "unavailable" };
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { secrets: Record<string, string>; resolved: Array<Record<string, unknown>> } };
    expect(json.data.secrets.DATABASE_URL).toBe(PLAINTEXT);
    expect(mintCalls).toBe(0);
    expect(capture.decryptCalls).toBe(1);
    // Static entries carry exactly the pre-IH7 shape — no broker fields.
    const entry = json.data.resolved[0]!;
    expect(entry.source).toBeUndefined();
    expect(entry.mintId).toBeUndefined();
    expect(entry.provider).toBeUndefined();
    expect(entry.template).toBeUndefined();
  });
});
