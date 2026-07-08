// Catalog-projection reliability sweep (saas-workspace-overview).
//
// The catalog read-model projection (state.org_catalog_entities + state.repo_facet)
// runs on catalog.head.advanced via ctx.waitUntil in state-worker. When state-worker
// is invoked over a service binding (api-edge -> state-worker), that background task
// can be torn down before it commits — the head advances but the read model stays
// frozen at an old head and repo_facet is left empty (the Workspace Overview blank).
//
// This cron phase is the reliable backstop: it drives from state.catalog_heads (the
// authoritative desired head) LEFT JOIN the state.catalog_projection outbox and
// re-projects any scope whose read model lags its head — in the cron's OWN lifecycle
// (a top-level scheduled trigger), which always runs to completion. projectCatalogSnapshot
// records success/failure on the outbox itself, so a converged scope drops out of the
// next pass and a poison scope is parked after MAX_ATTEMPTS. Coalesced into the single
// state-worker cron slot (risk R9 — a phase of the scheduled handler, never a new cron).

import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { createStateRepository } from "@saas/db/state";
import type { Uuid } from "@saas/db/ids";
import { projectCatalogSnapshot } from "./catalog-projection.js";
import type { Env } from "./env.js";
import { orgPublicId, projectPublicId } from "./ids.js";

/** Bounded so the phase stays within the cron budget; oldest-head-first. */
const PROJECTION_BATCH = 100;
/** Park a scope after this many consecutive failures (poison-snapshot guard). */
const MAX_ATTEMPTS = 5;

export interface CatalogProjectionSweepSummary {
  scanned: number;
  projected: number;
}

/**
 * Re-project a bounded batch of scopes whose read model lags their current catalog
 * head. Returns null when Postgres is unbound (dormant dev). Best-effort per scope —
 * one scope's failure never stalls the batch, and the outbox tracks its attempts.
 */
export async function runCatalogProjectionSweep(
  env: Env,
  deps?: { executor?: SqlExecutor },
): Promise<CatalogProjectionSweepSummary | null> {
  if (!deps?.executor && !env.PLATFORM_DB) return null;
  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  let scanned = 0;
  let projected = 0;
  try {
    const repo = createStateRepository(executor);
    const pending = await repo.listPendingCatalogProjections(PROJECTION_BATCH, MAX_ATTEMPTS);
    if (!pending.ok) return { scanned: 0, projected: 0 };
    for (const s of pending.value) {
      scanned += 1;
      try {
        // Reuse the same projector + executor; it records success/failure on the
        // outbox, so a converged scope drops out of the next pass.
        await projectCatalogSnapshot(
          env,
          {
            orgId: s.orgId as Uuid,
            projectId: s.projectId as Uuid,
            orgPublic: orgPublicId(s.orgId),
            projectPublic: projectPublicId(s.projectId),
            environment: s.environment,
            digest: s.digest,
            commit: s.commit,
          },
          { executor },
        );
        projected += 1;
      } catch (err) {
        // Best-effort per scope — the outbox already recorded the attempt; log so
        // a systemic failure (e.g. R2 misbound) is visible in tail.
        console.error(
          JSON.stringify({
            level: "error",
            scope: "state.catalog.projection.sweep",
            reason: "scope_failed",
            orgId: s.orgId,
            projectId: s.projectId,
            error: String(err),
          }),
        );
      }
    }
    return { scanned, projected };
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
