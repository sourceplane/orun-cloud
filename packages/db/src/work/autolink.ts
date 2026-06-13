// The delivery-bridge auto-linker (orun-work milestone W2, design §6.1).
//
// Pure decision logic: given the affected component set computed by orun's
// `internal/affected` over a PR's diff (the blast radius `Result.Affected`,
// consumed here as `string[]`) and the PR context, decide which open tasks to
// link and transition — entirely as `actor: automation`. Automation is never
// attributed to a human (invariant 4); a transition only ever moves a task
// forward, never regresses or touches a closed task.
//
// The blast radius this consumes is exactly `orun catalog affected`'s output,
// so the bridge's component matching has parity with the engine by construction
// (the orun-side `internal/workbridge` pins that wire contract).

import type { Actor, Status } from "./model.js";
import type { ProjectScope, WorkRepository, WorkRepositoryError } from "./types.js";

/** The fixed automation principal the PR auto-linker writes as (design §6.1). */
export const AUTOLINK_ACTOR: Actor = { type: "automation", id: "bridge/pr-linker", via: "github-webhook" };

export type PullRequestPhase = "opened" | "ready_for_review" | "merged";

export interface PullRequestContext {
  /** Stable PR reference, e.g. "sourceplane/orun#412". */
  ref: string;
  title: string;
  /** Head branch name, e.g. "feature/ORN-142-route-catalog-reads". */
  branch: string;
  phase: PullRequestPhase;
}

export interface TaskView {
  key: string;
  status: Status;
  /** The task's contract.affects — catalog component keys it claims. */
  affects: string[];
}

export type LinkReason = "component_overlap" | "key_parse";

export interface AutoLink {
  taskKey: string;
  pr: string;
  reason: LinkReason;
  /** The components that matched (empty for a pure key-parse link). */
  matchedComponents: string[];
}

export interface AutoTransition {
  taskKey: string;
  from: Status;
  to: Status;
}

export interface AutoLinkPlan {
  links: AutoLink[];
  transitions: AutoTransition[];
  /** Always the automation principal — surfaced so callers cannot mis-attribute
   *  (invariant 4 assertion point). */
  actor: Actor;
}

// Forward-only status rank. canceled is terminal/off-ladder (-1): automation
// never moves a canceled task. done/released are above the bridge's reach in W2
// (Done/Released are W3, derived from gates + the Deployment overlay).
const RANK: Record<Status, number> = {
  backlog: 0,
  todo: 1,
  in_progress: 2,
  in_review: 3,
  done: 4,
  released: 5,
  canceled: -1,
};

const OPEN: ReadonlySet<Status> = new Set<Status>(["backlog", "todo", "in_progress", "in_review"]);

/** Extract PREFIX-<n> task keys from free text (branch name, PR title). */
export function parseTaskKeys(text: string, prefix: string): string[] {
  const re = new RegExp(`\\b${prefix}-[1-9][0-9]*\\b`, "g");
  return [...new Set(text.match(re) ?? [])];
}

/** The W2 target status for a PR phase, or null if the phase drives no
 *  forward transition (merged → Done is W3). */
function targetFor(phase: PullRequestPhase): Status | null {
  switch (phase) {
    case "opened":
      return "in_progress";
    case "ready_for_review":
      return "in_review";
    case "merged":
      return null; // W3 owns Done/Released
  }
}

/**
 * Compute the auto-link plan for a PR against the affected component set and the
 * project's open tasks. A task is linked when its contract.affects overlaps the
 * blast radius OR its key is named in the branch/title; the resulting transition
 * is forward-only and skips already-closed tasks.
 */
export function computeAutoLinkPlan(
  pr: PullRequestContext,
  affectedComponents: string[],
  tasks: TaskView[],
  prefix: string,
): AutoLinkPlan {
  const affected = new Set(affectedComponents);
  const named = new Set([...parseTaskKeys(pr.branch, prefix), ...parseTaskKeys(pr.title, prefix)]);
  const target = targetFor(pr.phase);

  const links: AutoLink[] = [];
  const transitions: AutoTransition[] = [];

  for (const task of tasks) {
    if (!OPEN.has(task.status)) continue; // never touch done/released/canceled

    const matched = task.affects.filter((c) => affected.has(c));
    const byKey = named.has(task.key);
    if (matched.length === 0 && !byKey) continue;

    // Key-parse is the stronger, explicit signal; prefer it for the reason.
    links.push({
      taskKey: task.key,
      pr: pr.ref,
      reason: byKey ? "key_parse" : "component_overlap",
      matchedComponents: matched,
    });

    if (target && RANK[target] > RANK[task.status]) {
      transitions.push({ taskKey: task.key, from: task.status, to: target });
    }
  }

  return { links, transitions, actor: AUTOLINK_ACTOR };
}

// ── contract.affects → validated component links (Q-5) ────────────────────

export type AffectsResolution = "resolved" | "unresolved";

export interface AffectsLink {
  from: string; // task key
  to: string; // component key
  resolution: AffectsResolution;
}

/**
 * Materialize the `affects` edges from a task's contract.affects. With a catalog
 * resolver, a key that does not resolve degrades to `unresolved` rather than
 * being silently dropped (Q-5); without one, keys are taken as resolved (the
 * pre-catalog posture).
 */
export function materializeAffects(
  taskKey: string,
  affects: string[],
  resolve?: (componentKey: string) => boolean,
): AffectsLink[] {
  return affects.map((to) => ({
    from: taskKey,
    to,
    resolution: resolve ? (resolve(to) ? "resolved" : "unresolved") : "resolved",
  }));
}

// ── Applying the plan through the one write path (WD-3) ───────────────────

export interface AppliedAutoLink {
  /** Count of links + transitions committed. */
  applied: number;
  /** Per-entity failures (e.g. a task removed between planning and apply). */
  rejected: Array<{ key: string; reason: string }>;
}

function describeError(e: WorkRepositoryError): string {
  return "message" in e ? e.message : `${e.kind}: ${e.entity}`;
}

/**
 * Apply an auto-link plan via the W0 repository — every mutation runs through
 * the same mutators the UI and MCP use (one write path, WD-3), tagged with the
 * automation actor so the events render with automation provenance. Planning is
 * pure and tested separately; this is the thin, idempotent commit step.
 */
export async function applyAutoLinkPlan(
  repo: WorkRepository,
  scope: ProjectScope,
  pr: PullRequestContext,
  plan: AutoLinkPlan,
): Promise<AppliedAutoLink> {
  let applied = 0;
  const rejected: AppliedAutoLink["rejected"] = [];

  for (const link of plan.links) {
    const r = await repo.addLink({
      ...scope,
      from: link.taskKey,
      fromKind: "Task",
      type: "implementedBy",
      to: link.pr,
      toKind: "pr",
      actor: plan.actor,
    });
    if (r.ok) applied += 1;
    else rejected.push({ key: link.taskKey, reason: describeError(r.error) });
  }

  for (const t of plan.transitions) {
    const r = await repo.setStatus({
      ...scope,
      key: t.taskKey,
      status: t.to,
      cause: { pr: pr.ref },
      actor: plan.actor,
    });
    if (r.ok) applied += 1;
    else rejected.push({ key: t.taskKey, reason: describeError(r.error) });
  }

  return { applied, rejected };
}
