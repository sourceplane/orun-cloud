/**
 * Pure view-model for the per-integration detail page (saas-integrations-console
 * IX2). The detail page is a projection of the served descriptor + the
 * connection: its archetype (and therefore its tab set + body) is DERIVED from
 * the descriptor's category + declared capabilities — never a console-side
 * per-provider map (the doomed `archetype.ts`). Dependency-free so every
 * derivation is unit-testable.
 */

import type {
  IntegrationDescriptor,
  PublicConnection,
  PublicConnectionCustody,
} from "@saas/contracts/integrations";

/** The detail archetypes; "generic" is the honest fallback for anything else. */
export type DetailArchetype = "source-control" | "messaging" | "infrastructure" | "generic";

/**
 * Derive the archetype from the descriptor (capabilities first, category as the
 * backstop). A provider with `messaging` is messaging; a credential broker /
 * secrets producer is infrastructure; an `scm` provider is source-control.
 */
export function deriveArchetype(
  descriptor: Pick<IntegrationDescriptor, "category" | "capabilities">,
): DetailArchetype {
  const caps = descriptor.capabilities ?? [];
  if (caps.includes("messaging") || descriptor.category === "messaging") return "messaging";
  if (
    caps.includes("credential-broker") ||
    caps.includes("secrets") ||
    descriptor.category === "infrastructure"
  ) {
    return "infrastructure";
  }
  if (caps.includes("scm") || descriptor.category === "source-control") return "source-control";
  return "generic";
}

/** Archetypes whose detail body the console has implemented (grows per milestone). */
export const IMPLEMENTED_ARCHETYPES: ReadonlySet<DetailArchetype> = new Set<DetailArchetype>([
  "source-control", // IX2
  "infrastructure", // IX3
  "messaging", // IX4
]);

/** Whether the new tabbed detail page should render for this descriptor. */
export function hasArchetypeDetail(
  descriptor: Pick<IntegrationDescriptor, "category" | "capabilities">,
): boolean {
  return IMPLEMENTED_ARCHETYPES.has(deriveArchetype(descriptor));
}

export interface DetailTab {
  id: string;
  label: string;
}

/**
 * The tab set for an archetype. "Workspace access" (admission) is only
 * meaningful for account-shared connections, so it is included conditionally.
 */
export function detailTabs(
  archetype: DetailArchetype,
  connection: Pick<PublicConnection, "scope">,
): DetailTab[] {
  const overview: DetailTab = { id: "overview", label: "Overview" };
  const activity: DetailTab = { id: "activity", label: "Activity" };
  const workspaceAccess: DetailTab[] =
    connection.scope === "account" ? [{ id: "workspace-access", label: "Workspace access" }] : [];
  switch (archetype) {
    case "source-control":
      return [overview, { id: "repositories", label: "Repositories" }, ...workspaceAccess, activity];
    case "messaging":
      return [
        overview,
        { id: "channels", label: "Channels" },
        { id: "notifications", label: "Notifications" },
        ...workspaceAccess,
        activity,
      ];
    case "infrastructure":
      return [
        overview,
        { id: "secrets", label: "Secrets" },
        { id: "projects", label: "Projects" },
        ...workspaceAccess,
        activity,
      ];
    default:
      return [overview, ...workspaceAccess, activity];
  }
}

/** UPPERCASE sharing badge for the header (ACCOUNT-SHARED / WORKSPACE-PRIVATE). */
export function sharingBadge(scope: PublicConnection["scope"]): string {
  return scope === "account" ? "ACCOUNT-SHARED" : "WORKSPACE-PRIVATE";
}

/** What the external account anchor IS, per provider ("Installation …"). */
export function externalAnchorLabel(provider: string): string {
  switch (provider) {
    case "slack":
      return "Workspace";
    case "cloudflare":
      return "Account";
    case "supabase":
      return "Organization";
    default:
      return "Installation";
  }
}

