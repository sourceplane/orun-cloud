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
    // Full env: both methods live, oauth first (ordered preference).
    expect(module.resolveConnect(fullEnv())).toEqual([
      { kind: "oauth", live: true },
      { kind: "token", live: true },
    ]);
    // Custody only: token-paste live, oauth parked.
    const custodyOnly = { ENVIRONMENT: "test", SECRET_ENCRYPTION_KEY: KEY } as unknown as Env;
    expect(module.resolveConnect(custodyOnly)).toEqual([
      { kind: "oauth", live: false },
      { kind: "token", live: true },
    ]);
    // No custody: nothing is live.
    const bare = { ENVIRONMENT: "test" } as unknown as Env;
    expect(module.resolveConnect(bare).every((c) => !c.live)).toBe(true);
  });

  it("dormant providers never report a live connect method", () => {
    for (const id of DORMANT_PROVIDER_IDS) {
      const module = getManifestModule(id)!;
      expect(module.resolveConnect(fullEnv()).every((c) => !c.live)).toBe(true);
    }
  });
});
