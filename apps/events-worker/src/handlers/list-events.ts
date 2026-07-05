import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { EventLogFilters, EventsRepository } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createTimings } from "@saas/contracts/timing";
import { uuidFromPublicId } from "@saas/db/ids";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, validationError, withTimings } from "../http.js";
import { parsePageParams, encodeCursor } from "../pagination.js";
import { EVENT_ID_RE } from "../ids.js";
import { toPublicEvent } from "./to-public-event.js";

// Events explorer read API (saas-event-streaming ES5): the raw event_log,
// org-scoped, read-only. Same viewer+ policy (organization.event.read) and PERF4
// no-leak discipline as list-audit / event-groups.

const ROUTE = "event.read";

// Glob-safe type filter (exact type or a trailing-`*` prefix). Deliberately
// small charset so it can be handed to the repo's LIKE builder safely.
const TYPE_FILTER_RE = /^[a-z0-9_.*-]{1,128}$/;
const SOURCE_FILTER_RE = /^[a-z0-9_.-]{1,64}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

export interface ListEventsDeps {
  eventsRepo?: EventsRepository;
}

function bindingsMissing(env: Env): boolean {
  return !env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER;
}

async function authorizeRead(
  env: Env,
  actor: ActorContext,
  orgId: string,
  requestId: string,
  timings: ReturnType<typeof createTimings>,
): Promise<boolean> {
  const ctx = await timings.measure("authctx", () =>
    fetchAuthorizationContext(env.MEMBERSHIP_WORKER!, actor.subjectId, actor.subjectType, orgId, requestId),
  );
  if (!ctx.ok) return false;
  const decision = await timings.measure("policy", () =>
    authorizeViaPolicy(
      env.POLICY_WORKER!,
      actor.subjectId,
      actor.subjectType,
      "organization.event.read",
      { kind: "organization", orgId },
      ctx.memberships,
      requestId,
    ),
  );
  return decision.allow;
}

type FiltersResult = { ok: true; value: EventLogFilters } | { ok: false; field: string; reason: string };

function parseEventFilters(url: URL): FiltersResult {
  const value: EventLogFilters = {};

  const type = url.searchParams.get("type");
  if (type !== null && type !== "") {
    if (!TYPE_FILTER_RE.test(type)) {
      return { ok: false, field: "type", reason: "Must be an event type or a trailing-* prefix glob" };
    }
    value.type = type;
  }

  const source = url.searchParams.get("source");
  if (source !== null && source !== "") {
    if (!SOURCE_FILTER_RE.test(source)) {
      return { ok: false, field: "source", reason: "Must be lowercase letters, digits, dot, underscore, or hyphen (max 64)" };
    }
    value.source = source;
  }

  const project = url.searchParams.get("project");
  if (project !== null && project !== "") {
    const uuid = uuidFromPublicId(project, "prj");
    if (!uuid) return { ok: false, field: "project", reason: "Must be a project public id (prj_...)" };
    value.projectId = uuid;
  }

  const environment = url.searchParams.get("environment");
  if (environment !== null && environment !== "") {
    const uuid = uuidFromPublicId(environment, "env");
    if (!uuid) return { ok: false, field: "environment", reason: "Must be an environment public id (env_...)" };
    value.environmentId = uuid;
  }

  for (const param of ["from", "to"] as const) {
    const raw = url.searchParams.get(param);
    if (raw === null || raw === "") continue;
    if (!ISO_TS_RE.test(raw)) {
      return { ok: false, field: param, reason: "Must be an ISO-8601 timestamp with milliseconds (e.g. 2026-01-01T00:00:00.000Z)" };
    }
    value[param] = raw;
  }

  return { ok: true, value };
}

export async function handleListEvents(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps?: ListEventsDeps,
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  const url = new URL(request.url);
  const pageResult = parsePageParams(url);
  if (!pageResult.ok) {
    return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
  }
  const filtersResult = parseEventFilters(url);
  if (!filtersResult.ok) {
    return validationError(requestId, { [filtersResult.field]: [filtersResult.reason] });
  }
  const { limit, cursor } = pageResult.value;
  const dbCursor = cursor ? { occurredAt: cursor.occurredAt, id: cursor.id } : null;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  const timings = createTimings();
  const endTotal = timings.start("total");
  try {
    const repo = deps?.eventsRepo ?? createEventsRepository(executor);

    // PERF4: the authz-context fetch and the read are independent — run
    // concurrently, then discard the read on policy deny.
    const [allowed, result] = await Promise.all([
      authorizeRead(env, actor, orgId, requestId, timings),
      timings.measure("db", () => repo.queryEventLogByOrg(orgId, { limit, cursor: dbCursor }, filtersResult.value)),
    ]);
    if (!allowed) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, ROUTE, timings);
    }
    if (!result.ok) {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, ROUTE, timings);
    }

    const events = result.value.items.map(toPublicEvent);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.occurredAt, result.value.nextCursor.id)
      : null;
    endTotal();
    return withTimings(
      Response.json({ data: { events }, meta: { requestId, cursor: nextCursor } }, { status: 200 }),
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

export async function handleGetEvent(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  eventId: string,
  deps?: ListEventsDeps,
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!EVENT_ID_RE.test(eventId)) return errorResponse("not_found", "Not found", 404, requestId);

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  const timings = createTimings();
  const endTotal = timings.start("total");
  try {
    const repo = deps?.eventsRepo ?? createEventsRepository(executor);
    const [allowed, result] = await Promise.all([
      authorizeRead(env, actor, orgId, requestId, timings),
      timings.measure("db", () => repo.getEventById(orgId, eventId)),
    ]);
    if (!allowed) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, ROUTE, timings);
    }
    if (!result.ok) {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, ROUTE, timings);
    }
    if (!result.value) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, ROUTE, timings);
    }
    endTotal();
    return withTimings(
      Response.json({ data: { event: toPublicEvent(result.value) }, meta: { requestId } }, { status: 200 }),
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
