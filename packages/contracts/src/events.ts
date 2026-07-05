/**
 * Event envelope and audit contract types.
 *
 * These types match the durable event-envelope schema defined in
 * specs/core/contracts/event-envelope.schema.yaml. They are transport-safe,
 * package-safe, and contain no platform clients or database row types.
 */

// ---------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------

import {
  CUSTOM_EVENT_NAMESPACE,
  EVENT_SEVERITIES,
  EVENT_TYPE_PATTERN,
  type EventSeverity,
} from "./event-catalog.js";

export type EventActorType = "user" | "service_principal" | "workflow" | "system";

export interface EventActor {
  type: EventActorType;
  id: string;
  sessionId?: string | null;
  ip?: string | null;
}

// ---------------------------------------------------------------------------
// Tenant
// ---------------------------------------------------------------------------

export interface EventTenant {
  orgId: string;
  projectId?: string | null;
  environmentId?: string | null;
}

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

export interface EventSubject {
  kind: string;
  id: string;
  name?: string | null;
}

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

export interface EventTrace {
  requestId: string;
  correlationId?: string | null;
  causationId?: string | null;
  idempotencyKey?: string | null;
}

// ---------------------------------------------------------------------------
// Audit metadata
// ---------------------------------------------------------------------------

export interface EventAuditMeta {
  redact?: string[];
}

// ---------------------------------------------------------------------------
// Event Envelope
// ---------------------------------------------------------------------------

export interface EventEnvelope {
  id: string;
  type: string;
  version: number;
  source: string;
  occurredAt: string;
  actor: EventActor;
  tenant: EventTenant;
  subject: EventSubject;
  trace: EventTrace;
  payload: Record<string, unknown>;
  audit?: EventAuditMeta;
}

// ---------------------------------------------------------------------------
// Audit Entry (immutable projection for querying)
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  eventId: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  actorType: EventActorType;
  actorId: string;
  eventType: string;
  eventVersion: number;
  source: string;
  subjectKind: string;
  subjectId: string;
  subjectName: string | null;
  category: string;
  description: string;
  occurredAt: string;
  requestId: string;
  correlationId: string | null;
  payload: Record<string, unknown>;
  redactPaths: string[];
}

// ---------------------------------------------------------------------------
// Audit Query Filters
// ---------------------------------------------------------------------------

export interface AuditQueryByOrg {
  orgId: string;
  category?: string;
  /** Filter by actor identity (the raw actor id recorded on the event). */
  actorId?: string;
  /** Filter by actor type (validated against the EventActorType set). */
  actorType?: EventActorType;
  /** Filter by subject/resource kind (e.g. "project", "member"). */
  subjectKind?: string;
  /** Filter by subject/resource id. */
  subjectId?: string;
  /** Filter by audit action / event type (e.g. "member.role_changed"). */
  eventType?: string;
  /** Inclusive lower bound on occurredAt (ISO-8601 ms Z). */
  from?: string;
  /** Inclusive upper bound on occurredAt (ISO-8601 ms Z). */
  to?: string;
  limit: number;
  cursor?: string | null;
}

export interface AuditQueryByTarget {
  orgId: string;
  subjectKind: string;
  subjectId: string;
  limit: number;
  cursor?: string | null;
}

// ---------------------------------------------------------------------------
// Public Audit Response (API boundary types)
// ---------------------------------------------------------------------------

export interface PublicAuditEntry {
  id: string;
  eventId: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  actorType: EventActorType;
  actorId: string;
  eventType: string;
  source: string;
  category: string;
  description: string;
  subject: {
    kind: string;
    id: string;
    name: string | null;
  };
  occurredAt: string;
  requestId: string;
  correlationId: string | null;
  payload: Record<string, unknown>;
}

export interface ListAuditEntriesResponse {
  data: {
    auditEntries: PublicAuditEntry[];
  };
  meta: {
    requestId: string;
    cursor: string | null;
  };
}

// ---------------------------------------------------------------------------
// Custom event ingest (saas-event-streaming ES5)
// ---------------------------------------------------------------------------

/**
 * Hard cap on the JSON-serialized `payload` of a tenant-authored custom event.
 * Measured as the UTF-8 byte length of `JSON.stringify(payload)`; keeps a single
 * row bounded so the event_log stays cheap to scan and fan out.
 */
export const MAX_CUSTOM_EVENT_PAYLOAD_BYTES = 32 * 1024;

/** The raw, unvalidated shape a caller POSTs to the ingest endpoint. */
export interface CustomEventInput {
  type: string;
  title?: string;
  severity?: string;
  subject?: { kind: string; id: string; name?: string | null };
  projectId?: string | null;
  environmentId?: string | null;
  payload?: Record<string, unknown>;
  dedupKey?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  idempotencyKey?: string | null;
  occurredAt?: string;
}

