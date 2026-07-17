// Daytona SandboxProvider adapter tests (saas-agents AG5, design §2). The
// vendor is a recorded fetch stub; the assertions pin the security shape —
// Bearer auth, redacted failures, secret env only on exec, ttl → provider
// reclaim intervals.

import { createDaytonaProvider, DEFAULT_DAYTONA_API } from "@agents-worker/providers/daytona";
import type { SandboxSpec } from "@saas/contracts/agents";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(
  respond: (url: string, init: RequestInit) => Response = () => Response.json({ id: "sb_1", state: "started" }),
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(init?.body ? { body: JSON.parse(init.body as string) } : {}),
    });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const SPEC: SandboxSpec = {
  baseSnapshot: "agents-base",
  ttlSeconds: 5400,
  egressAllow: ["api.anthropic.com"],
  env: { ORUN_SESSION_ID: "as_1" },
};

describe("daytona sandbox adapter", () => {
  it("creates a sandbox from the base snapshot with Bearer auth and reclaim intervals", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const p = createDaytonaProvider({ apiKey: "dtn_key", fetchImpl });
    const ref = await p.create(SPEC);

    expect(ref).toEqual({ id: "sb_1", provider: "daytona" });
    expect(calls[0]!.url).toBe(`${DEFAULT_DAYTONA_API}/sandbox`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.authorization).toBe("Bearer dtn_key");
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.snapshot).toBe("agents-base");
    expect(body.env).toEqual({ ORUN_SESSION_ID: "as_1" });
    expect(body.autoStopInterval).toBe(90); // 5400s → minutes
  });

  it("omits the snapshot key when the spec pins none — the account's default image boots", async () => {
    // The regression this locks: a fabricated snapshot name (e.g. agents-base)
    // 404s against a workspace's own Daytona account. No pin → no key at all.
    const { fetchImpl, calls } = fakeFetch();
    const p = createDaytonaProvider({ apiKey: "k", fetchImpl });
    await p.create({ ttlSeconds: 5400, egressAllow: ["api.anthropic.com"], env: { ORUN_SESSION_ID: "as_1" } });
    expect("snapshot" in (calls[0]!.body as Record<string, unknown>)).toBe(false);
  });

  it("respects a custom apiUrl and target from the connection config", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const p = createDaytonaProvider({
      apiKey: "k",
      apiUrl: "https://eu.daytona.example/api/",
      target: "eu",
      fetchImpl,
    });
    await p.create(SPEC);
    expect(calls[0]!.url).toBe("https://eu.daytona.example/api/sandbox");
    expect((calls[0]!.body as Record<string, unknown>).target).toBe("eu");
  });

  it("execs through a toolbox SESSION: wait-for-started → create session → runAsync exec", async () => {
    // The regression this locks: the exec path is /toolbox/{id}/toolbox/…
    // (doubled segment — the flat path 404s), and the long-running channel is
    // the session api with runAsync (plain process/execute is sync, ~10s cap).
    const { fetchImpl, calls } = fakeFetch();
    const p = createDaytonaProvider({ apiKey: "k", fetchImpl });
    await p.exec({ id: "sb_1", provider: "daytona" }, ["orun", "agent", "serve"], {
      env: { ANTHROPIC_API_KEY: "sk-ant-secret" },
    });
    expect(calls.map((c) => `${c.method} ${c.url.slice(DEFAULT_DAYTONA_API.length)}`)).toEqual([
      "GET /sandbox/sb_1",
      "POST /toolbox/sb_1/toolbox/process/session",
      "POST /toolbox/sb_1/toolbox/process/session/orun-agent/exec",
    ]);
    expect((calls[1]!.body as { sessionId: string }).sessionId).toBe("orun-agent");
    const exec = calls[2]!.body as { command: string; runAsync: boolean };
    expect(exec.runAsync).toBe(true);
    // The api has no env field — secrets ride an export prefix on the command
    // (the vendor SDK's own mechanism), never the create-time manifest.
    expect(exec.command).toBe("export ANTHROPIC_API_KEY=sk-ant-secret; orun agent serve");
  });

  it("execCapture runs the SYNC process/execute endpoint and returns stdout + exit code", async () => {
    const { fetchImpl, calls } = fakeFetch((url, init) => {
      if ((init.method ?? "GET") === "GET") return Response.json({ id: "sb_1", state: "started" });
      if (url.endsWith("/toolbox/sb_1/toolbox/process/execute")) {
        return Response.json({ exitCode: 0, result: "orun 2.30.0\n" });
      }
      return Response.json({});
    });
    const p = createDaytonaProvider({ apiKey: "k", fetchImpl });
    const out = await p.execCapture!({ id: "sb_1", provider: "daytona" }, ["sh", "-lc", "orun --version"]);

    expect(out).toEqual({ stdout: "orun 2.30.0", exitCode: 0 });
    // Uses the synchronous execute endpoint (NOT the runAsync session api).
    const exec = calls.find((c) => c.url.endsWith("/process/execute"))!;
    expect(exec.method).toBe("POST");
    expect((exec.body as { command: string }).command).toBe("sh -lc 'orun --version'");
    expect(exec.headers.authorization).toBe("Bearer k");
  });

  it("waits for the sandbox to start before any toolbox call", async () => {
    let polls = 0;
    const { fetchImpl, calls } = fakeFetch((_url, init) => {
      if ((init.method ?? "GET") === "GET") {
        polls++;
        return Response.json({ id: "sb_1", state: polls < 3 ? "pulling_snapshot" : "started" });
      }
      return Response.json({});
    });
    const slept: number[] = [];
    const p = createDaytonaProvider({
      apiKey: "k",
      fetchImpl,
      sleepImpl: async (ms) => {
        slept.push(ms);
      },
    });
    await p.exec({ id: "sb_1", provider: "daytona" }, ["true"]);
    expect(polls).toBe(3);
    expect(slept.length).toBe(2);
    expect(calls.filter((c) => c.method === "POST").length).toBe(2);
  });

  it("retries a toolbox 404 until the daemon registers its route (started ≠ toolbox ready)", async () => {
    // The production regression this locks: Daytona reports the sandbox
    // `started` a beat before the in-sandbox toolbox daemon registers its edge
    // route, so the first /toolbox POST 404s for a short window. A single 404
    // used to fail the whole spawn ("daytona POST toolbox: 404 from provider");
    // it must be waited out instead.
    let sessionHits = 0;
    const { fetchImpl, calls } = fakeFetch((url, init) => {
      if ((init.method ?? "GET") === "GET") return Response.json({ id: "sb_1", state: "started" });
      if (url.endsWith("/process/session")) {
        sessionHits++;
        if (sessionHits < 3) return new Response("not found", { status: 404 });
      }
      return Response.json({});
    });
    const slept: number[] = [];
    const p = createDaytonaProvider({ apiKey: "k", fetchImpl, sleepImpl: async (ms) => void slept.push(ms) });
    await p.exec({ id: "sb_1", provider: "daytona" }, ["true"]);
    expect(sessionHits).toBe(3); // two 404s absorbed, then the daemon answered
    expect(slept).toEqual([2000, 2000]); // start poll never slept (already started); only the two retries
    // and the real exec still went out once the toolbox was ready
    expect(calls.some((c) => c.url.endsWith("/process/session/orun-agent/exec"))).toBe(true);
  });

  it("bounds the toolbox-readiness retry — a daemon that never registers fails, it does not spin forever", async () => {
    const { fetchImpl } = fakeFetch((url, init) => {
      if ((init.method ?? "GET") === "GET") return Response.json({ id: "sb_1", state: "started" });
      return new Response("not found", { status: 404 });
    });
    let slept = 0;
    const p = createDaytonaProvider({ apiKey: "k", fetchImpl, sleepImpl: async () => void slept++ });
    await expect(p.exec({ id: "sb_1", provider: "daytona" }, ["true"])).rejects.toThrow("404 from provider");
    expect(slept).toBe(30); // TOOLBOX_READY_POLL_MAX bounded attempts, then it gives up
  });

  it("fails fast when the sandbox lands in a dead state instead of polling out the clock", async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ id: "sb_1", state: "error" }));
    const p = createDaytonaProvider({ apiKey: "k", fetchImpl, sleepImpl: async () => {} });
    await expect(p.exec({ id: "sb_1", provider: "daytona" }, ["true"])).rejects.toThrow("box is error");
  });

  it("tolerates an already-created session (409) — a resume re-exec is idempotent", async () => {
    const { fetchImpl, calls } = fakeFetch((url, init) =>
      url.endsWith("/process/session") && init.method === "POST"
        ? new Response("{}", { status: 409 })
        : Response.json({ id: "sb_1", state: "started" }),
    );
    const p = createDaytonaProvider({ apiKey: "k", fetchImpl });
    await p.exec({ id: "sb_1", provider: "daytona" }, ["true"]);
    expect(calls.length).toBe(3); // 409 didn't abort; the exec still went out
  });

  it("quotes shell-unsafe exec arguments and env values", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const p = createDaytonaProvider({ apiKey: "k", fetchImpl });
    await p.exec({ id: "sb_1", provider: "daytona" }, ["echo", "a b", "it's"], {
      env: { TOKEN: "v alue" },
    });
    expect((calls[2]!.body as { command: string }).command).toBe(
      "export TOKEN='v alue'; echo 'a b' 'it'\\''s'",
    );
  });

  it("maps snapshot/resume to provider stop/start and destroys with force", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ id: "sb_1" }));
    const p = createDaytonaProvider({ apiKey: "k", fetchImpl });

    expect(await p.snapshot({ id: "sb_1", provider: "daytona" })).toBe("sb_1");
    expect(calls[0]!.url).toContain("/sandbox/sb_1/stop");

    const resumed = await p.resume("sb_1");
    expect(resumed.id).toBe("sb_1");
    expect(calls[1]!.url).toContain("/sandbox/sb_1/start");

    await p.destroy({ id: "sb_1", provider: "daytona" });
    expect(calls[2]!.method).toBe("DELETE");
    expect(calls[2]!.url).toContain("/sandbox/sb_1?force=true");
  });

  it("reports health from the sandbox state", async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ id: "sb_1", state: "stopped" }));
    const p = createDaytonaProvider({ apiKey: "k", fetchImpl });
    const h = await p.health({ id: "sb_1", provider: "daytona" });
    expect(h.healthy).toBe(false);
    expect(h.detail).toBe("stopped");
  });

  it("redacts provider failures to a status code — the body never leaks", async () => {
    const { fetchImpl } = fakeFetch(() =>
      new Response(JSON.stringify({ message: "bad key dtn_key, account acme" }), { status: 401 }),
    );
    const p = createDaytonaProvider({ apiKey: "dtn_key", fetchImpl });
    await expect(p.create(SPEC)).rejects.toThrow("401 from provider");
    await expect(p.create(SPEC)).rejects.not.toThrow(/acme|dtn_key/);
  });
});
