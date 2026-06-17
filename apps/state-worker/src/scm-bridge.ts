// scm.* → state.triggers bridge consumer (OV4 — design-v2 §5,
// bridge-to-state.md "Inbound"). The inbound half of the GitHub App bridge: a
// cron-driven drain that reads source-control events the integrations context
// normalized onto the event_log (`scm.push` / `scm.pull_request.*`) and projects
// them into state.triggers — the activity surface, resolved to (org, project)
// via the rename-stable repo federation.
//
// This is the worker-feasible inbound step (Option C): it records WHAT happened
// (push/PR) cheaply and idempotently; object-graph authorship (Source/Catalog
// materialization) is a separate, deferred concern (status stays 'recorded').
//
// CRON-SLOT BUDGET (risk R9): driven by the SINGLE state-worker scheduled
// handler, as a second phase after the lease sweep — never a new cron trigger.

import type { Env } from "./env.js";
import type { RecordTriggerInput, TriggerKind } from "@saas/db/state";
import { createStateRepository } from "@saas/db/state";
import { createEventsRepository, type StoredEvent } from "@saas/db/events";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { asUuid } from "@saas/db/ids";
import { generateUuid } from "./ids.js";
import { SCM_DRAIN_BATCH_LIMIT } from "./constants.js";

export interface ScmDrainSummary {
  scanned: number;
  recorded: number;
  /** Already-recorded events (idempotent no-ops). */
  skipped: number;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// Map an scm.* event type to (kind, action). Push has no action; the PR action
// is the type suffix.
function kindAndAction(type: string): { kind: TriggerKind; action: string | null } | null {
  if (type === "scm.push") return { kind: "push", action: null };
  if (type.startsWith("scm.pull_request.")) {
    return { kind: "pull_request", action: type.slice("scm.pull_request.".length) };
  }
  return null; // other scm.* (check/branch/tag/repo) are not triggers
}

// Project one scm.* event into a RecordTriggerInput, or null when it is not a
// push/PR or lacks the identity fields. projectId is resolved by the caller.
function toTriggerInput(event: StoredEvent, projectId: Uuid | null): RecordTriggerInput | null {
  const ka = kindAndAction(event.type);
  if (!ka) return null;
  const payload = event.payload ?? {};
  const repo = record(payload.repo);
  const providerRepoId = repo ? str(repo.externalId) : null;
  if (!providerRepoId) return null;

  const isPush = ka.kind === "push";
  const commitSha = isPush ? str(payload.afterSha) : str(payload.headSha);
  if (!commitSha) return null;

  return {
    id: generateUuid(),
    orgId: asUuid(event.orgId),
    projectId,
    provider: repo && typeof repo.provider === "string" ? repo.provider : "github",
    providerRepoId,
    repoFullName: repo ? str(repo.fullName) : null,
    kind: ka.kind,
    action: ka.action,
    ref: isPush ? str(payload.ref) : null,
    commitSha,
    baseSha: isPush ? null : str(payload.baseSha),
    prNumber: isPush ? null : num(payload.number),
    actorLogin: isPush ? str(payload.pusherLogin) : str(payload.authorLogin),
    eventId: event.id,
    occurredAt: event.occurredAt,
  };
}

/**
 * Drain pass (pure of the cron wiring, so unit-testable against a fake
 * executor): read scm.* events strictly after the stored cursor, project each
 * into state.triggers (idempotent by event id, project resolved via the
 * rename-stable repo federation), then advance the cursor to the last event.
 */
export async function drainScmTriggers(executor: SqlExecutor): Promise<ScmDrainSummary> {
  const state = createStateRepository(executor);
  const events = createEventsRepository(executor);
  const summary: ScmDrainSummary = { scanned: 0, recorded: 0, skipped: 0 };

  const cursorResult = await state.readScmIngestCursor();
  if (!cursorResult.ok) return summary;
  const cursor = cursorResult.value;

  const batch = await events.listScmEventsSince(cursor.lastOccurredAt, cursor.lastEventId, SCM_DRAIN_BATCH_LIMIT);
  if (!batch.ok || batch.value.length === 0) return summary;

  // Resolve the project for a repo once per (org, repo) within the batch.
  const projectCache = new Map<string, Uuid | null>();
  const resolveProject = async (orgId: string, providerRepoId: string): Promise<Uuid | null> => {
    const key = `${orgId}|${providerRepoId}`;
    const cached = projectCache.get(key);
    if (cached !== undefined) return cached;
    const links = await state.listActiveWorkspaceLinksForProviderRepo("github", providerRepoId);
    let resolved: Uuid | null = null;
    if (links.ok) {
      const match = links.value.find((l) => l.orgId === orgId);
      if (match) resolved = asUuid(match.projectId);
    }
    projectCache.set(key, resolved);
    return resolved;
  };

  let lastOccurredAt: string | null = null;
  let lastEventId: string | null = null;
  for (const event of batch.value) {
    summary.scanned++;
    // Advance the high-water mark over EVERY scm.* row scanned (even non-trigger
    // ones), so the cursor never stalls on an event the projector skips.
    lastOccurredAt = event.occurredAt.toISOString();
    lastEventId = event.id;

    const repo = record(event.payload?.repo);
    const providerRepoId = repo ? str(repo.externalId) : null;
    const projectId = providerRepoId ? await resolveProject(event.orgId, providerRepoId) : null;

    const input = toTriggerInput(event, projectId);
    if (!input) continue;
    const recorded = await state.recordTrigger(input);
    if (recorded.ok) {
      if (recorded.value.created) summary.recorded++;
      else summary.skipped++;
    }
  }

  if (lastOccurredAt && lastEventId) {
    await state.advanceScmIngestCursor(lastOccurredAt, lastEventId);
  }
  return summary;
}

/** Cron wrapper: create the executor, drain, dispose. Returns null when the DB
 *  binding is absent (dev). */
export async function runScmDrain(env: Env): Promise<ScmDrainSummary | null> {
  if (!env.PLATFORM_DB) return null;
  const { createSqlExecutor } = await import("@saas/db/hyperdrive");
  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    return await drainScmTriggers(executor);
  } finally {
    if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
