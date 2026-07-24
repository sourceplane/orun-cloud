// saas-integrations-console IX2: the detail page's pure view-model — archetype
// derivation (from the served descriptor, never a per-provider map), the tab
// set, the header projection, and the GitHub capability-toggle resolution.

import type {
  IntegrationDescriptor,
  PublicConnection,
} from "@saas/contracts/integrations";
import {
  authorizedDate,
  capabilityToggles,
  deriveArchetype,
  detailSubtitle,
  detailTabs,
  effectivePrefs,
  externalManageLink,
  hasArchetypeDetail,
  notificationRoutes,
  sharingBadge,
  toggleState,
  GITHUB_CAPABILITY_TOGGLES,
  SLACK_NOTIFICATION_ROUTES,
} from "@web-console-next/components/integrations/detail-model";

function descriptor(overrides: Partial<IntegrationDescriptor>): IntegrationDescriptor {
  return {
    id: "github",
    displayName: "GitHub",
    category: "source-control",
    tagline: "",
    connect: [{ kind: "install", live: true }],
    multiConnection: false,
    capabilities: ["connect", "scm"],
    space: { tabs: ["overview"], modules: [], authoring: "declarative" },
    entitlement: "feature.integrations.github",
    version: 1,
    status: "live",
    ...overrides,
  } as IntegrationDescriptor;
}

function connection(overrides: Partial<PublicConnection>): PublicConnection {
  return {
    id: "int_1",
    orgId: "org_1",
    provider: "github",
    status: "active",
    scope: "account",
    shareMode: "auto",
    displayName: null,
    externalAccountLogin: "acme-platform",
    externalAccountId: "42",
    externalAccountType: "Organization",
    repositorySelection: "all",
    connectedAt: "2025-11-12T00:00:00Z",
    createdAt: "2025-11-12T00:00:00Z",
    ...overrides,
  } as PublicConnection;
}

describe("deriveArchetype — capabilities first, category as backstop", () => {
  it("maps each provider family", () => {
    expect(deriveArchetype(descriptor({ capabilities: ["connect", "scm"] }))).toBe("source-control");
    expect(deriveArchetype(descriptor({ category: "messaging", capabilities: ["messaging"] }))).toBe("messaging");
    expect(
      deriveArchetype(descriptor({ category: "infrastructure", capabilities: ["credential-broker", "secrets"] })),
    ).toBe("infrastructure");
    expect(deriveArchetype(descriptor({ category: "ai-provider", capabilities: ["connect"] }))).toBe("generic");
  });

  it("messaging wins over category when both present", () => {
    expect(deriveArchetype(descriptor({ category: "source-control", capabilities: ["messaging"] }))).toBe("messaging");
  });

  it("hasArchetypeDetail is true for the implemented archetypes (source-control, infrastructure, messaging)", () => {
    expect(hasArchetypeDetail(descriptor({ capabilities: ["scm"] }))).toBe(true);
    expect(
      hasArchetypeDetail(descriptor({ category: "infrastructure", capabilities: ["credential-broker"] })),
    ).toBe(true); // IX3
    expect(hasArchetypeDetail(descriptor({ category: "messaging", capabilities: ["messaging"] }))).toBe(true); // IX4
    // The generic fallback stays unimplemented.
    expect(hasArchetypeDetail(descriptor({ category: "ai-provider", capabilities: ["connect"] }))).toBe(false);
  });
});

describe("detailTabs", () => {
  it("source-control includes Workspace access only for account scope", () => {
    expect(detailTabs("source-control", { scope: "account" }).map((t) => t.id)).toEqual([
      "overview",
      "repositories",
      "workspace-access",
      "activity",
    ]);
    expect(detailTabs("source-control", { scope: "workspace" }).map((t) => t.id)).toEqual([
      "overview",
      "repositories",
      "activity",
    ]);
  });

  it("messaging + infrastructure carry their archetype tabs", () => {
    expect(detailTabs("messaging", { scope: "workspace" }).map((t) => t.id)).toEqual([
      "overview",
      "channels",
      "notifications",
      "activity",
    ]);
    expect(detailTabs("infrastructure", { scope: "workspace" }).map((t) => t.id)).toEqual([
      "overview",
      "secrets",
      "projects",
      "activity",
    ]);
  });
});

