import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { EventsRepository, StoredEvent } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createTimings } from "@saas/contracts/timing";
import { validateCustomEvent } from "@saas/contracts/events";
import { uuidFromPublicId } from "@saas/db/ids";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { checkBillingEntitlement } from "../billing-client.js";
import { errorResponse, validationError, withTimings } from "../http.js";
import { generateEventId, orgPublicId } from "../ids.js";
import { toPublicEvent } from "./to-public-event.js";

export const FEATURE_CUSTOM_INGEST = "feature.events.custom_ingest";
export const LIMIT_CUSTOM_EVENTS_PER_DAY = "limit.custom_events_per_day";

// Reject an obviously oversized raw body before buffering/parsing. The precise
// 32KiB payload cap is enforced post-parse by validateCustomEvent; this coarse
// 64KiB guard bounds envelope + payload so a hostile body cannot force a large
// allocation.
const MAX_RAW_BODY_BYTES = 64 * 1024;

const ROUTE = "event.ingest";

export interface IngestEventDeps {
  eventsRepo?: EventsRepository;
}

function bindingsMissing(env: Env): boolean {
  return !env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER || !env.BILLING_WORKER;
}

function startOfUtcDayIso(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export async function handleIngestEvent(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps?: IngestEventDeps,
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_RAW_BODY_BYTES) {
    return validationError(requestId, { body: ["Request body exceeds the 64KiB limit"] });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Body must be valid JSON"] });
  }

  const nowMs = Date.now();
  const validated = validateCustomEvent(body, nowMs);
  if (!validated.ok) {
    return validationError(requestId, { [validated.field]: [validated.reason] });
  }
  const normalized = validated.value;

  // Convert the caller's public scope ids to the internal UUIDs the event_log
  // stores. A malformed id is a 400 (the caller supplied it); absent -> null.
  let projectUuid: string | null = null;
  if (normalized.projectId !== null) {
    const parsed = uuidFromPublicId(normalized.projectId, "prj");
    if (!parsed) return validationError(requestId, { projectId: ["Must be a project public id (prj_...)"] });
    projectUuid = parsed;
  }
  let environmentUuid: string | null = null;
  if (normalized.environmentId !== null) {
    const parsed = uuidFromPublicId(normalized.environmentId, "env");
    if (!parsed) return validationError(requestId, { environmentId: ["Must be an environment public id (env_...)"] });
    environmentUuid = parsed;
  }

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  const timings = createTimings();
  const endTotal = timings.start("total");
  try {
    const repo = deps?.eventsRepo ?? createEventsRepository(executor);

    // Authorize: membership context then the ingest policy action. Deny is
    // leak-free (404) — an ingest to an org the actor cannot see is a not-found.
    const contextResult = await timings.measure("authctx", () =>
      fetchAuthorizationContext(env.MEMBERSHIP_WORKER!, actor.subjectId, actor.subjectType, orgId, requestId),
    );
    if (!contextResult.ok) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, ROUTE, timings);
    }
    const policyResult = await timings.measure("policy", () =>
      authorizeViaPolicy(
        env.POLICY_WORKER!,
        actor.subjectId,
        actor.subjectType,
        "organization.event.ingest",
        { kind: "organization", orgId },
        contextResult.memberships,
        requestId,
      ),
    );
    if (!policyResult.allow) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, ROUTE, timings);
    }

    const publicOrgId = orgPublicId(orgId);

    // Entitlement: the custom-ingest feature must be on the plan.
    const feature = await timings.measure("entitlement", () =>
      checkBillingEntitlement(env.BILLING_WORKER!, publicOrgId, FEATURE_CUSTOM_INGEST, requestId),
    );
    if (feature.kind === "service_error") {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, ROUTE, timings);
    }
    if (!feature.decision.allowed) {
      endTotal();
      return withTimings(
        errorResponse(
          "entitlement_required",
          "Custom event ingest is not available on the current plan",
          402,
          requestId,
          { entitlementKey: FEATURE_CUSTOM_INGEST },
        ),
        requestId,
        ROUTE,
        timings,
      );
    }

    // Quota: a numeric per-day limit caps today's custom events.
    const quota = await checkBillingEntitlement(env.BILLING_WORKER!, publicOrgId, LIMIT_CUSTOM_EVENTS_PER_DAY, requestId);
    if (quota.kind === "service_error") {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, ROUTE, timings);
    }
    if (quota.decision.allowed && quota.decision.limitValue !== null && quota.decision.limitValue !== undefined) {
      const limitValue = quota.decision.limitValue;
      const since = startOfUtcDayIso(nowMs);
      const countResult = await timings.measure("quota", () => repo.countCustomEventsSince(orgId, since));
      if (!countResult.ok) {
        endTotal();
        return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, ROUTE, timings);
      }
      if (countResult.value >= limitValue) {
        endTotal();
        return withTimings(
          errorResponse(
            "quota_exceeded",
            "Daily custom event quota reached for the current plan",
            412,
            requestId,
            { entitlementKey: LIMIT_CUSTOM_EVENTS_PER_DAY, limit: limitValue, upgrade: "Upgrade your plan to raise the daily custom event quota" },
          ),
          requestId,
          ROUTE,
          timings,
        );
      }
    }

    // Idempotent replay: a prior event with the same key returns the original,
    // never a duplicate insert.
    if (normalized.idempotencyKey !== null) {
      const existing = await repo.findEventByIdempotencyKey(orgId, normalized.idempotencyKey);
      if (existing.ok && existing.value) {
        endTotal();
        return withTimings(
          Response.json({ data: { event: toPublicEvent(existing.value) }, meta: { requestId } }, { status: 200 }),
          requestId,
          ROUTE,
          timings,
        );
      }
    }

    const eventId = generateEventId();
    const occurredAt = normalized.occurredAt ? new Date(normalized.occurredAt) : new Date(nowMs);

    // Persist the event faithfully. The custom-event severity travels in the
    // payload under the `severity` key — the canonical place the platform reads a
    // claimed severity (effectiveEventSeverity escalates the catalog "info" base
    // from it), so the explorer and routing lanes see the caller's severity.
    // Custom-event grouping via the caller-supplied dedupKey is deferred to ES5b
    // (ES4's grouping lane keys only off catalog dedupKey templates); we thread
    // the caller dedupKey into the stored payload under a reserved key so ES5b
    // can honor it without a re-ingest.
    // The synthetic custom.* catalog entry renders its title from
    // `{payload.title}`, so the normalized title (caller-supplied or the type
    // default) is persisted there for the explorer / channels to render.
    const storedPayload: Record<string, unknown> = {
      ...normalized.payload,
      title: normalized.title,
      severity: normalized.severity,
      ...(normalized.dedupKey !== null ? { dedupKey: normalized.dedupKey } : {}),
    };

    const appended = await timings.measure("db", () =>
      repo.appendEvent({
        id: eventId,
        type: normalized.type,
        version: 1,
        source: "custom-ingest",
        occurredAt,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: projectUuid,
        environmentId: environmentUuid,
        subjectKind: normalized.subject.kind,
        subjectId: normalized.subject.id,
        subjectName: normalized.subject.name,
        requestId,
        correlationId: normalized.correlationId,
        causationId: normalized.causationId,
        idempotencyKey: normalized.idempotencyKey,
        payload: storedPayload,
      }),
    );
    if (!appended.ok) {
      endTotal();
      // A conflict here means a concurrent identical id (astronomically rare) or
      // duplicate idempotency key that lost the race — surface as unavailable so
      // the caller retries; the replay lookup above handles the common case.
      const status = appended.error.kind === "conflict" ? 409 : 503;
      const code = status === 409 ? "conflict" : "internal_error";
      return withTimings(errorResponse(code, status === 409 ? "Duplicate event" : "Service unavailable", status, requestId), requestId, ROUTE, timings);
    }

    const stored: StoredEvent = appended.value;
    endTotal();
    return withTimings(
      Response.json({ data: { event: toPublicEvent(stored) }, meta: { requestId } }, { status: 201 }),
      requestId,
      ROUTE,
      timings,
    );
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, ROUTE, timings);
  } finally {
    await executor.dispose();
  }
}
