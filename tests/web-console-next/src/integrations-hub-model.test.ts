// saas-integrations-console IX1: the hub's pure view-model — summary stats,
// filter predicates, and the connected-row meta line. All pure functions of the
// served registry + this org's connections + best-effort brokered metadata, so
// the directory stays a projection with no per-provider branch to regress.

import type {
  IntegrationDescriptor,
  PublicConnection,
} from "@saas/contracts/integrations";
import type { PublicSecretMetadata } from "@saas/contracts/config";
import {
  brokeredByConnection,
  brokeredSummary,
  connectedMetaLine,
  connectionAgeLabel,
  hubSummary,
  isLiveConnection,
  matchesSearch,
  matchesStatus,
  presentCategories,
  repositoryClause,
  roadmapListSentence,
} from "@web-console-next/components/integrations/hub-model";
import { CATEGORY_LABELS, CATEGORY_ORDER } from "@web-console-next/components/integrations/registry";

function descriptor(overrides: Partial<IntegrationDescriptor>): IntegrationDescriptor {
  return {
    id: "supabase",
    displayName: "Supabase",
    category: "infrastructure",
    tagline: "Connect an org for brokered credentials.",
    connect: [{ kind: "oauth", live: true }],
    multiConnection: false,
    capabilities: ["connect", "credential-broker", "secrets"],
    space: { tabs: ["overview"], modules: [], authoring: "declarative" },
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
    repositorySelection: null,
    connectedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as PublicConnection;
}

function brokered(overrides: Partial<PublicSecretMetadata>): PublicSecretMetadata {
  return {
    source: "brokered",
    binding: { provider: "supabase", connectionId: "int_1", template: "db-ro" },
    ...overrides,
  } as PublicSecretMetadata;
}

const REGISTRY = [
  descriptor({ id: "github", category: "source-control", displayName: "GitHub" }),
  descriptor({ id: "slack", category: "messaging", displayName: "Slack" }),
  descriptor({ id: "supabase", category: "infrastructure", displayName: "Supabase" }),
  descriptor({ id: "cloudflare", category: "infrastructure", displayName: "Cloudflare" }),
  descriptor({ id: "openai", category: "ai-provider", displayName: "OpenAI", connect: [{ kind: "apikey", live: true }] }),
  descriptor({ id: "fly" as never, category: "infrastructure", displayName: "Fly.io", entitled: false }),
  descriptor({ id: "aws", category: "infrastructure", displayName: "AWS", status: "roadmap" }),
];

describe("brokered secret reductions", () => {
  const secrets = [
    brokered({ binding: { provider: "supabase", connectionId: "int_1", template: "db-ro" } }),
    brokered({ binding: { provider: "supabase", connectionId: "int_1", template: "storage" } }),
    brokered({ binding: { provider: "cloudflare", connectionId: "int_2", template: "workers" } }),
    // static rows never count (no binding)
    { source: "static" } as PublicSecretMetadata,
  ];

  it("brokeredByConnection tallies per connection id", () => {
    const m = brokeredByConnection(secrets);
    expect(m.get("int_1")).toBe(2);
    expect(m.get("int_2")).toBe(1);
    expect(m.get("int_missing")).toBeUndefined();
  });

  it("brokeredSummary counts brokered rows and distinct providers", () => {
    expect(brokeredSummary(secrets)).toEqual({ total: 3, providers: 2 });
  });

  it("degrades to zero without the read", () => {
    expect(brokeredSummary(null)).toEqual({ total: 0, providers: 0 });
    expect(brokeredByConnection(undefined).size).toBe(0);
  });
});

describe("hubSummary", () => {
  it("counts live connections, registry categories, available, and brokered", () => {
    const connections = [
      connection({ id: "int_1", provider: "supabase", status: "active" }),
      connection({ id: "int_2", provider: "github", status: "pending" }),
      connection({ id: "int_3", provider: "slack", status: "revoked" }), // not live
    ];
    const secrets = [
      brokered({ binding: { provider: "supabase", connectionId: "int_1", template: "db-ro" } }),
    ];
    const s = hubSummary(connections, REGISTRY, secrets);
    expect(s.connectedCount).toBe(2); // active + pending, not revoked
    expect(s.categoryCount).toBe(4); // source-control, messaging, infrastructure, ai-provider
    expect(s.brokeredCount).toBe(1);
    expect(s.brokeredProviders).toBe(1);
    // available (available|locked|configure), not connected/roadmap:
    // slack (revoked→available), cloudflare, openai, fly(locked). github+supabase connected; aws roadmap.
    expect(s.availableCount).toBe(4);
  });

  it("categoryCount is distinct registry categories", () => {
    // REGISTRY spans source-control, messaging, infrastructure, ai-provider = 4.
    const s = hubSummary([], REGISTRY, null);
    expect(s.categoryCount).toBe(4);
  });
});

describe("filter predicates", () => {
  it("presentCategories keeps CATEGORY_ORDER and drops absent", () => {
    expect(presentCategories(REGISTRY, CATEGORY_ORDER)).toEqual([
      "source-control",
      "messaging",
      "infrastructure",
      "ai-provider",
    ]);
  });

  it("matchesStatus maps the three legs", () => {
    expect(matchesStatus("connected", "all")).toBe(true);
    expect(matchesStatus("connected", "connected")).toBe(true);
    expect(matchesStatus("connected", "available")).toBe(false);
    expect(matchesStatus("available", "available")).toBe(true);
    expect(matchesStatus("locked", "available")).toBe(true);
    expect(matchesStatus("configure", "available")).toBe(true);
    expect(matchesStatus("roadmap", "available")).toBe(false);
  });

  it("matchesSearch spans name, id, tagline, and category label; empty matches all", () => {
    const d = descriptor({ id: "github", displayName: "GitHub", tagline: "Repos and pull requests." });
    expect(matchesSearch(d, "", CATEGORY_LABELS[d.category])).toBe(true);
    expect(matchesSearch(d, "hub", CATEGORY_LABELS[d.category])).toBe(true);
    expect(matchesSearch(d, "PULL", CATEGORY_LABELS[d.category])).toBe(true);
    expect(matchesSearch(d, "infrastructure", "Infrastructure")).toBe(true);
    expect(matchesSearch(d, "vercel", CATEGORY_LABELS[d.category])).toBe(false);
  });
});

describe("connectedMetaLine + parts", () => {
  const NOW = Date.parse("2026-07-24T00:00:00Z");

  it("age label is whole days, null when never connected", () => {
    expect(connectionAgeLabel("2026-07-14T00:00:00Z", NOW)).toBe("10d");
    expect(connectionAgeLabel(null, NOW)).toBeNull();
    expect(connectionAgeLabel("not-a-date", NOW)).toBeNull();
  });

  it("repositoryClause maps GitHub grant", () => {
    expect(repositoryClause("all")).toBe("All repositories");
    expect(repositoryClause("selected")).toBe("Selected repositories");
    expect(repositoryClause(null)).toBeNull();
  });

  it("brokered count takes the detail slot and drops the age (infra rows)", () => {
    const c = connection({
      provider: "supabase",
      displayName: "acme-prod",
      scope: "workspace",
      connectedAt: "2026-01-01T00:00:00Z",
    });
    expect(connectedMetaLine(c, { brokeredCount: 3, nowMs: NOW })).toBe(
      "acme-prod · Workspace-private · 3 brokered secrets",
    );
    expect(connectedMetaLine(c, { brokeredCount: 1, nowMs: NOW })).toContain("1 brokered secret");
  });

  it("github row shows repo grant + age", () => {
    const c = connection({
      provider: "github",
      displayName: "acme-platform",
      scope: "account",
      repositorySelection: "all",
      connectedAt: "2025-11-12T00:00:00Z",
    });
    expect(connectedMetaLine(c, { nowMs: NOW })).toBe(
      "acme-platform · Account-shared · All repositories · 254d",
    );
  });

  it("messaging row shows just name · scope · age", () => {
    const c = connection({
      provider: "slack",
      displayName: "Acme HQ",
      scope: "workspace",
      connectedAt: "2026-02-03T00:00:00Z",
    });
    expect(connectedMetaLine(c, { nowMs: NOW })).toBe("Acme HQ · Workspace-private · 171d");
  });
});

describe("misc", () => {
  it("isLiveConnection", () => {
    expect(isLiveConnection({ status: "active" })).toBe(true);
    expect(isLiveConnection({ status: "pending" })).toBe(true);
    expect(isLiveConnection({ status: "revoked" })).toBe(false);
    expect(isLiveConnection({ status: "suspended" })).toBe(false);
  });

  it("roadmapListSentence Oxford-joins", () => {
    expect(roadmapListSentence([])).toBe("More integrations are");
    expect(roadmapListSentence(["GitLab"])).toBe("GitLab is");
    expect(roadmapListSentence(["GitLab", "Discord"])).toBe("GitLab and Discord are");
    expect(roadmapListSentence(["GitLab", "Discord", "AWS"])).toBe("GitLab, Discord, and AWS are");
  });
});
