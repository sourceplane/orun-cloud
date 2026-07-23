// saas-integration-registry IR6: provider space modules.
//
// Asserts (1) the module registry follows the SP1 graft pattern — built-in
// modules registered at load, custom grafts honored, unknown refs fail OPEN
// to nothing (a manifest may declare a module this console doesn't ship yet),
// and (2) the pure data mappers the modules render from. Pure-logic tests:
// components are compared by identity, never rendered (no jsdom here).

import {
  agentProviderFor,
  custodyHealth,
  firstActiveConnection,
  hasSpaceModule,
  recentSessions,
  registerSpaceModule,
  repoCountLabel,
  repoSelectionLabel,
  resolveSpaceModules,
  slackAppChannels,
  spaceModuleFor,
  supabaseProjectRefs,
  type SpaceModuleComponent,
} from "@web-console-next/components/integrations/space-modules";
import type {
  PublicConnection,
  PublicConnectionCustody,
} from "@saas/contracts/integrations";
import type { PublicNotificationChannel } from "@saas/contracts/notifications";
import type { AgentSession } from "@saas/contracts/agents";

// The refs the six live manifests declare today (design §5.3).
const BUILT_IN_MODULES = [
  "repositories",
  "channels",
  "accounts",
  "projects",
  "models",
  "sandboxes",
] as const;

