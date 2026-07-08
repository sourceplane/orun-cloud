// Tests for the ES5b CLI surface: `events emit|list|tail` and
// `notification-rules list|create|test`. Mirrors the commands.test.ts harness
// (tmp config dir + in-memory token store + injected fetch).

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { OrunCloud } from "@saas/sdk";

import { runCli } from "../cli-runner.js";
import { tailOnce } from "../commands/events.js";
import { ContextStore } from "../context/store.js";
import { jsonResponse, MemoryTokenStore } from "./helpers.js";

interface Cap {
  stdout: string[];
  stderr: string[];
  fetchCalls: { url: string; init: RequestInit }[];
}

/**
 * Harness variant that accepts a per-call response factory so multi-poll /
 * multi-page commands can serve a different body on each fetch.
 */
async function withHarness(
  fn: (h: {
    cap: Cap;
    contextStore: ContextStore;
    runArgv: (argv: string[]) => Promise<{ exitCode: number }>;
  }) => Promise<void>,
  options: { response: (callIndex: number) => Response; activeOrgId?: string },
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-events-"));
  try {
    const cap: Cap = { stdout: [], stderr: [], fetchCalls: [] };
    let i = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      cap.fetchCalls.push({ url: String(input), init: init ?? {} });
      const res = options.response(i);
      i += 1;
      return res;
    };
    const tokenStore = new MemoryTokenStore({ apiUrl: "https://api.test", token: "tok" });
    const contextStore = new ContextStore({ configDir: dir });
    if (options.activeOrgId) await contextStore.setActiveOrg(options.activeOrgId);

    const runArgv = (argv: string[]): Promise<{ exitCode: number }> =>
      runCli(argv, {
        stdout: (l) => cap.stdout.push(l),
        stderr: (l) => cap.stderr.push(l),
        tokenStore,
        contextStore,
        sdkFactory: (baseUrl, token) =>
          new OrunCloud({ baseUrl, auth: { kind: "bearer", token }, fetch: fetchImpl }),
      });

    await fn({ cap, contextStore, runArgv });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function eventBody(id: string, type = "custom.deploy") {
  return {
    id,
    type,
    version: 1,
    source: "custom-ingest",
    severity: "notice",
    category: "custom",
    title: "v42",
    occurredAt: "2026-07-05T10:00:00.000Z",
    actor: { type: "user", id: "usr_a" },
    orgId: "org_1",
    projectId: null,
    environmentId: null,
    subject: { kind: "custom", id: "custom", name: null },
    requestId: "req_1",
    correlationId: null,
    causationId: null,
    payload: {},
  };
}

// ---------------------------------------------------------------------------
// events emit
// ---------------------------------------------------------------------------

describe("events emit", () => {
  it("POSTs the custom event and prints the created id", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["events", "emit", "--type=custom.deploy", "--title=v42", "--payload={\"n\":1}", "--idempotency-key=idem-1"]);
        expect(r.exitCode).toBe(0);
        const call = cap.fetchCalls[0]!;
        expect(call.url).toBe("https://api.test/v1/organizations/org_1/events");
        expect(call.init.method).toBe("POST");
        expect(new Headers(call.init.headers).get("idempotency-key")).toBe("idem-1");
        expect(JSON.parse(String(call.init.body))).toMatchObject({ type: "custom.deploy", title: "v42", payload: { n: 1 } });
        expect(cap.stdout.join("\n")).toContain("evt_1");
      },
      { response: () => jsonResponse({ data: { event: eventBody("evt_1") }, meta: { requestId: "req_1" } }, { status: 201 }), activeOrgId: "org_1" },
    );
  });

  it("rejects a missing --type with exit 2", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["events", "emit", "--title=v42"]);
        expect(r.exitCode).toBe(2);
        expect(cap.stderr.join("\n")).toMatch(/usage/);
      },
      { response: () => jsonResponse({}), activeOrgId: "org_1" },
    );
  });

  it("rejects malformed --payload JSON with exit 2", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["events", "emit", "--type=custom.x", "--payload={bad"]);
        expect(r.exitCode).toBe(2);
        expect(cap.stderr.join("\n")).toMatch(/payload must be valid JSON/);
      },
      { response: () => jsonResponse({}), activeOrgId: "org_1" },
    );
  });
});

