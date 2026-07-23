// saas-integration-registry IR0: the manifest-conformance lint.
//
// The manifest is metadata beside the adapter; THIS test is what makes it
// unable to drift the way the deleted console catalogs did. Every manifest is
// pinned to its adapter's code reality: capability lists match exactly,
// declared connect kinds cover every posture the adapter can resolve to,
// authoring matches the adapter's secrets declaration, and the space tabs are
// a pure function of capabilities. A manifest change that violates any of
// these fails CI — the milestone gate, not an afterthought (epic risks R5).

import {
  getManifestModule,
  INTEGRATION_MANIFEST_MODULES,
  listIntegrationManifests,
} from "@integrations-worker/providers/manifests/index";
import {
  DORMANT_PROVIDER_IDS,
  getConfiguredProvider,
  getDormantProvider,
  KNOWN_PROVIDER_IDS,
} from "@integrations-worker/providers/registry";
import type { IntegrationProvider } from "@integrations-worker/providers/types";
import type { Env } from "@integrations-worker/env";

const KEY = "0".repeat(64);

/** Env with EVERY provider's credential set present, so each live adapter
 *  resolves in its fullest posture (Cloudflare: oauth). */
function fullEnv(): Env {
  return {
    ENVIRONMENT: "test",
    SECRET_ENCRYPTION_KEY: KEY,
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "app",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN-----",
    GITHUB_APP_WEBHOOK_SECRET: "whs",
    SLACK_APP_CLIENT_ID: "sl-cid",
    SLACK_APP_CLIENT_SECRET: "sl-cs",
    SLACK_APP_SIGNING_SECRET: "sl-ss",
    CLOUDFLARE_OAUTH_CLIENT_ID: "cf-cid",
    CLOUDFLARE_OAUTH_CLIENT_SECRET: "cf-cs",
    SUPABASE_OAUTH_CLIENT_ID: "sb-cid",
    SUPABASE_OAUTH_CLIENT_SECRET: "sb-cs",
  } as unknown as Env;
}

function adapterFor(id: string): IntegrationProvider {
  const adapter = getConfiguredProvider(fullEnv(), id)?.provider ?? getDormantProvider(id);
  if (!adapter) throw new Error(`no adapter for manifest ${id}`);
  return adapter;
}

