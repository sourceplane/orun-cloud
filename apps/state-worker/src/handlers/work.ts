// Work-plane handlers (orun-work v2 WP1) — the fold query API + the
// coordination mutator surface.
//
// Design rules enforced here (specs/epics/orun-work/):
//   * Lifecycle is NEVER stored or accepted: reads run the fold on every
//     request and return rungs WITH their evidence; there is no set-status
//     route to handle (WP-3).
//   * One mutator surface (WP-6): every write goes through the
//     @saas/db/work repository, which appends exactly one coordination
//     event per mutation. Actor provenance maps from the platform actor
//     (user → user, service principal → agent, workflow → automation);
//     agent guardrails (no pins) are enforced by the model, not the client.
//   * Import applies the CLI's dry-run plan idempotently and imports NO
//     lifecycle — rungs derive from observations after apply.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type {
  CreateWorkInitiativeRequest,
  CreateWorkInitiativeResponse,
  CreateWorkSpecRequest,
  CreateWorkSpecResponse,
  CreateWorkTaskRequest,
  CreateWorkTaskResponse,
  EditWorkItemRequest,
  GetWorkDocResponse,
  ListWorkEventsResponse,
  PutWorkDocRequest,
  PutWorkDocResponse,
  SaveWorkViewRequest,
  WorkDocHistoryResponse,
  WorkDocRevisionView,
  WorkEstimateRequest,
  WorkLabelRequest,
  WorkOrderRequest,
  WorkPriorityRequest,
  WorkRelateRequest,
  WorkTimelineEntry,
  WorkTimelineResponse,
  WorkActor,
  WorkAssignRequest,
  WorkCommentRequest,
  WorkContractRequest,
  WorkEventView,
  WorkImportRequest,
  WorkInitiativeView,
  WorkImportResponse,
  WorkMutationResponse,
  WorkPinRequest,
  WorkSpecView,
  WorkSummaryResponse,
  WorkTaskView,
  WorkViewConfig,
  WorkViewsResponse,
  WorkViewView,
} from "@saas/contracts/work";
import { WORK_POLICY_ACTIONS } from "@saas/contracts/work";
import {
  WorkError,
  buildEnvelopes,
  extractMentions,
  insertWorkObservation,
  taskKeysIn,
  contractComplete,
  createWorkRepository,
  fold,
  progress,
  type Contract,
  type CoordinationEvent,
  type FoldResult,
  type Priority,
  type RelationKind,
  type Rung,
  type Task,
  type WorkRepository,
  type WorkSet,
  type WorkspaceScope,
} from "@saas/db/work";
import { createSqlExecutor, type SqlExecutor, type TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { errorResponse, successResponse, validationError } from "../http.js";
import { authorizeOrg } from "../authz.js";

export interface WorkHandlerDeps {
  repo?: WorkRepository;
  executor?: SqlExecutor;
  /** PM1: mention fan-out seam — publishes work.task.mentioned onto the
   *  platform event_log (ES2 rules deliver). Injectable for tests; the
   *  default writes through the events repository. Best-effort: a publish
   *  failure never fails the comment. */
  publishMention?: (m: { orgId: string; taskKey: string; handle: string; by: WorkActor; requestId: string }) => Promise<void>;
}

async function defaultPublishMention(
  env: Env,
  executor: SqlExecutor,
  m: { orgId: string; taskKey: string; handle: string; by: WorkActor; requestId: string },
): Promise<void> {
  const { createEventsRepository } = await import("@saas/db/events");
  const events = createEventsRepository(executor);
  await events.appendEvent({
    id: crypto.randomUUID(),
    type: "work.task.mentioned",
    version: 1,
    source: "state-worker",
    occurredAt: new Date(),
    actorType: m.by.type === "user" ? "user" : "service_principal",
    actorId: m.by.id,
    orgId: m.orgId,
    subjectKind: "work_task",
    subjectId: m.taskKey,
    subjectName: m.taskKey,
    requestId: m.requestId,
    payload: { taskKey: m.taskKey, handle: m.handle, title: `@${m.handle} mentioned on ${m.taskKey}`, severity: "info" },
  });
}

async function dispose(executor: SqlExecutor | undefined): Promise<void> {
  if (executor && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

function repoOf(env: Env, deps?: WorkHandlerDeps): { repo: WorkRepository; owned: SqlExecutor | undefined } {
  if (deps?.repo) return { repo: deps.repo, owned: undefined };
  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  return { repo: createWorkRepository(executor as TransactionalSqlExecutor), owned: deps?.executor ? undefined : executor };
}

/** Maps the platform actor onto work-plane provenance (WP-8: membership
 *  subjects are the principals; there is no work-local identity). */
export function workActorOf(actor: ActorContext): WorkActor {
  switch (actor.subjectType) {
    case "service_principal":
      return { type: "agent", id: actor.subjectId, via: "api" };
    case "workflow":
      return { type: "automation", id: actor.subjectId, via: "api" };
    default:
      return { type: "user", id: actor.subjectId, via: "api" };
  }
}

function workErrorResponse(err: WorkError, requestId: string): Response {
  switch (err.code) {
    case "not_found":
      return errorResponse("not_found", "Not found", 404, requestId);
    case "conflict":
      return errorResponse("conflict", err.message, 409, requestId);
    default:
      // missing_actor / agent_pin / unknown_kind / invalid / bad_observation:
      // a structured verdict the caller (console, CLI, MCP) can reason about.
      return errorResponse("verdict_rejected", err.message, 422, requestId);
  }
}

function taskView(t: Task, foldResult: FoldResult): WorkTaskView {
  const lc = foldResult.lifecycles[t.key];
  return {
    key: t.key,
    spec: t.spec,
    title: t.title,
    labels: t.labels,
    contract: t.contract,
    createdBy: t.createdBy,
    createdAt: t.createdAt,
    tags: t.tags,
    priority: t.priority,
    estimate: t.estimate,
    relations: t.relations,
    lifecycle: {
      rung: lc?.rung ?? (contractComplete(t.contract) ? "ready" : "draft"),
      ready: lc?.ready ?? contractComplete(t.contract),
      blocked: lc?.blocked ?? false,
      evidence: lc?.evidence,
      pinned: lc?.pinned,
    },
  };
}

function summarize(orgId: string, ws: WorkSet): WorkSummaryResponse {
  const foldResult = fold(ws);
  const { specs, initiatives } = buildEnvelopes(orgId, ws.events);
  const specViews: WorkSpecView[] = specs.map((s) => ({
    key: s.key,
    title: s.title,
    docRef: s.docRef,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    progress: progress(ws, s.key, foldResult),
  }));
  const initiativeViews: WorkInitiativeView[] = initiatives.map((i) => ({
    key: i.key,
    title: i.title,
    description: i.description,
    createdBy: i.createdBy,
    createdAt: i.createdAt,
  }));
  return {
    specs: specViews,
    tasks: ws.tasks.map((t) => taskView(t, foldResult)),
    initiatives: initiativeViews,
    drift: foldResult.drift ?? [],
    suggestions: foldResult.suggestions ?? [],
    coordSeq: ws.events.length ? ws.events[ws.events.length - 1]!.seq : 0,
    obsSeq: ws.observations.length ? ws.observations[ws.observations.length - 1]!.seq : 0,
  };
}

async function taskViewOf(repo: WorkRepository, scope: WorkspaceScope, key: string): Promise<WorkTaskView | null> {
  const ws = await repo.getWorkSet(scope);
  const t = ws.tasks.find((x) => x.key === key);
  if (!t) return null;
  return taskView(t, fold(ws));
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function handleWorkSummary(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_READ);
  if (!authz.ok) return authz.response;
  const { repo, owned } = repoOf(env, deps);
  try {
    const ws = await repo.getWorkSet({ orgId });
    return successResponse(summarize(orgId, ws), requestId);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

export async function handleListWorkEvents(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_READ);
  if (!authz.ok) return authz.response;
  const from = Number(new URL(request.url).searchParams.get("from") ?? "0");
  const { repo, owned } = repoOf(env, deps);
  try {
    const events = await repo.listEvents({ orgId }, Number.isFinite(from) && from > 0 ? from : 0);
    const views: WorkEventView[] = events.map((e: CoordinationEvent) => eventView(e));
    const payload: ListWorkEventsResponse = {
      events: views,
      seq: views.length ? views[views.length - 1]!.seq : from > 0 ? from : 0,
    };
    return successResponse(payload, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

// ── SSE (WP1b follow-up): push the coordination log over the same cursor ────
//
// The seam the console poll established is transport-agnostic: this endpoint
// serves the SAME events, from the SAME `from` cursor, as `GET …/work/events`
// — just framed as text/event-stream so a new event reaches open tabs in
// ~pollMs instead of the client's poll interval. The stream is deliberately
// BOUNDED (maxMs) — Workers-friendly — and every frame carries `id: <seq>`,
// so a reconnecting client resumes exactly where it left off (Last-Event-ID
// or ?from=). Mutations and verdicts are untouched: this is read-only fan-out
// of the log, never a second write path.

export interface WorkStreamConfig {
  /** DB re-check interval while the stream is open. */
  pollMs?: number;
  /** Wall-clock bound; the client reconnects with its cursor after close. */
  maxMs?: number;
}

const STREAM_DEFAULTS: Required<WorkStreamConfig> = { pollMs: 2_500, maxMs: 55_000 };

function sseFrame(view: WorkEventView): string {
  return `id: ${view.seq}\nevent: work\ndata: ${JSON.stringify(view)}\n\n`;
}

function eventView(e: CoordinationEvent): WorkEventView {
  return {
    eventId: e.eventId ?? "",
    subject: e.subject,
    kind: e.kind,
    actor: e.actor,
    at: e.at,
    payload: e.payload,
    seq: e.seq,
  };
}

export async function handleStreamWorkEvents(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: WorkHandlerDeps & { stream?: WorkStreamConfig },
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_READ);
  if (!authz.ok) return authz.response;

  const fromParam = Number(new URL(request.url).searchParams.get("from") ?? "0");
  const lastEventId = Number(request.headers.get("last-event-id") ?? "0");
  let cursor = Math.max(
    Number.isFinite(fromParam) && fromParam > 0 ? fromParam : 0,
    Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0,
  );

  const cfg = { ...STREAM_DEFAULTS, ...(deps?.stream ?? {}) };
  const { repo, owned } = repoOf(env, deps);
  const encoder = new TextEncoder();
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => controller.enqueue(encoder.encode(s));
      const run = async () => {
        const startedAt = Date.now();
        try {
          write("retry: 3000\n\n");
          for (;;) {
            const events = await repo.listEvents({ orgId }, cursor);
            for (const e of events) {
              write(sseFrame(eventView(e)));
              cursor = Math.max(cursor, e.seq);
            }
            if (events.length === 0) write(": ka\n\n"); // keep intermediaries from idling us out
            if (cancelled || Date.now() - startedAt + cfg.pollMs > cfg.maxMs) break;
            await new Promise((r) => setTimeout(r, cfg.pollMs));
            if (cancelled) break;
          }
        } catch {
          // Transient failure mid-stream: close; the client reconnects from
          // its cursor and misses nothing (the log is the source of truth).
        } finally {
          await dispose(owned);
          try {
            controller.close();
          } catch {
            // already closed/cancelled
          }
        }
      };
      void run();
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-request-id": requestId,
    },
  });
}

// ── Mutations (verdicts ride the error envelope) ────────────────────────────

async function parseBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export async function handleCreateWorkSpec(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_WRITE);
  if (!authz.ok) return authz.response;
  const body = await parseBody<CreateWorkSpecRequest>(request);
  if (!body?.slug || !body.title) {
    return validationError(requestId, { slug: ["required"], title: ["required"] });
  }
  const { repo, owned } = repoOf(env, deps);
  try {
    const out = await repo.createSpec(
      { orgId },
      { slug: body.slug, title: body.title, docRef: body.docRef, labels: body.labels, actor: workActorOf(actor) },
    );
    const ws = await repo.getWorkSet({ orgId });
    const payload: CreateWorkSpecResponse = {
      key: out.key,
      seq: out.event.seq,
      spec: {
        key: out.spec.key,
        title: out.spec.title,
        docRef: out.spec.docRef,
        createdBy: out.spec.createdBy,
        createdAt: out.spec.createdAt,
        progress: progress(ws, out.spec.key, fold(ws)),
      },
    };
    return successResponse(payload, requestId, 201);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

export async function handleCreateWorkInitiative(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_WRITE);
  if (!authz.ok) return authz.response;
  const body = await parseBody<CreateWorkInitiativeRequest>(request);
  if (!body?.slug || !body.title) {
    return validationError(requestId, { slug: ["required"], title: ["required"] });
  }
  const { repo, owned } = repoOf(env, deps);
  try {
    const out = await repo.createInitiative(
      { orgId },
      { slug: body.slug, title: body.title, description: body.description, actor: workActorOf(actor) },
    );
    const payload: CreateWorkInitiativeResponse = {
      key: out.key,
      seq: out.event.seq,
      initiative: {
        key: out.initiative.key,
        title: out.initiative.title,
        description: out.initiative.description,
        createdBy: out.initiative.createdBy,
        createdAt: out.initiative.createdAt,
      },
    };
    return successResponse(payload, requestId, 201);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

export async function handleEditWorkItem(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  key: string,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_WRITE);
  if (!authz.ok) return authz.response;
  const body = await parseBody<EditWorkItemRequest>(request);
  if (!body || (body.title === undefined && body.description === undefined && body.labels === undefined)) {
    return validationError(requestId, { title: ["at least one field required"] });
  }
  const { repo, owned } = repoOf(env, deps);
  try {
    const out = await repo.editItem(
      { orgId },
      { key, title: body.title, labels: body.labels, actor: workActorOf(actor) },
    );
    const payload: WorkMutationResponse = { key: out.key, seq: out.event.seq };
    return successResponse(payload, requestId);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

// ── Cloud documents (orun-work-v3 PM0): content-addressed, fork-visible ─────
//
// The digest form equals the imported doc_ref (V3-2), so `orun spec pull`
// seals a cloud-authored document through the unchanged summary path. An
// identical save is a no-op (created:false, no event) — saving what already
// exists is not coordination.

export async function handlePutWorkDoc(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  specKey: string,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_WRITE);
  if (!authz.ok) return authz.response;
  const body = await parseBody<PutWorkDocRequest>(request);
  if (!body || typeof body.body !== "string" || body.body.length === 0) {
    return validationError(requestId, { body: ["required"] });
  }
  const { repo, owned } = repoOf(env, deps);
  try {
    const out = await repo.putDocRevision(
      { orgId },
      { specKey, body: body.body, parent: body.parent, actor: workActorOf(actor) },
    );
    const payload: PutWorkDocResponse = {
      revision: out.revision,
      parent: out.parent,
      created: out.created,
      seq: out.event?.seq ?? null,
    };
    return successResponse(payload, requestId, out.created ? 201 : 200);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

export async function handleGetWorkDoc(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  specKey: string,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_READ);
  if (!authz.ok) return authz.response;
  const revision = new URL(request.url).searchParams.get("rev") ?? undefined;
  const { repo, owned } = repoOf(env, deps);
  try {
    const rev = await repo.getDocRevision({ orgId }, specKey, revision);
    const payload: GetWorkDocResponse = {
      revision: rev.revision,
      parent: rev.parent,
      specKey: rev.specKey,
      createdBy: rev.createdBy,
      createdAt: rev.createdAt,
      body: rev.body,
    };
    return successResponse(payload, requestId);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

export async function handleWorkDocHistory(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  specKey: string,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_READ);
  if (!authz.ok) return authz.response;
  const { repo, owned } = repoOf(env, deps);
  try {
    const revisions = await repo.listDocHistory({ orgId }, specKey);
    const payload: WorkDocHistoryResponse = {
      revisions: revisions.map(
        (r): WorkDocRevisionView => ({
          revision: r.revision,
          parent: r.parent,
          specKey: r.specKey,
          createdBy: r.createdBy,
          createdAt: r.createdAt,
        }),
      ),
    };
    return successResponse(payload, requestId);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

export async function handleCreateWorkTask(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_WRITE);
  if (!authz.ok) return authz.response;
  const body = await parseBody<CreateWorkTaskRequest>(request);
  if (!body?.prefix || !body.title) {
    return validationError(requestId, { prefix: ["required"], title: ["required"] });
  }
  const { repo, owned } = repoOf(env, deps);
  try {
    const out = await repo.createTask(
      { orgId },
      {
        prefix: body.prefix,
        title: body.title,
        specKey: body.specKey,
        contract: body.contract as Contract | undefined,
        labels: body.labels,
        actor: workActorOf(actor),
      },
    );
    const view = await taskViewOf(repo, { orgId }, out.key);
    const payload: CreateWorkTaskResponse = {
      key: out.key,
      seq: out.event.seq,
      task: view ?? taskView(out.task, { lifecycles: {} }),
    };
    return successResponse(payload, requestId, 201);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

type TaskAction =
  | "comment"
  | "assign"
  | "pin"
  | "cancel"
  | "contract"
  // v3 PM2 board intent — pure intent verbs; none of them can move a rung:
  | "label"
  | "priority"
  | "estimate"
  | "relate"
  | "order";

// ── PM1: reactions + the timeline ────────────────────────────────────────────

export async function handleWorkReaction(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  targetEvent: string,
  mode: "add" | "remove",
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_WRITE);
  if (!authz.ok) return authz.response;
  const body = await parseBody<{ emoji?: string }>(request);
  if (!body?.emoji) return validationError(requestId, { emoji: ["required"] });
  const { repo, owned } = repoOf(env, deps);
  try {
    const input = { targetEvent, emoji: body.emoji, actor: workActorOf(actor) };
    const out = mode === "add" ? await repo.addReaction({ orgId }, input) : await repo.removeReaction({ orgId }, input);
    const payload: WorkMutationResponse = { key: out.key, seq: out.event.seq };
    return successResponse(payload, requestId);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

/** The unified timeline (PM1): both logs interleaved by time for one item —
 *  GitHub's issue thread on native data, zero new storage. Coordination
 *  events match by subject; observations match when their payload claims the
 *  key (taskKeys, or a branch/pr string carrying it). */
export async function handleWorkTimeline(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  key: string,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_READ);
  if (!authz.ok) return authz.response;
  const { repo, owned } = repoOf(env, deps);
  try {
    const ws = await repo.getWorkSet({ orgId });
    const observationMatches = (payload: Record<string, unknown> | undefined): boolean => {
      if (!payload) return false;
      const keys = payload.taskKeys;
      if (Array.isArray(keys) && keys.includes(key)) return true;
      for (const field of ["branch", "pr", "title"]) {
        const v = payload[field];
        if (typeof v === "string" && taskKeysIn(v).includes(key)) return true;
      }
      return false;
    };
    const entries: WorkTimelineEntry[] = [
      ...ws.events
        .filter((e) => e.subject === key)
        .map((e): WorkTimelineEntry => ({ at: e.at, type: "event", event: eventView(e) })),
      ...ws.observations
        .filter((o) => observationMatches(o.payload))
        .map(
          (o): WorkTimelineEntry => ({
            at: o.at,
            type: "observation",
            observation: {
              obsId: o.obsId ?? "",
              source: o.source,
              kind: o.kind,
              at: o.at,
              payload: o.payload,
              seq: o.seq,
            },
          }),
        ),
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const payload: WorkTimelineResponse = { key, entries };
    return successResponse(payload, requestId);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

export async function handleWorkTaskAction(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  key: string,
  action: TaskAction,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_WRITE);
  if (!authz.ok) return authz.response;
  const workActor = workActorOf(actor);
  const scope: WorkspaceScope = { orgId };
  const { repo, owned } = repoOf(env, deps);
  try {
    let out;
    switch (action) {
      case "comment": {
        const body = await parseBody<WorkCommentRequest>(request);
        if (!body?.body) return validationError(requestId, { body: ["required"] });
        out = await repo.comment(scope, {
          key,
          body: body.body,
          parentEvent: body.parentEvent,
          anchor: body.anchor,
          actor: workActor,
        });
        // PM1: mentions parse at write time; delivery rides ES2 rules. A
        // publish failure never fails the comment (best-effort fan-out).
        const publish =
          deps?.publishMention ??
          ((m: { orgId: string; taskKey: string; handle: string; by: WorkActor; requestId: string }) =>
            defaultPublishMention(env, owned ?? createSqlExecutor(env.PLATFORM_DB!), m));
        for (const handle of extractMentions(body.body)) {
          try {
            await publish({ orgId, taskKey: key, handle, by: workActor, requestId });
          } catch {
            // best-effort — the comment already committed
          }
        }
        break;
      }
      case "assign": {
        const body = await parseBody<WorkAssignRequest>(request);
        if (!body?.subject) return validationError(requestId, { subject: ["required"] });
        out = body.unassign
          ? await repo.unassign(scope, { key, subject: body.subject, actor: workActor })
          : await repo.assign(scope, { key, subject: body.subject, actor: workActor });
        break;
      }
      case "pin": {
        const body = await parseBody<WorkPinRequest>(request);
        if (body === null || body.rung === undefined) {
          return validationError(requestId, { rung: ["required (null to unpin)"] });
        }
        out = await repo.pin(scope, { key, rung: body.rung as Rung | null, note: body.note, actor: workActor });
        break;
      }
      case "cancel": {
        out = await repo.cancel(scope, { key, actor: workActor });
        break;
      }
      case "contract": {
        const body = await parseBody<WorkContractRequest>(request);
        if (!body?.contract) return validationError(requestId, { contract: ["required"] });
        out = await repo.editContract(scope, { key, contract: body.contract as Contract, actor: workActor });
        break;
      }
      case "label": {
        const body = await parseBody<WorkLabelRequest>(request);
        if (!body?.label) return validationError(requestId, { label: ["required"] });
        const input = { key, label: body.label, actor: workActor };
        out = body.remove ? await repo.unlabel(scope, input) : await repo.label(scope, input);
        break;
      }
      case "priority": {
        const body = await parseBody<WorkPriorityRequest>(request);
        if (!body?.priority) return validationError(requestId, { priority: ["required (none clears)"] });
        out = await repo.prioritize(scope, { key, priority: body.priority as Priority, actor: workActor });
        break;
      }
      case "estimate": {
        const body = await parseBody<WorkEstimateRequest>(request);
        if (body === null || body.points === undefined) {
          return validationError(requestId, { points: ["required (null clears)"] });
        }
        out = await repo.estimate(scope, { key, points: body.points, actor: workActor });
        break;
      }
      case "relate": {
        const body = await parseBody<WorkRelateRequest>(request);
        if (!body?.rel || !body.target) {
          return validationError(requestId, { rel: ["required"], target: ["required"] });
        }
        const input = { key, rel: body.rel as RelationKind, target: body.target, actor: workActor };
        out = body.remove ? await repo.unrelate(scope, input) : await repo.relate(scope, input);
        break;
      }
      case "order": {
        const body = await parseBody<WorkOrderRequest>(request);
        if (!body?.view || typeof body.order !== "number" || !Number.isFinite(body.order)) {
          return validationError(requestId, { view: ["required"], order: ["required number"] });
        }
        out = await repo.order(scope, { key, view: body.view, order: body.order, actor: workActor });
        break;
      }
    }
    const payload: WorkMutationResponse = { key: out.key, seq: out.event.seq };
    return successResponse(payload, requestId);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

// ── Saved views (v3 PM2): shareable UI intent beside the logs ────────────────
//
// Views are workspace configuration, not item coordination — they append NO
// event (the closed vocabulary has no view kind) and carry no lifecycle.

function viewView(v: { key: string; name: string; config: Record<string, unknown>; createdBy: WorkActor; createdAt: string }): WorkViewView {
  return { key: v.key, name: v.name, config: v.config as unknown as WorkViewConfig, createdBy: v.createdBy, createdAt: v.createdAt };
}

export async function handleSaveWorkView(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_WRITE);
  if (!authz.ok) return authz.response;
  const body = await parseBody<SaveWorkViewRequest>(request);
  if (!body?.key || !body.name || !body.config || (body.config.layout !== "board" && body.config.layout !== "list")) {
    return validationError(requestId, { key: ["required"], name: ["required"], config: ["required with layout board|list"] });
  }
  const { repo, owned } = repoOf(env, deps);
  try {
    const view = await repo.saveView(
      { orgId },
      { key: body.key, name: body.name, config: body.config as unknown as Record<string, unknown>, actor: workActorOf(actor) },
    );
    return successResponse(viewView(view), requestId, 201);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

export async function handleListWorkViews(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_READ);
  if (!authz.ok) return authz.response;
  const { repo, owned } = repoOf(env, deps);
  try {
    const views = await repo.listViews({ orgId });
    const payload: WorkViewsResponse = { views: views.map(viewView) };
    return successResponse(payload, requestId);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

// ── CI observation producer (the affected-set feed) ─────────────────────────

const CI_OBSERVATION_KINDS = new Set(["branch_seen", "pr_opened", "pr_merged", "pr_closed"]);

export async function handleIngestWorkObservation(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_WRITE);
  if (!authz.ok) return authz.response;
  const body = await parseBody<{
    source?: string;
    sourceVersion?: number;
    kind?: string;
    at?: string;
    dedupeKey?: string;
    payload?: Record<string, unknown>;
  }>(request);
  // The public API admits exactly one named producer: "ci" (the orun-side
  // affected-set feed). Internal ingesters (github-webhook, run-stream,
  // deploy-overlay) never come through this route.
  if (!body || body.source !== "ci" || !body.kind || !CI_OBSERVATION_KINDS.has(body.kind)) {
    return validationError(requestId, { source: ["must be \"ci\""], kind: ["branch_seen|pr_opened|pr_merged|pr_closed"] });
  }
  if (!body.dedupeKey) {
    return validationError(requestId, { dedupeKey: ["required (invariant 4)"] });
  }
  const { repo, owned } = repoOf(env, deps);
  try {
    const out = await repo.ingestObservation(
      { orgId },
      {
        workspace: orgId,
        source: "ci",
        sourceVersion: body.sourceVersion ?? 1,
        kind: body.kind as "pr_opened",
        at: body.at ?? new Date().toISOString(),
        dedupeKey: body.dedupeKey,
        payload: body.payload,
      },
    );
    return successResponse({ deduped: out.deduped, seq: out.observation?.seq ?? null }, requestId, out.deduped ? 200 : 201);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

// ── Import (the dogfood path) ───────────────────────────────────────────────

const IMPORT_MILESTONE_LABEL = "import.milestone";
const IMPORT_SPEC_LABEL = "import.spec";

export async function handleWorkImport(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_WRITE);
  if (!authz.ok) return authz.response;
  const body = await parseBody<WorkImportRequest>(request);
  if (!body || !Array.isArray(body.specs) || !Array.isArray(body.tasks)) {
    return validationError(requestId, { specs: ["required"], tasks: ["required"] });
  }
  const prefix = body.prefix ?? "WRK";
  const workActor: WorkActor = { ...workActorOf(actor), via: "import" };
  const scope: WorkspaceScope = { orgId };
  const { repo, owned } = repoOf(env, deps);
  try {
    const result: WorkImportResponse = { specsCreated: 0, specsSkipped: 0, tasksCreated: 0, tasksSkipped: 0 };

    for (const spec of body.specs) {
      try {
        await repo.createSpec(scope, {
          slug: spec.slug,
          title: spec.title,
          docRef: spec.docSha256,
          actor: workActor,
        });
        result.specsCreated++;
      } catch (err) {
        if (err instanceof WorkError && err.code === "conflict") {
          result.specsSkipped++; // re-import is idempotent on slugs
        } else {
          throw err;
        }
      }
    }

    // Idempotency for tasks: a milestone is identified by its
    // (spec, milestoneId) labels; re-imports skip existing ones. Dep tokens
    // (milestone ids) rewrite to allocated task keys where known.
    const ws = await repo.getWorkSet(scope);
    const milestoneKey = new Map<string, string>(); // "spec:milestone" -> task key
    for (const t of ws.tasks) {
      const m = t.labels?.[IMPORT_MILESTONE_LABEL];
      const s = t.labels?.[IMPORT_SPEC_LABEL];
      if (m && s) milestoneKey.set(`${s}:${m}`, t.key);
    }

    for (const task of body.tasks) {
      const id = `${task.specSlug}:${task.milestoneId}`;
      if (milestoneKey.has(id)) {
        result.tasksSkipped++;
        continue;
      }
      const contract = task.contract ? ({ ...task.contract } as Contract) : undefined;
      if (contract?.deps) {
        contract.deps = contract.deps.map((dep) => milestoneKey.get(`${task.specSlug}:${dep}`) ?? dep);
      }
      const out = await repo.createTask(scope, {
        prefix,
        title: `${task.milestoneId} — ${task.title}`,
        specKey: task.specSlug,
        contract,
        labels: { [IMPORT_MILESTONE_LABEL]: task.milestoneId, [IMPORT_SPEC_LABEL]: task.specSlug },
        actor: workActor,
      });
      milestoneKey.set(id, out.key);
      result.tasksCreated++;
    }

    return successResponse(result, requestId, 201);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}
