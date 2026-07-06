import type { Env } from "../env.js";
import type {
  EventsAdminRepository,
  LaneHealthRow,
  DeadLetterCountRow,
  SuppressedRuleRow,
} from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createEventsAdminRepository } from "@saas/db/events";
import { authorizeSupportAction } from "../support-auth.js";
import type { SupportRequestContext } from "./record-support-action.js";
import { successResponse, errorResponse } from "../http.js";
import { orgPublicId } from "../ids.js";

// ---------------------------------------------------------------------------
// Events scale/lifecycle admin surfaces (saas-event-streaming ES7). Read-only,
// cross-org, support-gated diagnostics: lane health, dead-letter counts, and
// the rule-storm audit. admin-worker reaches Postgres directly via
// cloudflare-hyperdrive — NO new worker dependency edge is introduced.
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(url: URL | undefined): number {
  if (!url) return DEFAULT_LIMIT;
  const raw = url.searchParams.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

// Test seam. When provided, the handler runs against an injected repo (no DB).
export interface EventsOpsDeps {
  adminRepo: EventsAdminRepository;
}

function authorize(ctx: SupportRequestContext): { ok: true } | { ok: false; reason: string } {
  const decision = authorizeSupportAction({
    actor: ctx.actor,
    supportRoleClaim: ctx.supportRoleClaim,
    systemOverride: ctx.systemOverride,
  });
  return decision.allow ? { ok: true } : { ok: false, reason: decision.reason };
}

async function withRepo<T>(
  env: Env,
  requestId: string,
  deps: EventsOpsDeps | undefined,
  run: (repo: EventsAdminRepository) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  if (deps) return { ok: true, value: await run(deps.adminRepo) };
  if (!env.PLATFORM_DB) {
    return { ok: false, response: errorResponse("internal_error", "Database not configured", 503, requestId) };
  }
  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    return { ok: true, value: await run(createEventsAdminRepository(executor)) };
  } finally {
    await executor.dispose();
  }
}

function laneHealthJson(row: LaneHealthRow): Record<string, unknown> {
  return {
    laneKey: row.laneKey,
    orgId: orgPublicId(row.orgId),
    lastOccurredAt: row.lastOccurredAt ? row.lastOccurredAt.toISOString() : null,
    headOccurredAt: row.headOccurredAt ? row.headOccurredAt.toISOString() : null,
    lagSeconds: row.lagSeconds,
  };
}

function deadLetterCountJson(row: DeadLetterCountRow): Record<string, unknown> {
  return { orgId: orgPublicId(row.orgId), openCount: row.openCount, terminalCount: row.terminalCount };
}

function suppressedRuleJson(row: SuppressedRuleRow): Record<string, unknown> {
  return {
    ruleId: row.ruleId,
    orgId: orgPublicId(row.orgId),
    name: row.name,
    suppressedAt: row.suppressedAt ? row.suppressedAt.toISOString() : null,
    suppressedReason: row.suppressedReason,
    saturatedWindowCount: row.saturatedWindowCount,
  };
}

export async function handleLaneHealth(
  env: Env,
  requestId: string,
  ctx: SupportRequestContext,
  url?: URL,
  deps?: EventsOpsDeps,
): Promise<Response> {
  const auth = authorize(ctx);
  if (!auth.ok) return errorResponse("forbidden", "Support action denied", 403, requestId, { reason: auth.reason });

  const limit = parseLimit(url);
  const outcome = await withRepo(env, requestId, deps, (repo) => repo.laneHealth(limit));
  if (!outcome.ok) return outcome.response;
  const result = outcome.value;
  if (!result.ok) return errorResponse("internal_error", "Failed to read lane health", 500, requestId);
  return successResponse({ lanes: result.value.map(laneHealthJson) }, requestId, 200);
}

export async function handleDeadLetterCounts(
  env: Env,
  requestId: string,
  ctx: SupportRequestContext,
  url?: URL,
  deps?: EventsOpsDeps,
): Promise<Response> {
  const auth = authorize(ctx);
  if (!auth.ok) return errorResponse("forbidden", "Support action denied", 403, requestId, { reason: auth.reason });

  const limit = parseLimit(url);
  const outcome = await withRepo(env, requestId, deps, (repo) => repo.deadLetterCounts(limit));
  if (!outcome.ok) return outcome.response;
  const result = outcome.value;
  if (!result.ok) return errorResponse("internal_error", "Failed to read dead-letter counts", 500, requestId);
  return successResponse({ orgs: result.value.map(deadLetterCountJson) }, requestId, 200);
}

export async function handleRuleStorms(
  env: Env,
  requestId: string,
  ctx: SupportRequestContext,
  url?: URL,
  deps?: EventsOpsDeps,
): Promise<Response> {
  const auth = authorize(ctx);
  if (!auth.ok) return errorResponse("forbidden", "Support action denied", 403, requestId, { reason: auth.reason });

  const limit = parseLimit(url);
  const outcome = await withRepo(env, requestId, deps, (repo) => repo.listSuppressedRules(limit));
  if (!outcome.ok) return outcome.response;
  const result = outcome.value;
  if (!result.ok) return errorResponse("internal_error", "Failed to read rule storms", 500, requestId);
  return successResponse({ suppressedRules: result.value.map(suppressedRuleJson) }, requestId, 200);
}
