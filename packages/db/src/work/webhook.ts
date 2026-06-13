// GitHub pull_request webhook → auto-linker input (orun-work W2 ingestion).
//
// The live half of the delivery bridge: a GitHub `pull_request` event names the
// PR, its phase, and its head branch; this maps it to the PullRequestContext the
// auto-linker consumes. Pure and side-effect free — the orchestration that runs
// the affected engine and applies the plan lives in ./ingest.ts.

import type { PullRequestContext, PullRequestPhase } from "./autolink.js";

/** The slice of a GitHub `pull_request` webhook payload we read. */
export interface GithubPullRequestEvent {
  action: string;
  number?: number;
  pull_request: {
    number?: number;
    title: string;
    html_url?: string;
    merged?: boolean;
    head: { ref: string };
  };
  repository?: { full_name?: string };
}

/** Map a GitHub PR action to a delivery-bridge phase, or null for actions the
 *  auto-linker ignores (label changes, assignments, unmerged close, …). */
function phaseFor(event: GithubPullRequestEvent): PullRequestPhase | null {
  switch (event.action) {
    case "opened":
    case "reopened":
    case "synchronize": // new commits — re-affirm links against the latest diff
      return "opened";
    case "ready_for_review":
      return "ready_for_review";
    case "closed":
      return event.pull_request.merged ? "merged" : null;
    default:
      return null;
  }
}

/**
 * Parse a GitHub `pull_request` webhook into the auto-linker's PullRequestContext,
 * or null when the action drives no auto-linking. The PR ref is the stable
 * `owner/repo#number` form used as the `implementedBy` link target.
 */
export function parsePullRequestEvent(event: GithubPullRequestEvent): PullRequestContext | null {
  const phase = phaseFor(event);
  if (!phase) return null;

  const number = event.pull_request.number ?? event.number;
  const repo = event.repository?.full_name;
  const ref = repo && number ? `${repo}#${number}` : (event.pull_request.html_url ?? `pr#${number ?? "unknown"}`);

  return {
    ref,
    title: event.pull_request.title,
    branch: event.pull_request.head.ref,
    phase,
  };
}
