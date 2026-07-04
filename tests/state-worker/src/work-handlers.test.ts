// Work handler tests (orun-work v2 WP1) — the fold query API + coordination
// mutators, driven end-to-end with the in-memory two-log repository injected
// through the handler DI seam. Proves at the HTTP boundary what the model
// proves at the unit level: lifecycle is derived (never accepted), verdicts
// are structured, agents can't pin, and import applies no lifecycle.

import { MemoryWorkRepository } from "@saas/db/work";
import { asUuid } from "@saas/db";
import type { Env } from "@state-worker/env";
import type { ActorContext } from "@state-worker/router";
import {
  handleCreateWorkSpec,
  handleCreateWorkTask,
  handleListWorkEvents,
  handleWorkImport,
  handleWorkSummary,
  handleWorkTaskAction,
} from "@state-worker/handlers/work";

const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_PUBLIC = `org_${ORG.replace(/-/g, "")}`;
const USER: ActorContext = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };
const AGENT: ActorContext = { subjectId: "sp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", subjectType: "service_principal" };

function membershipFetcher(): Fetcher {
  return {
    fetch: (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("authorization-context")) {
        return Promise.resolve(
          Response.json({
            data: {
              memberships: [
                { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_PUBLIC } },
              ],
            },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    },
    connect() {
      throw new Error("ni");
    },
  } as unknown as Fetcher;
}

function policyFetcher(allow: boolean): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json({ data: { allow } })),
    connect() {
      throw new Error("ni");
    },
  } as unknown as Fetcher;
}

function createEnv(allow = true): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: membershipFetcher(),
    POLICY_WORKER: policyFetcher(allow),
  } as unknown as Env;
}

function post(path: string, body: unknown): Request {
  return new Request(`https://state.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request(`https://state.internal${path}`);
}

const fixedClock = () => "2026-07-04T12:00:00Z";

async function seedTask(repo: MemoryWorkRepository) {
  const env = createEnv();
  await handleCreateWorkSpec(post("/x", { slug: "demo", title: "Demo" }), env, "r0", USER, asUuid(ORG), { repo });
  const res = await handleCreateWorkTask(
    post("/x", {
      prefix: "ORN",
      title: "route reads",
      specKey: "demo",
      contract: { goal: "g", affects: ["ns/repo/api"], doneWhen: ["d"], gates: ["tests"] },
    }),
    env,
    "r1",
    USER,
    asUuid(ORG),
    { repo },
  );
  const body = (await res.json()) as { data: { key: string } };
  return body.data.key;
}

describe("work summary (the fold with evidence)", () => {
  it("returns tasks with derived lifecycle — a complete contract reads Ready", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo);
    const res = await handleWorkSummary(get("/x"), createEnv(), "req", USER, asUuid(ORG), { repo });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tasks: Array<{ key: string; lifecycle: { rung: string; evidence?: string[] } }>; specs: Array<{ key: string; progress: Record<string, number> }> } };
    const task = body.data.tasks.find((t) => t.key === key)!;
    expect(task.lifecycle.rung).toBe("ready");
    expect(task.lifecycle.evidence).toEqual(["contract complete"]);
    expect(body.data.specs[0]!.progress).toEqual({ ready: 1 });
  });

  it("hides the workspace on policy deny (resource-hiding 404)", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const res = await handleWorkSummary(get("/x"), createEnv(false), "req", USER, asUuid(ORG), { repo });
    expect(res.status).toBe(404);
  });

  it("wire shape carries no bare status field — rungs live under lifecycle with evidence", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    await seedTask(repo);
    const res = await handleWorkSummary(get("/x"), createEnv(), "req", USER, asUuid(ORG), { repo });
    const raw = await res.text();
    expect(raw).not.toContain('"status"');
    expect(raw).toContain('"lifecycle"');
  });
});