describe("space-module registry (IR6, the SP1 graft pattern)", () => {
  it("registers a built-in component for every manifest-declared ref", () => {
    for (const ref of BUILT_IN_MODULES) {
      expect(hasSpaceModule(ref)).toBe(true);
      expect(spaceModuleFor(ref)).not.toBeNull();
    }
  });

  it("fails open: unknown refs resolve to nothing, declared order preserved", () => {
    expect(spaceModuleFor("not-a-module")).toBeNull();
    expect(hasSpaceModule("not-a-module")).toBe(false);

    const resolved = resolveSpaceModules(["sandboxes", "not-a-module", "repositories"]);
    expect(resolved.map((m) => m.id)).toEqual(["sandboxes", "repositories"]);

    // A registry-read outage (no descriptor) resolves to an empty list, not a throw.
    expect(resolveSpaceModules(undefined)).toEqual([]);
    expect(resolveSpaceModules(null)).toEqual([]);
    expect(resolveSpaceModules([])).toEqual([]);
  });

  it("honors a registered custom module and falls back after unregister", () => {
    const Custom: SpaceModuleComponent = () => null;
    const unregister = registerSpaceModule("usage-teaser", Custom);
    try {
      expect(spaceModuleFor("usage-teaser")).toBe(Custom);
      expect(resolveSpaceModules(["usage-teaser"]).map((m) => m.Component)).toEqual([Custom]);
    } finally {
      unregister();
    }
    expect(spaceModuleFor("usage-teaser")).toBeNull();
  });

  it("last registration wins; a stale unregister is a no-op", () => {
    const First: SpaceModuleComponent = () => null;
    const Second: SpaceModuleComponent = () => null;
    const unregisterFirst = registerSpaceModule("usage-teaser", First);
    const unregisterSecond = registerSpaceModule("usage-teaser", Second);
    try {
      expect(spaceModuleFor("usage-teaser")).toBe(Second);
      unregisterFirst();
      expect(spaceModuleFor("usage-teaser")).toBe(Second);
    } finally {
      unregisterSecond();
    }
    expect(hasSpaceModule("usage-teaser")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function connection(overrides?: Partial<PublicConnection>): PublicConnection {
  return {
    id: "int_1",
    orgId: "org_1",
    provider: "github",
    status: "active",
    scope: "account",
    shareMode: "auto",
    displayName: null,
    externalAccountLogin: "acme",
    externalAccountType: "Organization",
    repositorySelection: null,
    createdBy: "usr_1",
    connectedAt: "2026-06-11T10:00:00.000Z",
    revokedAt: null,
    suspendedAt: null,
    createdAt: "2026-06-11T09:59:00.000Z",
    updatedAt: "2026-06-11T10:00:00.000Z",
    ...overrides,
  };
}

function custody(overrides?: Partial<PublicConnectionCustody>): PublicConnectionCustody {
  return {
    kind: "cloudflare_service_token",
    credentialClass: "infrastructure",
    userDerived: false,
    rotatedAt: null,
    createdAt: "2026-06-11T10:00:00.000Z",
    scopes: null,
    ...overrides,
  };
}

function channel(overrides?: Partial<PublicNotificationChannel>): PublicNotificationChannel {
  return {
    id: "nch_1",
    orgId: "org_1",
    kind: "slack_app",
    name: "#deploys",
    status: "active",
    lastVerifiedAt: null,
    createdAt: "2026-06-11T10:00:00.000Z",
    updatedAt: "2026-06-11T10:00:00.000Z",
    ...overrides,
  };
}

function session(overrides?: Partial<AgentSession>): AgentSession {
  return {
    id: "as_1",
    profileId: "ap_1",
    runKind: "implementation",
    state: "running",
    spawnedBy: "usr_1",
    createdAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  } as AgentSession;
}

// ---------------------------------------------------------------------------
// Pure mappers
// ---------------------------------------------------------------------------

describe("module data mappers", () => {
  it("firstActiveConnection picks the first active row, else null", () => {
    const pending = connection({ id: "int_p", status: "pending" });
    const a = connection({ id: "int_a" });
    const b = connection({ id: "int_b" });
    expect(firstActiveConnection([pending, a, b])).toBe(a);
    expect(firstActiveConnection([pending])).toBeNull();
    expect(firstActiveConnection([])).toBeNull();
  });

  it("repoSelectionLabel maps GitHub's grant semantics honestly", () => {
    expect(repoSelectionLabel("all")).toBe("All repositories in the account");
    expect(repoSelectionLabel("selected")).toBe("An allowlist of selected repositories");
    expect(repoSelectionLabel(null)).toBe("Repository selection unknown");
  });

  it("repoCountLabel pluralizes and marks provider truncation", () => {
    expect(repoCountLabel(1, false)).toBe("1 repository");
    expect(repoCountLabel(3, false)).toBe("3 repositories");
    expect(repoCountLabel(50, true)).toBe("50+ repositories");
    // A truncated single page still means "more than one".
    expect(repoCountLabel(1, true)).toBe("1+ repositories");
  });

  it("slackAppChannels keeps only the workspace-bot kind", () => {
    const app = channel();
    const webhook = channel({ id: "nch_2", kind: "slack_incoming_webhook" });
    expect(slackAppChannels([webhook, app])).toEqual([app]);
    expect(slackAppChannels([])).toEqual([]);
  });

  it("supabaseProjectRefs reads only the project-secret row's string scopes", () => {
    const rows: PublicConnectionCustody[] = [
      custody({ kind: "supabase_refresh_token" }),
      custody({
        kind: "supabase_project_secret",
        scopes: ["abcd1234", 42 as unknown as string, "efgh5678"],
      }),
      // Non-array scopes (an object projection) contribute nothing.
      custody({ kind: "supabase_project_secret", scopes: { note: "n/a" } }),
    ];
    expect(supabaseProjectRefs(rows)).toEqual(["abcd1234", "efgh5678"]);
    expect(supabaseProjectRefs(undefined)).toEqual([]);
    expect(supabaseProjectRefs([custody()])).toEqual([]);
  });

  it("custodyHealth: no rows = neutral, any user-derived = warning, else success", () => {
    expect(custodyHealth(undefined)).toEqual({ label: "no custody on record", tone: "neutral" });
    expect(custodyHealth([])).toEqual({ label: "no custody on record", tone: "neutral" });
    expect(custodyHealth([custody()])).toEqual({ label: "org-owned custody", tone: "success" });
    expect(
      custodyHealth([
        custody(),
        custody({ kind: "cloudflare_refresh_token", credentialClass: "identity", userDerived: true }),
      ]),
    ).toEqual({ label: "user-derived custody", tone: "warning" });
  });

  it("recentSessions sorts newest-first, caps, and never mutates the input", () => {
    const older = session({ id: "as_old", createdAt: "2026-07-01T09:00:00.000Z" });
    const newest = session({ id: "as_new", createdAt: "2026-07-02T09:00:00.000Z" });
    const middle = session({ id: "as_mid", createdAt: "2026-07-01T12:00:00.000Z" });
    const input = [older, newest, middle];
    expect(recentSessions(input, 2).map((s) => s.id)).toEqual(["as_new", "as_mid"]);
    expect(input.map((s) => s.id)).toEqual(["as_old", "as_new", "as_mid"]);
    expect(recentSessions(input, 0)).toEqual([]);
    expect(recentSessions([], 5)).toEqual([]);
  });

  it("agentProviderFor maps only the agents-plane providers", () => {
    expect(agentProviderFor("anthropic")).toBe("anthropic");
    expect(agentProviderFor("openai")).toBe("openai");
    expect(agentProviderFor("openrouter")).toBe("openrouter");
    expect(agentProviderFor("daytona")).toBe("daytona");
    expect(agentProviderFor("github")).toBeNull();
    expect(agentProviderFor("")).toBeNull();
  });
});
