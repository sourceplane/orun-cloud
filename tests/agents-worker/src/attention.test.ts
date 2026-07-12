// The attention plane (saas-agents-fleet AF5) — the needs-you fold. What
// these lock: every item carries its provenance; acting on the fact removes
// the item (a resolved approval, a healthy lease, an old failure); counts are
// enum-complete with zeros; the route is read-gated like the fleet it feeds.

import { route } from "@agents-worker/router";
import { foldAttention, pendingApproval } from "@agents-worker/handlers/attention";
import type { AgentsDeps } from "@agents-worker/deps";
import { MemoryAgentsRepository } from "@saas/db/agents";
import type { SessionEvent } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";
import type { AttentionSummary } from "@saas/contracts/agents";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2";
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2";
const SCOPE = { orgId: ORG_UUID };
const env: Env = { ENVIRONMENT: "test" };

function makeDeps(overrides?: { allow?: boolean; repo?: MemoryAgentsRepository }): AgentsDeps {
  return {
    repo: overrides?.repo ?? new MemoryAgentsRepository(),
    async authorize() {
      return overrides?.allow ?? true;
    },
    async dispose() {},
  };
}

function req(path: string): Request {
  return new Request(`https://agents-worker${path}`, {
    headers: {
      "x-actor-subject-id": "usr_rahul",
      "x-actor-subject-type": "user",
    },
  });
}

async function seedProfile(repo: MemoryAgentsRepository): Promise<string> {
  const p = await repo.createProfile(SCOPE, {
    name: "coder-01",
    principalId: "sp_1",
    owner: "usr_elena",
    agentType: "implementer",
    harness: "claude-code",
    model: "claude-opus-4-8",
  });
  return p.publicId;
}

async function seedSession(
  repo: MemoryAgentsRepository,
  profileId: string,
  opts: { taskKey?: string; workRef?: string } = {},
): Promise<string> {
  const s = await repo.createSession(SCOPE, {
    profileId,
    runKind: "implementation",
    spawnedBy: "usr_rahul",
    ...opts,
  });
  await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "provisioning" });
  await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "running" });
  return s.publicId;
}

describe("pendingApproval", () => {
  const ev = (seq: number, kind: SessionEvent["kind"], payload: Record<string, unknown>): SessionEvent => ({
    seq,
    kind,
    payload,
    at: new Date(1700000000000 + seq * 1000).toISOString(),
  });

  it("finds the latest unresolved ask", () => {
    const ask = pendingApproval([
      ev(0, "approval_requested", { requestId: "r1", tool: "bash: rm -rf" }),
      ev(1, "approval_resolved", { requestId: "r1", approved: false }),
      ev(2, "approval_requested", { requestId: "r2", tool: "npx wrangler deploy --env preview" }),
    ]);
    expect(ask?.requestId).toBe("r2");
    expect(ask?.tool).toBe("npx wrangler deploy --env preview");
  });

  it("returns null when every ask is resolved — the fact went false", () => {
    const ask = pendingApproval([
      ev(0, "approval_requested", { requestId: "r1", tool: "x" }),
      ev(1, "approval_resolved", { requestId: "r1", approved: true }),
    ]);
    expect(ask).toBeNull();
  });
});

describe("attention fold via the route", () => {
  it("403s when policy denies — read-gated like the fleet view", async () => {
    const res = await route(req(`/v1/organizations/${ORG}/agents/attention`), env, makeDeps({ allow: false }));
    expect(res.status).toBe(403);
  });

  it("405s a POST", async () => {
    const res = await route(
      new Request(`https://agents-worker/v1/organizations/${ORG}/agents/attention`, {
        method: "POST",
        headers: { "x-actor-subject-id": "u", "x-actor-subject-type": "user" },
      }),
      env,
      makeDeps(),
    );
    expect(res.status).toBe(405);
  });

  it("folds an awaiting session into an answerable verdict item with provenance", async () => {
    const repo = new MemoryAgentsRepository();
    const profileId = await seedProfile(repo);
    const sid = await seedSession(repo, profileId, {
      taskKey: "ORN-146",
      workRef: `work://${ORG}/0146`,
    });
    await repo.advanceSession(SCOPE, { publicId: sid, to: "awaiting_approval" });
    await repo.appendSessionEvent(SCOPE, {
      sessionPublicId: sid,
      seq: 0,
      kind: "approval_requested",
      payload: { requestId: "req-1", tool: "npx wrangler deploy --env preview" },
    });

    const res = await route(req(`/v1/organizations/${ORG}/agents/attention`), env, makeDeps({ repo }));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: AttentionSummary };
    expect(data.items.length).toBe(1);
    const item = data.items[0]!;
    expect(item.kind).toBe("verdict");
    expect(item.sessionId).toBe(sid);
    expect(item.reason).toContain("npx wrangler deploy");
    expect(item.request).toEqual({ requestId: "req-1", tool: "npx wrangler deploy --env preview" });
    // Provenance travels with the item — the fold shows its arithmetic.
    expect(item.taskKey).toBe("ORN-146");
    expect(item.workRef).toBe(`work://${ORG}/0146`);
    expect(data.counts.verdict).toBe(1);
  });

  it("drops the verdict item once the ask resolves — no dismiss verb exists", async () => {
    const repo = new MemoryAgentsRepository();
    const profileId = await seedProfile(repo);
    const sid = await seedSession(repo, profileId);
    await repo.advanceSession(SCOPE, { publicId: sid, to: "awaiting_approval" });
    await repo.appendSessionEvent(SCOPE, {
      sessionPublicId: sid,
      seq: 0,
      kind: "approval_requested",
      payload: { requestId: "req-1", tool: "x" },
    });
    await repo.appendSessionEvent(SCOPE, {
      sessionPublicId: sid,
      seq: 1,
      kind: "approval_resolved",
      payload: { requestId: "req-1", approved: true },
    });
    await repo.advanceSession(SCOPE, { publicId: sid, to: "running" });

    const res = await route(req(`/v1/organizations/${ORG}/agents/attention`), env, makeDeps({ repo }));
    const { data } = (await res.json()) as { data: AttentionSummary };
    expect(data.items.length).toBe(0);
    expect(data.counts.verdict).toBe(0);
    expect(data.running).toBe(1);
  });

  it("counts are enum-complete — future sources ship as zeros, not absences", async () => {
    const res = await route(req(`/v1/organizations/${ORG}/agents/attention`), env, makeDeps());
    const { data } = (await res.json()) as { data: AttentionSummary };
    expect(data.counts).toEqual({
      verdict: 0,
      budget: 0,
      routine_parked: 0,
      failed_retryable: 0,
      stuck: 0,
    });
  });
});

