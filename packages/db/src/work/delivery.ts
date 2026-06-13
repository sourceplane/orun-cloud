// Delivery bridge II — gate-verified Done, Released, drift inbox (orun-work W3).
//
// The "status that cannot rot" core: pure decisions derived from delivery truth,
// never from what anyone says. A task reaches Done only when its contract gates
// verify green from orun execution truth (Q-3); it reaches Released — the status
// no external tracker can have — only from the Deployment overlay (invariant 5);
// and a merge with no claiming task raises a drift item. Everything here is
// `actor: automation`; a human override is a separate, human-attributed move.

import type { Actor, Status } from "./model.js";
import type { PullRequestContext } from "./autolink.js";

/** Automation principal for gate-derived Done decisions. */
export const DELIVERY_ACTOR: Actor = { type: "automation", id: "bridge/delivery", via: "github-webhook" };
/** Automation principal for Released — sourced from the Deployment overlay. */
export const RELEASE_ACTOR: Actor = { type: "automation", id: "bridge/release", via: "deployment-overlay" };

const CLOSED: ReadonlySet<Status> = new Set<Status>(["done", "released", "canceled"]);

// ── Gate-verified Done (design §4.1, Q-3) ─────────────────────────────────

/** A gate's outcome resolved from orun execution truth. Anything other than
 *  `passed` blocks automation from moving a task to Done. */
export type GateState = "passed" | "failed" | "pending" | "missing";

/** The gate outcomes for a merged PR, as resolved from orun execution truth
 *  (the run/check → gate mapping is fixed on the producer side). */
export interface GateReport {
  pr: string;
  gates: Record<string, GateState>;
}

/** A task's gate contract + current status — the input to the Done decision. */
export interface TaskGates {
  key: string;
  status: Status;
  gates: string[];
}

export type DoneReason = "gates_green" | "gate_blocked" | "no_gates";

export interface DoneDecision {
  taskKey: string;
  /** "done" only when every gate passed; otherwise the task parks in_review. */
  to: Extract<Status, "done" | "in_review">;
  reason: DoneReason;
  /** The first gate that is not green — present when reason is "gate_blocked". */
  blockedGate?: string;
}

/**
 * Decide a merged task's status from its gates. All gates green → Done. A gate
 * that is failed/pending/missing → the task parks in_review with that gate
 * surfaced (automation never moves it to Done — that would let status rot). A
 * task with no gates cannot be auto-verified, so it also parks in_review,
 * awaiting a human. Already-closed tasks yield no decision.
 */
export function decideDone(task: TaskGates, report: GateReport): DoneDecision | null {
  if (CLOSED.has(task.status)) return null;
  if (task.gates.length === 0) {
    return { taskKey: task.key, to: "in_review", reason: "no_gates" };
  }
  const blocked = task.gates.find((g) => report.gates[g] !== "passed");
  if (blocked) {
    return { taskKey: task.key, to: "in_review", reason: "gate_blocked", blockedGate: blocked };
  }
  return { taskKey: task.key, to: "done", reason: "gates_green" };
}

/** Whether automation may move this task to Done — false whenever any gate is
 *  not green (or none are defined). A human may still override; that override is
 *  recorded as a human-attributed move, never automation (invariant 4). */
export function automationDoneAllowed(task: TaskGates, report: GateReport): boolean {
  const d = decideDone(task, report);
  return d?.to === "done";
}

// ── Released, from the Deployment overlay (design §4.3, invariant 5) ───────

/** A Deployment-overlay observation: a revision is live in an environment. Only
 *  `source: "overlay"` (observed live state) releases tasks — a deploy *attempt*
 *  never does (invariant 5). */
export interface DeploymentObservation {
  source: "overlay" | "attempt";
  /** Deployment ref used as the `delivers` edge endpoint, e.g. "deploy:prod@<rev>". */
  ref: string;
  environment: string;
  revision: string;
}

export interface ReleaseDecision {
  taskKey: string;
  /** The `delivers` edge endpoint (Deployment → Task). */
  deploymentRef: string;
  environment: string;
}

/**
 * Decide which delivered tasks become Released. Released is derived ONLY from an
 * overlay observation of live state (invariant 5); a deploy attempt yields
 * nothing. Tasks already released or canceled are left alone.
 */
export function decideReleased(
  obs: DeploymentObservation,
  deliveredTasks: Array<{ key: string; status: Status }>,
): ReleaseDecision[] {
  if (obs.source !== "overlay") return []; // invariant 5: never from an attempt
  return deliveredTasks
    .filter((t) => t.status !== "released" && t.status !== "canceled")
    .map((t) => ({ taskKey: t.key, deploymentRef: obs.ref, environment: obs.environment }));
}

// ── Drift inbox (design §4 / §6.x) ────────────────────────────────────────

export interface DriftItem {
  pr: string;
  components: string[];
}

/**
 * Raise a drift item for an unplanned merge: a merged PR whose affected
 * components are claimed by no open task. A PR with at least one claiming task,
 * or any non-merge phase, raises nothing — so exactly one drift item per
 * genuinely unplanned merge.
 */
export function detectDrift(
  pr: PullRequestContext,
  affectedComponents: string[],
  claimingTaskKeys: string[],
): DriftItem | null {
  if (pr.phase !== "merged") return null;
  if (claimingTaskKeys.length > 0) return null;
  return { pr: pr.ref, components: affectedComponents };
}
