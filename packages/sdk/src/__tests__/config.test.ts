// Tests for the secret-manager console surface added to ConfigClient:
// chain read (SM1), version history (SM1), sync provenance (SM5), break-glass
// reveal (SEC7), and the secret-policy list/push/evaluate methods (SM3).
//
// Mirrors resources.test.ts: assert each method's URL + verb + body shape, and
// that reveal returns the (transient) value type and evaluate posts the facts.

import { describe, expect, it, vi } from "vitest";

import { OrunCloud } from "../index.js";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function captureFetch(response: Response): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response.clone();
  });
  return { fetch: fn, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function envelope<T>(data: T): { data: T; meta: { requestId: string; cursor: null } } {
  return { data, meta: { requestId: "req_test", cursor: null } };
}

function client(fetchImpl: typeof fetch): OrunCloud {
  return new OrunCloud({ baseUrl: "https://api.test", fetch: fetchImpl });
}

const ENV_SCOPE = {
  kind: "environment" as const,
  orgId: "org_1",
  projectId: "prj_1",
  environmentId: "env_1",
};
const ENV_BASE =
  "https://api.test/v1/organizations/org_1/projects/prj_1/environments/env_1/config";
const ORG_SCOPE = { kind: "organization" as const, orgId: "org_1" };
const ORG_BASE = "https://api.test/v1/organizations/org_1/config";

function bodyOf(call: CapturedCall): unknown {
  return JSON.parse(String(call.init.body));
}

describe("ConfigClient — secret chain / history / provenance", () => {
  it("listSecretChain requests the env-scope secrets path with ?chain=true", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ secrets: [] })));
    await client(fetch).config.listSecretChain(ENV_SCOPE);
    expect(calls[0]!.url).toBe(`${ENV_BASE}/secrets?chain=true`);
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("listSecretVersions addresses the secret by id", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ versions: [] })));
    await client(fetch).config.listSecretVersions(ENV_SCOPE, "sec_abc");
    expect(calls[0]!.url).toBe(`${ENV_BASE}/secrets/sec_abc/versions`);
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("listSecretSyncs forwards the secretKey/status filters as query params", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ syncs: [] })));
    await client(fetch).config.listSecretSyncs(ENV_SCOPE, { secretKey: "stripe_key", status: "synced" });
    const url = new URL(calls[0]!.url);
    expect(url.pathname.endsWith("/config/secrets/syncs")).toBe(true);
    expect(url.searchParams.get("secretKey")).toBe("stripe_key");
    expect(url.searchParams.get("status")).toBe("synced");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("listSecretSyncs sends no query params when unfiltered", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ syncs: [] })));
    await client(fetch).config.listSecretSyncs(ENV_SCOPE);
    expect(calls[0]!.url).toBe(`${ENV_BASE}/secrets/syncs`);
  });
});

describe("ConfigClient — break-glass reveal (SEC7)", () => {
  it("posts {reason} to the reveal route and returns the value type", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ secret: { value: "sk_live_xyz", version: 3 } })),
    );
    const res = await client(fetch).config.revealSecret(ENV_SCOPE, "sec_abc", {
      reason: "incident-1234 investigation",
    });
    expect(calls[0]!.url).toBe(`${ENV_BASE}/secrets/sec_abc/reveal`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(bodyOf(calls[0]!)).toEqual({ reason: "incident-1234 investigation" });
    // The one value-returning response — assert the transient value type.
    expect(res.secret.value).toBe("sk_live_xyz");
    expect(res.secret.version).toBe(3);
  });

  it("propagates an idempotency-key when supplied", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ secret: { value: "v", version: 1 } })),
    );
    await client(fetch).config.revealSecret(
      ENV_SCOPE,
      "sec_abc",
      { reason: "why" },
      { idempotencyKey: "ikey_reveal_1" },
    );
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_reveal_1");
  });
});

describe("ConfigClient — secret policies (SM3)", () => {
  it("listSecretPolicies hits the org-scope collection", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ policies: [] })));
    await client(fetch).config.listSecretPolicies(ORG_SCOPE);
    expect(calls[0]!.url).toBe(`${ORG_BASE}/secret-policies`);
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("putSecretPolicy PUTs the tier-tagged document", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({ policy: { name: "p", tier: "stack", source: "console", scope: "organization", documentHash: "h", updated: true } }),
      ),
    );
    const document = { rules: [{ id: "r1", effect: "allow", scope: { env: "*", key: "*" } }] };
    await client(fetch).config.putSecretPolicy(ORG_SCOPE, {
      name: "p",
      tier: "stack",
      source: "console",
      document,
    });
    expect(calls[0]!.url).toBe(`${ORG_BASE}/secret-policies`);
    expect(calls[0]!.init.method).toBe("PUT");
    expect(bodyOf(calls[0]!)).toEqual({ name: "p", tier: "stack", source: "console", document });
  });

  it("evaluateSecretPolicy POSTs the flat facts body to /evaluate", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({
          layer1: { action: "secret.value.use", allow: true, reason: "granted" },
          layer2: { allow: false, ruleId: "deny-prod", reason: "deny-prod" },
          decision: { allow: false },
        }),
      ),
    );
    const res = await client(fetch).config.evaluateSecretPolicy(ORG_SCOPE, {
      key: "STRIPE_KEY",
      env: "production",
      platform: "ci-oidc",
      subject: { id: "usr_1", kind: "user", teams: ["payments"] },
      trigger: { branch: "main", declared: true },
      component: { type: "service", name: "checkout" },
    });
    expect(calls[0]!.url).toBe(`${ORG_BASE}/secret-policies/evaluate`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(bodyOf(calls[0]!)).toEqual({
      key: "STRIPE_KEY",
      env: "production",
      platform: "ci-oidc",
      subject: { id: "usr_1", kind: "user", teams: ["payments"] },
      trigger: { branch: "main", declared: true },
      component: { type: "service", name: "checkout" },
    });
    // Both layers surface through unchanged.
    expect(res.layer1.allow).toBe(true);
    expect(res.layer2.ruleId).toBe("deny-prod");
    expect(res.decision.allow).toBe(false);
  });
});