// ---------------------------------------------------------------------------
// events list
// ---------------------------------------------------------------------------

describe("events list", () => {
  it("fetches a single page and prints a table with the cursor", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["events", "list", "--type=custom.*", "--limit=10"]);
        expect(r.exitCode).toBe(0);
        expect(cap.fetchCalls[0]!.url).toContain("/v1/organizations/org_1/events");
        expect(cap.fetchCalls[0]!.url).toContain("type=custom");
        const text = cap.stdout.join("\n");
        expect(text).toContain("custom.deploy");
        expect(text).toContain("next cursor: cur_2");
      },
      { response: () => jsonResponse({ data: { events: [eventBody("evt_1")] }, meta: { requestId: "r", cursor: "cur_2" } }), activeOrgId: "org_1" },
    );
  });

  it("--all walks every page via the iterator", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["events", "list", "--all", "--output=json"]);
        expect(r.exitCode).toBe(0);
        // Two fetches: page 1 (cursor) then page 2 (null).
        expect(cap.fetchCalls).toHaveLength(2);
        const parsed = JSON.parse(cap.stdout[0]!);
        expect(parsed.events.map((e: { id: string }) => e.id)).toEqual(["evt_1", "evt_2"]);
      },
      {
        response: (i) =>
          i === 0
            ? jsonResponse({ data: { events: [eventBody("evt_1")] }, meta: { requestId: "r", cursor: "cur_2" } })
            : jsonResponse({ data: { events: [eventBody("evt_2")] }, meta: { requestId: "r", cursor: null } }),
        activeOrgId: "org_1",
      },
    );
  });

  it("rejects --all with --cursor (exit 2)", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["events", "list", "--all", "--cursor=x"]);
        expect(r.exitCode).toBe(2);
        expect(cap.stderr.join("\n")).toMatch(/mutually exclusive/);
      },
      { response: () => jsonResponse({}), activeOrgId: "org_1" },
    );
  });
});

// ---------------------------------------------------------------------------
// events tail
// ---------------------------------------------------------------------------

describe("events tail", () => {
  it("prints only events newer than the last seen id across polls", async () => {
    // Poll 1 → [evt_2, evt_1] (newest first). Poll 2 → [evt_3, evt_2, evt_1].
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["events", "tail", "--max-polls=2", "--interval=0"]);
        expect(r.exitCode).toBe(0);
        const out = cap.stdout.join("\n");
        // Chronological print order: evt_1, evt_2 (poll 1) then evt_3 (poll 2).
        expect(out.indexOf("evt_1")).toBeGreaterThanOrEqual(0);
        expect(out.indexOf("evt_1")).toBeLessThan(out.indexOf("evt_2"));
        expect(out.indexOf("evt_2")).toBeLessThan(out.indexOf("evt_3"));
        // evt_1 and evt_2 must not be re-printed on poll 2.
        expect(out.match(/evt_2/g)).toHaveLength(1);
      },
      {
        response: (i) =>
          i === 0
            ? jsonResponse({ data: { events: [eventBody("evt_2"), eventBody("evt_1")] }, meta: { requestId: "r", cursor: null } })
            : jsonResponse({ data: { events: [eventBody("evt_3"), eventBody("evt_2"), eventBody("evt_1")] }, meta: { requestId: "r", cursor: null } }),
        activeOrgId: "org_1",
      },
    );
  });

  it("tailOnce returns fresh events chronologically and the newest id", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call += 1;
      const events =
        call === 1
          ? [eventBody("evt_2"), eventBody("evt_1")]
          : [eventBody("evt_3"), eventBody("evt_2"), eventBody("evt_1")];
      return jsonResponse({ data: { events }, meta: { requestId: "r", cursor: null } });
    };
    const sdk = new OrunCloud({ baseUrl: "https://api.test", auth: { kind: "bearer", token: "t" }, fetch: fetchImpl });

    const first = await tailOnce(sdk, "org_1", { limit: 50 }, null);
    expect(first.fresh.map((e) => e.id)).toEqual(["evt_1", "evt_2"]);
    expect(first.newestId).toBe("evt_2");

    const second = await tailOnce(sdk, "org_1", { limit: 50 }, first.newestId);
    expect(second.fresh.map((e) => e.id)).toEqual(["evt_3"]);
    expect(second.newestId).toBe("evt_3");
  });
});