/**
 * The validated + normalized form of a custom event. Optional inputs are filled
 * with their defaults; `occurredAt` is `null` when the caller omitted it, which
 * signals the server to stamp the ingest time.
 */
export interface NormalizedCustomEvent {
  type: string;
  title: string;
  severity: EventSeverity;
  subject: { kind: string; id: string; name: string | null };
  projectId: string | null;
  environmentId: string | null;
  payload: Record<string, unknown>;
  dedupKey: string | null;
  correlationId: string | null;
  causationId: string | null;
  idempotencyKey: string | null;
  occurredAt: string | null;
}

export type CustomEventValidationResult =
  | { ok: true; value: NormalizedCustomEvent }
  | { ok: false; field: string; reason: string };

const CUSTOM_EVENT_FUTURE_SKEW_MS = 5 * 60_000;

function nullableStringField(
  value: unknown,
  max: number,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || value.length > max) return { ok: false };
  return { ok: true, value };
}

/**
 * Validate and normalize a tenant-authored custom event. Pure and total: never
 * throws, returns a discriminated result. `nowMs` (ms epoch) bounds the
 * `occurredAt` future-skew check; omit it to skip that check (keeps the function
 * deterministic and testable).
 */
export function validateCustomEvent(input: unknown, nowMs?: number): CustomEventValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, field: "body", reason: "Expected a JSON object" };
  }
  const b = input as Record<string, unknown>;

  // type — required, dotted, custom.* namespaced, 1..128 chars.
  if (typeof b.type !== "string" || b.type.length < 1 || b.type.length > 128) {
    return { ok: false, field: "type", reason: "Required: a dotted event type of 1-128 chars" };
  }
  if (!EVENT_TYPE_PATTERN.test(b.type)) {
    return { ok: false, field: "type", reason: "Must be a dotted lowercase event type (e.g. custom.order.placed)" };
  }
  if (!b.type.startsWith(CUSTOM_EVENT_NAMESPACE)) {
    return { ok: false, field: "type", reason: "Only the custom.* namespace may be ingested" };
  }
  const type = b.type;

  // title — optional string <= 200; defaults to the type.
  let title = type;
  if (b.title !== undefined) {
    if (typeof b.title !== "string" || b.title.length > 200) {
      return { ok: false, field: "title", reason: "Must be a string of at most 200 chars" };
    }
    title = b.title;
  }

  // severity — optional; one of EVENT_SEVERITIES; defaults to "info".
  let severity: EventSeverity = "info";
  if (b.severity !== undefined) {
    if (typeof b.severity !== "string" || !(EVENT_SEVERITIES as readonly string[]).includes(b.severity)) {
      return { ok: false, field: "severity", reason: `Must be one of ${EVENT_SEVERITIES.join(", ")}` };
    }
    severity = b.severity as EventSeverity;
  }

  // subject — optional; defaults to a synthetic custom subject.
  let subject: { kind: string; id: string; name: string | null } = { kind: "custom", id: "custom", name: null };
  if (b.subject !== undefined && b.subject !== null) {
    if (typeof b.subject !== "object" || Array.isArray(b.subject)) {
      return { ok: false, field: "subject", reason: "Must be an object { kind, id, name? }" };
    }
    const s = b.subject as Record<string, unknown>;
    if (typeof s.kind !== "string" || s.kind.length < 1 || s.kind.length > 64) {
      return { ok: false, field: "subject", reason: "subject.kind must be a string of 1-64 chars" };
    }
    if (typeof s.id !== "string" || s.id.length < 1 || s.id.length > 256) {
      return { ok: false, field: "subject", reason: "subject.id must be a string of 1-256 chars" };
    }
    let name: string | null = null;
    if (s.name !== undefined && s.name !== null) {
      if (typeof s.name !== "string" || s.name.length > 256) {
        return { ok: false, field: "subject", reason: "subject.name must be a string of at most 256 chars" };
      }
      name = s.name;
    }
    subject = { kind: s.kind, id: s.id, name };
  }

  // projectId / environmentId — optional public ids; pass through (validated
  // downstream). Coerce undefined -> null.
  if (b.projectId !== undefined && b.projectId !== null && typeof b.projectId !== "string") {
    return { ok: false, field: "projectId", reason: "Must be a project public id or null" };
  }
  if (b.environmentId !== undefined && b.environmentId !== null && typeof b.environmentId !== "string") {
    return { ok: false, field: "environmentId", reason: "Must be an environment public id or null" };
  }
  const projectId = typeof b.projectId === "string" ? b.projectId : null;
  const environmentId = typeof b.environmentId === "string" ? b.environmentId : null;

  // payload — optional non-null non-array object, capped at 32KiB serialized.
  let payload: Record<string, unknown> = {};
  if (b.payload !== undefined && b.payload !== null) {
    if (typeof b.payload !== "object" || Array.isArray(b.payload)) {
      return { ok: false, field: "payload", reason: "Must be a JSON object" };
    }
    payload = b.payload as Record<string, unknown>;
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    if (bytes > MAX_CUSTOM_EVENT_PAYLOAD_BYTES) {
      return { ok: false, field: "payload", reason: "Payload exceeds 32KiB limit" };
    }
  }

  // dedupKey / correlationId / causationId / idempotencyKey — optional strings.
  const dedup = nullableStringField(b.dedupKey, 200);
  if (!dedup.ok) return { ok: false, field: "dedupKey", reason: "Must be a string of at most 200 chars" };
  const correlation = nullableStringField(b.correlationId, 200);
  if (!correlation.ok) return { ok: false, field: "correlationId", reason: "Must be a string of at most 200 chars" };
  const causation = nullableStringField(b.causationId, 200);
  if (!causation.ok) return { ok: false, field: "causationId", reason: "Must be a string of at most 200 chars" };
  const idempotency = nullableStringField(b.idempotencyKey, 200);
  if (!idempotency.ok) return { ok: false, field: "idempotencyKey", reason: "Must be a string of at most 200 chars" };

  // occurredAt — optional ISO-8601; not more than 5 minutes ahead of nowMs.
  let occurredAt: string | null = null;
  if (b.occurredAt !== undefined && b.occurredAt !== null) {
    if (typeof b.occurredAt !== "string") {
      return { ok: false, field: "occurredAt", reason: "Must be an ISO-8601 timestamp" };
    }
    const parsed = Date.parse(b.occurredAt);
    if (isNaN(parsed)) {
      return { ok: false, field: "occurredAt", reason: "Must be a valid ISO-8601 timestamp" };
    }
    if (nowMs !== undefined && parsed > nowMs + CUSTOM_EVENT_FUTURE_SKEW_MS) {
      return { ok: false, field: "occurredAt", reason: "occurredAt cannot be in the future" };
    }
    occurredAt = new Date(parsed).toISOString();
  }

  return {
    ok: true,
    value: {
      type,
      title,
      severity,
      subject,
      projectId,
      environmentId,
      payload,
      dedupKey: dedup.value,
      correlationId: correlation.value,
      causationId: causation.value,
      idempotencyKey: idempotency.value,
      occurredAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Public Event (explorer read projection)
// ---------------------------------------------------------------------------

export interface PublicEvent {
  id: string;
  type: string;
  version: number;
  source: string;
  severity: EventSeverity;
  category: string;
  title: string;
  occurredAt: string;
  actor: { type: EventActorType; id: string };
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  subject: { kind: string; id: string; name: string | null };
  requestId: string;
  correlationId: string | null;
  causationId: string | null;
  payload: Record<string, unknown>;
}

export interface ListEventsResponse {
  data: { events: PublicEvent[] };
  meta: { requestId: string; cursor: string | null };
}

export interface GetEventResponse {
  data: { event: PublicEvent };
  meta: { requestId: string };
}

export interface EventLogQueryFilters {
  type?: string;
  source?: string;
  projectId?: string;
  environmentId?: string;
  from?: string;
  to?: string;
}

// ---------------------------------------------------------------------------
// Public Event Group (dedup/correlation read projection, ES4)
// ---------------------------------------------------------------------------

export type EventGroupStatus = "open" | "closed";

/**
 * A dedup/correlation "story" as seen at the API boundary. Matches the JSON
 * emitted by the events-worker event-groups handler (`toPublicGroup`): the
 * internal org UUID is projected to its public `org_<hex>` form and every
 * timestamp is an ISO-8601 string.
 */
export interface PublicEventGroup {
  id: string;
  orgId: string;
  groupKey: string;
  status: EventGroupStatus;
  eventCount: number;
  maxSeverity: string;
  firstAt: string;
  lastAt: string;
  closedAt: string | null;
}

/**
 * A single member of an event group's timeline (`toPublicMember`): the member
 * event id and the moment it was appended to the group.
 */
export interface PublicEventGroupMember {
  eventId: string;
  addedAt: string;
}

export interface ListEventGroupsResponse {
  data: { eventGroups: PublicEventGroup[] };
  meta: { requestId: string; cursor: string | null };
}

export interface GetEventGroupResponse {
  data: { eventGroup: PublicEventGroup; members: PublicEventGroupMember[] };
  meta: { requestId: string };
}
