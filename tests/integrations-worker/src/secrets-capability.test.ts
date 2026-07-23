// saas-secrets-platform SP0: the provider secret-source DESCRIBE capability +
// its endpoint. Asserts the declaration reproduces today's hardcoded truth
// exactly (the SP0 no-behavior-change invariant), the secrets⇒broker invariant,
// and the endpoint's shape/error paths.

import { handleInternalSecretsCapability } from "@integrations-worker/handlers/internal-secrets-capability";
import { getConfiguredProvider, KNOWN_PROVIDER_IDS } from "@integrations-worker/providers/registry";
import { route } from "@integrations-worker/router";
import type { Env } from "@integrations-worker/env";
import { CLOUDFLARE_SCOPE_TEMPLATES } from "@integrations-worker/providers/cloudflare";
import { SUPABASE_SCOPE_TEMPLATES } from "@integrations-worker/providers/supabase";

const KEY = "0".repeat(64);

function jsonFetcher(body: unknown): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json(body)),
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function createEnv(overrides?: Record<string, unknown>): Env {
  return {
    ENVIRONMENT: "test",
    SECRET_ENCRYPTION_KEY: KEY,
    SUPABASE_OAUTH_CLIENT_ID: "sb-cid",
    SUPABASE_OAUTH_CLIENT_SECRET: "sb-cs",
    ...overrides,
  } as unknown as Env;
}

/** Env for the org-surface route: DB + auth service bindings present, policy allow. */
function createOrgEnv(): Env {
  return createEnv({
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
  });
}

// org_<32hex> — a valid v4-shaped uuid in hex form (matches parseOrgPublicId).
const ORG_PUBLIC_ID = "org_11111111111141118111111111111111";

function get(provider?: string): Request {
  const url = provider
    ? `https://iw/internal/providers/secrets-capability?provider=${provider}`
    : `https://iw/internal/providers/secrets-capability`;
  return new Request(url, { method: "GET" });
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

describe("secrets-source capability declarations (SP0)", () => {
  it("every provider that declares `secrets` also declares `broker` (invariant)", () => {
    const env = createEnv({
      CLOUDFLARE_OAUTH_CLIENT_ID: "cf-cid",
      CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-cs",
    });
    for (const id of KNOWN_PROVIDER_IDS) {
      const provider = getConfiguredProvider(env, id)?.provider;
      if (!provider) continue;
      if (provider.capabilities.includes("secrets")) {
        expect(provider.secrets).toBeDefined();
        expect(provider.broker).toBeDefined(); // secrets ⇒ broker
      }
    }
  });

  it("cloudflare reproduces the shipped hardcodes exactly (brokered+rotated, cf-worker target)", () => {
    const cf = getConfiguredProvider(createEnv(), "cloudflare")?.provider;
    expect(cf?.secrets).toBeDefined();
    const s = cf!.secrets!;
    expect(s.scopeTemplates()).toEqual(CLOUDFLARE_SCOPE_TEMPLATES);
    // ALLOWED_ROTATION_PROVIDERS = ["cloudflare"] → rotated present.
    expect([...s.supportedModes].sort()).toEqual(["brokered", "rotated"]);
    expect(s.deliveryTargets()).toEqual(["cloudflare-worker"]);
  });

  it("supabase reproduces the shipped hardcodes exactly (brokered only, no delivery)", () => {
    const sb = getConfiguredProvider(createEnv(), "supabase")?.provider;
    expect(sb?.secrets).toBeDefined();
    const s = sb!.secrets!;
    expect(s.scopeTemplates()).toEqual(SUPABASE_SCOPE_TEMPLATES);
    // In BROKER_CAPABLE_PROVIDERS but NOT ALLOWED_ROTATION_PROVIDERS.
    expect(s.supportedModes).toEqual(["brokered"]);
    expect(s.deliveryTargets()).toEqual([]);
  });
});

describe("GET /internal/providers/secrets-capability (SP0)", () => {
  it("projects the cloudflare capability", async () => {
    const env = createEnv();
    const res = await handleInternalSecretsCapability(get("cloudflare"), env, "req_1");
    expect(res.status).toBe(200);
    const data = await body(res);
    const cap = data.capability as Record<string, unknown>;
    expect(cap.provider).toBe("cloudflare");
    expect(cap.scopeTemplates).toEqual(CLOUDFLARE_SCOPE_TEMPLATES);
    expect([...(cap.supportedModes as string[])].sort()).toEqual(["brokered", "rotated"]);
    expect(cap.deliveryTargets).toEqual(["cloudflare-worker"]);
    expect(cap.authoring).toBe("declarative");
  });

  it("422s a missing provider param", async () => {
    const res = await handleInternalSecretsCapability(get(), createEnv(), "req_1");
    expect(res.status).toBe(422);
  });

  it("404s an unknown provider", async () => {
    const res = await handleInternalSecretsCapability(get("vercel"), createEnv(), "req_1");
    expect(res.status).toBe(404);
  });

  it("404s a provider without a secret-source capability (github)", async () => {
    // GitHub has no `secrets` capability (it is scm, not a credential broker).
    const env = createEnv({
      GITHUB_APP_ID: "1",
      GITHUB_APP_SLUG: "app",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN-----",
      GITHUB_APP_WEBHOOK_SECRET: "whs",
    });
    const res = await handleInternalSecretsCapability(get("github"), env, "req_1");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// SP0c (SP-A1): the org-facing BULK read the console consumes.
// ---------------------------------------------------------------------------

function orgGet(headers: Record<string, string> = {}): Request {
  return new Request(
    `https://iw/v1/organizations/${ORG_PUBLIC_ID}/integrations/secrets-capabilities`,
    { method: "GET", headers },
  );
}

const ACTOR_HEADERS = {
  "x-actor-subject-id": "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "x-actor-subject-type": "user",
};

describe("GET /v1/organizations/:orgId/integrations/secrets-capabilities (SP0c)", () => {
  it("lists every capability-declaring provider in one response", async () => {
    const res = await route(orgGet(ACTOR_HEADERS), createOrgEnv());
    expect(res.status).toBe(200);
    const data = await body(res);
    const capabilities = data.capabilities as Array<Record<string, unknown>>;
    const byProvider = new Map(capabilities.map((c) => [c.provider, c]));
    // The configured secret-source providers — and ONLY those.
    expect([...byProvider.keys()].sort()).toEqual(["cloudflare", "supabase"]);
    const cf = byProvider.get("cloudflare")!;
    expect(cf.scopeTemplates).toEqual(CLOUDFLARE_SCOPE_TEMPLATES);
    expect([...(cf.supportedModes as string[])].sort()).toEqual(["brokered", "rotated"]);
    expect(cf.deliveryTargets).toEqual(["cloudflare-worker"]);
    const sb = byProvider.get("supabase")!;
    expect(sb.scopeTemplates).toEqual(SUPABASE_SCOPE_TEMPLATES);
    expect(sb.supportedModes).toEqual(["brokered"]);
  });

  it("requires an actor (401 without x-actor headers)", async () => {
    const res = await route(orgGet(), createOrgEnv());
    expect(res.status).toBe(401);
  });

  it("policy deny resource-hides (404)", async () => {
    const env = createEnv({
      PLATFORM_DB: { connectionString: "postgres://fake" },
      MEMBERSHIP_WORKER: jsonFetcher({ data: { memberships: [] } }),
      POLICY_WORKER: jsonFetcher({ data: { allow: false, reason: "no_grant" } }),
    });
    const res = await route(orgGet(ACTOR_HEADERS), env);
    expect(res.status).toBe(404);
  });
});
