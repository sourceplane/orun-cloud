// PM3 cycle tests (orun-work-v3): authored time-boxes whose progress is
// derived, never entered. The burn-up is the fold replayed day by day —
// these tests plant events/observations at known dates and assert the
// series moves ONLY when facts (or planning intent) arrive. V3-3 is held by
// construction: there is no API in the repository or the burnup module that
// accepts a series point.

import { describe, expect, it } from "vitest";
import { burnup } from "./burnup.js";
import { MemoryWorkRepository } from "./memory.js";

const SCOPE = { orgId: "org-1" };
const USER = { type: "user" as const, id: "usr_1" };
const clock = () => "2026-07-01T00:00:00Z";

describe("cycle CRUD (intent rows beside the logs)", () => {
  it("allocates CYC-n keys, validates dates, appends no event", async () => {
    const repo = new MemoryWorkRepository(clock);
    const c1 = await repo.createCycle(SCOPE, { name: "Cycle 1", startsAt: "2026-07-01", endsAt: "2026-07-14", actor: USER });
    const c2 = await repo.createCycle(SCOPE, { name: "Cycle 2", startsAt: "2026-07-15", endsAt: "2026-07-28", actor: USER });
    expect(c1.key).toBe("CYC-1");
    expect(c2.key).toBe("CYC-2");
    expect(await repo.listEvents(SCOPE)).toHaveLength(0); // creating a box is not coordination

    await expect(
      repo.createCycle(SCOPE, { name: "backwards", startsAt: "2026-07-14", endsAt: "2026-07-01", actor: USER }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      repo.createCycle(SCOPE, { name: " ", startsAt: "2026-07-01", endsAt: "2026-07-02", actor: USER }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("setCycle plans a task in (one event) and null clears; unknown cycles 404", async () => {
    const repo = new MemoryWorkRepository(clock);
    const { key } = await repo.createTask(SCOPE, { prefix: "ORN", title: "t", actor: USER });
    const cycle = await repo.createCycle(SCOPE, { name: "C", startsAt: "2026-07-01", endsAt: "2026-07-14", actor: USER });

    await repo.setCycle(SCOPE, { key, cycle: cycle.key, actor: USER });
    expect(repo.envelopes(SCOPE).tasks[0]!.cycleKey).toBe(cycle.key);

    await repo.setCycle(SCOPE, { key, cycle: null, actor: USER });
    expect(repo.envelopes(SCOPE).tasks[0]!.cycleKey).toBeUndefined();

    await expect(repo.setCycle(SCOPE, { key, cycle: "CYC-99", actor: USER })).rejects.toMatchObject({
      code: "not_found",
    });
    const kinds = (await repo.listEvents(SCOPE)).map((e) => e.kind);
    expect(kinds.filter((k) => k === "cycle_set")).toHaveLength(2); // exactly one per mutation
  });
});

describe("the derived burn-up (V3-3: replayed, never stored)", () => {
  it("scope rises when tasks are planned in; done rises when facts arrive", async () => {
    const repo = new MemoryWorkRepository(clock);
    const cycle = await repo.createCycle(SCOPE, { name: "C", startsAt: "2026-07-01", endsAt: "2026-07-04", actor: USER });
    const a = (
      await repo.createTask(SCOPE, {
        prefix: "ORN",
        title: "a",
        contract: { goal: "g", affects: ["x"], doneWhen: ["d"], gatesDefined: true },
        actor: USER,
        at: "2026-07-01T08:00:00Z",
      })
    ).key;
    const b = (
      await repo.createTask(SCOPE, { prefix: "ORN", title: "b", actor: USER, at: "2026-07-01T08:00:00Z" })
    ).key;

    // Day 1: a planned in. Day 2: b planned in. Day 3: a's merge fact lands.
    await repo.setCycle(SCOPE, { key: a, cycle: cycle.key, actor: USER, at: "2026-07-01T09:00:00Z" });
    await repo.setCycle(SCOPE, { key: b, cycle: cycle.key, actor: USER, at: "2026-07-02T09:00:00Z" });
    await repo.ingestObservation(SCOPE, {
      workspace: SCOPE.orgId,
      source: "github-webhook",
      sourceVersion: 1,
      kind: "pr_merged",
      at: "2026-07-03T10:00:00Z",
      dedupeKey: "pr:1:merged",
      payload: { pr: "o/r#1", revision: "sha256:aa", taskKeys: [a] },
    });

    const ws = await repo.getWorkSet(SCOPE);
    const points = burnup(ws, cycle);
    expect(points.map((p) => `${p.date} ${p.scope}/${p.done}`)).toEqual([
      "2026-07-01 1/0",
      "2026-07-02 2/0",
      "2026-07-03 2/1",
      "2026-07-04 2/1",
    ]);
    // Carry-over IS the gap at the end — nothing to move by hand.
  });

  it("caps at `until` so future days render as nothing, not a flat line", async () => {
    const repo = new MemoryWorkRepository(clock);
    const cycle = await repo.createCycle(SCOPE, { name: "C", startsAt: "2026-07-01", endsAt: "2026-07-30", actor: USER });
    const ws = await repo.getWorkSet(SCOPE);
    expect(burnup(ws, cycle, "2026-07-03")).toHaveLength(3);
    expect(burnup(ws, cycle, "2026-06-30")).toHaveLength(0); // window not started
  });

  it("a task planned OUT mid-cycle leaves scope honestly (it drops)", async () => {
    const repo = new MemoryWorkRepository(clock);
    const cycle = await repo.createCycle(SCOPE, { name: "C", startsAt: "2026-07-01", endsAt: "2026-07-02", actor: USER });
    const a = (await repo.createTask(SCOPE, { prefix: "ORN", title: "a", actor: USER, at: "2026-07-01T08:00:00Z" })).key;
    await repo.setCycle(SCOPE, { key: a, cycle: cycle.key, actor: USER, at: "2026-07-01T09:00:00Z" });
    await repo.setCycle(SCOPE, { key: a, cycle: null, actor: USER, at: "2026-07-02T09:00:00Z" });
    const points = burnup(await repo.getWorkSet(SCOPE), cycle);
    expect(points.map((p) => p.scope)).toEqual([1, 0]);
  });
});
