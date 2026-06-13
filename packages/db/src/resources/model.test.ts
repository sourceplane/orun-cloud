import { describe, expect, it } from "vitest";
import {
  RESOURCE_API_VERSION,
  RuntimeError,
  applyDeploymentEvent,
  liveObservation,
  reconcile,
  resourcePhaseFor,
  type Deployment,
  type Resource,
} from "./model.js";

function resource(over: Partial<Resource["metadata"]> = {}): Resource {
  return {
    apiVersion: RESOURCE_API_VERSION,
    kind: "Resource",
    metadata: {
      id: "res_1", resourceType: "database.instance", orgId: "org_1", projectId: "proj_1",
      environmentId: "env_prod", name: "primary", generation: 2, createdAt: "2026-06-11T09:00:00Z",
      updatedAt: "2026-06-11T09:00:00Z", ...over,
    },
    spec: { size: "small" },
    status: { phase: "pending", observedGeneration: 1, conditions: [] },
  };
}

function deployment(over: Partial<Deployment> = {}): Deployment {
  return {
    id: "dep_1", resourceId: "res_1", orgId: "org_1", projectId: "proj_1", environmentId: "env_prod",
    intent: "create", generation: 2, phase: "queued", ...over,
  };
}

const AT = "2026-06-11T09:05:00Z";

describe("runtime — deployment transitions (component 08)", () => {
  it("advances queued → running → succeeded with a revision and outputs", () => {
    let d = deployment();
    d = applyDeploymentEvent(d, { kind: "started", at: AT });
    expect(d.phase).toBe("running");
    d = applyDeploymentEvent(d, { kind: "step_completed", step: "provision", at: AT });
    expect(d.phase).toBe("running");
    d = applyDeploymentEvent(d, { kind: "completed", at: AT, revision: "rev-abc", outputs: { host: "db.internal" } });
    expect(d.phase).toBe("succeeded");
    expect(d.revision).toBe("rev-abc");
    expect(d.outputs).toEqual({ host: "db.internal" });
  });

  it("advances to failed and records the failure", () => {
    let d = applyDeploymentEvent(deployment(), { kind: "started", at: AT });
    d = applyDeploymentEvent(d, { kind: "failed", at: AT, failure: { code: "quota", message: "over quota", retriable: true } });
    expect(d.phase).toBe("failed");
    expect(d.failure?.code).toBe("quota");
  });

  it("rejects events on a terminal deployment (idempotency guard)", () => {
    const done = deployment({ phase: "succeeded" });
    expect(() => applyDeploymentEvent(done, { kind: "completed", at: AT })).toThrow(RuntimeError);
  });
});

describe("runtime — resource phase mapping + reconcile", () => {
  it("maps create/update progress to resource phases", () => {
    expect(resourcePhaseFor("create", "queued")).toBe("pending");
    expect(resourcePhaseFor("create", "running")).toBe("provisioning");
    expect(resourcePhaseFor("create", "succeeded")).toBe("ready");
    expect(resourcePhaseFor("create", "failed")).toBe("failed");
  });

  it("maps delete progress to deleting/deleted/degraded", () => {
    expect(resourcePhaseFor("delete", "running")).toBe("deleting");
    expect(resourcePhaseFor("delete", "succeeded")).toBe("deleted");
    expect(resourcePhaseFor("delete", "failed")).toBe("degraded");
  });

  it("reconciles a succeeded deployment onto the resource: ready + observedGeneration + Ready condition", () => {
    const d = deployment({ phase: "succeeded", revision: "rev-1", outputs: { host: "h" } });
    const r = reconcile(resource(), d, AT);
    expect(r.status.phase).toBe("ready");
    expect(r.status.observedGeneration).toBe(2);
    expect(r.status.lastDeploymentId).toBe("dep_1");
    expect(r.status.outputs).toEqual({ host: "h" });
    const ready = r.status.conditions.find((c) => c.type === "Ready");
    expect(ready?.status).toBe("true");
  });

  it("reconciles a failed deployment: failed phase, Ready=false, failure surfaced, generation observed", () => {
    const d = deployment({ phase: "failed", failure: { code: "x", message: "boom", retriable: false } });
    const r = reconcile(resource(), d, AT);
    expect(r.status.phase).toBe("failed");
    // A terminal deployment (success OR failure) means the controller fully
    // processed this generation; observedGeneration advances, the failed phase +
    // failure record the outcome.
    expect(r.status.observedGeneration).toBe(2);
    expect(r.status.failure?.code).toBe("x");
    expect(r.status.conditions.find((c) => c.type === "Ready")?.status).toBe("false");
  });

  it("does not advance observedGeneration while still running", () => {
    const r = reconcile(resource(), deployment({ phase: "running" }), AT);
    expect(r.status.phase).toBe("provisioning");
    expect(r.status.observedGeneration).toBe(1);
  });
});

describe("runtime → work seam (Deployment overlay → Released)", () => {
  it("yields a live overlay observation for a succeeded create/update with a revision", () => {
    const obs = liveObservation(deployment({ phase: "succeeded", revision: "rev-9" }));
    expect(obs).toEqual({ source: "overlay", ref: "deploy:env_prod@rev-9", environment: "env_prod", revision: "rev-9" });
  });

  it("yields nothing for delete intents, non-succeeded, or missing revision", () => {
    expect(liveObservation(deployment({ intent: "delete", phase: "succeeded", revision: "r" }))).toBeNull();
    expect(liveObservation(deployment({ phase: "running", revision: "r" }))).toBeNull();
    expect(liveObservation(deployment({ phase: "succeeded" }))).toBeNull();
  });
});
