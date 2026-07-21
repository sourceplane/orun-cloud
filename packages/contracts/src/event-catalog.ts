/**
 * The typed event catalog (saas-event-streaming ES0).
 *
 * Routing, deduplication, severity facets, and human-readable rendering all
 * need one vocabulary. This registry is that vocabulary: every event type the
 * platform appends to `events.event_log` MUST be registered here. A CI guard
 * in `tests/contracts` enforces totality — an emitter shipping an
 * unregistered type is a build failure, not a silent escape from routing.
 *
 * Rules of the catalog (design §3 of the epic):
 * - **Additive-only.** Types and fields are never renamed or removed; payload
 *   projections evolve by version bump with old fields retained.
 * - **The catalog is code, not rows.** It ships with the platform version;
 *   tenants never edit it. Tenant-authored `custom.*` events (ES5) get the
 *   single catch-all entry below.
 * - **Dedup keys are authored, never inferred.** A type with no `dedupKey`
 *   never groups (false merges are worse than duplicates). Key templates may
 *   reference only envelope/payload fields and always embed the org scope.
 * - `title` is a render template over the envelope: `{subject.name}`,
 *   `{payload.x}` placeholders — resolved by consumers (channels, console),
 *   never at emit time.
 * - `audit: true` mirrors emit reality: the emitter writes the audit
 *   projection via `appendEventWithAudit`; `audit: false` types are
 *   event_log-only (`appendEvent`).
 *
 * Scope note: this catalog covers the canonical event bus only. Identity's
 * `security_events` store and the coordination Durable-Object log are
 * separate planes with their own vocabularies; their types are NOT registered
 * here unless they are also projected onto `event_log` (the terminal
 * `state.run.*` projections are).
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const EVENT_CATEGORIES = [
  "activity",
  "security",
  "billing",
  "delivery",
  "system",
  "custom",
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/** Severity ladder, ordered from least to most severe. */
export const EVENT_SEVERITIES = ["info", "notice", "warning", "error", "critical"] as const;

export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

/** Numeric rank for severity comparisons (rule `minSeverity` floors). */
export function severityRank(severity: EventSeverity): number {
  return EVENT_SEVERITIES.indexOf(severity);
}

/**
 * The envelope `type` pattern from
 * specs/core/contracts/event-envelope.schema.yaml — at least two dot-joined
 * lowercase segments.
 */
export const EVENT_TYPE_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/** Namespace reserved for tenant-authored events via the public ingest (ES5). */
export const CUSTOM_EVENT_NAMESPACE = "custom.";

