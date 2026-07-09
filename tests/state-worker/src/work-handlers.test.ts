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
  handleWorkReaction,
  handleWorkTimeline,
  handleWorkImport,
  handleWorkSummary,
  handleWorkTaskAction,
  handleSaveWorkView,
  handleListWorkViews,
  handleCreateWorkCycle,
  handleListWorkCycles,
  handleWorkBurnup,
  handleWorkTriage,
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

describe("PM1 conversation (threads, reactions, mentions, timeline)", () => {
  it("threads a reply, reacts, and interleaves the timeline", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const env = createEnv();
    const key = await seedTask(repo);
    const mentions: Array<{ handle: string; taskKey: string }> = [];
    const deps = {
      repo,
      publishMention: async (m: { handle: string; taskKey: string }) => {
        mentions.push({ handle: m.handle, taskKey: m.taskKey });
      },
    };
    const root = await handleWorkTaskAction(
      post("/x", { body: "root — cc @rahul" }),
      env,
      "r",
      USER,
      asUuid(ORG),
      key,
      "comment",
      deps,
    );
    expect(root.status).toBe(200);
    expect(mentions).toEqual([{ handle: "rahul", taskKey: key }]);
    const rootEvents = await repo.listEvents({ orgId: asUuid(ORG) } as never);
    const rootComment = rootEvents.find((e) => e.kind === "comment_added")!;

    const reply = await handleWorkTaskAction(
      post("/x", { body: "reply", parentEvent: rootComment.eventId }),
      env,
      "r",
      USER,
      asUuid(ORG),
      key,
      "comment",
      deps,
    );
    expect(reply.status).toBe(200);

    const react = await handleWorkReaction(
      post("/x", { emoji: "👍" }),
      env,
      "r",
      USER,
      asUuid(ORG),
      rootComment.eventId!,
      "add",
      { repo },
    );
    expect(react.status).toBe(200);

    // A fact lands too — the timeline interleaves both logs.
    await repo.ingestObservation(
      { orgId: asUuid(ORG) } as never,
      {
        workspace: ORG,
        source: "ci",
        sourceVersion: 1,
        kind: "pr_opened",
        at: "2026-07-05T00:00:00Z",
        dedupeKey: "pr:1",
        payload: { pr: `${key} fix`, taskKeys: [key] },
      } as never,
    );

    const tl = await handleWorkTimeline(get("/x"), env, "r", USER, asUuid(ORG), key, { repo });
    expect(tl.status).toBe(200);
    const body = (await tl.json()) as {
      data: { entries: Array<{ type: string; event?: { kind: string; payload?: { parentEvent?: string } } }> };
    };
    const kinds = body.data.entries.map((e) => (e.type === "event" ? e.event!.kind : "observation"));
    expect(kinds).toContain("comment_added");
    expect(kinds).toContain("reaction_added");
    expect(kinds).toContain("observation");
    const replyEntry = body.data.entries.find(
      (e) => e.type === "event" && e.event!.kind === "comment_added" && e.event!.payload?.parentEvent,
    );
    expect(replyEntry).toBeDefined();
  });

  it("hides the workspace on policy deny for timeline and reactions (404)", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const tl = await handleWorkTimeline(get("/x"), createEnv(false), "r", USER, asUuid(ORG), "ORN-1", { repo });
    expect(tl.status).toBe(404);
    const rx = await handleWorkReaction(post("/x", { emoji: "x" }), createEnv(false), "r", USER, asUuid(ORG), "ev", "add", { repo });
    expect(rx.status).toBe(404);
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

describe("PM2 board intent (labels, priority, estimates, relations, views)", () => {
  it("label/priority/estimate fold into the summary's task views", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo);
    const env = createEnv();
    const org = asUuid(ORG);

    expect((await handleWorkTaskAction(post("/x", { label: "infra" }), env, "r", USER, org, key, "label", { repo })).status).toBe(200);
    expect((await handleWorkTaskAction(post("/x", { priority: "high" }), env, "r", USER, org, key, "priority", { repo })).status).toBe(200);
    expect((await handleWorkTaskAction(post("/x", { points: 8 }), env, "r", USER, org, key, "estimate", { repo })).status).toBe(200);

    const res = await handleWorkSummary(get("/x"), env, "r", USER, org, { repo });
    const body = (await res.json()) as {
      data: { tasks: Array<{ key: string; tags?: string[]; priority?: string; estimate?: number }> };
    };
    const task = body.data.tasks.find((t) => t.key === key)!;
    expect(task.tags).toEqual(["infra"]);
    expect(task.priority).toBe("high");
    expect(task.estimate).toBe(8);

    const removed = await handleWorkTaskAction(post("/x", { label: "infra", remove: true }), env, "r", USER, org, key, "label", { repo });
    expect(removed.status).toBe(200);
  });

  it("a blocks relation derives the target's blocked flag; the relation is intent, not a rung", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const blocker = await seedTask(repo);
    const env = createEnv();
    const org = asUuid(ORG);
    const created = await handleCreateWorkTask(post("/x", { prefix: "ORN", title: "downstream" }), env, "r", USER, org, { repo });
    const target = ((await created.json()) as { data: { key: string } }).data.key;

    const rel = await handleWorkTaskAction(post("/x", { rel: "blocks", target }), env, "r", USER, org, blocker, "relate", { repo });
    expect(rel.status).toBe(200);

    const res = await handleWorkSummary(get("/x"), env, "r", USER, org, { repo });
    const body = (await res.json()) as {
      data: { tasks: Array<{ key: string; relations?: Array<{ rel: string; target: string }>; lifecycle: { rung: string; blocked: boolean } }> };
    };
    const blockedTask = body.data.tasks.find((t) => t.key === target)!;
    expect(blockedTask.lifecycle.blocked).toBe(true);
    expect(blockedTask.lifecycle.rung).toBe("draft"); // a flag, never a rung
    expect(body.data.tasks.find((t) => t.key === blocker)!.relations).toEqual([{ rel: "blocks", target }]);
  });

  it("rejects an unknown priority with a structured verdict", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo);
    const res = await handleWorkTaskAction(post("/x", { priority: "asap" }), createEnv(), "r", USER, asUuid(ORG), key, "priority", { repo });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("verdict_rejected");
  });

  it("saves and lists views without appending a coordination event", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    await seedTask(repo);
    const env = createEnv();
    const org = asUuid(ORG);
    const before = (await repo.listEvents({ orgId: ORG })).length;

    const saved = await handleSaveWorkView(
      post("/x", { key: "infra-board", name: "Infra board", config: { layout: "board", filters: { tags: ["infra"] } } }),
      env, "r", USER, org, { repo },
    );
    expect(saved.status).toBe(201);

    const list = await handleListWorkViews(get("/x"), env, "r", USER, org, { repo });
    const body = (await list.json()) as { data: { views: Array<{ key: string; config: { layout: string } }> } };
    expect(body.data.views).toHaveLength(1);
    expect(body.data.views[0]!.config.layout).toBe("board");
    expect((await repo.listEvents({ orgId: ORG })).length).toBe(before); // no event kind exists for views

    const bad = await handleSaveWorkView(post("/x", { key: "x", name: "X", config: { layout: "gantt" } }), env, "r", USER, org, { repo });
    expect(bad.status).toBe(422);
  });
});

