/**
 * Pure model for the notification-rule builder (saas-event-streaming ES6).
 *
 * Dependency-free (no React, no `next/*`) so the form → request mapping and the
 * glob/attribute parsing are unit-testable (settings-nav.ts / preferences.ts
 * convention). The React wiring (dialog, target picker) lives in
 * `rule-builder.tsx`; this file owns the exact mapping to the
 * `Create/UpdateNotificationRuleRequest` contract shapes.
 */

import {
  EVENT_SEVERITIES,
  type EventSeverity,
} from "@saas/contracts/event-catalog";
import type {
  CreateNotificationRuleRequest,
  NotificationRuleAttributeFilter,
  NotificationRuleFilterOp,
  NotificationRuleTargetKind,
  PublicNotificationRule,
  UpdateNotificationRuleRequest,
} from "@saas/contracts/notifications";

export const RULE_SEVERITY_OPTIONS: ReadonlyArray<EventSeverity> = EVENT_SEVERITIES;

export const RULE_FILTER_OPS: ReadonlyArray<{ value: NotificationRuleFilterOp; label: string }> = [
  { value: "eq", label: "equals" },
  { value: "neq", label: "not equals" },
  { value: "in", label: "in (comma list)" },
];

export const RULE_TARGET_KINDS: ReadonlyArray<{ value: NotificationRuleTargetKind; label: string }> = [
  { value: "email", label: "Email address" },
  { value: "slack_channel", label: "Slack channel" },
];

/** The notification-channel fields the rule builder needs to pick a target. */
export interface SelectableChannel {
  id: string;
  name: string;
  kind: string;
}

/**
 * Slack-deliverable notification channels a rule can target, in list order.
 * BOTH kinds route through the `slack_channel` target and are referenced by the
 * channel's `chan_` id — the workspace-bot (`slack_app`, IH2) exactly as the
 * legacy incoming-webhook. Kept as a shared, tested predicate so the builder
 * picker can never again silently drop a live channel kind.
 */
export const SLACK_CHANNEL_KINDS: ReadonlySet<string> = new Set([
  "slack_incoming_webhook",
  "slack_app",
]);

export function selectableSlackChannels<T extends { kind: string }>(
  channels: readonly T[],
): T[] {
  return channels.filter((c) => SLACK_CHANNEL_KINDS.has(c.kind));
}

/**
 * Option label for the channel picker. When a workspace has both a
 * workspace-bot channel and a webhook channel, the delivery mechanism is
 * disambiguated inline (e.g. "#alerts · Workspace bot") so they're not two
 * identical rows.
 */
export function slackChannelOptionLabel(channel: { name: string; kind: string }): string {
  const suffix =
    channel.kind === "slack_app"
      ? "Workspace bot"
      : channel.kind === "slack_incoming_webhook"
        ? "Webhook"
        : null;
  return suffix ? `${channel.name} · ${suffix}` : channel.name;
}

/** Default throttle: at most 10 deliveries per 5-minute window. */
export const DEFAULT_THROTTLE_WINDOW_SECONDS = 300;
export const DEFAULT_THROTTLE_MAX = 10;

/** One attribute-filter row in the builder (raw string `value`, parsed later). */
export interface RuleAttrFilterRow {
  path: string;
  op: NotificationRuleFilterOp;
  value: string;
}

/** Raw, unvalidated values straight from the rule-builder form. */
export interface RuleFormValues {
  name: string;
  scope: "org" | "project";
  projectId: string;
  /** Event-type globs, one per line or comma/space separated. */
  eventTypes: string;
  minSeverity: EventSeverity;
  /** Optional source allow-list, comma/space separated. */
  sources: string;
  attributeFilters: RuleAttrFilterRow[];
  throttleWindowSeconds: string;
  throttleMax: string;
  targetKind: NotificationRuleTargetKind;
  /** Email address (email) or channel id (slack_channel). */
  targetRef: string;
}

