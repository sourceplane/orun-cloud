// scm.* → work.observations projection (orun-work v2 WP2).
//
// The GitHub webhook ingester: maps the integrations-worker's NORMALIZED
// scm.* payloads (never raw provider JSON) onto the work plane's
// world-authored fact log. Pure — the drain applies the outputs inside its
// delivery transaction via insertWorkObservation.
//
// Discipline (P-2, invariant 4): every observation names the versioned
// source and carries a semantic dedupeKey, so webhook redeliveries fold
// identically. Task keys parse from the source branch + PR title
// (the auto-claim short-circuit); the `affected` component set is NOT
// available from GitHub — it arrives from the orun/CI producer (WP2's
// second half) and until then claims ride key parse only.

import { taskKeysIn } from "./model.js";
import type { IngestObservationInput } from "./types.js";

export const WORK_SCM_SOURCE = "github-webhook";
export const WORK_SCM_SOURCE_VERSION = 1;

/** The normalized scm payload fields this projector reads (a structural
 *  subset of the integrations contract's PR/push/branch payload v1). */
export interface ScmWorkPayload {
  repo?: { fullName?: string } | undefined;
  number?: number;
  title?: string;
  state?: string;
  sourceBranch?: string;
  headSha?: string;
  branch?: string;
  afterSha?: string;
}

/** Observation minus the workspace (the drain fills it per target org). */
export type WorkObservationDraft = Omit<IngestObservationInput, "workspace">;

function prId(full: string, number: number): string {
  return `${full}#${number}`;
}

/**
 * Maps one normalized scm event to work observations (usually 0 or 1).
 * Unknown event types yield [] — the work plane only consumes the PR/branch
 * trajectory here; checks and releases ride WP3's ingesters.
 */
export function workObservationsFromScm(
  type: string,
  payload: Record<string, unknown>,
  at: string,
): WorkObservationDraft[] {
  const p = payload as ScmWorkPayload;
  const full = p.repo?.fullName ?? "";
  if (!full) return [];

  switch (type) {
    case "scm.branch.created": {
      if (!p.branch) return [];
      return [
        {
          source: WORK_SCM_SOURCE,
          sourceVersion: WORK_SCM_SOURCE_VERSION,
          kind: "branch_seen",
          at,
          dedupeKey: `gh:branch:${full}:${p.branch}`,
          payload: { branch: p.branch, taskKeys: taskKeysIn(p.branch) },
        },
      ];
    }
    case "scm.push": {
      if (!p.branch) return [];
      const keys = taskKeysIn(p.branch);
      if (keys.length === 0) return []; // pushes to unclaiming branches are noise
      return [
        {
          source: WORK_SCM_SOURCE,
          sourceVersion: WORK_SCM_SOURCE_VERSION,
          kind: "branch_seen",
          at,
          dedupeKey: `gh:branch:${full}:${p.branch}:${p.afterSha ?? ""}`,
          payload: { branch: p.branch, taskKeys: keys },
        },
      ];
    }
    case "scm.pull_request.opened":
    case "scm.pull_request.updated": {
      if (typeof p.number !== "number") return [];
      const id = prId(full, p.number);
      const taskKeys = taskKeysIn(`${p.sourceBranch ?? ""} ${p.title ?? ""}`);
      const dedupe =
        type === "scm.pull_request.opened"
          ? `gh:pr:${id}:opened`
          : `gh:pr:${id}:upd:${p.headSha ?? ""}`;
      return [
        {
          source: WORK_SCM_SOURCE,
          sourceVersion: WORK_SCM_SOURCE_VERSION,
          kind: "pr_opened",
          at,
          dedupeKey: dedupe,
          payload: {
            pr: id,
            branch: p.sourceBranch,
            title: p.title,
            taskKeys,
          },
        },
      ];
    }
    case "scm.pull_request.merged": {
      if (typeof p.number !== "number") return [];
      const id = prId(full, p.number);
      return [
        {
          source: WORK_SCM_SOURCE,
          sourceVersion: WORK_SCM_SOURCE_VERSION,
          kind: "pr_merged",
          at,
          dedupeKey: `gh:pr:${id}:merged`,
          payload: {
            pr: id,
            // The head sha stands in for the merged revision until the
            // deploy-overlay feed correlates the merge commit (WP3).
            revision: p.headSha,
            taskKeys: taskKeysIn(`${p.sourceBranch ?? ""} ${p.title ?? ""}`),
          },
        },
      ];
    }
    case "scm.pull_request.closed": {
      if (typeof p.number !== "number") return [];
      const id = prId(full, p.number);
      return [
        {
          source: WORK_SCM_SOURCE,
          sourceVersion: WORK_SCM_SOURCE_VERSION,
          kind: "pr_closed",
          at,
          dedupeKey: `gh:pr:${id}:closed`,
          payload: { pr: id },
        },
      ];
    }
    default:
      return [];
  }
}
