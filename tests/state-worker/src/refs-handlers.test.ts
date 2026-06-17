// OV1 hosted RefStore — HTTP handler tests. Verify ref resolve (GET), the
// compare-and-swap PUT (create-if-absent, conditional advance, 409 ref_conflict
// on a stale expectedTarget, 412 object_missing when the target object was
// never uploaded), prefix listing, delete, ref-name validation, and policy
// gating. The DB is an in-memory refs store interpreting the repo's SQL (real
// CAS behavior); auth/policy are configurable fetchers (mirrors
// objects-handlers.test.ts).

import {
  handleGetRef,
  handleUpdateRef,
  handleListRefs,
  handleDeleteRef,
  isValidRefName,
} from "@state-worker/handlers/refs";
import type { Env } from "@state-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const ORG_PUBLIC = `org_${ORG.replace(/-/g, "")}`;
const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

const TARGET_A = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const TARGET_B = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

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

interface RefRow {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
  target: string;
  writer: string | null;
  created_at: string;
  updated_at: string;
}

// refsExecutor interprets the repository's SQL against an in-memory map so the
// CAS semantics (ON CONFLICT DO NOTHING, conditional UPDATE) behave like a real
// DB. fkMissing simulates the composite FK to state.objects failing.
function refsExecutor(opts?: { fkMissing?: boolean }): {
  executor: SqlExecutor;
  store: Map<string, RefRow>;
} {
  const store = new Map<string, RefRow>();
  const executor: SqlExecutor = {
    execute<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []): Promise<SqlExecutorResult<T>> {
      const rows = run(text, params) as unknown as T[];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };

  function run(text: string, p: unknown[]): RefRow[] {
    if (text.includes("INSERT INTO state.refs")) {
      if (opts?.fkMissing) throw { code: "23503" };
      const [id, orgId, projectId, name, target, writer] = p as string[];
      if (store.has(name!)) return []; // ON CONFLICT DO NOTHING
      const row: RefRow = {
        id: id!,
        org_id: orgId!,
        project_id: projectId!,
        name: name!,
        target: target!,
        writer: writer ?? null,
        created_at: "2026-06-17T00:00:00.000Z",
        updated_at: "2026-06-17T00:00:00.000Z",
      };
      store.set(name!, row);
      return [row];
    }
    if (text.includes("UPDATE state.refs")) {
      if (opts?.fkMissing) throw { code: "23503" };
      const [orgId, projectId, name, expected, target, writer] = p as string[];
      void orgId;
      void projectId;
      const cur = store.get(name!);
      if (!cur || cur.target !== expected) return [];
      cur.target = target!;
      cur.writer = writer ?? null;
      cur.updated_at = "2026-06-17T01:00:00.000Z";
      return [cur];
    }
    if (text.includes("DELETE FROM state.refs")) {
      const name = p[2] as string;
      store.delete(name);
      return [];
    }
    if (text.includes("SELECT * FROM state.refs") && text.includes("LIKE")) {
      const like = p[2] as string; // 'escapedPrefix%'
      const prefix = like.slice(0, -1).replace(/\\([\\%_])/g, "$1");
      return [...store.values()].filter((r) => r.name.startsWith(prefix)).sort((a, b) => a.name.localeCompare(b.name));
    }
    if (text.includes("SELECT * FROM state.refs")) {
      const name = p[2] as string;
      const r = store.get(name);
      return r ? [r] : [];
    }
    return [];
  }

  return { executor, store };
}

function putReq(body: unknown): Request {
  return new Request("https://state.test/v1/organizations/x/projects/y/state/refs/catalogs/current", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("isValidRefName", () => {
  it("accepts canonical ref names", () => {
    for (const n of ["catalogs/current", "sources/branches/main", "executions/by-id/exec_00", "revisions/by-hash/a.b-c"]) {
      expect(isValidRefName(n)).toBe(true);
    }
  });
  it("rejects traversal, empty segments, and bad characters", () => {
    for (const n of ["", "/leading", "trailing/", "a//b", "a/../b", "a/.", "bad name", "weird:seg"]) {
      expect(isValidRefName(n)).toBe(false);
    }
  });
});

describe("GET …/state/refs/{name}", () => {
  it("resolves an existing ref", async () => {
    const { executor, store } = refsExecutor();
    store.set("catalogs/current", {
      id: "r1",
      org_id: ORG,
      project_id: PROJECT,
      name: "catalogs/current",
      target: TARGET_A,
      writer: "cli",
      created_at: "2026-06-17T00:00:00.000Z",
      updated_at: "2026-06-17T00:00:00.000Z",
    });
    const res = await handleGetRef(createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), "catalogs/current", {
      executor,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { ref: { name: string; target: string } } };
    expect(body.data.ref.name).toBe("catalogs/current");
    expect(body.data.ref.target).toBe(TARGET_A);
  });

  it("404s a missing ref", async () => {
    const { executor } = refsExecutor();
    const res = await handleGetRef(createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), "executions/latest", {
      executor,
    });
    expect(res.status).toBe(404);
  });

  it("404s an invalid ref name", async () => {
    const { executor } = refsExecutor();
    const res = await handleGetRef(createEnv(), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), "a/../b", { executor });
    expect(res.status).toBe(404);
  });
});

