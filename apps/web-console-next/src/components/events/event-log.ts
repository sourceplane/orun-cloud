/**
 * Pure helpers for the org-scoped Events explorer (saas-event-streaming ES6).
 *
 * Kept dependency-free (no React, no `next/*`, no DOM) so the filter-query
 * building, "Load more" pagination accumulation, live-poll prepend, severity
 * accents, and timestamp formatting can be unit-tested in isolation. The React
 * wiring lives in the events page (`app/(app)/orgs/[orgSlug]/events/page.tsx`);
 * this file owns:
 *
 *   - the filter form → SDK `EventStreamFilters` query builder (`buildEventsQuery`)
 *   - the client-side severity-floor + category predicate
 *     (`eventMatchesClientFilters`) — the explorer read API filters ONLY by
 *     type/source/project/environment/from/to (see `EventStreamFilters`), so a
 *     severity floor and category narrowing are applied in-browser over the
 *     loaded rows.
 *   - the "Load more" accumulation reducer (`appendEventPage`) and the live-poll
 *     prepend (`prependNewEvents`)
 *   - the severity accent + day-group view-model shapers
 *
 * Cursor handling mirrors the SDK contract: the continuation cursor is an
 * opaque token surfaced by `EventsClient.listEventsPage` as `cursor` (from
 * `meta.cursor`). Callers MUST pass it back verbatim — never construct or parse
 * it. Time presets, relative-time formatting, and day-grouping are reused from
 * the audit module so the two explorers stay visually in lock-step.
 */

import type { PublicEvent } from "@saas/contracts/events";
import {
  EVENT_CATALOG,
  EVENT_CATEGORIES,
  EVENT_SEVERITIES,
  severityRank,
  type EventSeverity,
} from "@saas/contracts/event-catalog";
import type { EventStreamFilters } from "@saas/sdk";

import {
  AUDIT_TIME_PRESETS,
  formatRelativeTime,
  presetFromIso,
  type AuditTimePreset,
} from "@/components/audit/audit-log";

// The events explorer reuses the audit time-preset vocabulary verbatim.
export {
  AUDIT_TIME_PRESETS as EVENT_TIME_PRESETS,
  formatRelativeTime,
  presetFromIso,
};
export type EventTimePreset = AuditTimePreset;

/** Raw, unvalidated values straight from the explorer filter inputs. */
export interface EventFilterFormValues {
  /** Event-type glob (exact, `prefix.*`, or `*`). */
  type: string;
  /** Severity floor (client-side): "" = any, else one of EVENT_SEVERITIES. */
  severity: string;
  source: string;
  /** Catalog category (client-side): "" = any, else one of EVENT_CATEGORIES. */
  category: string;
  /** Public project id (`prj_…`). */
  project: string;
  /** Public environment id (`env_…`). */
  environment: string;
  from: string;
  to: string;
}

export const EMPTY_EVENT_FILTERS: EventFilterFormValues = {
  type: "",
  severity: "",
  source: "",
  category: "",
  project: "",
  environment: "",
  from: "",
  to: "",
};

