/**
 * Pure command registry for the Cmd-K palette (Task 0127 / U11).
 *
 * Kept dependency-free (no React, no `next/*`, no DOM, no icon imports) so the
 * command-set composition can be unit-tested in isolation. The React wiring
 * (icon rendering, navigation, action handlers, registration context) lives in
 * `command-palette.tsx`, which maps each descriptor's `kind` onto a concrete
 * effect.
 *
 * Extensibility: `command-palette.tsx` exposes a registration context so any
 * page/product area can contribute extra descriptors at mount time. The base
 * set is produced here by `buildBaseCommands(ctx)`; extra descriptors are
 * merged and ordered by `composeCommands(base, extra)`. New product areas add
 * commands without editing this file.
 */

/** Stable group ordering for the palette. IC7 adds the data-backed groups
 *  (catalog entities, docs, teams, secrets — sourced from the shared query
 *  cache by `palette-entity-source.tsx`) between Navigation and Create. */
export const COMMAND_GROUPS = ["Navigation", "Catalog", "Docs", "Teams", "Secrets", "Create", "Target", "Session"] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/**
 * A command descriptor is pure data. `kind` tells the renderer what to do:
 *   - `navigate` → router.push(`to`)
 *   - `action`   → invoke the handler registered under `actionId`
 *   - `target`   → switch the API target named `targetName`
 */
export type CommandDescriptor =
  | {
      id: string;
      label: string;
      group: CommandGroup;
      kind: "navigate";
      to: string;
      /** lucide icon name (resolved in the renderer); optional. */
      icon?: string;
      /** extra fuzzy-search terms beyond the label. */
      keywords?: string[];
      shortcut?: string;
    }
  | {
      id: string;
      label: string;
      group: CommandGroup;
      kind: "action";
      actionId: "logout";
      icon?: string;
      keywords?: string[];
      shortcut?: string;
    }
  | {
      id: string;
      label: string;
      group: CommandGroup;
      kind: "target";
      targetName: string;
      icon?: string;
      keywords?: string[];
      shortcut?: string;
    };

export interface CommandContext {
  orgSlug: string | null;
  projectSlug: string | null;
  /** when true, the target switcher is hidden (single locked deploy env). */
  isLocked: boolean;
  /** available API targets for the Target group (empty when locked). */
  targets: { name: string }[];
}

/**
 * Build the always-available base command set for the current URL scope.
 *
 * Scope-aware: org-scoped commands only appear when an org slug is present;
 * project-scoped commands only when both org and project slugs are present.
 * This mirrors the sidebar/scope-switcher invariant that scope comes from the
 * URL, never from local state.
 */
