// Provider-rotation engine (provider-rotated-secrets RS2).
//
// Asserts the engine mints (purpose rotation, TTL = interval + grace),
// encrypts, appends the version atomically, and emits a value-free
// secret.rotated event (with deliveryRequired for deliver-target consumers);
// that every failure path is NON-DESTRUCTIVE (no store call, a typed
// secret.rotation_failed event, the batch continues); and that the minted
// value never appears in any event.

import { runRotationEngine } from "@config-worker/rotation-engine";
import type { Env } from "@config-worker/env";
import type { ConfigResult, ProviderRotationDue, SecretMetadata } from "@saas/db/config";
import type {
  AppendEventWithAuditInput,
  EventsResult,
  StoredEvent,
  StoredAuditEntry,
} from "@saas/db/events";

const ORG = "11111111-1111-1111-1111-111111111111";
const CONN_UUID = "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd";
const FIXED_NOW = new Date("2026-07-02T00:00:00Z");
const MINT_EXPIRES = "2026-08-02T00:00:00.000Z";
const FAKE_ENV = {} as Env;

const PLACEHOLDER_EVENT = { id: "evt_x" } as unknown as StoredEvent;
const PLACEHOLDER_AUDIT = { id: "aud_x" } as unknown as StoredAuditEntry;

function due(overrides?: Partial<ProviderRotationDue>): ProviderRotationDue {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    orgId: ORG,
    projectId: null,
    environmentId: null,
    scopeKind: "organization",
    secretKey: "CF_API_TOKEN",
    rotationPolicy: "30d",
    rotationProvider: "cloudflare",
    rotationConnectionId: CONN_UUID,
    rotationTemplate: "workers-deploy",
    rotationParams: null,
    rotationGraceSeconds: null,
    rotationDeliverTarget: null,
    lastRotatedAt: new Date("2026-05-01T00:00:00Z"),
    expiresAt: new Date("2026-07-03T00:00:00Z"),
    ...overrides,
  };
}

function rotatedHead(version = 2): SecretMetadata {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    orgId: ORG,
    projectId: null,
    environmentId: null,
    scopeKind: "organization",
    secretKey: "CF_API_TOKEN",
    displayName: null,
    status: "active",
    version,
    rotationPolicy: "30d",
    lastRotatedAt: FIXED_NOW,
    expiresAt: new Date(MINT_EXPIRES),
    createdBy: "00000000-0000-0000-0000-000000000000",
    personalOwner: null,
    overridable: true,
    lastUsedAt: null,
    source: "static",
    bindingProvider: null,
    bindingConnectionId: null,
    bindingTemplate: null,
    rotationProvider: "cloudflare",
    rotationConnectionId: CONN_UUID,
    rotationTemplate: "workers-deploy",
    rotationParams: null,
    rotationGraceSeconds: null,
    rotationDeliverTarget: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: FIXED_NOW,
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
      return Promise.resolve({ ok: true, value: { event: PLACEHOLDER_EVENT, audit: PLACEHOLDER_AUDIT } });
    },
  };
}

function okAdapterFactory() {
  return Promise.resolve({
    encrypt: (plaintext: string) =>
      Promise.resolve({ alg: "AES-256-GCM" as const, v: 1 as const, iv: "iv", ct: `ENC(${plaintext.length})` }),
  });
}

function fakeMint(fail?: { reason: string }) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    fn: (req: Record<string, unknown>) => {
      calls.push(req);
      if (fail) return Promise.resolve({ ok: false as const, status: 412, reason: fail.reason });
      return Promise.resolve({
        ok: true as const,
        value: "cf-rotated-token-SECRET",
        mintId: "mint_" + "ef".repeat(16),
        provider: "cloudflare",
        template: "workers-deploy",
        expiresAt: MINT_EXPIRES,
      });
    },
  };
}