export interface CatalogEntry {
  /** The envelope type string; must equal its key in EVENT_CATALOG. */
  type: string;
  /** Payload projection version, additive-only. */
  version: number;
  category: EventCategory;
  /** Default severity; a payload may escalate but never de-escalate. */
  severity: EventSeverity;
  /** Human title render template ("{subject.name}", "{payload.x}"). */
  title: string;
  /**
   * Aggregation-key template (ES4). Absent = this type never groups.
   * Templates may reference only envelope/payload fields and must embed the
   * org scope (`{tenant.orgId}`).
   */
  dedupKey?: string;
  /** Allow-list of sibling types that may share a story via causation joins. */
  correlates?: string[];
  /** Whether the emitter writes the audit projection alongside the log row. */
  audit: boolean;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

function entry(e: CatalogEntry): [string, CatalogEntry] {
  return [e.type, e];
}

export const EVENT_CATALOG: Readonly<Record<string, CatalogEntry>> = Object.fromEntries([
  // --- organization / membership (membership-worker) -----------------------
  entry({ type: "organization.created", version: 1, category: "activity", severity: "notice", title: "Organization {subject.name} created", audit: true }),
  entry({ type: "membership.added", version: 1, category: "activity", severity: "info", title: "Member added to {subject.name}", audit: true }),
  entry({ type: "membership.removed", version: 1, category: "activity", severity: "notice", title: "Member removed from {subject.name}", audit: true }),
  entry({ type: "membership.updated", version: 1, category: "activity", severity: "info", title: "Member role updated in {subject.name}", audit: true }),
  entry({ type: "invite.created", version: 1, category: "activity", severity: "info", title: "Invitation created for {payload.email}", audit: true }),
  entry({ type: "invite.accepted", version: 1, category: "activity", severity: "info", title: "Invitation accepted", audit: true }),
  entry({ type: "invite.revoked", version: 1, category: "activity", severity: "info", title: "Invitation revoked", audit: true }),

  // --- teams (membership-worker) --------------------------------------------
  entry({ type: "team.created", version: 1, category: "activity", severity: "info", title: "Team {subject.name} created", audit: true }),
  entry({ type: "team.updated", version: 1, category: "activity", severity: "info", title: "Team {subject.name} updated", audit: true }),
  entry({ type: "team.deleted", version: 1, category: "activity", severity: "notice", title: "Team {subject.name} deleted", audit: true }),
  entry({ type: "team.member.added", version: 1, category: "activity", severity: "info", title: "Member added to team {subject.name}", audit: true }),
  entry({ type: "team.member.removed", version: 1, category: "activity", severity: "info", title: "Member removed from team {subject.name}", audit: true }),
  entry({ type: "team.member.role_changed", version: 1, category: "activity", severity: "info", title: "Team member role changed in {subject.name}", audit: true }),
  entry({ type: "team.owner_handle.set", version: 1, category: "activity", severity: "info", title: "Owner handle mapped to team {subject.name}", audit: true }),
  entry({ type: "team.owner_handle.removed", version: 1, category: "activity", severity: "info", title: "Owner handle unmapped from team {subject.name}", audit: true }),
  entry({ type: "team.role.granted", version: 1, category: "security", severity: "notice", title: "Role granted to team {subject.name}", audit: true }),
  entry({ type: "team.role.revoked", version: 1, category: "security", severity: "notice", title: "Role revoked from team {subject.name}", audit: true }),
  entry({ type: "account.role.granted", version: 1, category: "security", severity: "notice", title: "Account role granted", audit: true }),
  entry({ type: "account.role.revoked", version: 1, category: "security", severity: "notice", title: "Account role revoked", audit: true }),

  // --- projects / environments (projects-worker) ---------------------------
  entry({ type: "project.created", version: 1, category: "activity", severity: "notice", title: "Project {subject.name} created", audit: true }),
  entry({ type: "project.archived", version: 1, category: "activity", severity: "notice", title: "Project {subject.name} archived", audit: true }),
  entry({ type: "environment.created", version: 1, category: "activity", severity: "info", title: "Environment {subject.name} created", audit: true }),
  entry({ type: "environment.archived", version: 1, category: "activity", severity: "info", title: "Environment {subject.name} archived", audit: true }),

  // --- identity (identity-worker; org-scoped copies) -----------------------
  entry({ type: "api_key.created", version: 1, category: "security", severity: "notice", title: "API key created", audit: true }),
  entry({ type: "api_key.revoked", version: 1, category: "security", severity: "notice", title: "API key revoked", audit: true }),

  // --- config: settings / flags / secrets (config-worker) ------------------
  entry({ type: "settings.updated", version: 1, category: "activity", severity: "info", title: "Setting {subject.name} updated", audit: true }),
  entry({ type: "feature.updated", version: 1, category: "activity", severity: "info", title: "Feature flag {subject.name} updated", audit: true }),
  entry({ type: "secrets.updated", version: 1, category: "security", severity: "notice", title: "Secret {subject.name} updated", audit: true }),
  entry({ type: "secret.accessed", version: 1, category: "security", severity: "info", title: "Secret {subject.name} accessed", audit: true }),
  entry({ type: "secret.denied", version: 1, category: "security", severity: "warning", title: "Secret access denied for {subject.name}", audit: true }),
  entry({ type: "secret.revealed", version: 1, category: "security", severity: "critical", title: "Secret {subject.name} revealed (break-glass)", audit: true }),
  entry({ type: "secret.policy.updated", version: 1, category: "security", severity: "notice", title: "Secret policy updated for {subject.name}", audit: true }),
  entry({ type: "secret.sync.recorded", version: 1, category: "security", severity: "info", title: "Secret sync recorded for {subject.name}", audit: true }),
  entry({ type: "secret.rotation_due", version: 1, category: "security", severity: "warning", title: "Secret {subject.name} rotation due", audit: true }),
  entry({ type: "secret.expiring", version: 1, category: "security", severity: "warning", title: "Secret {subject.name} expiring", audit: true }),
  entry({ type: "secret.rotated", version: 1, category: "security", severity: "info", title: "Secret {subject.name} rotated", audit: true }),
  entry({ type: "secret.rotation_failed", version: 1, category: "security", severity: "warning", title: "Secret {subject.name} rotation failed", audit: true }),

  // --- billing (billing-worker) ---------------------------------------------
  entry({ type: "subscription.created", version: 1, category: "billing", severity: "notice", title: "Subscription created ({payload.planCode})", audit: true }),
  entry({ type: "subscription.updated", version: 1, category: "billing", severity: "notice", title: "Subscription updated ({payload.planCode})", audit: true }),
  entry({ type: "entitlements.updated", version: 1, category: "billing", severity: "info", title: "Entitlements updated", audit: true }),

  // --- state / catalog (state-worker) ---------------------------------------
  entry({ type: "org.cli.linked", version: 1, category: "security", severity: "notice", title: "CLI linked to organization", audit: true }),
  entry({ type: "org.cli.unlinked", version: 1, category: "security", severity: "notice", title: "CLI unlinked from organization", audit: true }),
  entry({ type: "catalog.head.advanced", version: 1, category: "system", severity: "info", title: "Catalog head advanced", audit: true }),
  entry({ type: "state.run.created", version: 1, category: "activity", severity: "info", title: "Run {subject.id} created", audit: true }),
  entry({
    type: "state.run.completed", version: 1, category: "activity", severity: "notice",
    title: "Run {subject.id} completed",
    dedupKey: "run:{tenant.orgId}:{payload.repoFullName}:{payload.headSha}",
    correlates: ["scm.push", "scm.check.completed", "state.run.failed"],
    audit: true,
  }),
  entry({
    type: "state.run.failed", version: 1, category: "activity", severity: "error",
    title: "Run {subject.id} failed",
    dedupKey: "run:{tenant.orgId}:{payload.repoFullName}:{payload.headSha}",
    correlates: ["scm.push", "scm.check.completed", "state.run.completed"],
    audit: true,
  }),
  entry({ type: "state.job.failed", version: 1, category: "activity", severity: "error", title: "Job {subject.id} failed", audit: true }),
  entry({ type: "state.gc.collected", version: 1, category: "system", severity: "info", title: "Garbage collection completed", audit: true }),
  // Work plane (state-worker; orun-work-v3 PM1 mention fan-out — ES2 rules
  // deliver). Registered here to keep the emit-line totality guard green.
  entry({ type: "work.task.mentioned", version: 1, category: "activity", severity: "info", title: "@{payload.handle} mentioned on {payload.taskKey}", audit: false }),

  // --- scm.* — normalized source-control events (integrations-worker) ------
  entry({
    type: "scm.push", version: 1, category: "activity", severity: "info",
    title: "Push to {payload.repoFullName}@{payload.branch}",
    dedupKey: "run:{tenant.orgId}:{payload.repoFullName}:{payload.headSha}",
    correlates: ["scm.check.completed", "state.run.completed", "state.run.failed"],
    audit: true,
  }),
  entry({ type: "scm.pull_request.opened", version: 1, category: "activity", severity: "info", title: "PR #{payload.number} opened in {payload.repoFullName}", audit: true }),
  entry({ type: "scm.pull_request.updated", version: 1, category: "activity", severity: "info", title: "PR #{payload.number} updated in {payload.repoFullName}", audit: true }),
  entry({ type: "scm.pull_request.merged", version: 1, category: "activity", severity: "notice", title: "PR #{payload.number} merged in {payload.repoFullName}", audit: true }),
  entry({ type: "scm.pull_request.closed", version: 1, category: "activity", severity: "info", title: "PR #{payload.number} closed in {payload.repoFullName}", audit: true }),
  entry({
    type: "scm.check.completed", version: 1, category: "activity", severity: "info",
    title: "Check {payload.checkName} completed: {payload.conclusion}",
    dedupKey: "run:{tenant.orgId}:{payload.repoFullName}:{payload.headSha}",
    correlates: ["scm.push", "state.run.completed", "state.run.failed"],
    audit: true,
  }),
  entry({ type: "scm.release.published", version: 1, category: "activity", severity: "notice", title: "Release {payload.tag} published in {payload.repoFullName}", audit: true }),
  entry({ type: "scm.branch.created", version: 1, category: "activity", severity: "info", title: "Branch {payload.branch} created in {payload.repoFullName}", audit: true }),
  entry({ type: "scm.branch.deleted", version: 1, category: "activity", severity: "info", title: "Branch {payload.branch} deleted in {payload.repoFullName}", audit: true }),
  entry({ type: "scm.tag.created", version: 1, category: "activity", severity: "info", title: "Tag {payload.tag} created in {payload.repoFullName}", audit: true }),
  entry({ type: "scm.repo.linked", version: 1, category: "activity", severity: "notice", title: "Repository {payload.repoFullName} linked", audit: true }),
  entry({ type: "scm.repo.unlinked", version: 1, category: "activity", severity: "notice", title: "Repository {payload.repoFullName} unlinked", audit: true }),

  // --- integration.* lifecycle (integrations-worker) ------------------------
  entry({ type: "integration.connected", version: 1, category: "activity", severity: "notice", title: "Integration connected", audit: true }),
  entry({ type: "integration.suspended", version: 1, category: "activity", severity: "warning", title: "Integration suspended", audit: true }),
  entry({ type: "integration.reactivated", version: 1, category: "activity", severity: "notice", title: "Integration reactivated", audit: true }),
  entry({ type: "integration.revoked", version: 1, category: "activity", severity: "warning", title: "Integration revoked", audit: true }),
  entry({ type: "integration.repo_selection_changed", version: 1, category: "activity", severity: "info", title: "Integration repository selection changed", audit: true }),
  entry({ type: "integration.token.issued", version: 1, category: "security", severity: "info", title: "Scoped integration token issued", audit: true }),
  entry({ type: "integration.checkrun.posted", version: 1, category: "activity", severity: "info", title: "Check run posted to {payload.repoFullName}", audit: true }),
  entry({ type: "integration.commit_status.posted", version: 1, category: "activity", severity: "info", title: "Commit status posted to {payload.repoFullName}", audit: true }),
  // Credential broker + brokered secret bindings (saas-integration-hub IH4/IH7).
  entry({ type: "integration.credential.issued", version: 1, category: "security", severity: "info", title: "Scoped credential minted ({payload.provider} · {payload.template})", audit: true }),
  entry({ type: "integration.credential.revoked", version: 1, category: "security", severity: "notice", title: "Minted credential revoked ({payload.provider})", audit: true }),
  entry({ type: "integration.credential.mint_failed", version: 1, category: "security", severity: "warning", title: "Credential mint failed ({payload.provider} · {payload.template})", audit: true }),
  entry({ type: "integration.secret_binding.created", version: 1, category: "security", severity: "notice", title: "Secret bound to integration ({payload.provider} · {payload.template})", audit: true }),
  entry({ type: "integration.secret_binding.removed", version: 1, category: "security", severity: "notice", title: "Brokered secret binding removed", audit: true }),
  // Service-identity bootstrap (sub-epics/service-identity-bootstrap SI3).
  entry({ type: "integration.connection.upgraded", version: 1, category: "security", severity: "notice", title: "Connection custody upgraded to a service identity ({payload.provider})", audit: true }),

  // --- messaging.* — normalized messaging events (integrations-worker, IH3) --
  entry({ type: "messaging.command.invoked", version: 1, category: "activity", severity: "info", title: "Slash command invoked ({payload.command})", audit: true }),
  entry({ type: "messaging.action.invoked", version: 1, category: "activity", severity: "info", title: "Notification action invoked ({payload.actionId})", audit: true }),
  entry({ type: "messaging.channel.renamed", version: 1, category: "activity", severity: "info", title: "Linked channel renamed", audit: false }),
  entry({ type: "messaging.channel.archived", version: 1, category: "activity", severity: "warning", title: "Linked channel archived", audit: true }),

  // --- webhooks (webhooks-worker) --------------------------------------------
  // Delivery lifecycle types are event_log-only (no audit projection) and are
  // excluded from lane re-fanout by the recursion guard.
  entry({ type: "webhook.delivery_succeeded", version: 1, category: "delivery", severity: "info", title: "Webhook delivery succeeded", audit: false }),
  entry({ type: "webhook.delivery_failed", version: 1, category: "delivery", severity: "warning", title: "Webhook delivery failed", audit: false }),
  entry({ type: "webhook.disabled", version: 1, category: "delivery", severity: "error", title: "Webhook endpoint auto-disabled after repeated failures", audit: true }),
  entry({ type: "webhook_endpoint.created", version: 1, category: "activity", severity: "info", title: "Webhook endpoint created", audit: true }),
  entry({ type: "webhook_endpoint.updated", version: 1, category: "activity", severity: "info", title: "Webhook endpoint updated", audit: true }),
  entry({ type: "webhook_endpoint.disabled", version: 1, category: "activity", severity: "notice", title: "Webhook endpoint disabled", audit: true }),
  entry({ type: "webhook_endpoint.enabled", version: 1, category: "activity", severity: "notice", title: "Webhook endpoint enabled", audit: true }),
  entry({ type: "webhook_endpoint.deleted", version: 1, category: "activity", severity: "notice", title: "Webhook endpoint deleted", audit: true }),
  entry({ type: "webhook_endpoint.secret_rotated", version: 1, category: "security", severity: "notice", title: "Webhook endpoint secret rotated", audit: true }),
  entry({ type: "webhook_subscription.created", version: 1, category: "activity", severity: "info", title: "Webhook subscription created", audit: true }),
  entry({ type: "webhook_subscription.updated", version: 1, category: "activity", severity: "info", title: "Webhook subscription updated", audit: true }),
  entry({ type: "webhook_subscription.deleted", version: 1, category: "activity", severity: "info", title: "Webhook subscription deleted", audit: true }),

  // --- notifications (notifications-worker; auditable as of ES0) -----------
  entry({ type: "notification.queued", version: 1, category: "delivery", severity: "info", title: "Notification queued", audit: true }),
  entry({ type: "notification.sent", version: 1, category: "delivery", severity: "info", title: "Notification sent", audit: true }),
  entry({ type: "notification.failed", version: 1, category: "delivery", severity: "warning", title: "Notification delivery failed", audit: true }),
  entry({ type: "notification.preference_updated", version: 1, category: "activity", severity: "info", title: "Notification preferences updated", audit: true }),
  entry({ type: "notification.suppressed", version: 1, category: "delivery", severity: "notice", title: "Notification suppressed", audit: true }),

  // --- admin / support (admin-worker) ----------------------------------------
  entry({ type: "support.action_recorded", version: 1, category: "security", severity: "notice", title: "Support action recorded", audit: true }),
  entry({ type: "support.access_denied", version: 1, category: "security", severity: "warning", title: "Support access denied", audit: true }),

  // --- event streaming lifecycle (events-worker; emitted from ES1) ----------
  // Recursion guard: lane dispatch skips `event.*` and `dead_letter.*` types.
  entry({ type: "event.delivery_failed", version: 1, category: "system", severity: "warning", title: "Lane delivery failed for event {payload.eventId}", audit: true }),
  entry({ type: "dead_letter.created", version: 1, category: "system", severity: "error", title: "Event dead-lettered on lane {payload.laneKey}", audit: true }),
  entry({ type: "dead_letter.replayed", version: 1, category: "system", severity: "notice", title: "Dead letter replayed on lane {payload.laneKey}", audit: true }),

  // --- notification rules (events-worker; emitted from ES2) -----------------
  entry({ type: "notification_rule.created", version: 1, category: "activity", severity: "info", title: "Notification rule {subject.name} created", audit: true }),
  entry({ type: "notification_rule.updated", version: 1, category: "activity", severity: "info", title: "Notification rule {subject.name} updated", audit: true }),
  entry({ type: "notification_rule.deleted", version: 1, category: "activity", severity: "notice", title: "Notification rule {subject.name} deleted", audit: true }),
  // The storm-breaker suppression event (ES7). Category `system`: it is the
  // pipeline monitoring itself (like the event.* / dead_letter.* lifecycle
  // events), not a tenant activity record. Lane-suppressed by the
  // `notification_rule.` guard so a suppression cannot itself trigger rule
  // matching / more suppression.
  entry({ type: "notification_rule.suppressed", version: 1, category: "system", severity: "warning", title: "Notification rule {payload.ruleId} auto-suppressed after storm", audit: true }),

  // --- scale & lifecycle (events-worker; emitted from ES7) ------------------
  // The lane-lag alert: the pipeline routes its own health onto the log. Uses
  // the `event.` namespace so it is lane-suppressed and never recurses.
  entry({ type: "event.lane_lagging", version: 1, category: "system", severity: "warning", title: "Lane {payload.laneKey} lagging {payload.lagSeconds}s behind budget", audit: true }),

  // --- notification channels (notifications-worker; emitted from ES3) -------
  entry({ type: "notification_channel.created", version: 1, category: "activity", severity: "notice", title: "Notification channel {subject.name} created", audit: true }),
  entry({ type: "notification_channel.updated", version: 1, category: "activity", severity: "info", title: "Notification channel {subject.name} updated", audit: true }),
  entry({ type: "notification_channel.deleted", version: 1, category: "activity", severity: "notice", title: "Notification channel {subject.name} deleted", audit: true }),
  entry({ type: "notification_channel.verified", version: 1, category: "activity", severity: "info", title: "Notification channel {subject.name} verified", audit: true }),
] as Array<[string, CatalogEntry]>);

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a catalog entry for an event type. Tenant-authored `custom.*` types
 * (ES5 public ingest) resolve to a synthetic catch-all entry — severity and
 * title come from the ingested payload under caps, never from the registry.
 */
export function catalogEntryFor(type: string): CatalogEntry | null {
  const direct = EVENT_CATALOG[type];
  if (direct) return direct;
  if (type.startsWith(CUSTOM_EVENT_NAMESPACE) && EVENT_TYPE_PATTERN.test(type)) {
    return {
      type,
      version: 1,
      category: "custom",
      severity: "info",
      title: "{payload.title}",
      audit: false,
    };
  }
  return null;
}

/** True when the type is registered (or a valid tenant `custom.*` type). */
export function isCatalogedEventType(type: string): boolean {
  return catalogEntryFor(type) !== null;
}

/**
 * Event-type glob matching shared by lane type-filters (ES1) and
 * notification-rule matching (ES2). Deliberately small vocabulary:
 *
 * - `*`            — every type
 * - exact type     — that type only
 * - `prefix.*`     — every type under the prefix, across ANY number of
 *                    segments (`scm.*` matches `scm.push` AND
 *                    `scm.pull_request.opened`) — strictly more expressive
 *                    than the webhook subscriptions' single-level wildcard.
 *
 * Mid-pattern wildcards (`scm.*.opened`) are NOT supported; expressiveness
 * grows by demonstrated need (design §11).
 */
export function matchesEventTypeGlob(type: string, glob: string): boolean {
  if (glob === "*") return true;
  if (glob === type) return true;
  if (glob.endsWith(".*")) {
    return type.startsWith(glob.slice(0, -1));
  }
  return false;
}

/** True when the type matches ANY glob in the list; an empty list matches all. */
export function matchesAnyEventTypeGlob(type: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return true;
  return globs.some((glob) => matchesEventTypeGlob(type, glob));
}

/**
 * The effective severity of a concrete event: the catalog default, escalated
 * (never de-escalated) by a valid `severity` field in the payload. Unregistered
 * types fall back to "info".
 */
export function effectiveEventSeverity(type: string, payload: Record<string, unknown>): EventSeverity {
  const base = catalogEntryFor(type)?.severity ?? "info";
  const claimed = payload["severity"];
  if (typeof claimed === "string" && (EVENT_SEVERITIES as readonly string[]).includes(claimed)) {
    const claimedSeverity = claimed as EventSeverity;
    if (severityRank(claimedSeverity) > severityRank(base)) return claimedSeverity;
  }
  return base;
}

/**
 * The category of a concrete event: the catalog entry's category when the type
 * is registered (or a tenant `custom.*` type, which resolves to "custom"), else
 * "system" for anything unrecognized. Never throws — used by the explorer read
 * projection where an unknown type must still render a category.
 */
export function eventCategory(type: string): string {
  return catalogEntryFor(type)?.category ?? (type.startsWith(CUSTOM_EVENT_NAMESPACE) ? "custom" : "system");
}

/**
 * Render a catalog title template against an envelope-shaped view. Supported
 * placeholders: `{subject.name}`, `{subject.id}`, `{subject.kind}`,
 * `{tenant.orgId}`, `{payload.<dotted.path>}`. Unresolvable placeholders
 * render as their trailing path segment in brackets, never throwing —
 * rendering is a display concern and must not fail routing.
 */
export function renderEventTitle(
  template: string,
  view: {
    subject?: { kind?: string; id?: string; name?: string | null };
    tenant?: { orgId?: string };
    payload?: Record<string, unknown>;
  },
): string {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_match, rawPath: string) => {
    const parts = rawPath.split(".");
    let target: unknown = view;
    for (const part of parts) {
      if (target && typeof target === "object" && part in (target as Record<string, unknown>)) {
        target = (target as Record<string, unknown>)[part];
      } else {
        target = undefined;
        break;
      }
    }
    if (target === undefined || target === null) return `[${parts[parts.length - 1]!}]`;
    if (typeof target === "object") return `[${parts[parts.length - 1]!}]`;
    return String(target);
  });
}

