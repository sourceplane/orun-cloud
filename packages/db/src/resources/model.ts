// Resources + runtime model core (saas-resources-runtime, the P2 moat).
//
// Pure, DB-agnostic decision logic for manifested project resources and the
// runtime that reconciles them (components 06 + 08; contracts
// resource-contract.schema.yaml). A Resource follows kind/spec/status; the
// runtime drives a Deployment from queued → running → succeeded/failed and
// reconciles the resulting phase back onto the resource. The SQL repository and
// the Cloudflare Workflows/Durable-Object runtime are thin shells over this.
//
// The connection to orun-work is `liveObservation`: a create/update deployment
// that succeeds means a revision is live in an environment — exactly the
// Deployment-overlay observation the work plane's W3 Released automation
// consumes. That bridge is the "seamless SaaS" seam.

export const RESOURCE_API_VERSION = "sourceplane.io/v1alpha1";

// ── Resource (component 06 / resource-contract.schema.yaml) ────────────────

export const RESOURCE_PHASES = [
  "draft",
  "pending",
  "provisioning",
  "ready",
  "degraded",
  "failed",
  "deleting",
  "deleted",
] as const;
export type ResourcePhase = (typeof RESOURCE_PHASES)[number];

export type ConditionStatus = "true" | "false" | "unknown";

export interface ResourceCondition {
  type: string;
  status: ConditionStatus;
  reason?: string | undefined;
  message?: string | undefined;
  updatedAt: string;
}

export interface ResourceMetadata {
  id: string;
  resourceType: string; // e.g. "database.instance"
  orgId: string;
  projectId: string;
  environmentId: string;
  name: string;
  labels?: Record<string, string> | undefined;
  componentRef?: { name: string; version?: string } | undefined;
  generation: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | undefined;
}

export interface ResourceFailure {
  code: string;
  message: string;
  retriable: boolean;
}

export interface ResourceStatus {
  phase: ResourcePhase;
  observedGeneration: number;
  conditions: ResourceCondition[];
  outputs?: Record<string, unknown> | undefined;
  lastDeploymentId?: string | undefined;
  failure?: ResourceFailure | undefined;
}

export interface Resource {
  apiVersion: string;
  kind: "Resource";
  metadata: ResourceMetadata;
  spec: Record<string, unknown>;
  status: ResourceStatus;
}

// ── Deployment (component 08 runtime orchestration) ────────────────────────

export const DEPLOYMENT_PHASES = ["queued", "running", "succeeded", "failed"] as const;
export type DeploymentPhase = (typeof DEPLOYMENT_PHASES)[number];

export type DeploymentIntent = "create" | "update" | "delete";

export interface Deployment {
  id: string;
  resourceId: string;
  orgId: string;
  projectId: string;
  environmentId: string;
  intent: DeploymentIntent;
  /** The resource generation this deployment reconciles. */
  generation: number;
  phase: DeploymentPhase;
  revision?: string | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  outputs?: Record<string, unknown> | undefined;
  failure?: ResourceFailure | undefined;
}

/** Runtime events that advance a deployment (component 08 §events). */
export type DeploymentEvent =
  | { kind: "started"; at: string }
  | { kind: "step_completed"; step: string; at: string }
  | { kind: "completed"; at: string; revision?: string; outputs?: Record<string, unknown> }
  | { kind: "failed"; at: string; failure: ResourceFailure };

export class RuntimeError extends Error {
  readonly kind: "invalid_transition" | "invalid_argument";
  constructor(kind: "invalid_transition" | "invalid_argument", message: string) {
    super(message);
    this.name = "RuntimeError";
    this.kind = kind;
  }
}

const TERMINAL: ReadonlySet<DeploymentPhase> = new Set<DeploymentPhase>(["succeeded", "failed"]);

/**
 * Fold a runtime event into a deployment. Transitions are one-way: queued →
 * running (started) → succeeded (completed) | failed (failed). A terminal
 * deployment rejects further events (a duplicate completion is a no-op-safe
 * error, supporting the idempotency invariant in component 08).
 */
