// OP2 run-coordination — repository-level concurrency + lifecycle tests.
//
// These exercise the REAL createStateRepository(executor) SQL paths against an
// in-memory store that models single-statement atomicity (FakeRunStore), so the
// no-double-claim and lease-recovery guarantees are proven against the actual
// claim/heartbeat/update/sweep SQL, not a hand-rolled stand-in.

import { createStateRepository } from "@saas/db/state";
import { asUuid } from "@saas/db";
import { sweepLeases } from "@state-worker/sweep";
import { FakeRunStore } from "./fake-run-jobs-store";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";

function makeStore(): FakeRunStore {
  const store = new FakeRunStore();
  store.addRun({ id: RUN, org_id: ORG, project_id: PROJECT, run_ulid: "01J0000000000000000000ABCD", status: "running" });
  return store;
}

describe("atomic claim — no double-claim under concurrency", () => {
  it("exactly one of many concurrent runners wins the same job", async () => {
    const store = makeStore();
    store.addJob({ id: "job-row-1", org_id: ORG, project_id: PROJECT, run_id: RUN, job_id: "build" });
    const repo = createStateRepository(store.executor());

    // 50 runners race for the one 'build' job.
    const N = 50;
    const claims = Array.from({ length: N }, (_, i) =>
      repo.claimRunJob({
        orgId: asUuid(ORG),
        projectId: asUuid(PROJECT),
        runId: asUuid(RUN),
        jobId: "build",
        runnerId: `runner-${i}`,
        leaseSeconds: 60,
      }),
    );
    const results = await Promise.all(claims);

    const winners = results.filter((r) => r.ok && r.value.claimed);
    const losers = results.filter((r) => r.ok && !r.value.claimed);
    expect(winners).toHaveLength(1); // EXACTLY one winner.
    expect(losers).toHaveLength(N - 1);
    // Every loser is told it was already claimed (someone holds the lease).
    for (const l of losers) {
      expect(l.ok && !l.value.claimed && l.value.reason).toBe("already_claimed");
    }
    // The row reflects exactly the winner's runner.
    const claimedJob = store.jobs[0]!;
    expect(claimedJob.status).toBe("claimed");
    const winningRunner = winners[0]!;
    expect(winningRunner.ok && winningRunner.value.claimed && winningRunner.value.job.runnerId).toBe(
      claimedJob.runner_id,
    );
  });

  it("refuses a claim whose deps are not all succeeded (deps_not_ready)", async () => {
    const store = makeStore();
    store.addJob({ id: "a", org_id: ORG, project_id: PROJECT, run_id: RUN, job_id: "compile", status: "running" });
    store.addJob({ id: "b", org_id: ORG, project_id: PROJECT, run_id: RUN, job_id: "test", deps: ["compile"] });
    const repo = createStateRepository(store.executor());

    const res = await repo.claimRunJob({
      orgId: asUuid(ORG),
      projectId: asUuid(PROJECT),
      runId: asUuid(RUN),
      jobId: "test",
      runnerId: "r1",
      leaseSeconds: 60,
    });
    expect(res.ok && !res.value.claimed && res.value.reason).toBe("deps_not_ready");

    // Once 'compile' succeeds, 'test' becomes claimable.
    store.jobs.find((j) => j.job_id === "compile")!.status = "succeeded";
    const res2 = await repo.claimRunJob({
      orgId: asUuid(ORG),
      projectId: asUuid(PROJECT),
      runId: asUuid(RUN),
      jobId: "test",
      runnerId: "r1",
      leaseSeconds: 60,
    });
    expect(res2.ok && res2.value.claimed).toBe(true);
  });
});

