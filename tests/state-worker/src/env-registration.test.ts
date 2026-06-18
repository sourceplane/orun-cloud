import { ensureEnvironmentRegistered } from "@state-worker/env-registration";

// UUIDs now — the internal register route takes ids in the body, not public ids.
const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "44444444-4444-4444-8444-444444444444";

/**
 * A projects-worker fetcher for the internal create-or-touch route. `created`
 * shapes the success body; `status >= 400` yields an error response.
 */
function envFetcher(opts: { status?: number; created?: boolean }, calls: { count: number; bodies: unknown[] }): Fetcher {
  const status = opts.status ?? 200;
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/environments/register")) {
        calls.count += 1;
        calls.bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        return Promise.resolve(
          status >= 400
            ? Response.json({ error: { code: "x" } }, { status })
            : Response.json(
                { data: { environment: { id: "e1", slug: "production" }, created: opts.created ?? true } },
                { status },
              ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

describe("ensureEnvironmentRegistered", () => {
  it("registers a new environment on first reference (created=true)", async () => {
    const calls = { count: 0, bodies: [] as unknown[] };
    const out = await ensureEnvironmentRegistered(envFetcher({ created: true }, calls), ORG, PROJECT, "production", "req_1");
    expect(out).toEqual({ kind: "registered" });
    expect(calls.count).toBe(1);
    expect(calls.bodies[0]).toEqual({ orgId: ORG, projectId: PROJECT, name: "production" });
  });

  it("touches an existing environment (created=false) reporting exists", async () => {
    const calls = { count: 0, bodies: [] as unknown[] };
    const out = await ensureEnvironmentRegistered(envFetcher({ created: false }, calls), ORG, PROJECT, "production", "req_1");
    expect(out).toEqual({ kind: "exists" });
    expect(calls.count).toBe(1);
  });

  it("skips an empty or nullish name without calling projects-worker", async () => {
    const calls = { count: 0, bodies: [] as unknown[] };
    const f = envFetcher({}, calls);
    expect(await ensureEnvironmentRegistered(f, ORG, PROJECT, null, "req_1")).toEqual({
      kind: "skipped",
      reason: "empty_name",
    });
    expect(await ensureEnvironmentRegistered(f, ORG, PROJECT, "   ", "req_1")).toEqual({
      kind: "skipped",
      reason: "empty_name",
    });
    expect(calls.count).toBe(0);
  });

  it("skips an invalid name (control/odd chars) without a call", async () => {
    const calls = { count: 0, bodies: [] as unknown[] };
    const out = await ensureEnvironmentRegistered(envFetcher({}, calls), ORG, PROJECT, "../../prod", "req_1");
    expect(out).toEqual({ kind: "skipped", reason: "invalid_name" });
    expect(calls.count).toBe(0);
  });

  it("surfaces an upstream error status", async () => {
    const calls = { count: 0, bodies: [] as unknown[] };
    const out = await ensureEnvironmentRegistered(envFetcher({ status: 503 }, calls), ORG, PROJECT, "production", "req_1");
    expect(out).toEqual({ kind: "error", status: 503 });
  });
});
