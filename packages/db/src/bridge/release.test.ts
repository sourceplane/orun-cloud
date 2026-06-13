import { describe, expect, it } from "vitest";
import type { Deployment } from "../resources/model.js";
import type { WorkEvent } from "../work/model.js";
import type { CommitOutcome, LinkInput, SetStatusInput, WorkResult } from "../work/types.js";
import { releaseDecisions, releaseDeliveredTasks, type DeliveredTask } from "./release.js";

const SCOPE = { orgId: "org_1", projectId: "proj_1" };

function deployment(over: Partial<Deployment> = {}): Deployment {
  return {
    id: "dep_1", resourceId: "res_1", orgId: "org_1", projectId: "proj_1", environmentId: "env_prod",
    intent: "create", generation: 1, phase: "succeeded", revision: "rev-1", ...over,
  };
}

function stub(subject: string): WorkEvent {
  return { eventId: "wev_s", project: "org_1/proj_1", subject, kind: "link_added", actor: { type: "automation", id: "x" }, at: "2026-06-11T09:00:00Z", seq: 0 };
}

class FakeRepo {
  links: LinkInput[] = [];
  statuses: SetStatusInput[] = [];
  async addLink(input: LinkInput): Promise<WorkResult<CommitOutcome>> {
    this.links.push(input);
    return { ok: true, value: { event: stub(input.from), key: input.from } };
  }
  async setStatus(input: SetStatusInput): Promise<WorkResult<CommitOutcome>> {
    this.statuses.push(input);
    return { ok: true, value: { event: stub(input.key), key: input.key } };
  }
}

const delivered = (...t: DeliveredTask[]): DeliveredTask[] => t;

describe("runtime → work Released bridge (the seamless seam)", () => {
  it("releases delivered tasks when a create deployment goes live", async () => {
    const repo = new FakeRepo();
    const out = await releaseDeliveredTasks(repo, SCOPE, deployment(), delivered({ key: "ORN-1", status: "done" }, { key: "ORN-2", status: "in_review" }));

    expect(out.released).toBe(2);
    expect(repo.statuses.map((s) => [s.key, s.status])).toEqual([["ORN-1", "released"], ["ORN-2", "released"]]);
    // A delivers edge (Deployment → Task) is recorded, automation-attributed.
    expect(repo.links[0]).toMatchObject({ from: "deploy:env_prod@rev-1", type: "delivers", to: "ORN-1", actor: { type: "automation" } });
    expect(repo.statuses[0]?.cause).toEqual({ deployment: "deploy:env_prod@rev-1" });
  });

  it("releases nothing for a deployment that is not live (invariant 5)", async () => {
    const repo = new FakeRepo();
    expect(releaseDecisions(deployment({ phase: "running" }), delivered({ key: "ORN-1", status: "done" }))).toEqual([]);
    const out = await releaseDeliveredTasks(repo, SCOPE, deployment({ phase: "running" }), delivered({ key: "ORN-1", status: "done" }));
    expect(out.released).toBe(0);
    expect(repo.links).toHaveLength(0);
    expect(repo.statuses).toHaveLength(0);
  });

  it("releases nothing for a delete deployment", async () => {
    const repo = new FakeRepo();
    const out = await releaseDeliveredTasks(repo, SCOPE, deployment({ intent: "delete" }), delivered({ key: "ORN-1", status: "done" }));
    expect(out.released).toBe(0);
  });

  it("skips tasks already released or canceled", async () => {
    const repo = new FakeRepo();
    const out = await releaseDeliveredTasks(repo, SCOPE, deployment(), delivered({ key: "ORN-1", status: "released" }, { key: "ORN-2", status: "canceled" }));
    expect(out.released).toBe(0);
    expect(repo.statuses).toHaveLength(0);
  });
});