/**
 * Render a catalog `dedupKey` template into a concrete aggregation key
 * (saas-event-streaming ES4). Unlike title rendering this is STRICT: if any
 * referenced field is missing/empty/non-scalar the key is `null` and the
 * event does not group (R2 — a partial key would fuse unrelated events). The
 * org scope is always part of an authored key, so cross-tenant grouping is
 * structurally impossible.
 */
export function renderDedupKey(
  template: string,
  view: {
    subject?: { kind?: string; id?: string; name?: string | null };
    tenant?: { orgId?: string };
    payload?: Record<string, unknown>;
  },
): string | null {
  let missing = false;
  const rendered = template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_match, rawPath: string) => {
    const parts = rawPath.split(".");
    let target: unknown = view;
    for (const part of parts) {
      if (target && typeof target === "object" && part in (target as Record<string, unknown>)) {
        target = (target as Record<string, unknown>)[part];
      } else {
        target = undefined;
        break;
      }
    }
    if (target === undefined || target === null || typeof target === "object") {
      missing = true;
      return "";
    }
    const str = String(target);
    if (str.length === 0) {
      missing = true;
      return "";
    }
    return str;
  });
  return missing ? null : rendered;
}

/**
 * The dedup group key for a concrete event, or `null` when the event's type
 * has no authored `dedupKey` (never groups) or a referenced field is absent.
 */
export function eventDedupKey(
  type: string,
  view: {
    subject?: { kind?: string; id?: string; name?: string | null };
    tenant?: { orgId?: string };
    payload?: Record<string, unknown>;
  },
): string | null {
  const template = catalogEntryFor(type)?.dedupKey;
  if (!template) return null;
  return renderDedupKey(template, view);
}