export function applyDeploymentEvent(d: Deployment, ev: DeploymentEvent): Deployment {
  if (TERMINAL.has(d.phase)) {
    throw new RuntimeError("invalid_transition", `deployment ${d.id} is terminal (${d.phase})`);
  }
  switch (ev.kind) {
    case "started":
      return { ...d, phase: "running", startedAt: d.startedAt ?? ev.at };
    case "step_completed":
      // Progress only; phase stays running. (Steps persist separately.)
      return d.phase === "running" ? d : { ...d, phase: "running", startedAt: d.startedAt ?? ev.at };
    case "completed":
      return {
        ...d,
        phase: "succeeded",
        finishedAt: ev.at,
        revision: ev.revision ?? d.revision,
        outputs: ev.outputs ?? d.outputs,
      };
    case "failed":
      return { ...d, phase: "failed", finishedAt: ev.at, failure: ev.failure };
  }
}

/** The resource phase implied by a deployment's intent + phase. */
export function resourcePhaseFor(intent: DeploymentIntent, phase: DeploymentPhase): ResourcePhase {
  if (intent === "delete") {
    switch (phase) {
      case "queued":
        return "pending";
      case "running":
        return "deleting";
      case "succeeded":
        return "deleted";
      case "failed":
        return "degraded";
    }
  }
  switch (phase) {
    case "queued":
      return "pending";
    case "running":
      return "provisioning";
    case "succeeded":
      return "ready";
    case "failed":
      return "failed";
  }
}

/**
 * Reconcile a deployment's progress onto its resource: set the phase, advance
 * observedGeneration when terminal, carry outputs/failure, and stamp the Ready
 * condition. The resource status is derived from runtime truth, never asserted.
 */
export function reconcile(resource: Resource, deployment: Deployment, at: string): Resource {
  // Monotonicity guard (component 08: terminal-idempotent). `observedGeneration`
  // only advances when a deployment reaches a terminal phase, so a deployment
  // for an older generation — or a non-terminal event for a generation the
  // resource has already fully reconciled — is necessarily stale (out-of-order
  // delivery). Ignoring it keeps a `ready`/terminal resource from regressing
  // back to `provisioning`/`pending`. Re-applying the same terminal deployment
  // recomputes the identical terminal status (idempotent).
  if (
    deployment.generation < resource.status.observedGeneration ||
    (deployment.generation === resource.status.observedGeneration && !TERMINAL.has(deployment.phase))
  ) {
    return resource;
  }
  const phase = resourcePhaseFor(deployment.intent, deployment.phase);
  const ready = phase === "ready";
  const condition: ResourceCondition = {
    type: "Ready",
    status: ready ? "true" : deployment.phase === "failed" ? "false" : "unknown",
    reason: deployment.failure?.code,
    message: deployment.failure?.message,
    updatedAt: at,
  };
  const conditions = [
    ...resource.status.conditions.filter((c) => c.type !== "Ready"),
    condition,
  ];
  return {
    ...resource,
    status: {
      ...resource.status,
      phase,
      observedGeneration: TERMINAL.has(deployment.phase) ? deployment.generation : resource.status.observedGeneration,
      conditions,
      outputs: deployment.outputs ?? resource.status.outputs,
      lastDeploymentId: deployment.id,
      failure: deployment.phase === "failed" ? deployment.failure : undefined,
    },
  };
}

// ── The seam to orun-work (Deployment overlay → Released) ──────────────────

/** The work-plane Deployment-overlay observation shape (mirrors
 *  @saas/db/work `DeploymentObservation`), kept structurally compatible so the
 *  bridge needs no import cycle. `source: "overlay"` denotes observed live
 *  state — the only thing that releases work tasks (work invariant 5). */
export interface LiveObservation {
  source: "overlay";
  ref: string;
  environment: string;
  revision: string;
}

/**
 * The observation a succeeded create/update deployment yields: the revision is
 * live in the environment. Returns null for delete intents, non-terminal/failed
 * deployments, or a missing revision — so only a genuine go-live releases work.
 */
export function liveObservation(deployment: Deployment): LiveObservation | null {
  if (deployment.intent === "delete") return null;
  if (deployment.phase !== "succeeded") return null;
  if (!deployment.revision) return null;
  return {
    source: "overlay",
    ref: `deploy:${deployment.environmentId}@${deployment.revision}`,
    environment: deployment.environmentId,
    revision: deployment.revision,
  };
}
