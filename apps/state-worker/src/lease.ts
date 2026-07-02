// Live-lease verification (saas-secret-manager SM3 — the second, independent
// gate of the lease-bound secrets resolve; state-api-contract §4).
//
// Bearer authz alone is NOT enough to serve a secret value: the caller must
// also hold a LIVE job lease for (runId, jobId, runnerId, leaseEpoch) — the
// same epoch discipline as the :heartbeat/:complete coordination verbs. This
// module answers exactly that question, covering BOTH coordination backends
// from day one (implementation-plan Q-10):
//
//   * DO backend — the RunCoordinator shard's fold is the authority: the job
//     must be `claimed` by this runner at this leaseEpoch with an unexpired
//     leaseExpiresAt (coordination-core decideHeartbeat's exact predicate,
//     plus the wall-clock expiry check the DO's alarm would enforce).
//   * Relational (OP2) backend — one SELECT on state.run_jobs: the runner
//     holds the row, status is claimed/running, and the lease is unexpired.
//     OP2 rows carry no lease epoch (the epoch is a DO-wire concept), so
//     `leaseEpoch` is ignored there.
//
// Backend selection mirrors coordination-route.runIsDoBacked: a run is DO-
// backed exactly when its shard reports the runId — per-run stickiness, so a
// flag flip never re-routes an in-flight run's lease checks.

import type { RunFoldState } from "@saas/contracts/coordination";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import type { Env } from "./env.js";
import { readCoordinatorState } from "./coordination-route.js";

export interface VerifyLeaseArgs {
  orgId: Uuid;
  projectId: Uuid;
  /** Public run id (client ULID). */
  runUlid: string;
  jobId: string;
  runnerId: string;
  /** DO-wire lease epoch; ignored on the relational backend (no epoch column). */
  leaseEpoch: number;
}

/** Typed verdict: `live: false` always carries a stable reason code. */
export type VerifyLeaseResult =
  | { live: true }
  | { live: false; reason: "lease_lost" | "not_found" };

export interface VerifyLeaseDeps {
  /** Injected executor (tests / callers that already hold one). */
  executor?: SqlExecutor;
  /** Injected fold reader (tests) — production reads the RunCoordinator shard. */
  readState?: (env: Env, runUlid: string) => Promise<RunFoldState | null>;
  /** Injected clock (tests). */
  now?: () => Date;
}

/**
 * True iff (runId, jobId) is currently leased by `runnerId` at `leaseEpoch`.
 * Fails closed: any backend error or missing row reads as not-live — a secret
 * value must never be served on an unverifiable lease.
 */
export async function verifyLiveLease(
  env: Env,
  args: VerifyLeaseArgs,
  deps?: VerifyLeaseDeps,
): Promise<VerifyLeaseResult> {
  const now = deps?.now ? deps.now() : new Date();

  // ── DO backend: the shard's fold is the authority when it exists. ──
  if (env.COORDINATOR !== undefined || deps?.readState) {
    const readState = deps?.readState ?? readCoordinatorState;
    let fold: RunFoldState | null = null;
    try {
      fold = await readState(env, args.runUlid);
    } catch {
      fold = null; // unreachable shard ⇒ fall through to the relational row
    }
    if (fold !== null && fold.runId === args.runUlid) {
      const job = fold.jobs[args.jobId];
      if (job === undefined) return { live: false, reason: "not_found" };
      // decideHeartbeat's predicate + wall-clock expiry ("running" accepted
      // defensively should the fold ever grow the phase).
      const phaseOk = job.phase === "claimed" || (job.phase as string) === "running";
      if (
        !phaseOk ||
        job.holder !== args.runnerId ||
        job.leaseEpoch !== args.leaseEpoch ||
        job.leaseExpiresAt === null ||
        Date.parse(job.leaseExpiresAt) <= now.getTime()
      ) {
        return { live: false, reason: "lease_lost" };
      }
      return { live: true };
    }
  }

  // ── Relational (OP2) backend: one SELECT on state.run_jobs. ──
  if (!deps?.executor && !env.PLATFORM_DB) return { live: false, reason: "not_found" };
  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const result = await executor.execute<{ status: string; runner_id: string | null; live: boolean }>(
      `SELECT j.status, j.runner_id,
              (j.runner_id = $5 AND j.status IN ('claimed', 'running') AND j.lease_expires_at > $6) AS live
       FROM state.run_jobs j
       JOIN state.runs r ON r.id = j.run_id AND r.org_id = j.org_id AND r.project_id = j.project_id
       WHERE j.org_id = $1 AND j.project_id = $2 AND r.run_ulid = $3 AND j.job_id = $4`,
      [args.orgId, args.projectId, args.runUlid, args.jobId, args.runnerId, now.toISOString()],
    );
    if (result.rowCount === 0) return { live: false, reason: "not_found" };
    return result.rows[0]!.live === true ? { live: true } : { live: false, reason: "lease_lost" };
  } catch {
    return { live: false, reason: "not_found" }; // fail closed
  } finally {
    if (owned && "dispose" in executor) {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
