// Provider verifier tests (saas-agents AG12, design §10.3). The pinned
// invariant: Daytona "verified" must PREDICT spawn — verification exercises the
// real create body (target/autoStop/autoDelete/snapshot), not a read-only list
// ping — and a probe box is never left behind. Redaction holds (status code
// only). Anthropic stays a cheap read-only /v1/models probe.

import { createProviderVerifier } from "@agents-worker/verifiers";
import { DEFAULT_DAYTONA_API } from "@agents-worker/providers/daytona";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

/** Install a recording stub over global fetch; returns the calls + a restore. */
function stubFetch(respond: (url: string, init: RequestInit) => Response): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(init?.body ? { body: JSON.parse(init.body as string) as Record<string, unknown> } : {}),
    });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe("provider verifier — daytona verify on the create path (AG12)", () => {
  it("creates a probe sandbox with the connection's create body, then reclaims it", async () => {
    const { calls, restore } = stubFetch((url, init) => {
      // DELETE (the reclaim) and POST (the create) both resolve fine here.
      if (init.method === "DELETE") return new Response("{}", { status: 200 });
      return Response.json({ id: "sb_probe", state: "creating" });
    });
    try {
      const res = await createProviderVerifier().verify("daytona", "dtn_key", {
        target: "eu",
        snapshot: "agents-base@v3",
      });
      expect(res).toEqual({ ok: true });

      // The list ping never exercised these; the create body now does.
      const create = calls.find((c) => c.method === "POST")!;
      expect(create.url).toBe(`${DEFAULT_DAYTONA_API}/sandbox`);
      expect(create.headers.authorization).toBe("Bearer dtn_key");
      expect(create.body!.target).toBe("eu");
      expect(create.body!.snapshot).toBe("agents-base@v3");
      expect(create.body!.autoStopInterval).toBeGreaterThanOrEqual(1);
      expect(create.body!.autoDeleteInterval).toBeGreaterThanOrEqual(1);

      // Never leaves a probe box behind (force reclaim on the returned id).
      const del = calls.find((c) => c.method === "DELETE")!;
      expect(del.url).toContain("/sandbox/sb_probe");
      expect(del.url).toContain("force=true");
    } finally {
      restore();
    }
  });

  it("fails with a redacted status when the account rejects the create body — no probe box, no body echo", async () => {
    const { calls, restore } = stubFetch(
      () => new Response(JSON.stringify({ message: "bad target for account acme, key dtn_key" }), { status: 400 }),
    );
    try {
      const res = await createProviderVerifier().verify("daytona", "dtn_key", { target: "nope" });
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("400");
      // Redaction: neither the account name nor the key leaks into the reason.
      expect(res.reason).not.toMatch(/acme|dtn_key/);
      // A create that never returned an id leaves nothing to destroy.
      expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    } finally {
      restore();
    }
  });

  it("honors a custom apiUrl from the connection config", async () => {
    const { calls, restore } = stubFetch((_url, init) =>
      init.method === "DELETE" ? new Response("{}") : Response.json({ id: "sb_probe" }),
    );
    try {
      await createProviderVerifier().verify("daytona", "k", { apiUrl: "https://eu.daytona.example/api/" });
      expect(calls.find((c) => c.method === "POST")!.url).toBe("https://eu.daytona.example/api/sandbox");
    } finally {
      restore();
    }
  });

  it("reports provider-unreachable without throwing when the probe create cannot connect", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    try {
      const res = await createProviderVerifier().verify("daytona", "k", {});
      expect(res.ok).toBe(false);
      expect(res.reason).toContain("unreachable");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("provider verifier — anthropic (unchanged read-only probe)", () => {
  it("verifies with GET /v1/models and the api-key header", async () => {
    const { calls, restore } = stubFetch(() => Response.json({ data: [] }));
    try {
      const res = await createProviderVerifier().verify("anthropic", "sk-ant-key", {});
      expect(res).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("GET");
      expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models");
      expect(calls[0]!.headers["x-api-key"]).toBe("sk-ant-key");
    } finally {
      restore();
    }
  });

  it("redacts a failed anthropic probe to a status code", async () => {
    const { restore } = stubFetch(() => new Response(JSON.stringify({ error: "bad key sk-ant-key" }), { status: 401 }));
    try {
      const res = await createProviderVerifier().verify("anthropic", "sk-ant-key", {});
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("401 from provider");
    } finally {
      restore();
    }
  });
});

describe("provider verifier — unsupported provider", () => {
  it("refuses an unknown provider", async () => {
    // openai/openrouter became verifiable providers in DX6; gemini is the
    // rejected-provider fixture platform-wide (the config-worker/db suites'
    // convention).
    const res = await createProviderVerifier().verify("gemini", "k", {});
    expect(res).toEqual({ ok: false, reason: "provider unsupported" });
  });
});