export function buildBaseCommands(ctx: CommandContext): CommandDescriptor[] {
  const out: CommandDescriptor[] = [];
  const orgBase = ctx.orgSlug ? `/orgs/${ctx.orgSlug}` : null;
  const projectBase =
    ctx.orgSlug && ctx.projectSlug ? `/orgs/${ctx.orgSlug}/projects/${ctx.projectSlug}` : null;

  // --- Navigation -----------------------------------------------------------
  out.push({
    id: "nav.orgs",
    label: "Switch workspace",
    group: "Navigation",
    kind: "navigate",
    to: "/orgs",
    icon: "Building2",
    keywords: ["workspace", "org", "organization", "switch", "tenant"],
    shortcut: "O",
  });
  out.push({
    id: "nav.account",
    label: "Account profile",
    group: "Navigation",
    kind: "navigate",
    to: "/you",
    icon: "User2",
    keywords: ["profile", "account", "you", "me", "name", "display name", "sign out", "logout"],
  });
  out.push({
    id: "nav.account.security",
    label: "Security activity",
    group: "Navigation",
    kind: "navigate",
    to: "/you/security",
    icon: "ShieldCheck",
    keywords: ["security", "sessions", "activity", "login", "account"],
  });

  if (orgBase) {
    const settingsBase = `${orgBase}/settings`;
    out.push(
      navItem("nav.activities", "Activities", `${orgBase}/activities`, "Activity", [
        "activity",
        "runs",
        "executions",
        "history",
        "feed",
      ]),
      // Agents / Implementers (saas-agent-supervision SV4). Synonyms carry the
      // old muscle memory (dispatch, fleet, sessions) to the renamed surfaces.
      navItem("nav.agents", "Agents", orgBase, "Send", ["dispatch", "agent", "supervisor", "chat", "thread"]),
      navItem("nav.implementers", "Implementers", `${orgBase}/agents`, "Bot", [
        "implementer",
        "fleet",
        "sessions",
        "agents",
        "runs",
      ]),
      navItem("nav.teams", "Teams", `${orgBase}/teams`, "UsersRound", ["team", "people", "group", "ownership", "members"]),
      navItem("nav.projects", "Git Repos", `${orgBase}/projects`, "FolderKanban", ["repo", "project", "git"]),
      // The work lens (orun-work-v3 PM4): jump + layout verbs. Layouts ride
      // query params the Work page consumes — scope stays in the URL.
      navItem("nav.work", "Work", `${orgBase}/work`, "ListTodo", [
        "work",
        "task",
        "spec",
        "epic",
        "initiative",
        "backlog",
        "board",
        "kanban",
      ]),
      // orun-work-v5 WV5: the home's three lenses as verbs (design.md §4).
      // No verb here can write a rung — the category is unrepresentable.
      navItem("nav.work-initiatives", "Work: Initiatives lens", `${orgBase}/work?lens=initiatives`, "ListTodo", [
        "initiatives",
        "portfolio",
        "health",
        "work",
      ]),
      navItem("nav.work-epics", "Work: Epics lens", `${orgBase}/work?lens=epics`, "ListTodo", [
        "epics",
        "approval",
        "drift",
        "work",
      ]),
      navItem("nav.work-tasks", "Work: Tasks lens", `${orgBase}/work?lens=tasks`, "ListTodo", [
        "tasks",
        "cycle",
        "work",
      ]),
      navItem("nav.work-board", "Work: board layout", `${orgBase}/work?layout=board`, "ListTodo", [
        "board",
        "kanban",
        "columns",
        "work",
      ]),
      navItem("nav.work-list", "Work: list layout", `${orgBase}/work?layout=list`, "ListTodo", [
        "list",
        "work",
        "specs",
      ]),
      navItem("nav.work-triage", "Work: triage", `${orgBase}/work/triage`, "ListTodo", [
        "triage",
        "drift",
        "review",
        "mentions",
        "contract",
        "proposals",
        "inbox",
      ]),
      navItem("nav.integrations", "Integrations", `${orgBase}/integrations`, "Plug", [
        "integration",
        "connection",
        "github",
        "supabase",
        "cloudflare",
        "slack",
        "provider",
      ]),
      navItem("nav.usage", "Usage & quota", `${orgBase}/usage`, "Gauge", [
        "usage",
        "quota",
        "metering",
        "limit",
        "consumption",
      ]),
      navItem("nav.org-settings", "Workspace settings", settingsBase, "SlidersHorizontal", [
        "settings",
        "workspace",
        "org",
        "general",
        "danger",
      ]),
      navItem("nav.members", "Members", `${settingsBase}/members`, "Users", [
        "member",
        "people",
        "team",
        "settings",
      ]),
      navItem("nav.invitations", "Invitations", `${settingsBase}/invitations`, "Mail", [
        "invite",
        "settings",
      ]),
      navItem("nav.billing", "Billing", `${settingsBase}/billing`, "Receipt", [
        "billing",
        "plan",
        "invoice",
        "settings",
      ]),
      navItem("nav.api-keys", "API keys", `${settingsBase}/api-keys`, "KeyRound", [
        "key",
        "token",
        "api",
        "settings",
      ]),
      navItem("nav.mcp", "MCP server", `${settingsBase}/mcp`, "Bot", [
        "mcp",
        "agent",
        "connect",
        "claude",
        "cursor",
        "settings",
      ]),
      navItem("nav.webhooks", "Webhooks", `${settingsBase}/webhooks`, "Webhook", [
        "webhook",
        "endpoint",
        "settings",
      ]),
      // Secrets & Config is a top-level product surface (not under settings):
      // the secret chain, feature flags, settings values, and policies.
      navItem("nav.secrets", "Secrets & Config", `${orgBase}/secrets`, "KeyRound", [
        "secret",
        "secrets",
        "vault",
        "config",
        "settings",
        "flags",
        "feature flag",
        "rotation",
        "policy",
      ]),
      navItem("nav.audit", "Audit log", `${settingsBase}/audit`, "ScrollText", [
        "audit",
        "history",
        "events",
        "settings",
      ]),
      // Event-bus surfaces (saas-event-streaming ES6).
      navItem("nav.events", "Events", `${orgBase}/events`, "Activity", [
        "events",
        "event",
        "stream",
        "bus",
        "explorer",
        "correlation",
        "groups",
      ]),
      navItem("nav.notification-rules", "Notification rules", `${settingsBase}/notifications/rules`, "Bell", [
        "notification",
        "rule",
        "route",
        "alert",
        "slack",
        "email",
        "settings",
      ]),
      navItem("nav.notification-channels", "Delivery channels", `${settingsBase}/notifications/channels`, "Bell", [
        "channel",
        "slack",
        "webhook",
        "delivery",
        "notification",
        "settings",
      ]),
      navItem("nav.dead-letters", "Dead letters", `${settingsBase}/notifications/dead-letters`, "ScrollText", [
        "dead letter",
        "dlq",
        "replay",
        "failed",
        "delivery",
        "ops",
        "settings",
      ]),
    );
  }
  if (projectBase) {
    out.push(
      navItem("nav.environments", "Environments", `${projectBase}/environments`, "Boxes", ["env", "environment"]),
      navItem("nav.storage", "Storage", `${projectBase}/storage`, "HardDrive", ["gc", "garbage", "reclaim", "objects"]),
    );
  }

  // --- Create ---------------------------------------------------------------
  out.push({
    id: "create.org",
    label: "Create workspace",
    group: "Create",
    kind: "navigate",
    to: "/orgs?new=1",
    icon: "PlusCircle",
    keywords: ["new", "create", "workspace", "org"],
  });
  if (orgBase) {
    out.push(
      navItem("create.project", "Create repo", `${orgBase}/projects?new=1`, "PlusCircle", ["new", "repo", "project"], "Create"),
      navItem("create.invitation", "Create invitation", `${orgBase}/settings/people?tab=pending`, "UserPlus", ["invite", "new"], "Create"),
      navItem("create.api-key", "Create API key", `${orgBase}/settings/api-keys?new=1`, "KeyRound", ["key", "new"], "Create"),
      // orun-work-v3 PM4: authoring verbs — the ?new= param opens the
      // matching dialog on the Work page. Intent only; no verb can write a
      // rung (the category is unrepresentable — WP-3).
      navItem("create.work-task", "New work task", `${orgBase}/work?new=task`, "PlusCircle", ["task", "work", "new"], "Create"),
      navItem("create.work-spec", "New work spec", `${orgBase}/work?new=spec`, "PlusCircle", ["spec", "work", "epic", "new"], "Create"),
      navItem("create.work-initiative", "New work initiative", `${orgBase}/work?new=initiative`, "PlusCircle", ["initiative", "work", "new"], "Create"),
      // Integration-hub verbs (saas-integration-hub IH8, design §6). The
      // `?connect=` param triggers the hub's connect dispatch on arrival —
      // the same `?new=1` convention the other Create verbs use.
      navItem("create.connect-slack", "Connect Slack", `${orgBase}/integrations?connect=slack`, "MessageSquare", ["connect", "slack", "integration", "notification", "messaging"], "Create"),
      navItem("create.connect-cloudflare", "Connect Cloudflare", `${orgBase}/integrations?connect=cloudflare`, "Cloud", ["connect", "cloudflare", "integration", "token", "workers", "infrastructure"], "Create"),
      navItem("create.connect-supabase", "Connect Supabase", `${orgBase}/integrations?connect=supabase`, "Database", ["connect", "supabase", "integration", "postgres", "database", "infrastructure"], "Create"),
      // `?bind=1` opens the scoped-credential (bind-to-integration) path on the
      // secrets surface — the single create home, reachable from here and from
      // each connection's detail page.
      navItem("create.scoped-credential", "Create scoped credential", `${orgBase}/secrets?bind=1`, "KeyRound", ["scoped", "credential", "bind", "broker", "brokered", "secret", "integration", "token"], "Create"),
    );
  }
  if (projectBase) {
    out.push(
      navItem("create.environment", "Create environment", `${projectBase}/environments?new=1`, "PlusCircle", ["env", "new"], "Create"),
    );
  }

  // --- Target ---------------------------------------------------------------
  if (!ctx.isLocked) {
    for (const t of ctx.targets) {
      out.push({
        id: `target.${t.name}`,
        label: `Switch target: ${t.name}`,
        group: "Target",
        kind: "target",
        targetName: t.name,
        icon: "Globe",
        keywords: ["target", "env", "stage", "prod", t.name],
      });
    }
  }

  // --- Session --------------------------------------------------------------
  out.push({
    id: "session.logout",
    label: "Logout",
    group: "Session",
    kind: "action",
    actionId: "logout",
    icon: "LogOut",
    keywords: ["sign out", "log out", "logout"],
  });

  return out;
}

