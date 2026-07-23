// saas-integration-registry IR1: the console's registry helpers — the pure
// logic that replaced the hardcoded `providers.ts` catalog. Card state and
// connect dispatch are pure functions of the served descriptor + this org's
// connections; there is no per-provider branch to regress.

import type {
  IntegrationDescriptor,
  PublicConnection,
} from "@saas/contracts/integrations";
import {
  cardState,
  CATEGORY_ORDER,
  connectDispatch,
  descriptorById,
  groupByCategory,
  primaryLiveConnect,
  providerDisplayName,
  providerIconName,
} from "@web-console-next/components/integrations/registry";

function descriptor(overrides: Partial<IntegrationDescriptor>): IntegrationDescriptor {
  return {
    id: "supabase",
    displayName: "Supabase",
    category: "infrastructure",
    tagline: "Connect an org.",
    connect: [{ kind: "oauth", live: true }],
    multiConnection: false,
    capabilities: ["connect", "credential-broker", "secrets"],
    space: { tabs: ["overview", "connections", "settings"], modules: [], authoring: "declarative" },
    entitlement: "feature.integrations.supabase",
    version: 1,
    status: "live",
    ...overrides,
  } as IntegrationDescriptor;
}

function connection(overrides: Partial<PublicConnection>): PublicConnection {
  return {
    id: "int_1",
    orgId: "org_1",
    provider: "supabase",
    status: "active",
    scope: "account",
    shareMode: "auto",
    displayName: null,
    externalAccountLogin: null,
    externalAccountId: null,
    externalAccountType: null,
    connectedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as PublicConnection;
}

describe("cardState — a pure function of descriptor + connections", () => {
  it("connected when an active or pending connection exists", () => {
    expect(cardState(descriptor({}), [connection({})])).toBe("connected");
    expect(cardState(descriptor({}), [connection({ status: "pending" })])).toBe("connected");
    // revoked/suspended rows do not count as connected.
    expect(cardState(descriptor({}), [connection({ status: "revoked" })])).toBe("available");
  });

  it("locked when the plan excludes it; available when entitlement is unknown (fail-soft)", () => {
    expect(cardState(descriptor({ entitled: false }), [])).toBe("locked");
    expect(cardState(descriptor({ entitled: true }), [])).toBe("available");
    expect(cardState(descriptor({}), [])).toBe("available"); // omitted flag → connect gate decides
  });

  it("configure when the manifest is live but no method is env-ready", () => {
    expect(cardState(descriptor({ connect: [{ kind: "oauth", live: false }] }), [])).toBe(
      "configure",
    );
  });

  it("roadmap for non-live manifests, regardless of anything else", () => {
    expect(cardState(descriptor({ status: "roadmap", entitled: false }), [])).toBe("roadmap");
    expect(cardState(descriptor({ status: "dormant" }), [connection({})])).toBe("roadmap");
  });
});

describe("connectDispatch — posture-driven, never provider-named", () => {
  it("popup for a single live install/oauth method", () => {
    expect(connectDispatch(descriptor({}))).toEqual({ kind: "popup" });
    expect(
      connectDispatch(descriptor({ connect: [{ kind: "install", live: true }] })),
    ).toEqual({ kind: "popup" });
  });

  it("space for a token method or a multi-method posture (the Cloudflare shape)", () => {
    expect(
      connectDispatch(descriptor({ connect: [{ kind: "token", live: true }] })),
    ).toEqual({ kind: "space" });
    expect(
      connectDispatch(
        descriptor({
          connect: [
            { kind: "oauth", live: true },
            { kind: "token", live: true },
          ],
        }),
      ),
    ).toEqual({ kind: "space" });
    // Multi-method with only ONE live still belongs to the space — the space
    // renders the full posture (the recipe for the parked method included).
    expect(
      connectDispatch(
        descriptor({
          connect: [
            { kind: "oauth", live: false },
            { kind: "token", live: true },
          ],
        }),
      ),
    ).toEqual({ kind: "space" });
  });

  it("none when nothing is env-live", () => {
    expect(
      connectDispatch(descriptor({ connect: [{ kind: "oauth", live: false }] })),
    ).toEqual({ kind: "none" });
  });

  it("space for an apikey method (IR5 — the re-homed AI/compute providers)", () => {
    // The space's connect dialog owns the paste form; the hub never popups an
    // apikey provider. Always live: the paste is the credential (no env gate).
    expect(
      connectDispatch(
        descriptor({
          id: "anthropic" as never,
          category: "ai-provider",
          connect: [{ kind: "apikey", live: true }],
        }),
      ),
    ).toEqual({ kind: "space" });
    expect(
      connectDispatch(
        descriptor({
          id: "daytona" as never,
          category: "compute",
          connect: [{ kind: "apikey", live: true }],
        }),
      ),
    ).toEqual({ kind: "space" });
  });
});

describe("grouping + lookups", () => {
  const registry = [
    descriptor({ id: "github", category: "source-control", displayName: "GitHub" }),
    descriptor({ id: "slack", category: "messaging", displayName: "Slack" }),
    descriptor({ id: "supabase" }),
    descriptor({ id: "cloudflare", displayName: "Cloudflare" }),
  ];

  it("groups by category in CATEGORY_ORDER, dropping empty categories", () => {
    const groups = groupByCategory(registry);
    expect(groups.map((g) => g.category)).toEqual(["source-control", "messaging", "infrastructure"]);
    expect(groups[2]!.items.map((d) => d.id)).toEqual(["supabase", "cloudflare"]);
    // Every category has an order slot (ai-provider/compute reserved for IR5).
    expect(CATEGORY_ORDER).toEqual([
      "source-control",
      "messaging",
      "infrastructure",
      "ai-provider",
      "compute",
    ]);
  });

  it("descriptorById + display names fail soft to the id (SP-A5)", () => {
    expect(descriptorById(registry, "cloudflare")?.displayName).toBe("Cloudflare");
    expect(descriptorById(registry, "vercel")).toBeNull();
    expect(providerDisplayName(registry, "slack")).toBe("Slack");
    expect(providerDisplayName(undefined, "slack")).toBe("slack");
  });

  it("primaryLiveConnect returns the first live method in declared order", () => {
    const d = descriptor({
      connect: [
        { kind: "oauth", live: false },
        { kind: "token", live: true },
      ],
    });
    expect(primaryLiveConnect(d)).toEqual({ kind: "token", live: true });
    expect(primaryLiveConnect(descriptor({ connect: [{ kind: "oauth", live: false }] }))).toBeNull();
  });

  it("every provider renders an icon name, category fallback included", () => {
    for (const d of registry) expect(providerIconName(d).length).toBeGreaterThan(0);
    expect(providerIconName(descriptor({ id: "anthropic" as never, category: "ai-provider" }))).toBe(
      "Sparkles",
    );
  });
});
