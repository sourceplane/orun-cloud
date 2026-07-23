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
  integrationCreateMenu,
  legacyBindRedirect,
  modeToggleFor,
  providerBoundSecrets,
  providerSpaceCreateHref,
  providerSpaceHref,
  surfaceModeFor,
} from "@web-console-next/components/integrations/provider-space-lib";
import {
  brokerConnections,
  managedByProvider,
  templatesForProvider,
} from "@web-console-next/components/config/bind-secret-flow";
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

describe("provider space routing (SP-A2/SP-A4; IR2 canonical route)", () => {
  it("builds the space and create hrefs", () => {
    expect(providerSpaceHref("acme", "cloudflare")).toBe(
      "/orgs/acme/integrations/cloudflare",
    );
    expect(providerSpaceCreateHref("acme", "cloudflare")).toBe(
      "/orgs/acme/integrations/cloudflare?create=1",
    );
    const conn = `int_${"a".repeat(32)}`;
    expect(providerSpaceCreateHref("acme", "cloudflare", conn)).toBe(
      `/orgs/acme/integrations/cloudflare?create=1&connection=${conn}`,
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

describe("integrationCreateMenu (SP3, SP-A3)", () => {
  it("derives one routed item per capability-declaring provider", () => {
    const items = integrationCreateMenu(CAPS, "acme", (id) => (id === "cloudflare" ? "Cloudflare" : id));
    expect(items).toEqual([
      {
        providerId: "cloudflare",
        label: "From Cloudflare…",
        href: "/orgs/acme/integrations/cloudflare?create=1",
      },
      {
        providerId: "supabase",
        label: "From supabase…",
        href: "/orgs/acme/integrations/supabase?create=1",
      },
    ]);
  });

  it("renders no items with no capabilities — never a hardcoded fallback (SP-A5)", () => {
    expect(integrationCreateMenu([], "acme")).toEqual([]);
  });
});

describe("legacyBindRedirect (SP3, SP-A4)", () => {
  const CONN = `int_${"c".repeat(32)}`;
  const connections = [{ id: CONN, provider: "cloudflare" }];

  it("routes a known connection to its owner's create dialog, pre-selected", () => {
    expect(legacyBindRedirect("acme", CONN, connections)).toBe(
      `/orgs/acme/integrations/cloudflare?create=1&connection=${CONN}`,
    );
  });

  it("falls back to the hub without (or with an unknown) connection", () => {
    expect(legacyBindRedirect("acme", null, connections)).toBe("/orgs/acme/integrations");
    expect(legacyBindRedirect("acme", `int_${"d".repeat(32)}`, connections)).toBe("/orgs/acme/integrations");
  });
});

describe("managedByProvider (SP3 'Managed by {integration}')", () => {
  const CONN = `int_${"e".repeat(32)}`;
  it("names the rotation producer, else the broker binding's provider, else null", () => {
    expect(
      managedByProvider({
        source: "static",
        rotation: { provider: "cloudflare", template: "t", connectionId: CONN, deliverTarget: null },
      } as never),
    ).toBe("cloudflare");
    expect(
      managedByProvider({
        source: "brokered",
        binding: { provider: "supabase", template: "t", connectionId: CONN },
      } as never),
    ).toBe("supabase");
    expect(managedByProvider({ source: "static" } as never)).toBeNull();
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

describe("SP6 pluggability proof — a new provider lights up by declaration alone", () => {
  // The dormant AWS declaration (brokered STS sessions, declarative
  // authoring). Every console derivation below runs the SAME generic code
  // paths that serve cloudflare/supabase — no console file names 'aws'.
  const AWS = capability({
    provider: "aws" as ProviderSecretsCapability["provider"],
    supportedModes: ["brokered"],
    scopeTemplates: [
      {
        id: "deploy-session",
        provider: "aws" as ProviderSecretsCapability["provider"],
        version: 1,
        displayName: "Deploy session",
        description: "STS session assuming the deploy role.",
        params: ["roleSessionName", "sessionPolicyArn"],
        maxTtlSeconds: 3600,
      },
    ],
  });

  it("inherits the default authoring surface (declarative, zero UI code)", () => {
    expect(hasCustomAuthoring("aws")).toBe(false);
    expect(authoringSurfaceFor("aws")).toBe(DefaultAuthoringSurface);
  });

  it("derives eligibility, templates, menu items, and the mode toggle generically", () => {
    const caps = [...CAPS, AWS];
    expect(capabilityForProvider(caps, "aws")?.supportedModes).toEqual(["brokered"]);
    expect(templatesForProvider(caps, "aws").map((t) => t.id)).toEqual(["deploy-session"]);
    expect(modeToggleFor(AWS)).toEqual([{ mode: "binding", label: "Scoped credential" }]);
    const menu = integrationCreateMenu(caps, "acme");
    expect(menu.some((m) => m.providerId === "aws")).toBe(true);
    const conns = [{ id: "1", provider: "aws", status: "active" }];
    expect(brokerConnections(conns, caps, "brokered")).toHaveLength(1);
    // Rotated narrows it out — the declaration, not a hardcode, decides.
    expect(brokerConnections(conns, caps, "rotated")).toHaveLength(0);
  });
});
