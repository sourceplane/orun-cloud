import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type {
  EventGroupsRepository,
  EventGroupStatus,
  StoredEventGroup,
  StoredEventGroupMember,
} from "@saas/db/events";
import { createEventGroupsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createTimings } from "@saas/contracts/timing";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, validationError, withTimings } from "../http.js";
import { parseDeadLetterPageParams, encodeCursor } from "../pagination.js";
import { toPublicScopeId } from "../ids.js";

// Event-groups read API (saas-event-streaming ES4): the dedup/correlation
// stories, read-only. Same viewer+ policy as the events read (organization
// .event.read), same PERF4 no-leak discipline as dead letters / audit.

const GROUP_STATUSES = new Set<string>(["open", "closed"]);
const GROUP_ID_RE = /^grp_[0-9a-f]{32}$/;

export interface EventGroupsHandlerDeps {
  groupsRepo?: EventGroupsRepository;
}

interface PublicEventGroup {
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

function toPublicGroup(g: StoredEventGroup): PublicEventGroup {
  return {
    id: g.id,
    orgId: toPublicScopeId("org_", g.orgId) ?? g.orgId,
    groupKey: g.groupKey,
    status: g.status,
    eventCount: g.eventCount,
    maxSeverity: g.maxSeverity,
    firstAt: g.firstAt.toISOString(),
    lastAt: g.lastAt.toISOString(),
    closedAt: g.closedAt ? g.closedAt.toISOString() : null,
  };
}

function toPublicMember(m: StoredEventGroupMember): { eventId: string; addedAt: string } {
  return { eventId: m.eventId, addedAt: m.addedAt.toISOString() };
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

export async function handleListEventGroups(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps?: EventGroupsHandlerDeps,
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);

  const url = new URL(request.url);
  const pageResult = parseDeadLetterPageParams(url); // same (created/last, id) cursor shape
  if (!pageResult.ok) {
    return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
  }
  const statusParam = url.searchParams.get("status");
  if (statusParam !== null && !GROUP_STATUSES.has(statusParam)) {
    return validationError(requestId, { status: ["Must be one of open, closed"] });
  }
  const { limit, cursor } = pageResult.value;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  const timings = createTimings();
  const endTotal = timings.start("total");
  try {
    const repo = deps?.groupsRepo ?? createEventGroupsRepository(executor);
    const [allowed, result] = await Promise.all([
      authorizeRead(env, actor, orgId, requestId, timings),
      timings.measure("db", () =>
        repo.listGroupsByOrg(
          orgId,
          { limit, cursor: cursor ? { occurredAt: cursor.occurredAt, id: cursor.id } : null },
          (statusParam as EventGroupStatus | null) ?? undefined,
        ),
      ),
    ]);
    if (!allowed) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "event_group.read", timings);
    }
    if (!result.ok) {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "event_group.read", timings);
    }
    const groups = result.value.items.map(toPublicGroup);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.occurredAt, result.value.nextCursor.id)
      : null;
    endTotal();
    return withTimings(
      Response.json({ data: { eventGroups: groups }, meta: { requestId, cursor: nextCursor } }, { status: 200 }),
      requestId,
      "event_group.read",
      timings,
    );
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "event_group.read", timings);
  } finally {
    await executor.dispose();
  }
}

export async function handleGetEventGroup(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  groupId: string,
  deps?: EventGroupsHandlerDeps,
): Promise<Response> {
  if (bindingsMissing(env)) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!GROUP_ID_RE.test(groupId)) return errorResponse("not_found", "Not found", 404, requestId);

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  const timings = createTimings();
  const endTotal = timings.start("total");
  try {
    const repo = deps?.groupsRepo ?? createEventGroupsRepository(executor);
    const [allowed, groupResult] = await Promise.all([
      authorizeRead(env, actor, orgId, requestId, timings),
      timings.measure("db", () => repo.getGroup(orgId, groupId)),
    ]);
    if (!allowed) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "event_group.read", timings);
    }
    if (!groupResult.ok) {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "event_group.read", timings);
    }
    if (!groupResult.value) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "event_group.read", timings);
    }
    const members = await repo.listMembers(groupId);
    endTotal();
    return withTimings(
      Response.json(
        {
          data: {
            eventGroup: toPublicGroup(groupResult.value),
            members: members.ok ? members.value.map(toPublicMember) : [],
          },
          meta: { requestId },
        },
        { status: 200 },
      ),
      requestId,
      "event_group.read",
      timings,
    );
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "event_group.read", timings);
  } finally {
    await executor.dispose();
  }
}

export { GROUP_ID_RE };