describe("PUT …/state/refs/{name} — compare-and-swap", () => {
  it("creates from absent (expectedTarget omitted)", async () => {
    const { executor, store } = refsExecutor();
    const res = await handleUpdateRef(
      putReq({ target: TARGET_A }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG),
      asUuid(PROJECT),
      "catalogs/current",
      { executor },
    );
    expect(res.status).toBe(200);
    expect(store.get("catalogs/current")?.target).toBe(TARGET_A);
  });

  it("conflicts (409) when creating over an existing ref", async () => {
    const { executor } = refsExecutor();
    await handleUpdateRef(putReq({ target: TARGET_A }), createEnv(), "r", ACTOR, asUuid(ORG), asUuid(PROJECT), "catalogs/current", { executor });
    const res = await handleUpdateRef(
      putReq({ target: TARGET_B }),
      createEnv(),
      "req_2",
      ACTOR,
      asUuid(ORG),
      asUuid(PROJECT),
      "catalogs/current",
      { executor },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ref_conflict");
  });

  it("advances with the correct expectedTarget", async () => {
    const { executor, store } = refsExecutor();
    await handleUpdateRef(putReq({ target: TARGET_A }), createEnv(), "r", ACTOR, asUuid(ORG), asUuid(PROJECT), "catalogs/current", { executor });
    const res = await handleUpdateRef(
      putReq({ expectedTarget: TARGET_A, target: TARGET_B }),
      createEnv(),
      "req_3",
      ACTOR,
      asUuid(ORG),
      asUuid(PROJECT),
      "catalogs/current",
      { executor },
    );
    expect(res.status).toBe(200);
    expect(store.get("catalogs/current")?.target).toBe(TARGET_B);
  });

  it("conflicts (409) on a stale expectedTarget", async () => {
    const { executor } = refsExecutor();
    await handleUpdateRef(putReq({ target: TARGET_A }), createEnv(), "r", ACTOR, asUuid(ORG), asUuid(PROJECT), "catalogs/current", { executor });
    const res = await handleUpdateRef(
      putReq({ expectedTarget: TARGET_B, target: TARGET_A }),
      createEnv(),
      "req_4",
      ACTOR,
      asUuid(ORG),
      asUuid(PROJECT),
      "catalogs/current",
      { executor },
    );
    expect(res.status).toBe(409);
  });

  it("412 object_missing when the target object was never uploaded", async () => {
    const { executor } = refsExecutor({ fkMissing: true });
    const res = await handleUpdateRef(
      putReq({ target: TARGET_A }),
      createEnv(),
      "req_5",
      ACTOR,
      asUuid(ORG),
      asUuid(PROJECT),
      "catalogs/current",
      { executor },
    );
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("object_missing");
  });

  it("422 on a malformed target", async () => {
    const { executor } = refsExecutor();
    const res = await handleUpdateRef(
      putReq({ target: "not-a-digest" }),
      createEnv(),
      "req_6",
      ACTOR,
      asUuid(ORG),
      asUuid(PROJECT),
      "catalogs/current",
      { executor },
    );
    expect(res.status).toBe(422);
  });
});

describe("GET …/state/refs?prefix= — list", () => {
  it("lists names under a prefix, sorted", async () => {
    const { executor } = refsExecutor();
    for (const [name, target] of [
      ["sources/main", TARGET_A],
      ["sources/branches/feature", TARGET_A],
      ["catalogs/current", TARGET_B],
    ] as const) {
      await handleUpdateRef(putReq({ target }), createEnv(), "r", ACTOR, asUuid(ORG), asUuid(PROJECT), name, { executor });
    }
    const req = new Request("https://state.test/v1/organizations/x/projects/y/state/refs?prefix=sources/");
    const res = await handleListRefs(req, createEnv(), "req_7", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { refs: { name: string }[] } };
    expect(body.data.refs.map((r) => r.name)).toEqual(["sources/branches/feature", "sources/main"]);
  });
});

describe("DELETE …/state/refs/{name}", () => {
  it("removes a ref", async () => {
    const { executor, store } = refsExecutor();
    await handleUpdateRef(putReq({ target: TARGET_A }), createEnv(), "r", ACTOR, asUuid(ORG), asUuid(PROJECT), "revisions/latest", { executor });
    expect(store.has("revisions/latest")).toBe(true);
    const res = await handleDeleteRef(createEnv(), "req_8", ACTOR, asUuid(ORG), asUuid(PROJECT), "revisions/latest", {
      executor,
    });
    expect(res.status).toBe(204);
    expect(store.has("revisions/latest")).toBe(false);
  });
});

describe("policy gating", () => {
  it("404s (resource-hiding) when policy denies", async () => {
    const { executor } = refsExecutor();
    const res = await handleGetRef(createEnv(false), "req_9", ACTOR, asUuid(ORG), asUuid(PROJECT), "catalogs/current", {
      executor,
    });
    expect(res.status).toBe(404);
  });
});