// ---------------------------------------------------------------------------
// notification-rules
// ---------------------------------------------------------------------------

function ruleBody(id: string) {
  return {
    id,
    orgId: "org_1",
    projectId: null,
    name: "deploys",
    status: "enabled",
    eventTypes: ["custom.deploy.*"],
    minSeverity: "notice",
    sources: null,
    attributeFilters: null,
    throttleWindowSeconds: 300,
    throttleMax: 10,
    createdAt: "2026-07-05T10:00:00.000Z",
    updatedAt: "2026-07-05T10:00:00.000Z",
    targets: [{ id: "rtgt_1", kind: "email", ref: "a@b.co", enabled: true, createdAt: "2026-07-05T10:00:00.000Z" }],
  };
}

describe("notification-rules list", () => {
  it("GETs the org rules and prints a table", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["notification-rules", "list"]);
        expect(r.exitCode).toBe(0);
        expect(cap.fetchCalls[0]!.url).toBe("https://api.test/v1/organizations/org_1/notification-rules");
        expect(cap.stdout.join("\n")).toContain("deploys");
      },
      { response: () => jsonResponse({ data: { notificationRules: [ruleBody("rule_1")] }, meta: { requestId: "r", cursor: null } }), activeOrgId: "org_1" },
    );
  });
});

describe("notification-rules create", () => {
  it("maps flags onto the create body (targets parsed from JSON)", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "notification-rules",
          "create",
          "--name=deploys",
          "--event-type=custom.deploy.*,custom.rollback.*",
          "--min-severity=notice",
          '--target=[{"kind":"email","ref":"a@b.co"}]',
          "--idempotency-key=idem-1",
        ]);
        expect(r.exitCode).toBe(0);
        const call = cap.fetchCalls[0]!;
        expect(call.init.method).toBe("POST");
        expect(new Headers(call.init.headers).get("idempotency-key")).toBe("idem-1");
        const body = JSON.parse(String(call.init.body));
        expect(body).toMatchObject({
          name: "deploys",
          eventTypes: ["custom.deploy.*", "custom.rollback.*"],
          minSeverity: "notice",
          targets: [{ kind: "email", ref: "a@b.co" }],
        });
      },
      { response: () => jsonResponse({ data: { notificationRule: ruleBody("rule_1") }, meta: { requestId: "r" } }, { status: 201 }), activeOrgId: "org_1" },
    );
  });

  it("requires --name and --event-type (exit 2)", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["notification-rules", "create", "--name=x"]);
        expect(r.exitCode).toBe(2);
        expect(cap.stderr.join("\n")).toMatch(/usage/);
      },
      { response: () => jsonResponse({}), activeOrgId: "org_1" },
    );
  });

  it("rejects malformed --target JSON (exit 2)", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["notification-rules", "create", "--name=x", "--event-type=custom.x", "--target={bad"]);
        expect(r.exitCode).toBe(2);
        expect(cap.stderr.join("\n")).toMatch(/target must be valid JSON/);
      },
      { response: () => jsonResponse({}), activeOrgId: "org_1" },
    );
  });
});

describe("notification-rules test", () => {
  it("POSTs a synthetic event to the rule test route and reports the match", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["notification-rules", "test", "rule_1", "--type=custom.deploy", "--severity=error"]);
        expect(r.exitCode).toBe(0);
        const call = cap.fetchCalls[0]!;
        expect(call.url).toBe("https://api.test/v1/organizations/org_1/notification-rules/rule_1/test");
        expect(call.init.method).toBe("POST");
        expect(JSON.parse(String(call.init.body))).toMatchObject({ type: "custom.deploy", severity: "error" });
        expect(cap.stdout.join("\n")).toMatch(/yes/);
      },
      { response: () => jsonResponse({ data: { matched: true, ruleStatus: "enabled", matchedTargets: [{ id: "rtgt_1", kind: "email", ref: "a@b.co", enabled: true, createdAt: "x" }] }, meta: { requestId: "r" } }), activeOrgId: "org_1" },
    );
  });

  it("requires the ruleId positional and --type (exit 2)", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["notification-rules", "test", "rule_1"]);
        expect(r.exitCode).toBe(2);
        expect(cap.stderr.join("\n")).toMatch(/usage/);
      },
      { response: () => jsonResponse({}), activeOrgId: "org_1" },
    );
  });
});