describe("kill/recovery — lapsed lease re-queued by the sweep", () => {
  it("a killed runner's job is re-queued (attempt+1) and a second runner finishes it", async () => {
    const store = makeStore();
    store.addJob({ id: "j1", org_id: ORG, project_id: PROJECT, run_id: RUN, job_id: "deploy" });
    const repo = createStateRepository(store.executor());
    const scope = { orgId: asUuid(ORG), projectId: asUuid(PROJECT), runId: asUuid(RUN) };

    // Runner A claims, then is "killed" (stops heartbeating).
    const claimed = await repo.claimRunJob({ ...scope, jobId: "deploy", runnerId: "A", leaseSeconds: 60 });
    expect(claimed.ok && claimed.value.claimed).toBe(true);
    const job = store.jobs[0]!;
    expect(job.attempt).toBe(1);
    expect(job.runner_id).toBe("A");

    // Lease lapses. The sweep re-queues it (attempt+1), not timed_out (< max).
    store.advance(120); // past the 60s lease
    const summary = await sweepLeases(store.executor(), store.now());
    expect(summary.requeued).toBe(1);
    expect(summary.timedOut).toBe(0);
    expect(job.status).toBe("queued");
    expect(job.runner_id).toBeNull();
    expect(job.attempt).toBe(2);

    // Runner B now claims and finishes it. A heartbeat from the dead A is lost.
    const lostHeartbeat = await repo.heartbeatRunJob({ ...scope, jobId: "deploy", runnerId: "A", leaseSeconds: 60 });
    expect(lostHeartbeat.ok && !lostHeartbeat.value.ok && lostHeartbeat.value.reason).toBe("lease_lost");

    const claimedB = await repo.claimRunJob({ ...scope, jobId: "deploy", runnerId: "B", leaseSeconds: 60 });
    expect(claimedB.ok && claimedB.value.claimed).toBe(true);
    const done = await repo.updateRunJob({ ...scope, jobId: "deploy", runnerId: "B", status: "succeeded" });
    expect(done.ok && done.value.ok && !done.value.replayed).toBe(true);
    expect(job.status).toBe("succeeded");

    // The run reconciles to succeeded (all jobs terminal-success).
    const reconciled = await repo.reconcileRunStatus(asUuid(ORG), asUuid(PROJECT), asUuid(RUN));
    expect(reconciled.ok && reconciled.value.transitioned).toBe("succeeded");
  });

  it("a job past MAX attempts is marked timed_out by the sweep", async () => {
    const store = makeStore();
    // attempt already at the max (5) and claimed with a lapsed lease.
    store.addJob({
      id: "j1",
      org_id: ORG,
      project_id: PROJECT,
      run_id: RUN,
      job_id: "flaky",
      status: "claimed",
      runner_id: "A",
      attempt: 5,
      lease_expires_at: new Date(store.now().getTime() - 1000).toISOString(),
    });
    const summary = await sweepLeases(store.executor(), store.now());
    expect(summary.timedOut).toBe(1);
    expect(summary.requeued).toBe(0);
    expect(summary.runsFailed).toBe(1); // the sweep derived the run terminal status
    expect(store.jobs[0]!.status).toBe("timed_out");
    // The run was driven to failed by the sweep itself (a timed_out job is
    // failed-class), so a follow-up reconcile is a no-op on the now-terminal run.
    expect(store.runs[0]!.status).toBe("failed");
    const repo = createStateRepository(store.executor());
    const reconciled = await repo.reconcileRunStatus(asUuid(ORG), asUuid(PROJECT), asUuid(RUN));
    expect(reconciled.ok && reconciled.value.transitioned).toBeNull();
  });
});

