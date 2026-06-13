// PR auto-link ingestion orchestrator (orun-work W2 ingestion).
//
// Ties the live path together: a GitHub `pull_request` webhook + the affected
// component set (produced by orun's `internal/affected`, crossing the seam as
// the workbridge AffectedSet) → load the project's open tasks → compute the
// auto-link plan → apply it through the W0 one write path. The affected
// computation itself runs in orun (CI / a future affected-worker); this layer
// receives its result, so the cloud never re-implements the closure.

import {
  applyAutoLinkPlan,
  computeAutoLinkPlan,
  type AppliedAutoLink,
  type AutoLinkRepo,
} from "./autolink.js";
import type { Status } from "./model.js";
import type { ProjectScope, WorkResult } from "./types.js";
import { parsePullRequestEvent, type GithubPullRequestEvent } from "./webhook.js";

/** The workbridge wire DTO (orun `internal/workbridge.AffectedSet`): the PR's
 *  blast radius, identical to `orun catalog affected`'s `affected` field. */
export interface AffectedSet {
  pr: string;
  components: string[];
  dependents?: string[];
}

/** The repository slice the ingestion path needs: read open tasks + write
 *  links/transitions. WorkRepository satisfies it; tests use an in-memory fake. */
export type IngestRepo = AutoLinkRepo & {
  listOpenTasks(scope: ProjectScope): Promise<WorkResult<Array<{ key: string; status: Status; affects: string[] }>>>;
};

export type IngestOutcome =
  | { ingested: false; reason: "ignored_action" }
  | ({ ingested: true; pr: string } & AppliedAutoLink);

/**
 * Ingest a GitHub PR event: parse it, and (for an actionable phase) link and
 * transition the matching open tasks against the affected set. Returns an
 * "ignored" outcome for actions that drive no auto-linking, so callers can ack
 * the webhook uniformly.
 */
export async function ingestPullRequest(
  repo: IngestRepo,
  scope: ProjectScope,
  event: GithubPullRequestEvent,
  affected: AffectedSet,
  prefix: string,
): Promise<IngestOutcome> {
  const pr = parsePullRequestEvent(event);
  if (!pr) return { ingested: false, reason: "ignored_action" };

  const tasksRes = await repo.listOpenTasks(scope);
  if (!tasksRes.ok) {
    // A read failure surfaces as zero work rather than a thrown webhook — the
    // caller acks and the next event re-affirms.
    return { ingested: true, pr: pr.ref, applied: 0, rejected: [{ key: "*", reason: describe(tasksRes) }] };
  }

  const plan = computeAutoLinkPlan(pr, affected.components, tasksRes.value, prefix);
  const applied = await applyAutoLinkPlan(repo, scope, pr, plan);
  return { ingested: true, pr: pr.ref, ...applied };
}

function describe(res: Extract<WorkResult<unknown>, { ok: false }>): string {
  const e = res.error;
  return "message" in e ? e.message : `${e.kind}: ${e.entity}`;
}
