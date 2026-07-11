// v4 hierarchy handlers (orun-work-v4 WH1) — milestones, review/approval,
// designs, and the initiative rollup read.
//
// Design rules enforced here (specs/epics/orun-work-v4/):
//   * Intent state is authored, delivery is derived, and neither is stored:
//     every read below folds from the logs on request (V4-3/V4-4).
//   * approved / approval_revoked / design_adopted / superseded are
//     HUMAN-ONLY (V4-2): the model rejects agents and automation at write
//     time (WorkError "human_only" → 422 verdict); approve/revoke/adopt
//     routes additionally require the `work.approve` policy action —
//     reviewer ≠ approver is a real privilege boundary.
//   * Approval names bytes: a stale revision is a 409 conflict.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type {
  AdoptWorkDesignRequest,
  AdoptWorkDesignResponse,
  ApproveWorkEpicRequest,
  ApproveWorkEpicResponse,
  RegenerateWorkTasksRequest,
  RegenerateWorkTasksResponse,
  WorkEpicBriefResponse,
  CreateWorkDesignRequest,
  CreateWorkDesignResponse,
  RevokeWorkApprovalRequest,
  SupersedeWorkDesignRequest,
  WorkDesignView,
  WorkDesignsResponse,
  WorkMilestoneRequest,
  WorkMilestonesResponse,
  WorkMutationResponse,
  WorkReviewRequest,
  WorkRollupsResponse,
  WorkVerdictRequest,
} from "@saas/contracts/work";
import { WORK_POLICY_ACTIONS } from "@saas/contracts/work";
import {
  WorkError,
  buildEnvelopes,
  fold,
  foldDesignIntent,
  foldEpicExecution,
  foldEpicIntent,
  foldInitiativeStatus,
  foldMilestones,
  type Contract,
  type Design,
  type EpicRollup,
  type Proposal,
  type WorkRepository,
  type WorkspaceScope,
} from "@saas/db/work";
import type { Uuid } from "@saas/db/ids";
import { errorResponse, successResponse, validationError } from "../http.js";
import { authorizeOrg } from "../authz.js";
import { dispose, parseBody, repoOf, workActorOf, workErrorResponse, type WorkHandlerDeps } from "./work.js";

async function designView(repo: WorkRepository, scope: WorkspaceScope, d: Design): Promise<WorkDesignView> {
  const events = await repo.listEvents(scope);
  const intent = foldDesignIntent(d.key, events);
  return {
    key: d.key,
    initiative: d.initiative,
    title: d.title,
    docRef: d.docRef,
    context: d.context,
    proposal: d.proposal as WorkDesignView["proposal"],
    labels: d.labels,
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    intent: {
      state: intent.state,
      adoptedRevision: intent.adoptedRevision,
      minted: intent.minted,
      adoptedBy: intent.adoptedBy,
      supersededBy: intent.supersededBy,
    },
  };
}

// ── Milestones ───────────────────────────────────────────────────────────────