describe("PM3 cycles (authored time-boxes; derived progress)", () => {
  it("creates a cycle, plans a task in, and the summary + cycle list carry derived counts", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo);
    const env = createEnv();
    const org = asUuid(ORG);

    const created = await handleCreateWorkCycle(
      post("/x", { name: "Cycle 1", startsAt: "2026-07-01", endsAt: "2026-07-14" }),
      env, "r", USER, org, { repo },
    );
    expect(created.status).toBe(201);
    const cycle = ((await created.json()) as { data: { key: string } }).data.key;

    const planned = await handleWorkTaskAction(post("/x", { cycle }), env, "r", USER, org, key, "cycle", { repo });
    expect(planned.status).toBe(200);

    const summary = await handleWorkSummary(get("/x"), env, "r", USER, org, { repo });
    const sBody = (await summary.json()) as { data: { tasks: Array<{ key: string; cycleKey?: string }> } };
    expect(sBody.data.tasks.find((t) => t.key === key)!.cycleKey).toBe(cycle);

    const list = await handleListWorkCycles(get("/x"), env, "r", USER, org, { repo });
    const lBody = (await list.json()) as { data: { cycles: Array<{ key: string; scope: number; done: number }> } };
    expect(lBody.data.cycles[0]).toMatchObject({ key: cycle, scope: 1, done: 0 });

    const unknown = await handleWorkTaskAction(post("/x", { cycle: "CYC-99" }), env, "r", USER, org, key, "cycle", { repo });
    expect(unknown.status).toBe(404);
  });

  it("serves the derived burn-up and 404s an unknown cycle; there is no write route for points", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo);
    const env = createEnv();
    const org = asUuid(ORG);
    // The fixed clock stamps events at 2026-07-04 — the window must cover it.
    const created = await handleCreateWorkCycle(
      post("/x", { name: "C", startsAt: "2026-07-02", endsAt: "2026-07-04" }),
      env, "r", USER, org, { repo },
    );
    const cycle = ((await created.json()) as { data: { key: string } }).data.key;
    await handleWorkTaskAction(post("/x", { cycle }), env, "r", USER, org, key, "cycle", { repo });

    const res = await handleWorkBurnup(get("/x"), env, "r", USER, org, cycle, { repo, today: "2026-07-05" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { points: Array<{ date: string; scope: number; done: number }> } };
    expect(body.data.points).toHaveLength(3);
    expect(body.data.points.map((p) => p.scope)).toEqual([0, 0, 1]); // planned in on the 4th
    expect(body.data.points[2]).toMatchObject({ scope: 1, done: 0 });

    expect((await handleWorkBurnup(get("/x"), env, "r", USER, org, "CYC-9", { repo })).status).toBe(404);
  });

  it("initiative rollups derive from parent relations in the summary", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    await seedTask(repo); // spec "demo" + one ready task
    const env = createEnv();
    const org = asUuid(ORG);
    await handleCreateWorkInitiative(post("/x", { slug: "q3", title: "Q3" }), env, "r", USER, org, { repo });
    await repo.relate({ orgId: ORG }, { key: "q3", rel: "parent", target: "demo", actor: { type: "user", id: "usr_1" } });

    const res = await handleWorkSummary(get("/x"), env, "r", USER, org, { repo });
    const body = (await res.json()) as {
      data: { initiatives: Array<{ key: string; specs?: string[]; progress?: Record<string, number> }> };
    };
    const q3 = body.data.initiatives.find((i) => i.key === "q3")!;
    expect(q3.specs).toEqual(["demo"]);
    expect(q3.progress).toEqual({ ready: 1 });
  });
});

