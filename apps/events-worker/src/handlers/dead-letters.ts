import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type {
  DeadLetterStatus,
  EventsRepository,
  EventStreamsRepository,
  StoredDeadLetter,
} from "@saas/db/events";
import {
  createEventsRepository,
  createEventStreamsRepository,
  createNotificationRulesRepository,
  createEventGroupsRepository,
} from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createTimings } from "@saas/contracts/timing";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse, validationError, withTimings } from "../http.js";
import { parseDeadLetterPageParams, encodeCursor } from "../pagination.js";
import { toPublicScopeId } from "../ids.js";
import type { LaneHandler } from "../lanes/types.js";
import { buildLaneHandlers } from "../lanes/registry.js";
import { emitDeadLetterLifecycle } from "../lanes/dispatcher.js";

const DL_STATUSES = new Set<string>(["open", "replayed", "discarded"]);

export interface DeadLetterHandlerDeps {
  streamsRepo?: EventStreamsRepository;
  eventsRepo?: EventsRepository;
  handlers?: LaneHandler[];
}

interface PublicDeadLetter {
  id: string;
  orgId: string;
  laneKey: string;
  eventId: string;
  reason: string;
  attempts: number;
  status: DeadLetterStatus;
  firstFailedAt: string;
  lastFailedAt: string;
  createdAt: string;
}

function toPublicDeadLetter(dl: StoredDeadLetter): PublicDeadLetter {
  return {
    id: dl.id,
    orgId: toPublicScopeId("org_", dl.orgId) ?? dl.orgId,
    laneKey: dl.laneKey,
    eventId: dl.eventId,
    reason: dl.reason,
    attempts: dl.attempts,
    status: dl.status,
    firstFailedAt: dl.firstFailedAt.toISOString(),
    lastFailedAt: dl.lastFailedAt.toISOString(),
    createdAt: dl.createdAt.toISOString(),
  };
}

function bindingsMissing(env: Env): boolean {
  return !env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER;
}

export async function handleListDeadLetters(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps?: DeadLetterHandlerDeps,
): Promise<Response> {
  if (bindingsMissing(env)) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const url = new URL(request.url);
  const pageResult = parseDeadLetterPageParams(url);
  if (!pageResult.ok) {
    return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
  }
  const statusParam = url.searchParams.get("status");
  if (statusParam !== null && !DL_STATUSES.has(statusParam)) {
    return validationError(requestId, { status: ["Must be one of open, replayed, discarded"] });
  }

  const { limit, cursor } = pageResult.value;

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  const timings = createTimings();
  const endTotal = timings.start("total");
  try {
    const repo = deps?.streamsRepo ?? createEventStreamsRepository(executor);

    // PERF4 discipline (mirrors list-audit): authz context and the read run
    // concurrently; the read is discarded on deny, never returned.
    const [contextResult, result] = await Promise.all([
      timings.measure("authctx", () =>
        fetchAuthorizationContext(env.MEMBERSHIP_WORKER!, actor.subjectId, actor.subjectType, orgId, requestId),
      ),
      timings.measure("db", () =>
        repo.listDeadLettersByOrg(
          orgId,
          { limit, cursor: cursor ? { occurredAt: cursor.occurredAt, id: cursor.id } : null },
          (statusParam as DeadLetterStatus | null) ?? undefined,
        ),
      ),
    ]);

    if (!contextResult.ok) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "dead_letter.read", timings);
    }

    const policyResult = await timings.measure("policy", () =>
      authorizeViaPolicy(
        env.POLICY_WORKER!,
        actor.subjectId,
        actor.subjectType,
        "dead_letter.read",
        { kind: "organization", orgId },
        contextResult.memberships,
        requestId,
      ),
    );
    if (!policyResult.allow) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "dead_letter.read", timings);
    }

    if (!result.ok) {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "dead_letter.read", timings);
    }

    const deadLetters = result.value.items.map(toPublicDeadLetter);
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.occurredAt, result.value.nextCursor.id)
      : null;

    endTotal();
    return withTimings(
      Response.json(
        { data: { deadLetters }, meta: { requestId, cursor: nextCursor } },
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      requestId,
      "dead_letter.read",
      timings,
    );
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "dead_letter.read", timings);
  } finally {
    await executor.dispose();
  }
}

