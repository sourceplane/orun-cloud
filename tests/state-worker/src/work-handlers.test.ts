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
  handleCreateWorkInitiative,
  handleCreateWorkSpec,
  handleEditWorkItem,
  handleGetWorkDoc,
  handleIngestWorkObservation,
  handleCreateWorkTask,
  handleListWorkEvents,
  handlePutWorkDoc,
  handleStreamWorkEvents,
  handleWorkDocHistory,
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

describe("work events stream (SSE — the same cursor, pushed)", () => {
  const streamCfg = { pollMs: 1, maxMs: 10 };

  it("frames existing events as id/event/data SSE records", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo);
    const env = createEnv();
    await handleWorkTaskAction(post("/x", { body: "hello" }), env, "r", USER, asUuid(ORG), key, "comment", { repo });

    const res = await handleStreamWorkEvents(get("/x/events/stream"), env, "req", USER, asUuid(ORG), {
      repo,
      stream: streamCfg,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    // A retry hint, then one frame per coordination event, ids = seqs.
    expect(text.startsWith("retry: 3000\n\n")).toBe(true);
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([1, 2, 3]); // spec created, task created, comment
    const frames = [...text.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]!) as { kind: string; seq: number });
    expect(frames.map((f) => f.kind)).toEqual(["item_created", "item_created", "comment_added"]);
    expect(text).toContain("event: work\n");
  });

  it("resumes from the ?from= cursor (and Last-Event-ID wins when larger)", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo);
    const env = createEnv();
    await handleWorkTaskAction(post("/x", { body: "hello" }), env, "r", USER, asUuid(ORG), key, "comment", { repo });

    const fromRes = await handleStreamWorkEvents(get("/x/events/stream?from=2"), env, "req", USER, asUuid(ORG), {
      repo,
      stream: streamCfg,
    });
    const fromIds = [...(await fromRes.text()).matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(fromIds).toEqual([3]);

    const req = new Request("https://state.internal/x/events/stream?from=1", {
      headers: { "last-event-id": "3" },
    });
    const lastRes = await handleStreamWorkEvents(req, env, "req", USER, asUuid(ORG), { repo, stream: streamCfg });
    const lastText = await lastRes.text();
    expect([...lastText.matchAll(/^id: (\d+)$/gm)]).toHaveLength(0);
    expect(lastText).toContain(": ka\n"); // an idle leg still heartbeats
  });

  it("hides the workspace on policy deny (resource-hiding 404) before any stream opens", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const res = await handleStreamWorkEvents(get("/x/events/stream"), createEnv(false), "req", USER, asUuid(ORG), {
      repo,
      stream: streamCfg,
    });
    expect(res.status).toBe(404);
  });
});

