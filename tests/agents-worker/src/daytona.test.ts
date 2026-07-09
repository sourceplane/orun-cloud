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

  it("execs through the toolbox with the secret env on the exec call only", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({}));
    const p = createDaytonaProvider({ apiKey: "k", fetchImpl });
    await p.exec({ id: "sb_1", provider: "daytona" }, ["orun", "agent", "serve"], {
      env: { ANTHROPIC_API_KEY: "sk-ant-secret" },
    });
    expect(calls[0]!.url).toBe(`${DEFAULT_DAYTONA_API}/toolbox/sb_1/process/execute`);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.command).toBe("orun agent serve");
    expect(body.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-secret" });
  });

  it("quotes shell-unsafe exec arguments", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({}));
    const p = createDaytonaProvider({ apiKey: "k", fetchImpl });
    await p.exec({ id: "sb_1", provider: "daytona" }, ["echo", "a b", "it's"]);
    expect((calls[0]!.body as { command: string }).command).toBe("echo 'a b' 'it'\\''s'");
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