describe("idempotent + sticky-terminal update", () => {
  it("a replayed update from the same runner+status is a no-op returning the same result", async () => {
    const store = makeStore();
    store.addJob({ id: "j1", org_id: ORG, project_id: PROJECT, run_id: RUN, job_id: "build" });
    const repo = createStateRepository(store.executor());
    const scope = { orgId: asUuid(ORG), projectId: asUuid(PROJECT), runId: asUuid(RUN) };

    await repo.claimRunJob({ ...scope, jobId: "build", runnerId: "A", leaseSeconds: 60 });
    const first = await repo.updateRunJob({ ...scope, jobId: "build", runnerId: "A", status: "succeeded" });
    expect(first.ok && first.value.ok && first.value.replayed).toBe(false);
    expect(store.jobs[0]!.status).toBe("succeeded");

    // Replay the exact same transition — idempotent no-op, replayed=true.
    const replay = await repo.updateRunJob({ ...scope, jobId: "build", runnerId: "A", status: "succeeded" });
    expect(replay.ok && replay.value.ok && replay.value.replayed).toBe(true);
    expect(store.jobs[0]!.status).toBe("succeeded");
  });

  it("an update from a runner that lost its lease is rejected with lease_lost; terminal stays sticky", async () => {
    const store = makeStore();
    store.addJob({ id: "j1", org_id: ORG, project_id: PROJECT, run_id: RUN, job_id: "build" });
    const repo = createStateRepository(store.executor());
    const scope = { orgId: asUuid(ORG), projectId: asUuid(PROJECT), runId: asUuid(RUN) };

    await repo.claimRunJob({ ...scope, jobId: "build", runnerId: "A", leaseSeconds: 60 });
    await repo.updateRunJob({ ...scope, jobId: "build", runnerId: "A", status: "succeeded" });

    // A different runner B tries to fail the already-succeeded job → lease_lost,
    // and the terminal status is unchanged (sticky).
    const stolen = await repo.updateRunJob({ ...scope, jobId: "build", runnerId: "B", status: "failed" });
    expect(stolen.ok && !stolen.value.ok && stolen.value.reason).toBe("lease_lost");
    expect(store.jobs[0]!.status).toBe("succeeded");
  });

  it("a failed job drives the run to failed on reconcile", async () => {
    const store = makeStore();
    store.addJob({ id: "j1", org_id: ORG, project_id: PROJECT, run_id: RUN, job_id: "build" });
    const repo = createStateRepository(store.executor());
    const scope = { orgId: asUuid(ORG), projectId: asUuid(PROJECT), runId: asUuid(RUN) };

    await repo.claimRunJob({ ...scope, jobId: "build", runnerId: "A", leaseSeconds: 60 });
    await repo.updateRunJob({ ...scope, jobId: "build", runnerId: "A", status: "failed", errorText: "boom" });
    const reconciled = await repo.reconcileRunStatus(asUuid(ORG), asUuid(PROJECT), asUuid(RUN));
    expect(reconciled.ok && reconciled.value.transitioned).toBe("failed");
    expect(store.runs[0]!.status).toBe("failed");
  });
});

describe("runnable frontier", () => {
  it("returns only queued jobs whose deps are all succeeded", async () => {
    const store = makeStore();
    store.addJob({ id: "a", org_id: ORG, project_id: PROJECT, run_id: RUN, job_id: "a", status: "succeeded" });
    store.addJob({ id: "b", org_id: ORG, project_id: PROJECT, run_id: RUN, job_id: "b", deps: ["a"] });
    store.addJob({ id: "c", org_id: ORG, project_id: PROJECT, run_id: RUN, job_id: "c", deps: ["b"] });
    store.addJob({ id: "d", org_id: ORG, project_id: PROJECT, run_id: RUN, job_id: "d" });
    const repo = createStateRepository(store.executor());

    const frontier = await repo.listRunnableJobs(asUuid(ORG), asUuid(PROJECT), asUuid(RUN));
    expect(frontier.ok).toBe(true);
    const ids = frontier.ok ? frontier.value.map((j) => j.jobId).sort() : [];
    // 'b' (deps a succeeded) and 'd' (no deps) are runnable; 'c' is blocked on 'b'.
    expect(ids).toEqual(["b", "d"]);
  });
});

describe("cancel", () => {
  it("cancels non-terminal jobs and sets the run canceled (idempotent)", async () => {
    const store = makeStore();
    store.addJob({ id: "a", org_id: ORG, project_id: PROJECT, run_id: RUN, job_id: "a", status: "succeeded" });
    store.addJob({ id: "b", org_id: ORG, project_id: PROJECT, run_id: RUN, job_id: "b", status: "running", runner_id: "A" });
    const repo = createStateRepository(store.executor());

    const first = await repo.cancelRun(asUuid(ORG), asUuid(PROJECT), asUuid(RUN));
    expect(first.ok && first.value.status).toBe("canceled");
    expect(store.jobs.find((j) => j.job_id === "b")!.status).toBe("canceled");
    expect(store.jobs.find((j) => j.job_id === "a")!.status).toBe("succeeded"); // terminal untouched

    // Idempotent: cancel again returns the same canceled run.
    const again = await repo.cancelRun(asUuid(ORG), asUuid(PROJECT), asUuid(RUN));
    expect(again.ok && again.value.status).toBe("canceled");
  });
});