describe("header projection", () => {
  it("sharingBadge", () => {
    expect(sharingBadge("account")).toBe("ACCOUNT-SHARED");
    expect(sharingBadge("workspace")).toBe("WORKSPACE-PRIVATE");
  });

  it("authorizedDate formats or nulls", () => {
    expect(authorizedDate("2025-11-12T00:00:00Z")).toBe("Nov 12, 2025");
    expect(authorizedDate(null)).toBeNull();
    expect(authorizedDate("nope")).toBeNull();
  });

  it("detailSubtitle joins anchor, type, and authorized date; omits absent parts", () => {
    expect(detailSubtitle(connection({}))).toBe(
      "Installation acme-platform · Organization · authorized Nov 12, 2025",
    );
    expect(
      detailSubtitle(connection({ externalAccountType: null, connectedAt: null, externalAccountLogin: "acme" })),
    ).toBe("Installation acme");
  });

  it("externalManageLink is provider-specific and null for unknowns", () => {
    expect(externalManageLink({ provider: "github", externalAccountLogin: "acme" })).toEqual({
      label: "Open on GitHub",
      url: "https://github.com/acme",
    });
    expect(externalManageLink({ provider: "supabase", externalAccountLogin: null })?.label).toBe("Open dashboard");
    expect(externalManageLink({ provider: "openai", externalAccountLogin: null })).toBeNull();
  });
});

describe("capability toggles", () => {
  it("GitHub catalog is the mockup set with the right defaults", () => {
    expect(GITHUB_CAPABILITY_TOGGLES.map((t) => t.id)).toEqual([
      "pull_requests",
      "checks",
      "deployments",
      "issues",
    ]);
    expect(GITHUB_CAPABILITY_TOGGLES.find((t) => t.id === "issues")!.defaultOn).toBe(false);
    expect(capabilityToggles("slack")).toEqual([]);
  });

  it("toggleState uses the stored pref, else the default", () => {
    const t = GITHUB_CAPABILITY_TOGGLES[3]!; // issues, default off
    expect(toggleState(t, null)).toBe(false);
    expect(toggleState(t, { issues: true })).toBe(true);
    expect(toggleState(GITHUB_CAPABILITY_TOGGLES[0]!, {})).toBe(true); // pull_requests default on
  });

  it("effectivePrefs overlays defaults with stored", () => {
    expect(effectivePrefs("github", { issues: true, checks: false })).toEqual({
      pull_requests: true,
      checks: false,
      deployments: true,
      issues: true,
    });
    expect(effectivePrefs("openai", null)).toEqual({});
  });
});

describe("notification routing (IX4)", () => {
  it("Slack routes are the mockup set with channels and defaults", () => {
    expect(SLACK_NOTIFICATION_ROUTES.map((r) => r.id)).toEqual([
      "run_outcomes",
      "approval_requests",
      "incident_alerts",
      "daily_digest",
    ]);
    expect(SLACK_NOTIFICATION_ROUTES.map((r) => r.channel)).toEqual([
      "#deploys",
      "#eng-approvals",
      "#incidents",
      "#agent-digest",
    ]);
    // Run outcomes + approvals default on; incidents + digest default off.
    expect(SLACK_NOTIFICATION_ROUTES.map((r) => r.defaultOn)).toEqual([true, true, false, false]);
  });

  it("notificationRoutes only surfaces for Slack; toggleState resolves them", () => {
    expect(notificationRoutes("slack")).toBe(SLACK_NOTIFICATION_ROUTES);
    expect(notificationRoutes("github")).toEqual([]);
    const incidents = SLACK_NOTIFICATION_ROUTES[2]!; // default off
    expect(toggleState(incidents, null)).toBe(false);
    expect(toggleState(incidents, { incident_alerts: true })).toBe(true);
  });
});
