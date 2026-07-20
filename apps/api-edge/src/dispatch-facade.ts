// Dispatch facade (saas-dispatch DX0) — the Situation read-model.
//
// GET /v1/organizations/{orgId}/dispatch/situation
//
// A per-viewer FOLD over surfaces that already exist (epic decisions DD1/DD2):
// the work fold (state-worker), the session list + attention fold + budgets
// (agents-worker). The edge resolves the actor ONCE, stamps x-actor-* exactly
// like every other facade, fans out in parallel, and composes — it owns no
// table and no cache, so there is nowhere to write a status. Every downstream
// re-authorizes deny-by-default from the stamped actor, which is what makes
// the fold per-viewer (DD4): two viewers of one workspace can see different
// Situations, and this facade never blurs them.
//
// Degradation is per section: a failed source yields an empty section flagged
// `unavailable: true` — a partial Situation renders honestly. Only when every
// section fails does the route 503 (`situation_unavailable`).

import type {
  Situation,
  SituationAttentionItem,
  SituationReadyItem,
  SituationSessionItem,
} from "@saas/contracts/dispatch";
import { isLiveSessionState } from "@saas/contracts/dispatch";
import type { Env } from "./env.js";
import { errorResponse } from "./http.js";
import { resolveActor } from "./resolve-actor.js";

const ORG_DISPATCH_SITUATION_RE = /^\/v1\/organizations\/([^/]+)\/dispatch\/situation$/;

export function isDispatchRoute(pathname: string): boolean {
  return ORG_DISPATCH_SITUATION_RE.test(pathname);
}

/** The soft mark (AF8): attention fires past this fraction of a ceiling. */
const BUDGET_SOFT_MARK = 0.8;

/** Bound each section so a huge workspace cannot balloon the fold. The rail
 * is a glanceable surface; deep lists live on their own pages. */
const SECTION_CAP = 50;

interface SectionResult<T> {
  items: T[];
  unavailable: boolean;
}

async function fetchData<T>(
  worker: Fetcher | undefined,
  target: string,
  headers: Headers,
): Promise<T | null> {
  if (!worker) return null;
  try {
    const res = await worker.fetch(new Request(target, { method: "GET", headers }));
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: T };
    return body.data ?? null;
  } catch {
    return null;
  }
}

// Minimal downstream shapes — only the fields the fold reads. The full wire
// shapes live in @saas/contracts/work and @saas/contracts/agents; reading
// loosely here keeps the facade tolerant of additive downstream evolution.
interface WorkSetSlice {
  tasks?: Array<{
    key: string;
    title: string;
    spec?: string;
    priority?: string;
    labels?: Record<string, string>;
    assignees?: string[];
    lifecycle?: { rung?: string; evidence?: string[] };
  }>;
  coordSeq?: number;
  obsSeq?: number;
}

interface SessionSlice {
  id: string;
  state: string;
  runKind: string;
  profileId: string;
  taskKey?: string;
  workRef?: string;
  spawnedBy: string;
  startedAt?: string;
  tokensUsed?: number;
  parentSessionId?: string;
  depth?: number;
}

interface AttentionSlice {
  items?: Array<{
    kind: string;
    reason: string;
    at: string;
    sessionId?: string;
    routineId?: string;
    taskKey?: string;
    workRef?: string;
    request?: { requestId: string; tool: string };
  }>;
  counts?: Record<string, number>;
  running?: number;
}

interface BudgetSlice {
  grain: string;
  ref?: string;
  maxTokens: number;
}

