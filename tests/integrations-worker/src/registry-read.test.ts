// saas-integration-registry IR0: GET /v1/organizations/:orgId/integrations/registry.
//
// The bulk registry read every surface derives from: manifest projection with
// per-environment connect liveness, fail-soft entitlement projection, ETag'd
// repeat reads. Pure metadata — the tests also pin that no credential-shaped
// field can appear in a descriptor.

import { route } from "@integrations-worker/router";
import type { Env } from "@integrations-worker/env";

const KEY = "0".repeat(64);
const ORG_PUBLIC_ID = "org_11111111111141118111111111111111";

const ACTOR_HEADERS = {
  "x-actor-subject-id": "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "x-actor-subject-type": "user",
};

function jsonFetcher(body: unknown): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json(body)),
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function createOrgEnv(overrides?: Record<string, unknown>): Env {
  return {
    ENVIRONMENT: "test",
    SECRET_ENCRYPTION_KEY: KEY,
    SUPABASE_OAUTH_CLIENT_ID: "sb-cid",
    SUPABASE_OAUTH_CLIENT_SECRET: "sb-cs",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: jsonFetcher({
      data: {
        memberships: [
          {
            kind: "role_assignment",
            role: "admin",
            scope: { kind: "organization", orgId: "11111111-1111-4111-8111-111111111111" },
          },
        ],
      },
    }),
    POLICY_WORKER: jsonFetcher({ data: { allow: true, reason: "org_admin" } }),
    ...overrides,
  } as unknown as Env;
}

function get(headers: Record<string, string> = {}): Request {
  return new Request(`https://iw/v1/organizations/${ORG_PUBLIC_ID}/integrations/registry`, {
    method: "GET",
    headers,
  });
}

async function registryOf(res: Response): Promise<Array<Record<string, unknown>>> {
  const parsed = (await res.json()) as { data: { registry: Array<Record<string, unknown>> } };
  return parsed.data.registry;
}

describe("GET /v1/organizations/:orgId/integrations/registry (IR0)", () => {
  it("serves every manifest — live and dormant — in one response", async () => {
    const res = await route(get(ACTOR_HEADERS), createOrgEnv());
    expect(res.status).toBe(200);
    const registry = await registryOf(res);
    expect(registry.map((d) => d.id).sort()).toEqual(
      ["aws", "cloudflare", "discord", "github", "slack", "supabase"].sort(),
    );
    const statuses = new Map(registry.map((d) => [d.id, d.status]));
    expect(statuses.get("supabase")).toBe("live");
    expect(statuses.get("aws")).toBe("roadmap");
  });

  it("projects per-environment connect liveness (the configured gate, reported)", async () => {
    // This env: supabase configured, cloudflare custody-only, github/slack not.
    const res = await route(get(ACTOR_HEADERS), createOrgEnv());
    const registry = await registryOf(res);
    const byId = new Map(registry.map((d) => [d.id, d]));
    expect(byId.get("supabase")!.connect).toEqual([{ kind: "oauth", live: true }]);
    expect(byId.get("github")!.connect).toEqual([{ kind: "install", live: false }]);
    // Cloudflare's token method carries its adapter-derived recipe (IR3).
    expect(byId.get("cloudflare")!.connect).toMatchObject([
      { kind: "oauth", live: false },
      { kind: "token", live: true, recipe: expect.anything() },
    ]);
  });

  it("omits `entitled` when no billing binding exists (fail-soft, never fabricated)", async () => {
    const res = await route(get(ACTOR_HEADERS), createOrgEnv());
    const registry = await registryOf(res);
    for (const descriptor of registry) {
      expect("entitled" in descriptor).toBe(false);
    }
  });

  it("projects entitlement per live provider when billing answers", async () => {
    const env = createOrgEnv({
      BILLING_WORKER: jsonFetcher({
        data: { allowed: true, orgId: ORG_PUBLIC_ID, entitlementKey: "feature.integrations.x" },
      }),
    });
    const res = await route(get(ACTOR_HEADERS), env);
    const registry = await registryOf(res);
    const byId = new Map(registry.map((d) => [d.id, d]));
    expect(byId.get("supabase")!.entitled).toBe(true);
    // Dormant/roadmap manifests have nothing to gate yet.
    expect("entitled" in byId.get("aws")!).toBe(false);
  });

  it("ETags the payload and answers If-None-Match with 304", async () => {
    const env = createOrgEnv();
    const first = await route(get(ACTOR_HEADERS), env);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await route(get({ ...ACTOR_HEADERS, "if-none-match": etag! }), env);
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("descriptors are pure metadata — no credential-shaped fields", async () => {
    const res = await route(get(ACTOR_HEADERS), createOrgEnv());
    const serialized = JSON.stringify(await registryOf(res)).toLowerCase();
    for (const forbidden of ["ciphertext", "token\":", "secret\":", "privatekey"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("requires an actor (401) and respects policy deny (404)", async () => {
    expect((await route(get(), createOrgEnv())).status).toBe(401);
    const denyEnv = createOrgEnv({
      POLICY_WORKER: jsonFetcher({ data: { allow: false, reason: "denied" } }),
    });
    expect((await route(get(ACTOR_HEADERS), denyEnv)).status).toBe(404);
  });

  it("rejects non-GET methods (405)", async () => {
    const res = await route(
      new Request(`https://iw/v1/organizations/${ORG_PUBLIC_ID}/integrations/registry`, {
        method: "POST",
        headers: ACTOR_HEADERS,
      }),
      createOrgEnv(),
    );
    expect(res.status).toBe(405);
  });
});