export async function handleWorkMilestones(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  epicKey: string,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  if (request.method === "GET") {
    const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_READ);
    if (!authz.ok) return authz.response;
    const { repo, owned } = repoOf(env, deps);
    try {
      const ladder = await repo.listMilestones({ orgId }, epicKey);
      const ws = await repo.getWorkSet({ orgId });
      const execution = foldEpicExecution(ws, epicKey, ladder, fold(ws));
      const payload: WorkMilestonesResponse = {
        epic: epicKey,
        milestones: ladder.map((m, i) => ({
          ...m,
          progress: execution.milestones?.[i]?.counts,
          total: execution.milestones?.[i]?.total,
          complete: execution.milestones?.[i]?.complete,
        })),
        unscheduled: execution.unscheduled
          ? { total: execution.unscheduled.total, complete: execution.unscheduled.complete }
          : undefined,
      };
      return successResponse(payload, requestId);
    } catch (err) {
      if (err instanceof WorkError) return workErrorResponse(err, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    } finally {
      await dispose(owned);
    }
  }

  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_WRITE);
  if (!authz.ok) return authz.response;
  const body = await parseBody<WorkMilestoneRequest>(request);
  if (!body?.op || !body.key) {
    return validationError(requestId, { op: ["required"], key: ["required"] });
  }
  const { repo, owned } = repoOf(env, deps);
  try {
    const out = await repo.editMilestone(
      { orgId },
      {
        epicKey,
        op: body.op,
        key: body.key,
        title: body.title,
        goal: body.goal,
        doneWhen: body.doneWhen,
        targetDate: body.targetDate,
        ordinal: body.ordinal,
        actor: workActorOf(actor),
      },
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

// ── Review and approval ──────────────────────────────────────────────────────

export async function handleWorkReview(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  key: string,
  mode: "review" | "verdict",
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_WRITE);
  if (!authz.ok) return authz.response;
  const { repo, owned } = repoOf(env, deps);
  try {
    if (mode === "review") {
      const body = (await parseBody<WorkReviewRequest>(request)) ?? {};
      const out = await repo.requestReview(
        { orgId },
        { key, revision: body.revision, reviewers: body.reviewers, note: body.note, actor: workActorOf(actor) },
      );
      await publishWorkEvent(env, requestId, orgId, actor, "work.review.requested", key, {
        itemKey: key,
        reviewers: body.reviewers,
        title: `Review requested on ${key}`,
        severity: "info",
      });
      const payload: WorkMutationResponse = { key: out.key, seq: out.event.seq };
      return successResponse(payload, requestId);
    }
    const body = await parseBody<WorkVerdictRequest>(request);
    if (!body?.verdict) {
      return validationError(requestId, { verdict: ["required (approve|request_changes)"] });
    }
    const out = await repo.submitVerdict(
      { orgId },
      { key, revision: body.revision, verdict: body.verdict, note: body.note, actor: workActorOf(actor) },
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

export async function handleWorkApprove(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  key: string,
  mode: "approve" | "revoke",
  deps?: WorkHandlerDeps,
): Promise<Response> {
  // Approval is a privilege boundary (reviewer ≠ approver): work.approve,
  // owner/admin by default. The human-only actor rule is enforced again in
  // the model (defense in depth, as with agent pins).
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_APPROVE);
  if (!authz.ok) return authz.response;
  const { repo, owned } = repoOf(env, deps);
  try {
    if (mode === "approve") {
      const body = (await parseBody<ApproveWorkEpicRequest>(request)) ?? {};
      const out = await repo.approve(
        { orgId },
        { key, revision: body.revision, minApprovals: body.minApprovals, actor: workActorOf(actor) },
      );
      // ES2 rail: work.epic.approved onto the platform event_log —
      // best-effort; a notification must never fail an approval.
      await publishWorkEvent(env, requestId, orgId, actor, "work.epic.approved", key, {
        epicKey: key,
        snapshot: out.snapshot,
        title: `Epic ${key} approved`,
        severity: "info",
      });
      const payload: ApproveWorkEpicResponse = { key: out.key, seq: out.event.seq, snapshot: out.snapshot };
      return successResponse(payload, requestId);
    }
    const body = (await parseBody<RevokeWorkApprovalRequest>(request)) ?? {};
    const out = await repo.revokeApproval({ orgId }, { key, note: body.note, actor: workActorOf(actor) });
    const payload: WorkMutationResponse = { key: out.key, seq: out.event.seq };
    return successResponse(payload, requestId);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

// ── Designs ──────────────────────────────────────────────────────────────────

export async function handleWorkDesigns(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  initiativeKey: string,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  if (request.method === "GET") {
    const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_READ);
    if (!authz.ok) return authz.response;
    const { repo, owned } = repoOf(env, deps);
    try {
      const designs = await repo.listDesigns({ orgId }, initiativeKey);
      const views: WorkDesignView[] = [];
      for (const d of designs) views.push(await designView(repo, { orgId }, d));
      const payload: WorkDesignsResponse = { designs: views };
      return successResponse(payload, requestId);
    } catch (err) {
      if (err instanceof WorkError) return workErrorResponse(err, requestId);
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    } finally {
      await dispose(owned);
    }
  }

  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_WRITE);
  if (!authz.ok) return authz.response;
  const body = await parseBody<CreateWorkDesignRequest>(request);
  if (!body?.title) {
    return validationError(requestId, { title: ["required"] });
  }
  const { repo, owned } = repoOf(env, deps);
  try {
    const out = await repo.createDesign(
      { orgId },
      {
        initiativeKey,
        title: body.title,
        docRef: body.docRef,
        proposal: body.proposal as Proposal | undefined,
        context: body.catalog ? { catalog: body.catalog } : undefined,
        labels: body.labels,
        actor: workActorOf(actor),
      },
    );
    const payload: CreateWorkDesignResponse = {
      key: out.key,
      seq: out.event.seq,
      design: await designView(repo, { orgId }, out.design),
    };
    return successResponse(payload, requestId, 201);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

export async function handleGetWorkDesign(
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
    const design = await repo.getDesign({ orgId }, key);
    return successResponse(await designView(repo, { orgId }, design), requestId);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

export async function handleWorkDesignDecision(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  key: string,
  mode: "adopt" | "supersede",
  deps?: WorkHandlerDeps,
): Promise<Response> {
  // Adoption mints epics — a decision with the same privilege boundary as
  // approval. Supersede is a lighter call but still a human-only decision
  // (the model enforces the actor rule for both).
  const action = mode === "adopt" ? WORK_POLICY_ACTIONS.WORK_APPROVE : WORK_POLICY_ACTIONS.WORK_WRITE;
  const authz = await authorizeOrg(env, requestId, actor, orgId, action);
  if (!authz.ok) return authz.response;
  const { repo, owned } = repoOf(env, deps);
  try {
    if (mode === "adopt") {
      const body = (await parseBody<AdoptWorkDesignRequest>(request)) ?? {};
      const out = await repo.adoptDesign(
        { orgId },
        { key, epics: body.epics, taskPrefix: body.taskPrefix, actor: workActorOf(actor) },
      );
      const payload: AdoptWorkDesignResponse = {
        key,
        seq: out.event.seq,
        minted: out.minted,
        tasks: out.tasks,
      };
      return successResponse(payload, requestId, 201);
    }
    const body = (await parseBody<SupersedeWorkDesignRequest>(request)) ?? {};
    const out = await repo.supersedeDesign({ orgId }, { key, by: body.by, note: body.note, actor: workActorOf(actor) });
    const payload: WorkMutationResponse = { key: out.key, seq: out.event.seq };
    return successResponse(payload, requestId);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

// ── Rollups (GET /work/rollups?initiative=…) ─────────────────────────────────

export async function handleWorkRollups(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_READ);
  if (!authz.ok) return authz.response;
  const initiativeKey = new URL(request.url).searchParams.get("initiative");
  if (!initiativeKey) {
    return validationError(requestId, { initiative: ["required"] });
  }
  const { repo, owned } = repoOf(env, deps);
  try {
    const ws = await repo.getWorkSet({ orgId });
    const { specs, initiatives, milestones } = buildEnvelopes(orgId, ws.events);
    if (!initiatives.some((i) => i.key === initiativeKey)) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
    const foldResult = fold(ws);
    const rollups: EpicRollup[] = [];
    const epicViews: WorkRollupsResponse["epics"] = [];
    for (const s of specs) {
      if (s.initiative !== initiativeKey) continue;
      const intent = await foldEpicIntent(s.key, ws.events);
      const ladder = milestones.get(s.key) ?? foldMilestones(s.key, ws.events);
      const execution = foldEpicExecution(ws, s.key, ladder, foldResult);
      rollups.push({ epic: s, intent: { state: intent.state }, execution });
      epicViews.push({
        key: s.key,
        title: s.title,
        targetDate: s.targetDate,
        intent: {
          state: intent.state,
          approval: intent.approval,
          currentRevision: intent.currentRevision,
          docDrifted: intent.docDrifted,
          ladderDrifted: intent.ladderDrifted,
        },
        total: execution.total,
        complete: execution.complete,
        blocked: execution.blocked,
      });
    }
    // Time enters only through asOf — the request clock, never a fold clock.
    const status = foldInitiativeStatus(initiativeKey, rollups, ws.events, new Date().toISOString().slice(0, 10));
    const payload: WorkRollupsResponse = {
      initiative: initiativeKey,
      health: status.health,
      evidence: status.evidence,
      pinnedHealth: status.pinned
        ? { health: status.pinned.health, by: status.pinned.by, note: status.pinned.note, at: status.pinned.at }
        : undefined,
      progress: status.progress,
      total: status.total,
      complete: status.complete,
      epics: epicViews,
    };
    return successResponse(payload, requestId);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

/** Best-effort platform-event publish for the ES2 notification rail —
 *  mirrors the mention fan-out seam: a publish failure never fails the
 *  mutation it narrates. */
async function publishWorkEvent(
  env: Env,
  requestId: string,
  orgId: Uuid,
  actor: ActorContext,
  type: string,
  subjectId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const { createSqlExecutor } = await import("@saas/db/hyperdrive");
    const { createEventsRepository } = await import("@saas/db/events");
    const executor = createSqlExecutor(env.PLATFORM_DB!);
    try {
      const events = createEventsRepository(executor);
      await events.appendEvent({
        id: crypto.randomUUID(),
        type,
        version: 1,
        source: "state-worker",
        occurredAt: new Date(),
        actorType: actor.subjectType === "service_principal" ? "service_principal" : "user",
        actorId: actor.subjectId,
        orgId,
        subjectKind: "work_item",
        subjectId,
        subjectName: subjectId,
        requestId,
        payload,
      });
    } finally {
      await dispose(executor as unknown as Parameters<typeof dispose>[0]);
    }
  } catch {
    // best-effort by design
  }
}

// ── The sealed brief (GET /work/epics/{key}/brief[?id=]) ────────────────────

export async function handleWorkEpicBrief(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  epicKey: string,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_READ);
  if (!authz.ok) return authz.response;
  const id = new URL(request.url).searchParams.get("id") ?? undefined;
  const { repo, owned } = repoOf(env, deps);
  try {
    const brief = await repo.getEpicBrief({ orgId }, epicKey, id);
    const payload: WorkEpicBriefResponse = {
      id: brief.id,
      subject: brief.subject,
      canonical: brief.canonical,
      createdAt: brief.createdAt,
    };
    return successResponse(payload, requestId);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}

// ── Governed re-planning (POST /work/epics/{key}/milestones/{m}/regenerate) ─

export async function handleWorkRegenerate(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  epicKey: string,
  milestoneKey: string,
  deps?: WorkHandlerDeps,
): Promise<Response> {
  const authz = await authorizeOrg(env, requestId, actor, orgId, WORK_POLICY_ACTIONS.WORK_WRITE);
  if (!authz.ok) return authz.response;
  const body = await parseBody<RegenerateWorkTasksRequest>(request);
  if (!body?.tasks || !Array.isArray(body.tasks) || body.tasks.length === 0) {
    return validationError(requestId, { tasks: ["required (the replacement plan)"] });
  }
  const { repo, owned } = repoOf(env, deps);
  try {
    const out = await repo.regenerateTasks(
      { orgId },
      {
        epicKey,
        milestone: milestoneKey,
        tasks: body.tasks.map((t) => ({ title: t.title, contract: t.contract as Contract | undefined })),
        prefix: body.prefix,
        actor: workActorOf(actor),
      },
    );
    const payload: RegenerateWorkTasksResponse = out;
    return successResponse(payload, requestId, 201);
  } catch (err) {
    if (err instanceof WorkError) return workErrorResponse(err, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await dispose(owned);
  }
}