/** Trim a form value; treat empty / whitespace-only as "unset". */
function clean(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the SDK `EventStreamFilters` query from the filter form. Only the
 * server-supported fields are forwarded — `severity` and `category` are NOT in
 * `EventStreamFilters`, so they are applied client-side by
 * {@link eventMatchesClientFilters} instead. `cursor` is threaded in for "Load
 * more"; omit it for the first page.
 */
export function buildEventsQuery(
  values: EventFilterFormValues,
  cursor?: string,
): EventStreamFilters {
  const type = clean(values.type);
  const source = clean(values.source);
  const project = clean(values.project);
  const environment = clean(values.environment);
  const from = clean(values.from);
  const to = clean(values.to);
  return {
    ...(type !== undefined ? { type } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(environment !== undefined ? { environment } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

/** Is `sev` a valid severity in the ladder? */
function isSeverity(sev: string): sev is EventSeverity {
  return (EVENT_SEVERITIES as readonly string[]).includes(sev);
}

/**
 * Client-side predicate for the two filters the read API cannot express: a
 * severity floor (keep events at or above the floor) and a category match.
 * Blank/invalid floor and blank category both pass everything.
 */
export function eventMatchesClientFilters(
  event: Pick<PublicEvent, "severity" | "category">,
  values: EventFilterFormValues,
): boolean {
  const floor = clean(values.severity);
  if (floor !== undefined && isSeverity(floor)) {
    if (severityRank(event.severity) < severityRank(floor)) return false;
  }
  const category = clean(values.category);
  if (category !== undefined && event.category !== category) return false;
  return true;
}

/** Whether the form has at least one active filter. */
export function hasActiveEventFilters(values: EventFilterFormValues): boolean {
  return (
    clean(values.type) !== undefined ||
    clean(values.severity) !== undefined ||
    clean(values.source) !== undefined ||
    clean(values.category) !== undefined ||
    clean(values.project) !== undefined ||
    clean(values.environment) !== undefined ||
    clean(values.from) !== undefined ||
    clean(values.to) !== undefined
  );
}

/** Accumulated state for the cursor-paginated event stream. */
export interface EventLogState {
  events: ReadonlyArray<PublicEvent>;
  /** Opaque continuation cursor; null when the last page has been reached. */
  cursor: string | null;
}

export const EMPTY_EVENT_LOG: EventLogState = {
  events: [],
  cursor: null,
};

/**
 * Fold a freshly-fetched page into the accumulated state.
 *
 * `reset` distinguishes the initial / refreshed load (replace) from a "Load
 * more" append (concatenate). De-duplication by event id guards against a
 * boundary event appearing on two adjacent pages — append is idempotent on id.
 */
export function appendEventPage(
  prev: EventLogState,
  page: { events: ReadonlyArray<PublicEvent>; cursor: string | null },
  reset = false,
): EventLogState {
  if (reset) {
    return { events: page.events.slice(), cursor: page.cursor };
  }
  const seen = new Set(prev.events.map((e) => e.id));
  const merged = prev.events.slice();
  for (const e of page.events) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      merged.push(e);
    }
  }
  return { events: merged, cursor: page.cursor };
}

/**
 * Merge a live-poll first-page fetch into the current state: prepend any events
 * not already present (newest-first order preserved) and keep the existing
 * continuation cursor untouched (the poll only refreshes the head, never the
 * tail). Returns the same state object when nothing is new so callers can skip
 * a re-render.
 */
export function prependNewEvents(
  prev: EventLogState,
  incoming: ReadonlyArray<PublicEvent>,
): EventLogState {
  const seen = new Set(prev.events.map((e) => e.id));
  const fresh = incoming.filter((e) => !seen.has(e.id));
  if (fresh.length === 0) return prev;
  return { events: [...fresh, ...prev.events], cursor: prev.cursor };
}

/** Whether a "Load more" affordance should be shown. */
export function hasMoreEvents(state: EventLogState): boolean {
  return state.cursor !== null;
}

// ---------------------------------------------------------------------------
// Catalog-fed select vocabularies
// ---------------------------------------------------------------------------

/**
 * Known event types for the type datalist/select, sorted. The API treats
 * `type` as a free glob, so this is a UX courtesy (autocomplete over the
 * catalog) — an unknown/custom type typed by hand filters fine.
 */
export const EVENT_TYPE_OPTIONS: ReadonlyArray<string> = Object.keys(EVENT_CATALOG).sort();

/**
 * Prefix globs (`scm.*`, `notification.*`, …) derived from the catalog's first
 * type segment — offered alongside the exact types so a user can subscribe to a
 * whole family in one click.
 */
export const EVENT_TYPE_GLOB_OPTIONS: ReadonlyArray<string> = Array.from(
  new Set(EVENT_TYPE_OPTIONS.map((t) => `${t.split(".")[0]}.*`)),
).sort();

export const EVENT_SEVERITY_OPTIONS: ReadonlyArray<EventSeverity> = EVENT_SEVERITIES;

export const EVENT_CATEGORY_OPTIONS: ReadonlyArray<string> = EVENT_CATEGORIES;

// ---------------------------------------------------------------------------
// Severity accents (renderer maps tone → design tokens; icon by name)
// ---------------------------------------------------------------------------

export interface SeverityAccent {
  tone: "slate" | "blue" | "amber" | "rose" | "red";
  icon: string;
}

const SEVERITY_ACCENTS: Record<EventSeverity, SeverityAccent> = {
  info: { tone: "slate", icon: "Info" },
  notice: { tone: "blue", icon: "Bell" },
  warning: { tone: "amber", icon: "AlertTriangle" },
  error: { tone: "rose", icon: "AlertOctagon" },
  critical: { tone: "red", icon: "Flame" },
};

export function severityAccent(severity: string): SeverityAccent {
  return SEVERITY_ACCENTS[severity as EventSeverity] ?? SEVERITY_ACCENTS.info;
}

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

/** One removable chip per active filter, for the toolbar summary row. */
export interface EventFilterChip {
  key: keyof EventFilterFormValues;
  label: string;
}

const CHIP_LABELS: Record<keyof EventFilterFormValues, string> = {
  type: "type",
  severity: "severity ≥",
  source: "source",
  category: "category",
  project: "project",
  environment: "environment",
  from: "from",
  to: "to",
};

export function buildEventFilterChips(
  values: EventFilterFormValues,
): EventFilterChip[] {
  const chips: EventFilterChip[] = [];
  for (const key of Object.keys(CHIP_LABELS) as Array<keyof EventFilterFormValues>) {
    const v = clean(values[key]);
    if (v !== undefined) chips.push({ key, label: `${CHIP_LABELS[key]}: ${v}` });
  }
  return chips;
}

// ---------------------------------------------------------------------------
// Day grouping (mirrors the audit timeline)
// ---------------------------------------------------------------------------

export interface EventDayGroup {
  label: string;
  key: string;
  events: PublicEvent[];
}

function localDayKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Group events by local calendar day, preserving input order (the API returns
 * newest-first). Events with malformed timestamps fall into a trailing "Unknown
 * date" group rather than being dropped.
 */
export function groupEventsByDay(
  events: ReadonlyArray<PublicEvent>,
  now: number = Date.now(),
): EventDayGroup[] {
  const todayKey = localDayKey(new Date(now));
  const yesterdayKey = localDayKey(new Date(now - 24 * 60 * 60 * 1000));
  const groups: EventDayGroup[] = [];
  const byKey = new Map<string, EventDayGroup>();
  for (const e of events) {
    const d = new Date(e.occurredAt);
    const valid = !Number.isNaN(d.getTime());
    const key = valid ? localDayKey(d) : "unknown";
    let group = byKey.get(key);
    if (!group) {
      const label = !valid
        ? "Unknown date"
        : key === todayKey
          ? "Today"
          : key === yesterdayKey
            ? "Yesterday"
            : d.toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              });
      group = { label, key, events: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.events.push(e);
  }
  return groups;
}