function navItem(
  id: string,
  label: string,
  to: string,
  icon: string,
  keywords: string[],
  group: CommandGroup = "Navigation",
): CommandDescriptor {
  return { id, label, group, kind: "navigate", to, icon, keywords };
}

/**
 * Merge base + page-contributed descriptors. Later registrations override an
 * earlier descriptor with the same `id` (so a page can refine a base command),
 * and the result is grouped in stable `COMMAND_GROUPS` order while preserving
 * insertion order within a group.
 */
export function composeCommands(
  base: CommandDescriptor[],
  extra: CommandDescriptor[],
): CommandDescriptor[] {
  const byId = new Map<string, CommandDescriptor>();
  for (const c of base) byId.set(c.id, c);
  for (const c of extra) byId.set(c.id, c);
  const merged = [...byId.values()];

  return merged.sort((a, b) => {
    const ga = COMMAND_GROUPS.indexOf(a.group);
    const gb = COMMAND_GROUPS.indexOf(b.group);
    if (ga !== gb) return ga - gb;
    // stable within group: fall back to insertion order
    return merged.indexOf(a) - merged.indexOf(b);
  });
}

/** Group composed commands for rendering, dropping empty groups. */
export function groupCommands(
  commands: CommandDescriptor[],
): { group: CommandGroup; items: CommandDescriptor[] }[] {
  return COMMAND_GROUPS.map((group) => ({
    group,
    items: commands.filter((c) => c.group === group),
  })).filter((g) => g.items.length > 0);
}
