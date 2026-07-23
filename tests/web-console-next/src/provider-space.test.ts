// saas-secrets-platform SP2: the per-provider integration space (SP-A2).
//
// Pure-logic tests for the space's routing, secret filtering, and mode
// derivation, plus the Cloudflare custom-surface registration (the SP2
// "authoring: custom" fulfillment). No jsdom — components are identity-
// checked, never rendered.

import type { ProviderSecretsCapability } from "@saas/contracts/integrations";
import type { PublicSecretMetadata } from "@saas/contracts/config";
import {
  capabilityForProvider,
  modeToggleFor,
  providerBoundSecrets,
  providerSpaceCreateHref,
  providerSpaceHref,
  surfaceModeFor,
} from "@web-console-next/components/integrations/provider-space-lib";
import {
  authoringSurfaceFor,
  hasCustomAuthoring,
} from "@web-console-next/components/config/authoring-registry";
import { DefaultAuthoringSurface } from "@web-console-next/components/config/authoring-surface";
import { CloudflareAuthoringSurface } from "@web-console-next/components/integrations/cloudflare-authoring";
// The side-effect module the provider space imports.
import "@web-console-next/components/integrations/authoring-surfaces";

function capability(overrides: Partial<ProviderSecretsCapability> & { provider: ProviderSecretsCapability["provider"] }): ProviderSecretsCapability {
  return {
    scopeTemplates: [],
    supportedModes: ["brokered"],
    deliveryTargets: [],
    authoring: "declarative",
    ...overrides,
  };
}

const CAPS = [
  capability({ provider: "cloudflare", supportedModes: ["brokered", "rotated"], authoring: "custom" }),
  capability({ provider: "supabase" }),
];

describe("provider space routing (SP-A2/SP-A4)", () => {
  it("builds the space and create hrefs", () => {
    expect(providerSpaceHref("acme", "cloudflare")).toBe(
      "/orgs/acme/integrations/providers/cloudflare",
    );
    expect(providerSpaceCreateHref("acme", "cloudflare")).toBe(
      "/orgs/acme/integrations/providers/cloudflare?create=1",
    );
    const conn = `int_${"a".repeat(32)}`;
    expect(providerSpaceCreateHref("acme", "cloudflare", conn)).toBe(
      `/orgs/acme/integrations/providers/cloudflare?create=1&connection=${conn}`,
    );
  });
});

describe("capabilityForProvider / modeToggleFor", () => {
  it("finds the provider's declaration, null when absent", () => {
    expect(capabilityForProvider(CAPS, "cloudflare")?.supportedModes).toEqual(["brokered", "rotated"]);
    expect(capabilityForProvider(CAPS, "github")).toBeNull();
    expect(capabilityForProvider([], "cloudflare")).toBeNull();
  });

  it("derives the create-mode toggle from the declared modes", () => {
    expect(modeToggleFor(capabilityForProvider(CAPS, "cloudflare"))).toEqual([
      { mode: "binding", label: "Scoped credential" },
      { mode: "rotated", label: "Rotated secret" },
    ]);
    expect(modeToggleFor(capabilityForProvider(CAPS, "supabase"))).toEqual([
      { mode: "binding", label: "Scoped credential" },
    ]);
    expect(modeToggleFor(null)).toEqual([]);
  });

  it("maps SecretMode to the surface mode", () => {
    expect(surfaceModeFor("brokered")).toBe("binding");
    expect(surfaceModeFor("rotated")).toBe("rotated");
  });
});

describe("providerBoundSecrets (the owner's footprint)", () => {
  const CONN = `int_${"b".repeat(32)}`;
  const rows = [
    // Brokered, bound to cloudflare.
    {
      source: "brokered",
      binding: { provider: "cloudflare", template: "workers-deploy", connectionId: CONN },
    },
    // Rotated, minted from cloudflare.
    {
      source: "static",
      rotation: { provider: "cloudflare", template: "workers-deploy", connectionId: CONN, deliverTarget: null },
    },
    // Brokered, bound to supabase — not cloudflare's.
    {
      source: "brokered",
      binding: { provider: "supabase", template: "db-migrate", connectionId: CONN },
    },
    // Plain static — no owner.
    { source: "static" },
  ] as unknown as Array<Pick<PublicSecretMetadata, "source" | "binding" | "rotation">>;

  it("keeps only rows this provider's connections produced", () => {
    expect(providerBoundSecrets(rows, "cloudflare")).toHaveLength(2);
    expect(providerBoundSecrets(rows, "supabase")).toHaveLength(1);
    expect(providerBoundSecrets(rows, "github")).toHaveLength(0);
  });
});

describe("Cloudflare custom-surface registration (SP2)", () => {
  it("cloudflare resolves to its custom surface; supabase inherits the default", () => {
    expect(hasCustomAuthoring("cloudflare")).toBe(true);
    expect(authoringSurfaceFor("cloudflare")).toBe(CloudflareAuthoringSurface);
    expect(hasCustomAuthoring("supabase")).toBe(false);
    expect(authoringSurfaceFor("supabase")).toBe(DefaultAuthoringSurface);
  });
});