export const EMPTY_RULE_FORM: RuleFormValues = {
  name: "",
  scope: "org",
  projectId: "",
  eventTypes: "",
  minSeverity: "warning",
  sources: "",
  attributeFilters: [],
  throttleWindowSeconds: String(DEFAULT_THROTTLE_WINDOW_SECONDS),
  throttleMax: String(DEFAULT_THROTTLE_MAX),
  targetKind: "email",
  targetRef: "",
};

/**
 * Split a free-text list (globs or sources) into trimmed, de-duplicated,
 * non-empty tokens. Accepts commas, whitespace, and newlines as separators.
 */
export function parseTokenList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw.split(/[\s,]+/)) {
    const t = tok.trim();
    if (t.length > 0 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Coerce a scalar string to number / boolean / string (a payload literal). */
function coerceScalar(raw: string): string | number | boolean {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  return t;
}

/**
 * Map builder attribute rows to the contract `NotificationRuleAttributeFilter[]`
 * (or `null` when there are none). Rows with a blank `path` are dropped. For
 * `in`, the value is split on commas into a scalar array; for `eq`/`neq` the
 * value is coerced to a single scalar.
 */
export function attrRowsToFilters(
  rows: ReadonlyArray<RuleAttrFilterRow>,
): NotificationRuleAttributeFilter[] | null {
  const filters: NotificationRuleAttributeFilter[] = [];
  for (const row of rows) {
    const path = row.path.trim();
    if (path.length === 0) continue;
    const value =
      row.op === "in"
        ? row.value.split(",").map((v) => coerceScalar(v)).filter((v) => v !== "")
        : coerceScalar(row.value);
    filters.push({ path, op: row.op, value });
  }
  return filters.length > 0 ? filters : null;
}

export type RuleFormResult<T> =
  | { ok: true; value: T }
  | { ok: false; field: string; reason: string };

function parseThrottle(
  values: RuleFormValues,
): RuleFormResult<{ window: number; max: number }> {
  const window = Number(values.throttleWindowSeconds);
  if (!Number.isFinite(window) || window < 0) {
    return { ok: false, field: "throttleWindowSeconds", reason: "Must be a non-negative number of seconds" };
  }
  const max = Number(values.throttleMax);
  if (!Number.isFinite(max) || max < 1) {
    return { ok: false, field: "throttleMax", reason: "Must be at least 1" };
  }
  return { ok: true, value: { window: Math.floor(window), max: Math.floor(max) } };
}

/** Common validation shared by create/update: name, event types, target. */
function validateCore(
  values: RuleFormValues,
): RuleFormResult<{ eventTypes: string[]; sources: string[] | null; targetRef: string }> {
  const name = values.name.trim();
  if (name.length === 0) {
    return { ok: false, field: "name", reason: "A rule name is required" };
  }
  const eventTypes = parseTokenList(values.eventTypes);
  if (eventTypes.length === 0) {
    return { ok: false, field: "eventTypes", reason: "Add at least one event-type glob (e.g. scm.* or *)" };
  }
  if (values.scope === "project" && values.projectId.trim().length === 0) {
    return { ok: false, field: "projectId", reason: "A project id is required for a project-scoped rule" };
  }
  const targetRef = values.targetRef.trim();
  if (targetRef.length === 0) {
    return {
      ok: false,
      field: "targetRef",
      reason: values.targetKind === "email" ? "An email address is required" : "Select a Slack channel",
    };
  }
  const sources = parseTokenList(values.sources);
  return { ok: true, value: { eventTypes, sources: sources.length > 0 ? sources : null, targetRef } };
}

/** Map the builder form to a `CreateNotificationRuleRequest` (validated). */
export function ruleFormToCreateRequest(
  values: RuleFormValues,
): RuleFormResult<CreateNotificationRuleRequest> {
  const core = validateCore(values);
  if (!core.ok) return core;
  const throttle = parseThrottle(values);
  if (!throttle.ok) return throttle;

  const body: CreateNotificationRuleRequest = {
    name: values.name.trim(),
    eventTypes: core.value.eventTypes,
    minSeverity: values.minSeverity,
    sources: core.value.sources,
    attributeFilters: attrRowsToFilters(values.attributeFilters),
    throttleWindowSeconds: throttle.value.window,
    throttleMax: throttle.value.max,
    targets: [{ kind: values.targetKind, ref: core.value.targetRef }],
  };
  if (values.scope === "project") body.projectId = values.projectId.trim();
  return { ok: true, value: body };
}

/**
 * Map the builder form to an `UpdateNotificationRuleRequest` (validated).
 * Targets are NOT included: target membership is managed on its own (the update
 * contract carries no `targets`), so an edit updates the rule's matching /
 * throttle / scope only.
 */
export function ruleFormToUpdateRequest(
  values: RuleFormValues,
): RuleFormResult<UpdateNotificationRuleRequest> {
  const core = validateCore(values);
  if (!core.ok) return core;
  const throttle = parseThrottle(values);
  if (!throttle.ok) return throttle;

  const body: UpdateNotificationRuleRequest = {
    name: values.name.trim(),
    eventTypes: core.value.eventTypes,
    minSeverity: values.minSeverity,
    sources: core.value.sources,
    attributeFilters: attrRowsToFilters(values.attributeFilters),
    throttleWindowSeconds: throttle.value.window,
    throttleMax: throttle.value.max,
    projectId: values.scope === "project" ? values.projectId.trim() : null,
  };
  return { ok: true, value: body };
}

/** Seed the builder from an existing rule (edit prefill). */
export function ruleToFormValues(rule: PublicNotificationRule): RuleFormValues {
  const target = rule.targets?.[0];
  const minSeverity = (EVENT_SEVERITIES as readonly string[]).includes(rule.minSeverity)
    ? (rule.minSeverity as EventSeverity)
    : "info";
  return {
    name: rule.name,
    scope: rule.projectId ? "project" : "org",
    projectId: rule.projectId ?? "",
    eventTypes: rule.eventTypes.join("\n"),
    minSeverity,
    sources: (rule.sources ?? []).join(", "),
    attributeFilters: (rule.attributeFilters ?? []).map((f) => ({
      path: f.path,
      op: f.op,
      value: attrValueToString(f.value),
    })),
    throttleWindowSeconds: String(rule.throttleWindowSeconds),
    throttleMax: String(rule.throttleMax),
    targetKind: (target?.kind === "slack_channel" ? "slack_channel" : "email") as NotificationRuleTargetKind,
    targetRef: target?.ref ?? "",
  };
}

/** Render a stored attribute-filter value back to an editable string. */
export function attrValueToString(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Short human summary of a rule's targets ("email: ops@x", "slack: #alerts").
 * A `slack_channel` target's `ref` is an opaque `chan_` id; pass the org's
 * channels to resolve it to the channel name (falls back to the id when the
 * channel is unknown — e.g. deleted).
 */
export function summarizeTargets(
  rule: PublicNotificationRule,
  channels?: ReadonlyArray<{ id: string; name: string }>,
): string {
  const targets = rule.targets ?? [];
  if (targets.length === 0) return "No targets";
  const nameById = new Map((channels ?? []).map((c) => [c.id, c.name]));
  return targets
    .map((t) => {
      if (t.kind === "slack_channel") return `slack: ${nameById.get(t.ref) ?? t.ref}`;
      return `${t.kind}: ${t.ref}`;
    })
    .join(", ");
}

/** Human throttle summary ("10 / 5m"). */
export function summarizeThrottle(rule: Pick<PublicNotificationRule, "throttleMax" | "throttleWindowSeconds">): string {
  const secs = rule.throttleWindowSeconds;
  const window =
    secs % 3600 === 0 && secs >= 3600
      ? `${secs / 3600}h`
      : secs % 60 === 0
        ? `${secs / 60}m`
        : `${secs}s`;
  return `${rule.throttleMax} / ${window}`;
}