export async function handleDispatchRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const m = ORG_DISPATCH_SITUATION_RE.exec(pathname);
  if (!m) return errorResponse("not_found", "Not found", 404, requestId);
  if (request.method !== "GET") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }
  if (!env.IDENTITY_WORKER) {
    return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
  }
  const sessionResult = await resolveActor(request, env, requestId);
  if ("error" in sessionResult) return sessionResult.error;

  const orgId = m[1]!;
  const headers = new Headers();
  headers.set("x-request-id", requestId);
  headers.set("x-actor-subject-id", sessionResult.subjectId);
  headers.set("x-actor-subject-type", sessionResult.subjectType);
  headers.set("x-actor-email", sessionResult.email);

  const agentsBase = `https://agents.internal/v1/organizations/${orgId}/agents`;
  const workTarget = `https://state.internal/v1/organizations/${orgId}/work`;

  // One parallel fan-out — the fold's latency is the slowest source, not the
  // sum (the responsiveness contract's server half, design §4).
  const [workSet, sessions, attention, budgets] = await Promise.all([
    fetchData<WorkSetSlice>(env.STATE_WORKER, workTarget, headers),
    fetchData<SessionSlice[]>(env.AGENTS_WORKER, `${agentsBase}/sessions`, headers),
    fetchData<AttentionSlice>(env.AGENTS_WORKER, `${agentsBase}/attention`, headers),
    fetchData<BudgetSlice[]>(env.AGENTS_WORKER, `${agentsBase}/budgets`, headers),
  ]);

  const ready: SectionResult<SituationReadyItem> = { items: [], unavailable: workSet === null };
  if (workSet?.tasks) {
    for (const t of workSet.tasks) {
      // ready ∧ unassigned — the design's dispatchable predicate, read off
      // the fold's derived lifecycle (never recomputed here).
      if (t.lifecycle?.rung !== "ready") continue;
      if (t.assignees && t.assignees.length > 0) continue;
      ready.items.push({
        plane: "work",
        key: t.key,
        title: t.title,
        ...(t.spec !== undefined ? { spec: t.spec } : {}),
        ...(t.lifecycle.evidence !== undefined ? { evidence: t.lifecycle.evidence } : {}),
        ...(t.priority !== undefined ? { priority: t.priority } : {}),
        ...(t.labels !== undefined ? { labels: t.labels } : {}),
      });
      if (ready.items.length >= SECTION_CAP) break;
    }
  }

  const inFlight: SectionResult<SituationSessionItem> = { items: [], unavailable: sessions === null };
  if (sessions) {
    for (const s of sessions) {
      if (!isLiveSessionState(s.state)) continue;
      inFlight.items.push({
        plane: "session",
        id: s.id,
        state: s.state,
        runKind: s.runKind,
        profileId: s.profileId,
        spawnedBy: s.spawnedBy,
        ...(s.taskKey !== undefined ? { taskKey: s.taskKey } : {}),
        ...(s.workRef !== undefined ? { workRef: s.workRef } : {}),
        ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
        ...(s.tokensUsed !== undefined ? { tokensUsed: s.tokensUsed } : {}),
        ...(s.parentSessionId !== undefined ? { parentSessionId: s.parentSessionId } : {}),
        ...(s.depth !== undefined ? { depth: s.depth } : {}),
      });
      if (inFlight.items.length >= SECTION_CAP) break;
    }
  }

  const waitingOnMe: SectionResult<SituationAttentionItem> = {
    items: [],
    unavailable: attention === null,
  };
  if (attention?.items) {
    for (const a of attention.items.slice(0, SECTION_CAP)) {
      waitingOnMe.items.push({
        plane: a.kind === "budget" || a.kind === "routine_parked" ? "governance" : "session",
        kind: a.kind,
        reason: a.reason,
        at: a.at,
        ...(a.sessionId !== undefined ? { sessionId: a.sessionId } : {}),
        ...(a.routineId !== undefined ? { routineId: a.routineId } : {}),
        ...(a.taskKey !== undefined ? { taskKey: a.taskKey } : {}),
        ...(a.workRef !== undefined ? { workRef: a.workRef } : {}),
        ...(a.request !== undefined ? { request: a.request } : {}),
      });
    }
  }

  const budgetUnavailable = budgets === null;
  const workspaceCeiling = budgets?.find((b) => b.grain === "workspace" && !b.ref) ?? null;
  const liveTokens = inFlight.items.reduce((sum, s) => sum + (s.tokensUsed ?? 0), 0);

  if (ready.unavailable && inFlight.unavailable && waitingOnMe.unavailable && budgetUnavailable) {
    return errorResponse(
      "situation_unavailable",
      "No situation source is reachable",
      503,
      requestId,
    );
  }

  const situation: Situation = {
    ready: ready.items,
    inFlight: inFlight.items,
    waitingOnMe: waitingOnMe.items,
    counts: {
      ...(attention?.counts ?? {}),
      running: attention?.running ?? inFlight.items.filter((s) => s.state === "running").length,
    },
    budget: {
      plane: "governance",
      workspaceMaxTokens: workspaceCeiling ? workspaceCeiling.maxTokens : null,
      liveTokens,
      softMark: BUDGET_SOFT_MARK,
    },
    cursor: `w${workSet?.coordSeq ?? 0}.${workSet?.obsSeq ?? 0}`,
    sections: {
      ready: ready.unavailable ? { unavailable: true } : {},
      inFlight: inFlight.unavailable ? { unavailable: true } : {},
      waitingOnMe: waitingOnMe.unavailable ? { unavailable: true } : {},
      budget: budgetUnavailable ? { unavailable: true } : {},
    },
  };

  return Response.json(
    { data: situation, meta: { requestId, cursor: null } },
    { status: 200 },
  );
}
