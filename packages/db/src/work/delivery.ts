// Execution truth → work observations (orun-work v2 WP3).
//
// Two named internal ingesters, both pure (the callers apply the drafts via
// insertWorkObservation inside their own transactions):
//
//   * run-stream — the native-coordination run fold. Gates come from orun's
//     OWN execution truth, never re-derived GitHub statuses (P-3): a gate
//     name is a run job id, its verdict the job's terminal phase, its
//     revision the run's git commit. A gate GitHub reports green but orun
//     has no record of stays unknown and parks the task In Review.
//
//   * deploy-overlay — the resources-runtime liveObservation: a deployment
//     reconciling to LIVE (never a deploy attempt — invariant 5) becomes a
//     revision_live fact, the only thing Released derives from.

import type { WorkObservationDraft } from "./scm.js";

export const WORK_RUN_SOURCE = "run-stream";
export const WORK_RUN_SOURCE_VERSION = 1;
export const WORK_OVERLAY_SOURCE = "deploy-overlay";
export const WORK_OVERLAY_SOURCE_VERSION = 1;

/** The slice of the coordination RunFoldState the gate projector reads. */
export interface RunFoldJobs {
  jobs: Record<string, { phase: string }>;
}

const GREEN_PHASES = new Set(["succeeded", "memoized"]);
const RED_PHASES = new Set(["failed", "timed_out"]);

/**
 * Maps a run fold's terminal jobs onto gate_result facts. Non-terminal jobs
 * yield nothing (unknown renders unknown); a run without git provenance
 * yields nothing (no revision to bind a verdict to — honest degradation).
 * Dedupe is per (run, job, phase): projection sweeps re-emit idempotently,
 * and a retried job that later flips phase lands a NEW fact whose later seq
 * wins in the fold.
 */
export function gateObservationsFromRunFold(
  runId: string,
  gitCommit: string | null,
  fold: RunFoldJobs,
  at: string,
): WorkObservationDraft[] {
  if (!gitCommit) return [];
  const drafts: WorkObservationDraft[] = [];
  for (const jobId of Object.keys(fold.jobs).sort()) {
    const phase = fold.jobs[jobId]!.phase;
    const status = GREEN_PHASES.has(phase) ? "green" : RED_PHASES.has(phase) ? "red" : null;
    if (!status) continue;
    drafts.push({
      source: WORK_RUN_SOURCE,
      sourceVersion: WORK_RUN_SOURCE_VERSION,
      kind: "gate_result",
      at,
      dedupeKey: `run:${runId}:${jobId}:${phase}`,
      payload: { gate: jobId, revision: gitCommit, status, runRef: runId },
    });
  }
  return drafts;
}

/** The resources-runtime liveObservation shape (structurally compatible with
 *  @saas/db/resources LiveObservation — no import cycle). */
export interface LiveDeploymentObservation {
  source: "overlay";
  ref: string;
  environment: string;
  revision: string;
}

/**
 * Maps a live-deployment observation onto the revision_live fact Released
 * derives from. The runtime wiring lands with saas-resources-runtime (P2);
 * until then this seam is exercised by fixture feeds only.
 */
export function workObservationFromLiveDeployment(
  live: LiveDeploymentObservation,
  at: string,
): WorkObservationDraft | null {
  if (live.source !== "overlay" || !live.revision || !live.environment) return null;
  return {
    source: WORK_OVERLAY_SOURCE,
    sourceVersion: WORK_OVERLAY_SOURCE_VERSION,
    kind: "revision_live",
    at,
    dedupeKey: `overlay:${live.revision}:${live.environment}`,
    payload: {
      revision: live.revision,
      environment: live.environment,
      deploymentRef: live.ref,
    },
  };
}
