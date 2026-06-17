// Run-result → GitHub write-back driver (OV5 — bridge-to-state.md "Outbound";
// pairs with saas-integrations IG9). The outbound half's TRIGGER: a cron-driven
// drain that reads TERMINAL run events the run-coordination plane emitted
// (state.run.completed / state.run.failed) and, for runs that came from a linked
// GitHub repo, posts a Check Run back to that repo — THROUGH integrations-worker,
// which alone holds the App key. state-worker never calls GitHub and never sees
// the App credential.
//
// Decoupled by design: it consumes the same run lifecycle EVENTS the sweep and
// the run-job handler already emit (via emitRunLifecycle), so there is exactly
// one funnel and the hot path is never coupled to an outbound HTTP call.
//
// At-most-once posting: a Check Run create is NOT idempotent on GitHub's side,
// so the cursor advances PER EVENT after the attempt — a crash resumes strictly
// after the last event we acted on, never re-posting it. A missed post on a
// transient error is acceptable (write-back is best-effort); a duplicate is not.
//
// CRON-SLOT BUDGET (risk R9): driven by the SINGLE state-worker scheduled
// handler, as a third phase after the sweep and the scm drain — never a new cron.

import type { Env } from "./env.js";
import { createStateRepository } from "@saas/db/state";
import { createEventsRepository, type StoredEvent } from "@saas/db/events";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import {
  INTEGRATIONS_WRITEBACK_CALLER,
  type WritebackRequest,
  type WritebackResponse,
} from "@saas/contracts/integrations";
import { STATE_EVENT_TYPES } from "@saas/contracts/state";
import { generateRequestId, orgPublicId } from "./ids.js";
import { RUN_WRITEBACK_BATCH_LIMIT } from "./constants.js";

export interface RunWritebackSummary {
  scanned: number;
  posted: number;
  /** Not GitHub-linked, no commit, or no project — a benign no-op. */
  skipped: number;
  /** integrations-worker reported failed, or the call itself failed. */
  failed: number;
}

/** Outbound call to integrations-worker's write-back endpoint (injected for tests). */
export type WritebackPoster = (body: WritebackRequest) => Promise<WritebackResponse | null>;

/** succeeded → success; anything else terminal → failure (GitHub's conclusions). */
function conclusionFor(eventType: string): "success" | "failure" {
  return eventType === STATE_EVENT_TYPES.RUN_COMPLETED ? "success" : "failure";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Drain pass (pure of the cron wiring, so unit-testable against a fake executor
 * + a scripted poster): read terminal run events strictly after the stored
 * cursor; for each, resolve the run's commit + the project's active GitHub link
 * and post a Check Run; advance the cursor per event. Skips (never fails) when a
 * run has no commit or the project is not GitHub-linked.
 */
export async function drainRunWriteback(
  executor: SqlExecutor,
  post: WritebackPoster,
): Promise<RunWritebackSummary> {
  const state = createStateRepository(executor);
  const events = createEventsRepository(executor);
  const summary: RunWritebackSummary = { scanned: 0, posted: 0, skipped: 0, failed: 0 };

  const cursorResult = await state.readRunWritebackCursor();
  if (!cursorResult.ok) return summary;
  const cursor = cursorResult.value;

  const batch = await events.listRunResultEventsSince(
    cursor.lastOccurredAt,
    cursor.lastEventId,
    RUN_WRITEBACK_BATCH_LIMIT,
  );
  if (!batch.ok || batch.value.length === 0) return summary;

  for (const event of batch.value) {
    summary.scanned++;
    await handleRunEvent(state, post, event, summary);
    // Advance per event (after the attempt): at-most-once, crash-safe — see header.
    await state.advanceRunWritebackCursor(event.occurredAt.toISOString(), event.id);
  }

  return summary;
}

async function handleRunEvent(
  state: ReturnType<typeof createStateRepository>,
  post: WritebackPoster,
  event: StoredEvent,
  summary: RunWritebackSummary,
): Promise<void> {
  // A run event is project-scoped; without the project we can't resolve a repo.
  if (!event.projectId) {
    summary.skipped++;
    return;
  }
  const runUlid = event.subjectName ?? str(event.payload.runId);
  if (!runUlid) {
    summary.skipped++;
    return;
  }
  const orgId = asUuid(event.orgId);
  const projectId = asUuid(event.projectId);

  // The commit is on the run row, not the event payload — fetch it. No commit
  // (a gitless CLI run) means nothing to attach a Check Run to.
  const runResult = await state.getRunByUlid(orgId, projectId, runUlid);
  if (!runResult.ok) {
    summary.skipped++;
    return;
  }
  const headSha = runResult.value.gitCommit;
  if (!headSha) {
    summary.skipped++;
    return;
  }

  // Resolve the project's active GitHub link → rename-stable provider repo id.
  // OV2.2 makes this at most one active link per (org, project).
  const links = await state.listWorkspaceLinks(orgId, projectId, { limit: 5, cursor: null });
  const link = links.ok
    ? links.value.items.find((l) => l.status === "active" && l.provider === "github" && l.providerRepoId)
    : undefined;
  if (!link || !link.providerRepoId) {
    summary.skipped++;
    return;
  }

  const conclusion = conclusionFor(event.type);
  const env = runResult.value.environment;
  const body: WritebackRequest = {
    kind: "check_run",
    orgId: orgPublicId(orgId),
    repoExternalId: link.providerRepoId,
    checkRun: {
      name: "orun",
      headSha,
      status: "completed",
      conclusion,
      title: `Run ${runUlid} ${conclusion === "success" ? "succeeded" : "failed"}`,
      summary: env ? `Environment: ${env}` : `Run ${runUlid}`,
    },
  };

  const result = await post(body);
  if (result && result.outcome === "posted") summary.posted++;
  else if (result && result.outcome === "skipped") summary.skipped++;
  else summary.failed++;
}

/** Build the production poster over the integrations-worker service binding. */
function bindingPoster(binding: Fetcher): WritebackPoster {
  return async (body) => {
    try {
      const res = await binding.fetch("https://integrations-worker/internal/github/writeback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-caller": INTEGRATIONS_WRITEBACK_CALLER,
          "x-request-id": generateRequestId(),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const parsed = (await res.json()) as { data?: WritebackResponse };
      return parsed.data ?? null;
    } catch {
      return null;
    }
  };
}

/**
 * Cron wrapper: create the executor, drain, dispose. Returns null when the DB
 * binding OR the integrations-worker binding is absent (dormant: the GitHub App
 * may not exist yet — D1). Write-back is best-effort and never blocks the cron.
 */
export async function runRunWriteback(env: Env): Promise<RunWritebackSummary | null> {
  if (!env.PLATFORM_DB || !env.INTEGRATIONS_WORKER) return null;
  const post = bindingPoster(env.INTEGRATIONS_WORKER);
  const { createSqlExecutor } = await import("@saas/db/hyperdrive");
  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    return await drainRunWriteback(executor, post);
  } finally {
    if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
