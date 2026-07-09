import { route } from "@agents-worker/router";
import type { AgentsDeps } from "@agents-worker/deps";
import { MemoryAgentsRepository } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";

const ORG = "org_test";
const env: Env = { ENVIRONMENT: "test" };

function actorHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-actor-subject-id": "usr_rahul",
    "x-actor-subject-type": "user",
    ...extra,
  };
}

function makeDeps(overrides?: { allow?: boolean; repo?: MemoryAgentsRepository }): AgentsDeps {
  const repo = overrides?.repo ?? new MemoryAgentsRepository();
  return {
    repo,
    async authorize() {
      return overrides?.allow ?? true;
    },
    async dispose() {
      /* no-op */
    },
  };
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://agents-worker${path}`, {
    method,
    headers: actorHeaders(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function json(res: Response): Promise<{ data?: unknown; error?: { code: string } }> {
  return (await res.json()) as { data?: unknown; error?: { code: string } };
}

describe("agents-worker route", () => {
  it("serves /health without auth", async () => {
    const res = await route(new Request("https://agents-worker/health"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { service: string } };
    expect(body.data.service).toBe("agents-worker");
  });

  it("404s an unknown route", async () => {
    const res = await route(new Request("https://agents-worker/nope"), env, makeDeps());
    expect(res.status).toBe(404);
  });

  it("401s an agents route with no actor headers", async () => {
    const res = await route(new Request(`https://agents-worker/v1/organizations/${ORG}/agents/profiles`), env, makeDeps());
    expect(res.status).toBe(401);
  });

  it("503s when unbound and no deps injected", async () => {
    const res = await route(req("GET", `/v1/organizations/${ORG}/agents/profiles`), env);
    expect(res.status).toBe(503);
  });

  it("403s when policy denies", async () => {
    const res = await route(
      req("GET", `/v1/organizations/${ORG}/agents/profiles`),
      env,
      makeDeps({ allow: false }),
    );
    expect(res.status).toBe(403);
  });

  it("creates + lists a profile", async () => {
    const deps = makeDeps();
    const create = await route(
      req("POST", `/v1/organizations/${ORG}/agents/profiles`, {
        name: "impl-default",
        principalId: "sp_1",
        owner: "team/platform",
        agentType: "implementer",
        harness: "claude-code",
        model: "claude-opus-4-8",
      }),
      env,
      deps,
    );
    expect(create.status).toBe(201);
    const created = (await json(create)).data as { id: string; name: string };
    expect(created.id).toMatch(/^agp_/);
    expect(created.name).toBe("impl-default");

    const list = await route(req("GET", `/v1/organizations/${ORG}/agents/profiles`), env, deps);
    const rows = (await json(list)).data as unknown[];
    expect(rows.length).toBe(1);
  });

  it("validates a profile create body", async () => {
    const res = await route(
      req("POST", `/v1/organizations/${ORG}/agents/profiles`, { name: "x" }),
      env,
      makeDeps(),
    );
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error?.code).toBe("validation_failed");
  });

  it("runs a session through create → get → advance → events", async () => {
    const deps = makeDeps();
    // Seed a profile.
    const p = await route(
      req("POST", `/v1/organizations/${ORG}/agents/profiles`, {
        name: "impl",
        principalId: "sp_1",
        owner: "team/platform",
        agentType: "implementer",
        harness: "claude-code",
        model: "claude-opus-4-8",
      }),
      env,
      deps,
    );
    const profile = (await json(p)).data as { id: string };

    const create = await route(
      req("POST", `/v1/organizations/${ORG}/agents/sessions`, {
        profileId: profile.id,
        runKind: "implementation",
        taskKey: "ORN-142",
      }),
      env,
      deps,
    );
    expect(create.status).toBe(201);
    const session = (await json(create)).data as { id: string; state: string; spawnedBy: string };
    expect(session.id).toMatch(/^as_/);
    expect(session.state).toBe("requested");
    expect(session.spawnedBy).toBe("usr_rahul"); // taken from the actor, not the body

    const get = await route(req("GET", `/v1/organizations/${ORG}/agents/sessions/${session.id}`), env, deps);
    expect(get.status).toBe(200);

    // Advance through the repo directly (the runtime/DO relay drives transitions
    // in production); then read the event relay.
    await deps.repo.advanceSession({ orgId: ORG }, { publicId: session.id, to: "provisioning" });
    await deps.repo.appendSessionEvent({ orgId: ORG }, { sessionPublicId: session.id, seq: 0, kind: "state_changed", payload: { state: "provisioning" } });

    const events = await route(req("GET", `/v1/organizations/${ORG}/agents/sessions/${session.id}/events`), env, deps);
    expect(events.status).toBe(200);
    const evs = (await json(events)).data as unknown[];
    expect(evs.length).toBe(1);
  });

  it("404s a session create against a missing profile", async () => {
    const res = await route(
      req("POST", `/v1/organizations/${ORG}/agents/sessions`, { profileId: "agp_missing", runKind: "design" }),
      env,
      makeDeps(),
    );
    expect(res.status).toBe(404);
  });

  it("405s an unsupported method", async () => {
    const res = await route(req("DELETE", `/v1/organizations/${ORG}/agents/profiles`), env, makeDeps());
    expect(res.status).toBe(405);
  });
});
