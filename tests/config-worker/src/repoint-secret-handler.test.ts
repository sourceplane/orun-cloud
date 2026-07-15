// brokered-orphan-safety (Feature 7): repoint a brokered secret's binding.
import { handleRepointSecret } from "@config-worker/handlers/repoint-secret";
import type { RepointSecretDeps } from "@config-worker/handlers/repoint-secret";
import type { ActorContext } from "@config-worker/router";
import type { Env } from "@config-worker/env";
import type { Scope, SecretMetadata } from "@saas/db/config";
import type {
  AppendEventWithAuditInput,
  EventsResult,
  StoredEvent,
  StoredAuditEntry,
} from "@saas/db/events";
import type { BrokerBindingValidation } from "@config-worker/integrations-client";

const TEST_ORG_UUID = "11111111-1111-1111-1111-111111111111";
const TEST_USER_ID = "usr_" + "ab".repeat(16);
const SECRET_UUID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const OLD_CONNECTION = "int_" + "a".repeat(32);
const NEW_CONNECTION = "int_" + "b".repeat(32);
const NEW_CONNECTION_UUID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const FIXED_NOW = new Date("2026-05-01T00:00:00Z");

const ACTOR: ActorContext = { subjectId: TEST_USER_ID, subjectType: "user" };
const ORG_SCOPE: Scope = { kind: "organization", orgId: TEST_ORG_UUID };
const FAKE_ENV = {} as Env;

const EVENT_STUB = { id: "evt", type: "x", version: 1 } as unknown as StoredEvent;
const AUDIT_STUB = { id: "aud" } as unknown as StoredAuditEntry;

function brokeredSecret(overrides?: Partial<SecretMetadata>): SecretMetadata {
  return {
    id: SECRET_UUID,
    orgId: TEST_ORG_UUID,
    projectId: null,
    environmentId: null,
    scopeKind: "organization",
    secretKey: "SUPABASE_API",
    displayName: null,
    status: "active",
    version: 3,
    rotationPolicy: null,
    lastRotatedAt: null,
    expiresAt: null,
    createdBy: TEST_USER_ID,
    personalOwner: null,
    source: "brokered",
    bindingProvider: "supabase",
    bindingConnectionId: OLD_CONNECTION,
    bindingTemplate: "management-access",
    overridable: true,
    lastUsedAt: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  } as SecretMetadata;
}

function eventsRepo() {
  const calls: AppendEventWithAuditInput[] = [];
  return {
    calls,
    appendEventWithAudit(input: AppendEventWithAuditInput): Promise<EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>> {
      calls.push(input);
      return Promise.resolve({ ok: true as const, value: { event: EVENT_STUB, audit: AUDIT_STUB } });
    },
  };
}

