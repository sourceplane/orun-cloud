import { ensureEnvironmentRegistered } from "@state-worker/env-registration";

const ORG = "org_11111111111111111111111111111111";
const PROJECT = "prj_44444444444444444444444444444444";
const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

/** A projects-worker fetcher that returns a fixed status for the env-create POST. */
function envFetcher(status: number, calls: { count: number }): Fetcher {
  return {
    fetch: (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/environments")) {
        calls.count += 1;
        return Promise.resolve(
          status === 409
            ? Response.json({ error: { code: "conflict" } }, { status: 409 })
            : status >= 400
              ? Response.json({ error: { code: "x" } }, { status })
              : Response.json({ data: { environment: { id: "e1", slug: "production" } } }, { status }),
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
  it("registers a new environment on first reference", async () => {
    const calls = { count: 0 };
    const out = await ensureEnvironmentRegistered(
      envFetcher(201, calls),
      ORG,
      PROJECT,
      "production",
      ACTOR,
      "req_1",
    );
    expect(out).toEqual({ kind: "registered" });
    expect(calls.count).toBe(1);
  });

  it("is idempotent: a 409 (already exists) reports exists, not an error", async () => {
    const calls = { count: 0 };
    const out = await ensureEnvironmentRegistered(
      envFetcher(409, calls),
      ORG,
      PROJECT,
      "production",
      ACTOR,
      "req_1",
    );
    expect(out).toEqual({ kind: "exists" });
    expect(calls.count).toBe(1);
  });

  it("skips an empty or nullish name without calling projects-worker", async () => {
    const calls = { count: 0 };
    const f = envFetcher(201, calls);
    expect(await ensureEnvironmentRegistered(f, ORG, PROJECT, null, ACTOR, "req_1")).toEqual({
      kind: "skipped",
      reason: "empty_name",
    });
    expect(await ensureEnvironmentRegistered(f, ORG, PROJECT, "   ", ACTOR, "req_1")).toEqual({
      kind: "skipped",
      reason: "empty_name",
    });
    expect(calls.count).toBe(0);
  });

  it("skips an invalid name (control/odd chars) without a call", async () => {
    const calls = { count: 0 };
    const out = await ensureEnvironmentRegistered(
      envFetcher(201, calls),
      ORG,
      PROJECT,
      "../../prod",
      ACTOR,
      "req_1",
    );
    expect(out).toEqual({ kind: "skipped", reason: "invalid_name" });
    expect(calls.count).toBe(0);
  });

  it("surfaces an upstream error status", async () => {
    const calls = { count: 0 };
    const out = await ensureEnvironmentRegistered(
      envFetcher(503, calls),
      ORG,
      PROJECT,
      "production",
      ACTOR,
      "req_1",
    );
    expect(out).toEqual({ kind: "error", status: 503 });
  });
});
