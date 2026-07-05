import type { StoredEvent, StoredNotificationRule, RuleAttributeFilter } from "@saas/db/events";
import {
  effectiveEventSeverity,
  matchesAnyEventTypeGlob,
  severityRank,
  type EventSeverity,
} from "@saas/contracts/event-catalog";

/**
 * The notification-rule matching engine (saas-event-streaming ES2).
 * Pure predicate, evaluated cheapest-first: type glob → severity floor →
 * source → tenancy scope → conjunctive attribute filters. Throttling is NOT
 * here — it is stateful admission, applied by the lane handler only after a
 * rule matches.
 */
export function ruleMatchesEvent(rule: StoredNotificationRule, event: StoredEvent): boolean {
  // Type globs. A rule with an empty list matches nothing (rules must opt in;
  // CRUD validation enforces at least one glob — this is defense in depth,
  // deliberately diverging from lane type_filter semantics where empty=all).
  if (rule.eventTypes.length === 0) return false;
  if (!matchesAnyEventTypeGlob(event.type, rule.eventTypes)) return false;

  // Severity floor (catalog default, payload may escalate).
  const severity = effectiveEventSeverity(event.type, event.payload);
  if (severityRank(severity) < severityRank(rule.minSeverity as EventSeverity)) return false;

  // Source allow-list (null = any source).
  if (rule.sources && rule.sources.length > 0 && !rule.sources.includes(event.source)) {
    return false;
  }

  // Tenancy scope: project-scoped rules match only their project's events.
  if (rule.projectId && event.projectId !== rule.projectId) return false;

  // Conjunctive attribute filters over the payload.
  for (const filter of rule.attributeFilters ?? []) {
    if (!attributeFilterMatches(filter, event.payload)) return false;
  }

  return true;
}

function resolvePath(payload: Record<string, unknown>, path: string): unknown {
  let target: unknown = payload;
  for (const part of path.split(".")) {
    if (target && typeof target === "object" && !Array.isArray(target) && part in (target as Record<string, unknown>)) {
      target = (target as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return target;
}

function scalarEquals(a: unknown, b: unknown): boolean {
  if (typeof a === "string" || typeof a === "number" || typeof a === "boolean" || a === null) {
    return a === b;
  }
  return false;
}

export function attributeFilterMatches(
  filter: RuleAttributeFilter,
  payload: Record<string, unknown>,
): boolean {
  const actual = resolvePath(payload, filter.path);
  switch (filter.op) {
    case "eq":
      return scalarEquals(actual, filter.value);
    case "neq":
      // Deliberately "known and different": an absent path does NOT satisfy
      // neq — routing on fields the event doesn't carry is a false positive.
      return actual !== undefined && !scalarEquals(actual, filter.value);
    case "in":
      return Array.isArray(filter.value) && filter.value.some((candidate) => scalarEquals(actual, candidate));
    default:
      return false;
  }
}