describe("coordination mutators (verdicts, provenance, guardrails)", () => {
  it("comment/assign/pin/cancel each append one event with the platform actor", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo);
    const env = createEnv();
    const org = asUuid(ORG);

    const c = await handleWorkTaskAction(post("/x", { body: "hi" }), env, "r", USER, org, key, "comment", { repo });
    expect(c.status).toBe(200);
    const a = await handleWorkTaskAction(post("/x", { subject: "usr_2" }), env, "r", USER, org, key, "assign", { repo });
    expect(a.status).toBe(200);
    const p = await handleWorkTaskAction(post("/x", { rung: "done", note: "override" }), env, "r", USER, org, key, "pin", { repo });
    expect(p.status).toBe(200);

    const events = await handleListWorkEvents(get("/x/events"), env, "r", USER, org, { repo });
    const body = (await events.json()) as { data: { events: Array<{ kind: string; actor: { type: string; id: string } }> } };
    expect(body.data.events.map((e) => e.kind)).toEqual([
      "item_created",
      "item_created",
      "comment_added",
      "assigned",
      "pinned",
    ]);
    for (const e of body.data.events) {
      expect(e.actor.type).toBe("user");
      expect(e.actor.id).toBe(USER.subjectId);
    }
  });

  it("rejects an agent pin with a structured verdict (WP-10)", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo);
    const res = await handleWorkTaskAction(
      post("/x", { rung: "done" }),
      createEnv(),
      "r",
      AGENT,
      asUuid(ORG),
      key,
      "pin",
      { repo },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("verdict_rejected");
    expect(body.error.message).toMatch(/agents may not pin/);
  });

  it("agents can comment and assign (their allowed writes)", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo);
    const res = await handleWorkTaskAction(
      post("/x", { body: "on it" }),
      createEnv(),
      "r",
      AGENT,
      asUuid(ORG),
      key,
      "comment",
      { repo },
    );
    expect(res.status).toBe(200);
    const events = await repo.listEvents({ orgId: ORG });
    expect(events[events.length - 1]!.actor).toEqual({ type: "agent", id: AGENT.subjectId, via: "api" });
  });

  it("404s an unknown task and 409s a duplicate spec slug", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    await seedTask(repo);
    const notFound = await handleWorkTaskAction(
      post("/x", { body: "x" }),
      createEnv(),
      "r",
      USER,
      asUuid(ORG),
      "ORN-999",
      "comment",
      { repo },
    );
    expect(notFound.status).toBe(404);
    const dup = await handleCreateWorkSpec(post("/x", { slug: "demo", title: "Again" }), createEnv(), "r", USER, asUuid(ORG), { repo });
    expect(dup.status).toBe(409);
  });
});

describe("import (the dogfood path)", () => {
  const plan = {
    workspace: "ws_test",
    root: "specs",
    prefix: "ORN",
    specs: [{ slug: "demo-epic", title: "Demo Epic", docPath: "demo-epic/README.md", docSha256: "sha256:aa" }],
    tasks: [
      { specSlug: "demo-epic", milestoneId: "D0", title: "Lay the substrate", contract: { goal: "g", doneWhen: ["d"] } },
      { specSlug: "demo-epic", milestoneId: "D1", title: "Wire the surface", contract: { goal: "g2", deps: ["D0"] } },
    ],
  };

  it("applies a plan, rewrites milestone deps to allocated keys, imports no lifecycle", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const res = await handleWorkImport(post("/x", plan), createEnv(), "r", USER, asUuid(ORG), { repo });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { specsCreated: number; tasksCreated: number } };
    expect(body.data.specsCreated).toBe(1);
    expect(body.data.tasksCreated).toBe(2);

    const ws = await repo.getWorkSet({ orgId: ORG });
    const d1 = ws.tasks.find((t) => t.title.startsWith("D1"))!;
    const d0 = ws.tasks.find((t) => t.title.startsWith("D0"))!;
    expect(d1.contract?.deps).toEqual([d0.key]); // milestone token → allocated key
    for (const e of ws.events) {
      expect(e.actor.via).toBe("import");
    }
    // no lifecycle imported: everything folds from scratch (draft/ready)
    const summary = await handleWorkSummary(get("/x"), createEnv(), "r", USER, asUuid(ORG), { repo });
    const sBody = (await summary.json()) as { data: { tasks: Array<{ lifecycle: { rung: string } }> } };
    for (const t of sBody.data.tasks) {
      expect(["draft", "ready"]).toContain(t.lifecycle.rung);
    }
  });

  it("re-import is idempotent (slugs and milestones skip)", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    await handleWorkImport(post("/x", plan), createEnv(), "r", USER, asUuid(ORG), { repo });
    const res = await handleWorkImport(post("/x", plan), createEnv(), "r", USER, asUuid(ORG), { repo });
    const body = (await res.json()) as { data: { specsCreated: number; specsSkipped: number; tasksCreated: number; tasksSkipped: number } };
    expect(body.data).toEqual({ specsCreated: 0, specsSkipped: 1, tasksCreated: 0, tasksSkipped: 2 });
    const ws = await repo.getWorkSet({ orgId: ORG });
    expect(ws.tasks.length).toBe(2);
  });
});