export async function handleReplayDeadLetter(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deadLetterId: string,
  deps?: DeadLetterHandlerDeps,
): Promise<Response> {
  if (bindingsMissing(env)) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB!);
  const timings = createTimings();
  const endTotal = timings.start("total");
  try {
    const streamsRepo = deps?.streamsRepo ?? createEventStreamsRepository(executor);
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor);
    const handlers =
      deps?.handlers ??
      buildLaneHandlers(env, {
        rulesRepo: createNotificationRulesRepository(executor),
        groupsRepo: createEventGroupsRepository(executor),
        eventsRepo,
        requestId,
      });

    // Replay is a mutation with side effects: authorize strictly BEFORE any
    // work (no speculative execution; only the deny path stays leak-free 404).
    const contextResult = await timings.measure("authctx", () =>
      fetchAuthorizationContext(env.MEMBERSHIP_WORKER!, actor.subjectId, actor.subjectType, orgId, requestId),
    );
    if (!contextResult.ok) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "dead_letter.replay", timings);
    }
    const policyResult = await timings.measure("policy", () =>
      authorizeViaPolicy(
        env.POLICY_WORKER!,
        actor.subjectId,
        actor.subjectType,
        "dead_letter.replay",
        { kind: "organization", orgId },
        contextResult.memberships,
        requestId,
      ),
    );
    if (!policyResult.allow) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "dead_letter.replay", timings);
    }

    const dlResult = await timings.measure("db", () => streamsRepo.getDeadLetter(orgId, deadLetterId));
    if (!dlResult.ok) {
      endTotal();
      return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "dead_letter.replay", timings);
    }
    const deadLetter = dlResult.value;
    if (!deadLetter) {
      endTotal();
      return withTimings(errorResponse("not_found", "Not found", 404, requestId), requestId, "dead_letter.replay", timings);
    }
    if (deadLetter.status !== "open") {
      endTotal();
      return withTimings(
        errorResponse("conflict", `Dead letter is ${deadLetter.status}, not open`, 409, requestId),
        requestId,
        "dead_letter.replay",
        timings,
      );
    }

    const handler = handlers.find((h) => h.laneKey === deadLetter.laneKey);
    if (!handler) {
      endTotal();
      return withTimings(
        errorResponse("conflict", `Lane '${deadLetter.laneKey}' is not replayable by events-worker`, 409, requestId),
        requestId,
        "dead_letter.replay",
        timings,
      );
    }

    const eventResult = await eventsRepo.getEventById(orgId, deadLetter.eventId);
    if (!eventResult.ok || !eventResult.value) {
      endTotal();
      return withTimings(
        errorResponse("conflict", "Source event is no longer available", 409, requestId),
        requestId,
        "dead_letter.replay",
        timings,
      );
    }

    try {
      await handler.handleEvent(eventResult.value);
    } catch {
      // Replay failed — the dead letter stays open with another attempt.
      await streamsRepo.recordDeadLetter({
        id: deadLetter.id,
        laneKey: deadLetter.laneKey,
        eventId: deadLetter.eventId,
        orgId,
        reason: "replay_failed",
      });
      endTotal();
      return withTimings(
        errorResponse("bad_gateway", "Replay failed; dead letter remains open", 502, requestId),
        requestId,
        "dead_letter.replay",
        timings,
      );
    }

    const marked = await streamsRepo.markDeadLetter(orgId, deadLetter.id, "replayed");
    await emitDeadLetterLifecycle(eventsRepo, {
      type: "dead_letter.replayed",
      orgId,
      laneKey: deadLetter.laneKey,
      eventId: deadLetter.eventId,
      deadLetterId: deadLetter.id,
      attempts: deadLetter.attempts,
      reason: "",
      requestId,
      description: `Dead letter ${deadLetter.id} replayed on lane '${deadLetter.laneKey}'`,
    });

    endTotal();
    const body =
      marked.ok && marked.value
        ? toPublicDeadLetter(marked.value)
        : { ...toPublicDeadLetter(deadLetter), status: "replayed" as DeadLetterStatus };
    return withTimings(
      Response.json({ data: { deadLetter: body }, meta: { requestId } }, { status: 200 }),
      requestId,
      "dead_letter.replay",
      timings,
    );
  } catch {
    endTotal();
    return withTimings(errorResponse("internal_error", "Service unavailable", 503, requestId), requestId, "dead_letter.replay", timings);
  } finally {
    await executor.dispose();
  }
}