describe("runRotationEngine (RS2)", () => {
  it("mints purpose rotation (TTL = interval + grace), encrypts, appends, and emits secret.rotated", async () => {
    const mint = fakeMint();
    const eventsRepo = fakeEventsRepo();
    let stored: { envelope: string; expiresAt: Date | null } | undefined;
    const summary = await runRotationEngine(FAKE_ENV, {
      repo: {
        listSecretsDueForProviderRotation: () => Promise.resolve({ ok: true, value: [due()] } as ConfigResult<ProviderRotationDue[]>),
        rotateProviderSecret: (_org, _id, _by, envelope, expiresAt) => {
          stored = { envelope, expiresAt };
          return Promise.resolve({ ok: true as const, value: rotatedHead() });
        },
      },
      eventsRepo,
      mintRotation: mint.fn as never,
      encryptionAdapterFor: okAdapterFactory as never,
      now: () => FIXED_NOW,
      generateId: () => "deadbeef01234567",
    });
    expect(summary).toEqual({ scanned: 1, rotated: 1, failed: 0 });
    // The mint: purpose rotation, public connection id, TTL = 30d + 24h default grace.
    expect(mint.calls).toHaveLength(1);
    expect(mint.calls[0]!.purpose).toBe("rotation");
    expect(mint.calls[0]!.connectionId).toBe("int_" + "cd".repeat(16));
    expect(mint.calls[0]!.ttlSeconds).toBe(30 * 86400 + 86400);
    // Stored: the ENCRYPTED minted value + the new token's expiry.
    expect(stored?.envelope).toBe(JSON.stringify({ alg: "AES-256-GCM", v: 1, iv: "iv", ct: "ENC(23)" }));
    expect(stored?.expiresAt?.toISOString()).toBe(MINT_EXPIRES);
    // The event: value-free, versioned, no delivery flag for a per-run secret.
    expect(eventsRepo.calls).toHaveLength(1);
    const evt = eventsRepo.calls[0]!;
    expect(evt.event.type).toBe("secret.rotated");
    expect(evt.event.payload).toMatchObject({ key: "CF_API_TOKEN", version: 2, deliveryRequired: false });
    expect(JSON.stringify(eventsRepo.calls)).not.toContain("cf-rotated-token-SECRET");
  });

  it("honors a custom grace and flags deliveryRequired for a deliver-target secret", async () => {
    const mint = fakeMint();
    const eventsRepo = fakeEventsRepo();
    await runRotationEngine(FAKE_ENV, {
      repo: {
        listSecretsDueForProviderRotation: () =>
          Promise.resolve({
            ok: true,
            value: [due({ rotationPolicy: "7d", rotationGraceSeconds: 3600, rotationDeliverTarget: "cloudflare-worker:api-prod" })],
          } as ConfigResult<ProviderRotationDue[]>),
        rotateProviderSecret: () => Promise.resolve({ ok: true as const, value: rotatedHead(3) }),
      },
      eventsRepo,
      mintRotation: mint.fn as never,
      encryptionAdapterFor: okAdapterFactory as never,
      now: () => FIXED_NOW,
    });
    expect(mint.calls[0]!.ttlSeconds).toBe(7 * 86400 + 3600);
    expect(eventsRepo.calls[0]!.event.payload).toMatchObject({
      deliveryRequired: true,
      deliverTarget: "cloudflare-worker:api-prod",
      version: 3,
    });
  });

  it("a refused mint is NON-DESTRUCTIVE: no store call, secret.rotation_failed with the typed reason", async () => {
    const mint = fakeMint({ reason: "parent_grant_insufficient" });
    const eventsRepo = fakeEventsRepo();
    let storeCalled = false;
    const summary = await runRotationEngine(FAKE_ENV, {
      repo: {
        listSecretsDueForProviderRotation: () => Promise.resolve({ ok: true, value: [due()] } as ConfigResult<ProviderRotationDue[]>),
        rotateProviderSecret: () => {
          storeCalled = true;
          return Promise.resolve({ ok: true as const, value: rotatedHead() });
        },
      },
      eventsRepo,
      mintRotation: mint.fn as never,
      encryptionAdapterFor: okAdapterFactory as never,
      now: () => FIXED_NOW,
    });
    expect(summary).toEqual({ scanned: 1, rotated: 0, failed: 1 });
    expect(storeCalled).toBe(false);
    expect(eventsRepo.calls[0]!.event.type).toBe("secret.rotation_failed");
    expect(eventsRepo.calls[0]!.event.payload).toMatchObject({ reason: "parent_grant_insufficient" });
  });

  it("an unavailable encryption adapter fails that secret without storing", async () => {
    const mint = fakeMint();
    const eventsRepo = fakeEventsRepo();
    const summary = await runRotationEngine(FAKE_ENV, {
      repo: {
        listSecretsDueForProviderRotation: () => Promise.resolve({ ok: true, value: [due()] } as ConfigResult<ProviderRotationDue[]>),
        rotateProviderSecret: () => {
          throw new Error("must not store");
        },
      },
      eventsRepo,
      mintRotation: mint.fn as never,
      encryptionAdapterFor: (() => Promise.resolve(null)) as never,
      now: () => FIXED_NOW,
    });
    expect(summary).toEqual({ scanned: 1, rotated: 0, failed: 1 });
    expect(eventsRepo.calls[0]!.event.payload).toMatchObject({ reason: "encryption_unavailable" });
  });

  it("a failure on one secret never breaks the batch — the next still rotates", async () => {
    const eventsRepo = fakeEventsRepo();
    let mintCount = 0;
    const summary = await runRotationEngine(FAKE_ENV, {
      repo: {
        listSecretsDueForProviderRotation: () =>
          Promise.resolve({
            ok: true,
            value: [due({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1" }), due({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2" })],
          } as ConfigResult<ProviderRotationDue[]>),
        rotateProviderSecret: () => Promise.resolve({ ok: true as const, value: rotatedHead() }),
      },
      eventsRepo,
      mintRotation: ((req: Record<string, unknown>) => {
        mintCount += 1;
        if (mintCount === 1) return Promise.resolve({ ok: false, status: 503, reason: "unavailable" });
        return fakeMint().fn(req);
      }) as never,
      encryptionAdapterFor: okAdapterFactory as never,
      now: () => FIXED_NOW,
    });
    expect(summary).toEqual({ scanned: 2, rotated: 1, failed: 1 });
    expect(eventsRepo.calls.map((c) => c.event.type)).toEqual(["secret.rotation_failed", "secret.rotated"]);
  });

  it("a head changed since the due scan is a benign skip (head_changed), not a stored rotation", async () => {
    const mint = fakeMint();
    const eventsRepo = fakeEventsRepo();
    const summary = await runRotationEngine(FAKE_ENV, {
      repo: {
        listSecretsDueForProviderRotation: () => Promise.resolve({ ok: true, value: [due()] } as ConfigResult<ProviderRotationDue[]>),
        rotateProviderSecret: () => Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } }),
      },
      eventsRepo,
      mintRotation: mint.fn as never,
      encryptionAdapterFor: okAdapterFactory as never,
      now: () => FIXED_NOW,
    });
    expect(summary).toEqual({ scanned: 1, rotated: 0, failed: 1 });
    expect(eventsRepo.calls[0]!.event.payload).toMatchObject({ reason: "head_changed" });
  });

  it("returns a zero summary when nothing is due", async () => {
    const summary = await runRotationEngine(FAKE_ENV, {
      repo: {
        listSecretsDueForProviderRotation: () => Promise.resolve({ ok: true, value: [] } as ConfigResult<ProviderRotationDue[]>),
        rotateProviderSecret: () => {
          throw new Error("unused");
        },
      },
      eventsRepo: fakeEventsRepo(),
      mintRotation: (() => {
        throw new Error("unused");
      }) as never,
      encryptionAdapterFor: okAdapterFactory as never,
    });
    expect(summary).toEqual({ scanned: 0, rotated: 0, failed: 0 });
  });
});