describe("PM5 triage (the agent project surface)", () => {
  it("summary tasks carry folded assignees; an sp_ seat assigns through the ordinary mutator", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo);
    const env = createEnv();
    const org = asUuid(ORG);
    await handleWorkTaskAction(post("/x", { subject: "sp_agent_1" }), env, "r", USER, org, key, "assign", { repo });
    const res = await handleWorkSummary(get("/x"), env, "r", USER, org, { repo });
    const body = (await res.json()) as { data: { tasks: Array<{ key: string; assignees?: string[] }> } };
    expect(body.data.tasks.find((t) => t.key === key)!.assignees).toEqual(["sp_agent_1"]);
  });

  it("a contract proposal opens in triage, Accept (reviewing comment) clears it", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo);
    const env = createEnv();
    const org = asUuid(ORG);

    // The agent proposes (contract_propose = apply + flag).
    const prop = await handleWorkTaskAction(
      post("/x", { contract: { goal: "wider", affects: ["ns/repo/api"], doneWhen: ["d"], gatesDefined: true } }),
      env, "r", AGENT, org, key, "contract", { repo },
    );
    expect(prop.status).toBe(200);

    let res = await handleWorkTriage(get("/x"), env, "r", USER, org, { repo });
    expect(res.status).toBe(200);
    let body = (await res.json()) as {
      data: { contractProposals: Array<{ key: string; eventId: string; proposedBy: { type: string }; previousContract?: { goal?: string } }> };
    };
    expect(body.data.contractProposals).toHaveLength(1);
    const proposal = body.data.contractProposals[0]!;
    expect(proposal.proposedBy.type).toBe("agent");
    expect(proposal.previousContract?.goal).toBe("g"); // the revert target

    // Accept = a human comment naming the proposal.
    await handleWorkTaskAction(
      post("/x", { body: "accepted", reviewsEvent: proposal.eventId }),
      env, "r", USER, org, key, "comment", { repo },
    );
    res = await handleWorkTriage(get("/x"), env, "r", USER, org, { repo });
    body = (await res.json()) as typeof body;
    expect(body.data.contractProposals).toHaveLength(0);
  });

  it("Revert (a human contract edit) clears the proposal too", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo);
    const env = createEnv();
    const org = asUuid(ORG);
    await handleWorkTaskAction(
      post("/x", { contract: { goal: "wider" } }),
      env, "r", AGENT, org, key, "contract", { repo },
    );
    await handleWorkTaskAction(
      post("/x", { contract: { goal: "g", affects: ["ns/repo/api"], doneWhen: ["d"], gates: ["tests"] } }),
      env, "r", USER, org, key, "contract", { repo },
    );
    const res = await handleWorkTriage(get("/x"), env, "r", USER, org, { repo });
    const body = (await res.json()) as { data: { contractProposals: unknown[] } };
    expect(body.data.contractProposals).toHaveLength(0);
  });

  it("review-parked and mentions surface; policy deny hides the route (404)", async () => {
    const repo = new MemoryWorkRepository(fixedClock);
    const key = await seedTask(repo);
    const env = createEnv();
    const org = asUuid(ORG);
    // Merge without a gate verdict → parked In Review by honest degradation.
    await handleIngestWorkObservation(
      post("/x", {
        source: "ci",
        kind: "pr_merged",
        dedupeKey: "pr:9:merged",
        payload: { pr: "o/r#9", revision: "sha256:zz", taskKeys: [key] },
      }),
      env, "r", USER, org, { repo },
    );
    await handleWorkTaskAction(post("/x", { body: "@rahul look" }), env, "r", USER, org, key, "comment", { repo });

    const res = await handleWorkTriage(get("/x"), env, "r", USER, org, { repo });
    const body = (await res.json()) as {
      data: { reviewParked: Array<{ key: string }>; mentions: Array<{ handles: string[] }> };
    };
    expect(body.data.reviewParked.map((t) => t.key)).toEqual([key]);
    expect(body.data.mentions[0]!.handles).toEqual(["rahul"]);

    expect((await handleWorkTriage(get("/x"), createEnv(false), "r", USER, org, { repo })).status).toBe(404);
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