describe("foldAttention (pure)", () => {
  // The memory repo's default clock is a 1970 monotonic counter; pin a real
  // instant so window math (the 24h retry horizon) is deterministic.
  const CLOCK = "2026-07-12T09:00:00.000Z";
  const NOW = new Date("2026-07-12T10:00:00.000Z");

  async function fixtures() {
    const repo = new MemoryAgentsRepository({ now: () => CLOCK });
    const profileId = await seedProfile(repo);
    return { repo, profileId };
  }

  it("surfaces a lapsed lease as stuck, and a healthy one not at all", async () => {
    const { repo, profileId } = await fixtures();
    const stuck = await seedSession(repo, profileId);
    await repo.touchSessionLease(SCOPE, stuck, "2026-07-12T09:40:00.000Z"); // lapsed
    const healthy = await seedSession(repo, profileId);
    await repo.touchSessionLease(SCOPE, healthy, "2026-07-12T10:15:00.000Z");

    const summary = foldAttention(await repo.listSessions(SCOPE), new Map(), NOW);
    expect(summary.items.map((i) => i.kind)).toEqual(["stuck"]);
    expect(summary.items[0]!.sessionId).toBe(stuck);
    expect(summary.items[0]!.at).toBe("2026-07-12T09:40:00.000Z");
    expect(summary.running).toBe(2);
  });

  it("offers a re-dispatch on a recent task-bound failure, not on stale or unbound ones", async () => {
    const { repo, profileId } = await fixtures();
    const recent = await seedSession(repo, profileId, { taskKey: "ORN-9" });
    await repo.advanceSession(SCOPE, {
      publicId: recent,
      to: "failed",
      sandbox: { error: "lease_lost" },
    });
    const unbound = await seedSession(repo, profileId); // no taskKey
    await repo.advanceSession(SCOPE, { publicId: unbound, to: "failed" });

    const sessions = await repo.listSessions(SCOPE);
    const summary = foldAttention(sessions, new Map(), NOW);
    expect(summary.items.map((i) => i.kind)).toEqual(["failed_retryable"]);
    expect(summary.items[0]!.sessionId).toBe(recent);
    expect(summary.items[0]!.reason).toContain("lease_lost");

    // A day later the failure leaves the queue — stale failures are digest
    // material, not attention.
    const later = new Date(Date.parse(CLOCK) + 25 * 60 * 60 * 1000);
    expect(foldAttention(sessions, new Map(), later).items.length).toBe(0);
  });

  it("ranks verdicts above failures above stuck, oldest fact first within rank", async () => {
    const { repo, profileId } = await fixtures();
    const stuck = await seedSession(repo, profileId);
    await repo.touchSessionLease(SCOPE, stuck, "2020-01-01T00:00:00.000Z");
    const failed = await seedSession(repo, profileId, { taskKey: "ORN-1" });
    await repo.advanceSession(SCOPE, { publicId: failed, to: "failed" });
    const waiting = await seedSession(repo, profileId);
    await repo.advanceSession(SCOPE, { publicId: waiting, to: "awaiting_approval" });

    const summary = foldAttention(await repo.listSessions(SCOPE), new Map(), NOW);
    expect(summary.items.map((i) => i.kind)).toEqual(["verdict", "failed_retryable", "stuck"]);
  });

  it("a verdict item with no relayed ask still surfaces (relay behind), unanswerable", async () => {
    const { repo, profileId } = await fixtures();
    const sid = await seedSession(repo, profileId);
    await repo.advanceSession(SCOPE, { publicId: sid, to: "awaiting_approval" });

    const summary = foldAttention(await repo.listSessions(SCOPE), new Map(), NOW);
    expect(summary.items[0]!.kind).toBe("verdict");
    expect(summary.items[0]!.reason).toBe("waiting on your verdict");
    expect(summary.items[0]!.request).toBeUndefined();
  });
});