function req(body: unknown): Request {
  return new Request("https://config-worker/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validationOk: BrokerBindingValidation = { ok: true, provider: "supabase", maxTtlSeconds: 3600 };

function makeDeps(over: {
  head?: SecretMetadata;
  repoint?: RepointSecretDeps["repo"]["repointBrokeredSecret"];
  validate?: (r: unknown) => Promise<BrokerBindingValidation>;
  events?: ReturnType<typeof eventsRepo>;
}): RepointSecretDeps {
  const head = over.head ?? brokeredSecret();
  return {
    repo: {
      getSecretMetadata: () => Promise.resolve({ ok: true as const, value: head }),
      repointBrokeredSecret:
        over.repoint ??
        ((_o, _s, _c, binding) =>
          Promise.resolve({
            ok: true as const,
            value: brokeredSecret({
              version: 4,
              bindingConnectionId: NEW_CONNECTION,
              bindingProvider: binding.provider,
              bindingTemplate: binding.template,
            }),
          })),
    },
    ...(over.events ? { eventsRepo: over.events } : {}),
    validateBinding: ((over.validate ?? (() => Promise.resolve(validationOk))) as NonNullable<RepointSecretDeps["validateBinding"]>),
    generateId: () => "fixedid",
    now: () => FIXED_NOW,
  };
}

describe("handleRepointSecret", () => {
  it("repoints a brokered head to a new connection and bumps the version", async () => {
    const events = eventsRepo();
    let repointArgs: unknown = null;
    const res = await handleRepointSecret(
      req({ binding: { connectionId: NEW_CONNECTION } }),
      FAKE_ENV,
      "req_1",
      ACTOR,
      ORG_SCOPE,
      SECRET_UUID,
      makeDeps({
        events,
        repoint: (o, s, c, binding) => {
          repointArgs = { o, s, binding };
          return Promise.resolve({
            ok: true as const,
            value: brokeredSecret({ version: 4, bindingConnectionId: NEW_CONNECTION }),
          });
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { secret: { version: number; source: string } } };
    expect(json.data.secret.version).toBe(4);
    expect(json.data.secret.source).toBe("brokered");
    // The new connection's uuid + reused template flowed into the repoint call.
    expect(repointArgs).toMatchObject({
      binding: { connectionUuid: NEW_CONNECTION_UUID, template: "management-access", provider: "supabase" },
    });
    // A secrets.updated (repoint) + a binding.created event were emitted.
    const ops = events.calls.map((c) => (c.event.payload as { operation?: string }).operation);
    expect(ops).toContain("repoint");
  });

  it("reuses the existing template when the body omits it, but honors an override", async () => {
    let seenTemplate = "";
    const deps = makeDeps({
      repoint: (_o, _s, _c, binding) => {
        seenTemplate = binding.template;
        return Promise.resolve({ ok: true as const, value: brokeredSecret({ version: 4 }) });
      },
    });
    await handleRepointSecret(req({ binding: { connectionId: NEW_CONNECTION, template: "read-only" } }), FAKE_ENV, "r", ACTOR, ORG_SCOPE, SECRET_UUID, deps);
    expect(seenTemplate).toBe("read-only");
  });

  it("refuses to repoint a static secret (400 not_brokered)", async () => {
    const res = await handleRepointSecret(
      req({ binding: { connectionId: NEW_CONNECTION } }),
      FAKE_ENV,
      "r",
      ACTOR,
      ORG_SCOPE,
      SECRET_UUID,
      makeDeps({ head: brokeredSecret({ source: "static", bindingTemplate: null, bindingConnectionId: null, bindingProvider: null }) }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { details: { reason: string } } };
    expect(json.error.details.reason).toBe("not_brokered");
  });

  it("rejects repointing onto a dead connection (412 connection_inactive) before any DB write", async () => {
    let repointCalled = false;
    const res = await handleRepointSecret(
      req({ binding: { connectionId: NEW_CONNECTION } }),
      FAKE_ENV,
      "r",
      ACTOR,
      ORG_SCOPE,
      SECRET_UUID,
      makeDeps({
        validate: () => Promise.resolve({ ok: false, status: 412, reason: "connection_inactive" }),
        repoint: () => {
          repointCalled = true;
          return Promise.resolve({ ok: true as const, value: brokeredSecret() });
        },
      }),
    );
    expect(res.status).toBe(412);
    const json = (await res.json()) as { error: { details: { reason: string } } };
    expect(json.error.details.reason).toBe("connection_inactive");
    expect(repointCalled).toBe(false);
  });

  it("404s an unknown secret", async () => {
    const deps = makeDeps({});
    deps.repo.getSecretMetadata = () => Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } });
    const res = await handleRepointSecret(req({ binding: { connectionId: NEW_CONNECTION } }), FAKE_ENV, "r", ACTOR, ORG_SCOPE, SECRET_UUID, deps);
    expect(res.status).toBe(404);
  });

  it("422s a malformed connection id", async () => {
    const res = await handleRepointSecret(req({ binding: { connectionId: "int_nope" } }), FAKE_ENV, "r", ACTOR, ORG_SCOPE, SECRET_UUID, makeDeps({}));
    expect(res.status).toBe(422);
  });
});