describe("PM0 authoring (initiatives + cloud documents)", () => {
  const put = (path: string, body: unknown): Request =>
    new Request(`https://state.internal${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("creates an initiative and the summary carries it (envelope-only, no rung)", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const env = createEnv();
    const res = await handleCreateWorkInitiative(
      post("/x", { slug: "platform-q3", title: "Platform Q3", description: "spine" }),
      env,
      "r",
      USER,
      asUuid(ORG),
      { repo },
    );
    expect(res.status).toBe(201);
    const summary = await handleWorkSummary(get("/x"), env, "r", USER, asUuid(ORG), { repo });
    const body = (await summary.json()) as {
      data: { initiatives: Array<{ key: string; title: string; description?: string }> };
    };
    expect(body.data.initiatives).toEqual([
      expect.objectContaining({ key: "platform-q3", title: "Platform Q3", description: "spine" }),
    ]);
    // No lifecycle anywhere on an initiative view.
    expect(JSON.stringify(body.data.initiatives[0])).not.toContain("rung");
  });

  it("saves + reads + histories a cloud document; identical save is a 200 no-op", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const env = createEnv();
    await handleCreateWorkSpec(post("/x", { slug: "checkout", title: "Checkout" }), env, "r", USER, asUuid(ORG), {
      repo,
    });
    const putRes = await handlePutWorkDoc(
      put("/x", { body: "# Checkout\n\nIntent.\n" }),
      env,
      "r",
      USER,
      asUuid(ORG),
      "checkout",
      { repo },
    );
    expect(putRes.status).toBe(201);
    const putBody = (await putRes.json()) as { data: { revision: string; created: boolean; seq: number } };
    expect(putBody.data.created).toBe(true);
    expect(putBody.data.revision).toMatch(/^sha256:/);

    const again = await handlePutWorkDoc(
      put("/x", { body: "# Checkout\n\nIntent.\n" }),
      env,
      "r",
      USER,
      asUuid(ORG),
      "checkout",
      { repo },
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: { created: boolean } }).data.created).toBe(false);

    const getRes = await handleGetWorkDoc(get("/x"), env, "r", USER, asUuid(ORG), "checkout", { repo });
    expect(getRes.status).toBe(200);
    const doc = (await getRes.json()) as { data: { body: string; revision: string } };
    expect(doc.data.body).toContain("# Checkout");
    expect(doc.data.revision).toBe(putBody.data.revision);

    const hist = await handleWorkDocHistory(get("/x"), env, "r", USER, asUuid(ORG), "checkout", { repo });
    const histBody = (await hist.json()) as { data: { revisions: Array<{ revision: string }> } };
    expect(histBody.data.revisions).toHaveLength(1);
  });

  it("edits an item envelope through the one mutator route", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const env = createEnv();
    const key = await seedTask(repo);
    const res = await handleEditWorkItem(post("/x", { title: "renamed" }), env, "r", USER, asUuid(ORG), key, {
      repo,
    });
    expect(res.status).toBe(200);
    const summary = await handleWorkSummary(get("/x"), env, "r", USER, asUuid(ORG), { repo });
    const body = (await summary.json()) as { data: { tasks: Array<{ key: string; title: string }> } };
    expect(body.data.tasks.find((t) => t.key === key)!.title).toBe("renamed");
  });

  it("re-import never overwrites a cloud doc chain (V3-5: it skips, the chain survives)", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const env = createEnv();
    await handleWorkImport(
      post("/x", {
        workspace: ORG,
        root: "specs",
        specs: [{ slug: "checkout", title: "Checkout", docPath: "checkout/README.md", docSha256: "sha256:" + "ab".repeat(32) }],
        tasks: [],
      }),
      env,
      "r",
      USER,
      asUuid(ORG),
      { repo },
    );
    // A cloud edit starts a chain on the imported spec.
    const cloud = await handlePutWorkDoc(
      put("/x", { body: "cloud-authored\n" }),
      env,
      "r",
      USER,
      asUuid(ORG),
      "checkout",
      { repo },
    );
    const cloudRev = ((await cloud.json()) as { data: { revision: string } }).data.revision;
    // Re-import with a CHANGED repo digest: the slug exists → skipped.
    const reimport = await handleWorkImport(
      post("/x", {
        workspace: ORG,
        root: "specs",
        specs: [{ slug: "checkout", title: "Checkout", docPath: "checkout/README.md", docSha256: "sha256:" + "cd".repeat(32) }],
        tasks: [],
      }),
      env,
      "r",
      USER,
      asUuid(ORG),
      { repo },
    );
    const rb = (await reimport.json()) as { data: { specsSkipped: number } };
    expect(rb.data.specsSkipped).toBe(1);
    const doc = await handleGetWorkDoc(get("/x"), env, "r", USER, asUuid(ORG), "checkout", { repo });
    expect(((await doc.json()) as { data: { revision: string } }).data.revision).toBe(cloudRev);
  });

  it("hides the workspace on policy deny before any doc write (404)", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const res = await handlePutWorkDoc(
      put("/x", { body: "x\n" }),
      createEnv(false),
      "r",
      USER,
      asUuid(ORG),
      "checkout",
      { repo },
    );
    expect(res.status).toBe(404);
  });
});

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

describe("CI observation producer (the affected-set feed)", () => {
  it("admits only the named ci source and dedupes by key", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    await seedTask(repo);
    const env = createEnv();
    const org = asUuid(ORG);

    const badSource = await handleIngestWorkObservation(
      post("/x", { source: "github-webhook", kind: "pr_opened", dedupeKey: "k" }),
      env, "r", USER, org, { repo },
    );
    expect(badSource.status).toBe(422);

    const body = {
      source: "ci",
      sourceVersion: 1,
      kind: "pr_opened",
      dedupeKey: "ci:pr:o/r#9:affected",
      payload: { pr: "o/r#9", affected: ["ns/repo/api"] },
    };
    const first = await handleIngestWorkObservation(post("/x", body), env, "r", USER, org, { repo });
    expect(first.status).toBe(201);
    const second = await handleIngestWorkObservation(post("/x", body), env, "r", USER, org, { repo });
    expect(second.status).toBe(200);
    const sBody = (await second.json()) as { data: { deduped: boolean } };
    expect(sBody.data.deduped).toBe(true);
  });

  it("an affected set claims the single matching open task (overlap join)", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo); // contract.affects = ["ns/repo/api"]
    const env = createEnv();
    const org = asUuid(ORG);
    await handleIngestWorkObservation(
      post("/x", {
        source: "ci",
        sourceVersion: 1,
        kind: "pr_opened",
        dedupeKey: "ci:pr:o/r#9:opened",
        payload: { pr: "o/r#9", affected: ["ns/repo/api"] },
      }),
      env, "r", USER, org, { repo },
    );
    const res = await handleWorkSummary(get("/x"), env, "r", USER, org, { repo });
    const body = (await res.json()) as { data: { tasks: Array<{ key: string; lifecycle: { rung: string; evidence?: string[] } }> } };
    const task = body.data.tasks.find((t) => t.key === key)!;
    expect(task.lifecycle.rung).toBe("in_review");
    expect(task.lifecycle.evidence).toEqual(["PR o/r#9 open"]);
  });
});