describe("manifest registry shape (IR0)", () => {
  it("covers every known + dormant provider id, exactly once", () => {
    const ids = listIntegrationManifests().map((m) => m.id);
    expect([...ids].sort()).toEqual([...KNOWN_PROVIDER_IDS, ...DORMANT_PROVIDER_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("known providers are live, dormant providers are not", () => {
    for (const m of listIntegrationManifests()) {
      if ((KNOWN_PROVIDER_IDS as readonly string[]).includes(m.id)) {
        expect(m.status).toBe("live");
      } else {
        expect(m.status).not.toBe("live");
      }
    }
  });

  it("getManifestModule resolves by id and rejects unknowns", () => {
    expect(getManifestModule("cloudflare")?.manifest.id).toBe("cloudflare");
    expect(getManifestModule("vercel")).toBeNull();
  });
});

describe("manifest ⊆ adapter conformance (IR0)", () => {
  for (const module of INTEGRATION_MANIFEST_MODULES) {
    const { manifest } = module;

    describe(manifest.id, () => {
      it("capabilities match the adapter exactly", () => {
        const adapter = adapterFor(manifest.id);
        expect([...manifest.capabilities].sort()).toEqual([...adapter.capabilities].sort());
      });

      it("declared connect kinds cover the adapter's resolved kind", () => {
        const adapter = adapterFor(manifest.id);
        const declared = manifest.connect.map((c) => c.kind);
        expect(declared).toContain(adapter.connectKind);
      });

      it("authoring matches the adapter's secrets declaration", () => {
        const adapter = adapterFor(manifest.id);
        if (adapter.secrets) {
          expect(manifest.capabilities).toContain("secrets");
          expect(manifest.space.authoring).toBe(adapter.secrets.authoring);
        } else {
          expect(manifest.capabilities).not.toContain("secrets");
        }
      });

      it("space tabs are a pure function of capabilities", () => {
        const tabs = manifest.space.tabs;
        // Always-on chrome.
        expect(tabs).toContain("overview");
        expect(tabs).toContain("connections");
        expect(tabs).toContain("settings");
        // Capability-driven tabs, both directions.
        expect(tabs.includes("secrets")).toBe(manifest.capabilities.includes("secrets"));
        expect(tabs.includes("templates")).toBe(
          manifest.capabilities.includes("credential-broker"),
        );
      });

      it("liveness resolver reports every declared method, in order", () => {
        const resolved = module.resolveConnect(fullEnv());
        expect(resolved.map((c) => c.kind)).toEqual(manifest.connect.map((c) => c.kind));
        for (const method of resolved) expect(typeof method.live).toBe("boolean");
      });
    });
  }

  it("cloudflare reports per-method liveness honestly across env postures", () => {
    const module = getManifestModule("cloudflare")!;
    // Full env: both methods live, oauth first (ordered preference); the
    // token method carries its derived recipe (IR3).
    expect(module.resolveConnect(fullEnv())).toMatchObject([
      { kind: "oauth", live: true },
      { kind: "token", live: true, recipe: expect.anything() },
    ]);
    // Custody only: token-paste live, oauth parked.
    const custodyOnly = { ENVIRONMENT: "test", SECRET_ENCRYPTION_KEY: KEY } as unknown as Env;
    expect(module.resolveConnect(custodyOnly)).toMatchObject([
      { kind: "oauth", live: false },
      { kind: "token", live: true },
    ]);
    // No custody: nothing is live.
    const bare = { ENVIRONMENT: "test" } as unknown as Env;
    expect(module.resolveConnect(bare).every((c) => !c.live)).toBe(true);
  });

  it("cloudflare's token recipe is derived from the adapter grammar (IR3 — no drift possible)", async () => {
    const { TEMPLATE_PERMISSION_GROUPS, buildParentTokenRecipe } = await import(
      "@integrations-worker/providers/cloudflare"
    );
    const module = getManifestModule("cloudflare")!;
    const token = module.resolveConnect(fullEnv()).find((m) => m.kind === "token");
    expect(token?.recipe).toEqual(buildParentTokenRecipe());
    // Every permission group any template needs appears in the recipe, plus
    // the mint grant itself — the deleted console copy can never come back
    // incomplete.
    const served = new Set(token!.recipe!.items.map((i) => i.name));
    for (const groups of Object.values(TEMPLATE_PERMISSION_GROUPS)) {
      for (const group of groups as readonly string[]) expect(served.has(group)).toBe(true);
    }
    expect(served.has("Account API Tokens Write")).toBe(true);
    // OAuth (a provider-hosted consent) needs no recipe.
    const oauth = module.resolveConnect(fullEnv()).find((m) => m.kind === "oauth");
    expect(oauth?.recipe).toBeUndefined();
  });

  it("dormant providers never report a live connect method", () => {
    for (const id of DORMANT_PROVIDER_IDS) {
      const module = getManifestModule(id)!;
      expect(module.resolveConnect(fullEnv()).every((c) => !c.live)).toBe(true);
    }
  });
});

// saas-integration-registry IR5: the re-homed AI/compute apikey family.
describe("apikey providers (IR5)", () => {
  const APIKEY_IDS = ["anthropic", "openai", "openrouter", "daytona"] as const;

  it("apikey connect is live with ZERO env secrets — the paste is the credential", () => {
    const bare = { ENVIRONMENT: "test" } as unknown as Env;
    for (const id of APIKEY_IDS) {
      const module = getManifestModule(id)!;
      expect(module.resolveConnect(bare)).toEqual([{ kind: "apikey", live: true }]);
      // The adapter resolves configured on the same bare env (no gate).
      expect(getConfiguredProvider(bare, id)?.provider.connectKind).toBe("apikey");
    }
  });

  it("declares connect-only capabilities and the capability-pure tab set", () => {
    for (const id of APIKEY_IDS) {
      const { manifest } = getManifestModule(id)!;
      expect(manifest.status).toBe("live");
      expect([...manifest.capabilities]).toEqual(["connect"]);
      expect(manifest.multiConnection).toBe(true); // named keys
      // No secrets/templates capability → no secrets/templates tab.
      expect([...manifest.space.tabs]).toEqual(["overview", "connections", "activity", "settings"]);
    }
  });

  it("categories: the AI trio + daytona compute; modules models/sandboxes", () => {
    for (const id of ["anthropic", "openai", "openrouter"] as const) {
      const { manifest } = getManifestModule(id)!;
      expect(manifest.category).toBe("ai-provider");
      expect([...manifest.space.modules]).toEqual(["models"]);
      expect(manifest.entitlement).toBe(`feature.integrations.${id}`);
    }
    const daytona = getManifestModule("daytona")!.manifest;
    expect(daytona.category).toBe("compute");
    expect([...daytona.space.modules]).toEqual(["sandboxes"]);
    expect(daytona.entitlement).toBe("feature.integrations.daytona");
  });

  it("every apikey adapter exposes verifyApiKey; daytona's is DELEGATED", async () => {
    const bare = { ENVIRONMENT: "test" } as unknown as Env;
    for (const id of APIKEY_IDS) {
      expect(getConfiguredProvider(bare, id)?.provider.verifyApiKey).toBeDefined();
    }
    // Daytona never re-implements the agents plane's sandbox-create probe —
    // it answers with the delegation marker instead of a real verdict.
    const daytona = getConfiguredProvider(bare, "daytona")!.provider;
    await expect(daytona.verifyApiKey!("dtn_x", {})).resolves.toEqual({
      ok: true,
      delegated: true,
    });
  });

  it("AI trio verification mirrors the agents-worker probes (endpoint + headers, redacted failures)", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response("nope", { status: 401 });
    }) as unknown as Parameters<typeof getConfiguredProvider>[2];
    const bare = { ENVIRONMENT: "test" } as unknown as Env;

    const anthropic = getConfiguredProvider(bare, "anthropic", fetchImpl)!.provider;
    expect(await anthropic.verifyApiKey!("sk-ant-x", {})).toEqual({
      ok: false,
      reason: "401 from provider",
    });
    expect(calls[0]).toEqual({
      url: "https://api.anthropic.com/v1/models",
      headers: { "x-api-key": "sk-ant-x", "anthropic-version": "2023-06-01" },
    });

    const openai = getConfiguredProvider(bare, "openai", fetchImpl)!.provider;
    await openai.verifyApiKey!("sk-x", {});
    expect(calls[1]).toEqual({
      url: "https://api.openai.com/v1/models",
      headers: { authorization: "Bearer sk-x" },
    });

    const openrouter = getConfiguredProvider(bare, "openrouter", fetchImpl)!.provider;
    await openrouter.verifyApiKey!("sk-or-x", { baseUrl: "https://gw.example/v1/" });
    // config.baseUrl overrides the vendor default, trailing slash trimmed.
    expect(calls[2]).toEqual({
      url: "https://gw.example/v1/key",
      headers: { authorization: "Bearer sk-or-x" },
    });
  });
});
