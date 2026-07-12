// SM3 SecretPolicy routes: PUT push (idempotent by hash) + POST evaluate
// (dry-run reporting both layers, the engine behind `orun policy test`).

import { handlePutSecretPolicy } from "@config-worker/handlers/put-secret-policy";
import { handleEvaluateSecretPolicy } from "@config-worker/handlers/evaluate-secret-policy";
import type { Env } from "@config-worker/env";
import type { ActorContext } from "@config-worker/router";
import type { ConfigResult, Scope, SecretPolicyRecord } from "@saas/db/config";
import type { AppendEventWithAuditInput, EventsResult, StoredEvent, StoredAuditEntry } from "@saas/db/events";

const ORG = "11111111-1111-1111-1111-111111111111";
const ACTOR: ActorContext = { subjectId: "usr_aabbccdd", subjectType: "user" };
const ENV = {} as Env;
const ORG_SCOPE: Scope = { kind: "organization", orgId: ORG };

function req(body: unknown, method = "PUT"): Request {
  return new Request("http://config-worker/v1/organizations/org_x/config/secret-policies", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function record(over: Partial<SecretPolicyRecord> = {}): SecretPolicyRecord {
  return {
    id: "p1",
    orgId: ORG,
    projectId: null,
    name: "prod-secrets",
    tier: "stack",
    source: "stack:test",
    document: { rules: [] },
    documentHash: "h",
    createdAt: new Date("2026-07-02T00:00:00Z"),
    ...over,
  };
}

describe("handlePutSecretPolicy", () => {
  it("validates and upserts, emitting secret.policy.updated when changed", async () => {
    const events: AppendEventWithAuditInput[] = [];
    const okEvent: EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }> = { ok: true, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
    const res = await handlePutSecretPolicy(
      req({ name: "prod-secrets", tier: "stack", source: "stack:test", document: { rules: [] } }),
      ENV, "req_1", ACTOR, ORG_SCOPE,
      {
        // Echo the handler-computed content hash back on the stored record.
        repo: { putSecretPolicy: async (input) => ({ ok: true, value: { record: record({ documentHash: input.documentHash }), updated: true } }) },
        eventsRepo: { appendEventWithAudit: async (i) => { events.push(i); return okEvent; } },
        generateId: () => "id",
      },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { policy: { name: string; updated: boolean; documentHash: string } } };
    expect(json.data.policy.name).toBe("prod-secrets");
    expect(json.data.policy.updated).toBe(true);
    expect(json.data.policy.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(events).toHaveLength(1);
    expect(events[0]!.event.type).toBe("secret.policy.updated");
  });

  it("does NOT emit an event on an idempotent (unchanged) re-push", async () => {
    const events: AppendEventWithAuditInput[] = [];
    await handlePutSecretPolicy(
      req({ name: "prod-secrets", tier: "stack", source: "stack:test", document: { rules: [] } }),
      ENV, "req_2", ACTOR, ORG_SCOPE,
      {
        repo: { putSecretPolicy: async () => ({ ok: true, value: { record: record(), updated: false } }) },
        eventsRepo: { appendEventWithAudit: async (i) => { events.push(i); return { ok: true, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } }; } },
      },
    );
    expect(events).toHaveLength(0);
  });

  it("422s an invalid tier", async () => {
    const res = await handlePutSecretPolicy(
      req({ name: "x", tier: "bogus", source: "s", document: { rules: [] } }),
      ENV, "req_3", ACTOR, ORG_SCOPE,
      { repo: { putSecretPolicy: async (): Promise<ConfigResult<{ record: SecretPolicyRecord; updated: boolean }>> => ({ ok: false, error: { kind: "internal", message: "x" } }) } },
    );
    expect(res.status).toBe(422);
  });

  // Locked-vocabulary validation at PUT time (SM3 pinned rule): an unknown
  // predicate must be a push-time validation error, never a resolve-time one.
  it("422s a rule whose when[] is outside the locked vocabulary", async () => {
    const neverCalled = { putSecretPolicy: async (): Promise<ConfigResult<{ record: SecretPolicyRecord; updated: boolean }>> => { throw new Error("must not persist an invalid document"); } };
    const res = await handlePutSecretPolicy(
      req({
        name: "p", tier: "stack", source: "s",
        document: { rules: [{ id: "r1", effect: "allow", scope: { env: "prod", key: "*" }, when: ["platform !~ weird-operator"] }] },
      }),
      ENV, "req_v1", ACTOR, ORG_SCOPE, { repo: neverCalled },
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { details: { fields: { document: string[] } } } };
    expect(json.error.details.fields.document.join(" ")).toContain("unknown predicate");
  });

  it("422s an unknown fact path, bad subject spelling, missing scope, and unknown rule fields", async () => {
    const neverCalled = { putSecretPolicy: async (): Promise<ConfigResult<{ record: SecretPolicyRecord; updated: boolean }>> => { throw new Error("must not persist an invalid document"); } };
    const res = await handlePutSecretPolicy(
      req({
        name: "p", tier: "stack", source: "s",
        document: {
          rules: [
            { id: "r1", effect: "allow", scope: { env: "prod", key: "*" }, when: ['tirgger.branch == "main"'] },
            { id: "r2", effect: "deny", subjects: ["robot:zed"], scope: { env: "prod", key: "*" } },
            { id: "r3", effect: "allow" },
            { id: "r4", effect: "allow", scope: { env: "prod", key: "*" }, sideEffect: true },
          ],
        },
      }),
      ENV, "req_v2", ACTOR, ORG_SCOPE, { repo: neverCalled },
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { details: { fields: { document: string[] } } } };
    const all = json.error.details.fields.document.join("\n");
    expect(all).toContain('unknown fact "tirgger.branch"');
    expect(all).toContain('unknown subject "robot:zed"');
    expect(all).toContain("rules[2].scope: required");
    expect(all).toContain("rules[3].sideEffect: unknown rule field");
  });

  it("accepts the full locked vocabulary (string DSL + structured forms)", async () => {
    const res = await handlePutSecretPolicy(
      req({
        name: "p", tier: "stack", source: "s",
        document: {
          rules: [
            {
              id: "ok",
              effect: "allow",
              subjects: ["team:platform-admins", "user:usr_1", "workflow", "*authenticated"],
              scope: { env: "prod", key: "STRIPE_*" },
              when: [
                'platform == "ci-oidc"',
                'trigger.branch == "main"',
                "trigger.declared",
                'component.type in ["billing-worker"]',
                "subject in team:payments",
                { kind: "matches", fact: "trigger.repository", glob: "acme/*" },
                { kind: "equals", fact: "component.labels.stage", value: "released" },
              ],
            },
          ],
        },
      }),
      ENV, "req_v3", ACTOR, ORG_SCOPE,
      { repo: { putSecretPolicy: async (input) => ({ ok: true, value: { record: record({ documentHash: input.documentHash }), updated: true } }) } },
    );
    expect(res.status).toBe(200);
  });
});

describe("handleEvaluateSecretPolicy (dry-run, both layers)", () => {
  const policies = (rules: unknown[]): SecretPolicyRecord[] => [record({ document: { rules } })];

  it("reports Layer-1 allow + Layer-2 allow ⇒ overall allow", async () => {
    const res = await handleEvaluateSecretPolicy(
      req({ key: "K", env: "dev", platform: "local-cli", subject: { id: "usr_1", kind: "user", teams: [] } }, "POST"),
      ENV, "req_4", ACTOR, ORG_SCOPE,
      { repo: { listSecretPolicies: async () => ({ ok: true, value: [] }) }, layer1: async () => true },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { layer1: { allow: boolean }; layer2: { allow: boolean; reason: string }; decision: { allow: boolean } } };
    expect(json.data.layer1.allow).toBe(true);
    expect(json.data.layer2.allow).toBe(true);
    expect(json.data.layer2.reason).toBe("rbac-only"); // dev untargeted
    expect(json.data.decision.allow).toBe(true);
  });

  it("reports a Layer-2 deny (protected env, no grant) even when Layer-1 allows", async () => {
    const res = await handleEvaluateSecretPolicy(
      req({ key: "K", env: "prod", platform: "ci-oidc", subject: { id: "usr_1", kind: "workflow", teams: [] } }, "POST"),
      ENV, "req_5", ACTOR, ORG_SCOPE,
      {
        repo: { listSecretPolicies: async () => ({ ok: true, value: policies([{ id: "deny-laptops", effect: "deny", subjects: ["*authenticated"], scope: { env: "prod", key: "*" }, when: ['platform == "local-cli"'] }]) }) },
        layer1: async () => true,
      },
    );
    const json = (await res.json()) as { data: { layer2: { allow: boolean; reason: string }; decision: { allow: boolean } } };
    expect(json.data.layer2.allow).toBe(false);
    expect(json.data.layer2.reason).toBe("no-matching-grant");
    expect(json.data.decision.allow).toBe(false);
  });

  it("a Layer-1 deny alone fails the overall decision", async () => {
    const res = await handleEvaluateSecretPolicy(
      req({ key: "K", env: "dev", platform: "local-cli" }, "POST"),
      ENV, "req_6", ACTOR, ORG_SCOPE,
      { repo: { listSecretPolicies: async () => ({ ok: true, value: [] }) }, layer1: async () => false },
    );
    const json = (await res.json()) as { data: { layer1: { allow: boolean }; decision: { allow: boolean } } };
    expect(json.data.layer1.allow).toBe(false);
    expect(json.data.decision.allow).toBe(false);
  });
});