/** Full date "Nov 12, 2025"; null when never connected. */
export function authorizedDate(connectedAt: string | null | undefined): string | null {
  if (!connectedAt) return null;
  const t = new Date(connectedAt);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Header subtitle, e.g. "Installation acme-platform · Organization · authorized
 * Nov 12, 2025". Omits absent parts rather than fabricating them.
 */
export function detailSubtitle(connection: PublicConnection): string {
  const parts: string[] = [];
  const anchor = externalAnchorLabel(connection.provider);
  const login = connection.externalAccountLogin ?? connection.displayName;
  parts.push(login ? `${anchor} ${login}` : anchor);
  if (connection.externalAccountType) parts.push(connection.externalAccountType);
  const date = authorizedDate(connection.connectedAt);
  if (date) parts.push(`authorized ${date}`);
  return parts.join(" · ");
}

/** The "Open on {Provider}" external management link, or null when none applies. */
export function externalManageLink(
  connection: Pick<PublicConnection, "provider" | "externalAccountLogin">,
): { label: string; url: string } | null {
  const login = connection.externalAccountLogin;
  switch (connection.provider) {
    case "github":
      return { label: "Open on GitHub", url: login ? `https://github.com/${login}` : "https://github.com" };
    case "supabase":
      return { label: "Open dashboard", url: "https://supabase.com/dashboard" };
    case "cloudflare":
      return { label: "Open dashboard", url: "https://dash.cloudflare.com" };
    default:
      return null;
  }
}

// ── Capability toggles (new noun #1) ──────────────────────────────────────

export interface CapabilityToggle {
  id: string;
  label: string;
  description: string;
  /** Default posture when the connection has no stored preference. */
  defaultOn: boolean;
}

/**
 * GitHub's console-surfaced capability toggles. These are finer-grained than the
 * manifest `capabilities` enum — they are the operator-facing switches for what
 * Orun does with the installation (persisted as `connection.capabilityPrefs`).
 */
export const GITHUB_CAPABILITY_TOGGLES: readonly CapabilityToggle[] = [
  {
    id: "pull_requests",
    label: "Pull requests",
    description: "Open, review, and merge PRs as part of a plan run.",
    defaultOn: true,
  },
  {
    id: "checks",
    label: "Checks & status",
    description: "Report plan progress back as commit checks.",
    defaultOn: true,
  },
  {
    id: "deployments",
    label: "Deployments",
    description: "Create GitHub deployments and environments.",
    defaultOn: true,
  },
  {
    id: "issues",
    label: "Issues",
    description: "Read and comment on issues from a plan.",
    defaultOn: false,
  },
];

/** The toggle catalog for a provider ([] when the archetype has none). */
export function capabilityToggles(provider: string): readonly CapabilityToggle[] {
  return provider === "github" ? GITHUB_CAPABILITY_TOGGLES : [];
}

// ── Infrastructure archetype helpers (IX3) ────────────────────────────────

/** A project/resource ref surfaced by a connection's custody (metadata only). */
export interface CustodyProjectRef {
  ref: string;
  /** Custody kind the ref came from, e.g. "supabase_project_secret". */
  kind: string;
}

/**
 * Extract the string scope refs from a connection's custody rows — the linked
 * projects/resources the Projects tab lists. Metadata only; never keys. Absent
 * or non-string scopes are skipped (no fabrication).
 */
export function custodyProjectRefs(
  custody: readonly PublicConnectionCustody[] | null | undefined,
): CustodyProjectRef[] {
  const out: CustodyProjectRef[] = [];
  for (const row of custody ?? []) {
    if (!Array.isArray(row.scopes)) continue;
    for (const s of row.scopes) {
      if (typeof s === "string" && s.length > 0) out.push({ ref: s, kind: row.kind });
    }
  }
  return out;
}

/** Resolve a toggle's effective state: stored pref, else the toggle default. */
export function toggleState(
  toggle: CapabilityToggle,
  prefs: Record<string, boolean> | null | undefined,
): boolean {
  return prefs?.[toggle.id] ?? toggle.defaultOn;
}

/** The full effective prefs map for a provider (defaults overlaid by stored). */
export function effectivePrefs(
  provider: string,
  prefs: Record<string, boolean> | null | undefined,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const t of capabilityToggles(provider)) out[t.id] = toggleState(t, prefs);
  return out;
}

// ── Notification routing (new noun #2, IX4) ───────────────────────────────
// The messaging archetype's Notifications tab routes event groups to channels
// with per-route on/off. Persisted in the SAME `capability_prefs` blob as the
// capability toggles (a generic per-connection preference map) — so IX4 needs no
// new backend. Each route also carries the channel it targets, shown as context.

export interface NotificationRoute extends CapabilityToggle {
  /** The channel this route posts to, e.g. "#deploys" (display context). */
  channel: string;
}

/** Slack's console-surfaced notification routes (the mockup's Notifications tab). */
export const SLACK_NOTIFICATION_ROUTES: readonly NotificationRoute[] = [
  {
    id: "run_outcomes",
    label: "Run outcomes",
    description: "Post when a plan run succeeds or fails.",
    channel: "#deploys",
    defaultOn: true,
  },
  {
    id: "approval_requests",
    label: "Approval requests",
    description: "Ask for human approval before a gated step.",
    channel: "#eng-approvals",
    defaultOn: true,
  },
  {
    id: "incident_alerts",
    label: "Incident alerts",
    description: "Page the channel when a run errors repeatedly.",
    channel: "#incidents",
    defaultOn: false,
  },
  {
    id: "daily_digest",
    label: "Daily digest",
    description: "A once-a-day summary of agent activity.",
    channel: "#agent-digest",
    defaultOn: false,
  },
];

/** The notification-route catalog for a provider ([] when the archetype has none). */
export function notificationRoutes(provider: string): readonly NotificationRoute[] {
  return provider === "slack" ? SLACK_NOTIFICATION_ROUTES : [];
}
