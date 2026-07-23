// saas-secrets-platform SP4: org-curated scope templates.
//
// Covers the merge law (declared + active customs, base semantics inherited,
// retired/orphaned dropped), the CRUD handlers (validation, collision, the
// declared-is-code-owned guard, version bump on display edits), and the
// mint-path resolution (custom → base, any status; unknown stays unknown).

import {
  handleCreateScopeTemplate,
  handleListScopeTemplates,
  handleUpdateScopeTemplate,
  mergeActiveTemplates,
  resolveCustomTemplate,
  toWireTemplate,
} from "@integrations-worker/handlers/scope-templates";
import { handleListSecretsCapabilities } from "@integrations-worker/handlers/secrets-capabilities";
import { CLOUDFLARE_SCOPE_TEMPLATES } from "@integrations-worker/providers/cloudflare";
import type { ActorContext } from "@integrations-worker/router";
import type { Env } from "@integrations-worker/env";
import type { OrgScopeTemplate } from "@saas/db/integrations";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";

const KEY = "0".repeat(64);
const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const ACTOR: ActorContext = { subjectId: "usr_a", subjectType: "user" };

function jsonFetcher(body: unknown) {
  return {
    fetch: () => Promise.resolve(Response.json(body)),
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function createEnv(): Env {
  return {
    ENVIRONMENT: "test",
    SECRET_ENCRYPTION_KEY: KEY,
    SUPABASE_OAUTH_CLIENT_ID: "sb-cid",
    SUPABASE_OAUTH_CLIENT_SECRET: "sb-cs",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: jsonFetcher({
      data: {
        memberships: [
          { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_UUID } },
        ],
      },
    }),
    POLICY_WORKER: jsonFetcher({ data: { allow: true, reason: "org_admin" } }),
  } as unknown as Env;
}

type SqlResponder = (text: string, params: unknown[]) => Record<string, unknown>[] | null;

function fakeExecutor(respond: SqlResponder): {
  executor: SqlExecutor;
  queries: Array<{ text: string; params: unknown[] }>;
} {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      const rows = (respond(text, params ?? []) ?? []) as unknown as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { executor, queries };
}

const NOW = new Date("2026-07-23T00:00:00Z");

function customRow(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    org_id: ORG_UUID,
    provider: "cloudflare",
    template_id: "prod-deploy",
    base_template: "workers-deploy",
    display_name: "Prod deploy",
    description: "Deploys production workers.",
    version: 1,
    status: "active",
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function mappedCustom(overrides?: Partial<OrgScopeTemplate>): OrgScopeTemplate {
  return {
    id: asUuid("22222222-2222-4222-8222-222222222222"),
    orgId: asUuid(ORG_UUID),
    provider: "cloudflare",
    templateId: "prod-deploy",
    baseTemplate: "workers-deploy",
    displayName: "Prod deploy",
    description: "Deploys production workers.",
    version: 1,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

describe("mergeActiveTemplates (the served catalog)", () => {
  const declared = CLOUDFLARE_SCOPE_TEMPLATES;

  it("stamps declared origin and appends active customs with base semantics", () => {
    const merged = mergeActiveTemplates(declared, [mappedCustom()]);
    expect(merged).toHaveLength(declared.length + 1);
    expect(merged[0]!.origin).toBe("declared");
    const custom = merged[merged.length - 1]!;
    expect(custom.id).toBe("prod-deploy");
    expect(custom.origin).toBe("custom");
    expect(custom.baseTemplate).toBe("workers-deploy");
    // Mint semantics inherited from the base, not authored.
    const base = declared.find((t) => t.id === "workers-deploy")!;
    expect(custom.params).toEqual(base.params);
    expect(custom.maxTtlSeconds).toBe(base.maxTtlSeconds);
  });

  it("drops retired customs and customs whose base vanished", () => {
    const merged = mergeActiveTemplates(declared, [
      mappedCustom({ status: "retired" }),
      mappedCustom({ templateId: "orphan", baseTemplate: "no-such-base" }),
    ]);
    expect(merged).toHaveLength(declared.length);
  });
});

describe("scope-template CRUD handlers (SP4)", () => {
  const listUrl = "https://iw/v1/organizations/org/integrations/providers/cloudflare/scope-templates";

  it("list = declared + every custom (retired included), manage view", async () => {
    const { executor } = fakeExecutor((text) =>
      text.startsWith("SELECT") ? [customRow(), customRow({ template_id: "old", status: "retired" })] : [],
    );
    const res = await handleListScopeTemplates(
      new Request(listUrl),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      "cloudflare",
      { executor },
    );
    expect(res.status).toBe(200);
    const data = await body(res);
    const templates = data.templates as Array<Record<string, unknown>>;
    expect(templates.filter((t) => t.origin === "custom")).toHaveLength(2);
    expect(templates.find((t) => t.id === "old")!.status).toBe("retired");
  });

  it("create validates id grammar, declared collision, and unknown base (422)", async () => {
    const { executor, queries } = fakeExecutor(() => []);
    const post = (payload: unknown) =>
      handleCreateScopeTemplate(
        new Request(listUrl, { method: "POST", body: JSON.stringify(payload) }),
        createEnv(),
        "req_1",
        ACTOR,
        asUuid(ORG_UUID),
        "cloudflare",
        { executor },
      );
    expect((await post({ templateId: "BAD ID", baseTemplate: "workers-deploy", displayName: "x" })).status).toBe(422);
    expect((await post({ templateId: "workers-deploy", baseTemplate: "workers-deploy", displayName: "x" })).status).toBe(422);
    expect((await post({ templateId: "ok-id", baseTemplate: "nope", displayName: "x" })).status).toBe(422);
    // Fail-closed: no INSERT ever ran.
    expect(queries.filter((q) => q.text.includes("INSERT"))).toHaveLength(0);
  });

  it("create inserts and projects the wire template (201)", async () => {
    const { executor } = fakeExecutor((text) => (text.includes("INSERT") ? [customRow()] : []));
    const res = await handleCreateScopeTemplate(
      new Request(listUrl, {
        method: "POST",
        body: JSON.stringify({
          templateId: "prod-deploy",
          baseTemplate: "workers-deploy",
          displayName: "Prod deploy",
          description: "Deploys production workers.",
        }),
      }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      "cloudflare",
      { executor },
    );
    expect(res.status).toBe(201);
    const data = await body(res);
    const t = data.template as Record<string, unknown>;
    expect(t.id).toBe("prod-deploy");
    expect(t.origin).toBe("custom");
    expect(t.params).toEqual([]);
  });

  it("update refuses a declared id (409, code-owned)", async () => {
    const { executor } = fakeExecutor(() => []);
    const res = await handleUpdateScopeTemplate(
      new Request(`${listUrl}/workers-deploy`, { method: "PATCH", body: JSON.stringify({ displayName: "x" }) }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      "cloudflare",
      "workers-deploy",
      { executor },
    );
    expect(res.status).toBe(409);
  });

  it("display edits bump the version; retire flips status", async () => {
    const { executor, queries } = fakeExecutor((text) =>
      text.includes("UPDATE") ? [customRow({ version: 2, display_name: "Renamed" })] : [customRow()],
    );
    const res = await handleUpdateScopeTemplate(
      new Request(`${listUrl}/prod-deploy`, { method: "PATCH", body: JSON.stringify({ displayName: "Renamed" }) }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      "cloudflare",
      "prod-deploy",
      { executor },
    );
    expect(res.status).toBe(200);
    const update = queries.find((q) => q.text.includes("UPDATE"))!;
    expect(update.text).toContain("version = version + 1");
    const data = await body(res);
    expect((data.template as Record<string, unknown>).version).toBe(2);

    const { executor: e2, queries: q2 } = fakeExecutor((text) =>
      text.includes("UPDATE") ? [customRow({ status: "retired" })] : [customRow()],
    );
    const retire = await handleUpdateScopeTemplate(
      new Request(`${listUrl}/prod-deploy`, { method: "PATCH", body: JSON.stringify({ status: "retired" }) }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      "cloudflare",
      "prod-deploy",
      { executor: e2 },
    );
    expect(retire.status).toBe(200);
    // A status-only flip must NOT bump the version.
    expect(q2.find((q) => q.text.includes("UPDATE"))!.text).not.toContain("version = version + 1");
  });
});

describe("resolveCustomTemplate (the mint-path seam)", () => {
  it("resolves a custom id to its base — any status (retired keeps resolving)", async () => {
    const { executor } = fakeExecutor(() => [customRow({ status: "retired" })]);
    const resolved = await resolveCustomTemplate(
      executor,
      asUuid(ORG_UUID),
      "cloudflare",
      "prod-deploy",
      CLOUDFLARE_SCOPE_TEMPLATES,
    );
    expect(resolved?.id).toBe("workers-deploy");
  });

  it("returns null for an unknown id (template_unknown preserved)", async () => {
    const { executor } = fakeExecutor(() => []);
    const resolved = await resolveCustomTemplate(
      executor,
      asUuid(ORG_UUID),
      "cloudflare",
      "nope",
      CLOUDFLARE_SCOPE_TEMPLATES,
    );
    expect(resolved).toBeNull();
  });
});

describe("bulk capability read merges org customs (SP4)", () => {
  it("serves declared + active customs; fail-soft on a store error", async () => {
    const { executor } = fakeExecutor((text, params) =>
      text.startsWith("SELECT") && params.includes("cloudflare") ? [customRow()] : [],
    );
    const res = await handleListSecretsCapabilities(
      new Request("https://iw/v1/organizations/org/integrations/secrets-capabilities"),
      createEnv(),
      "req_1",
      ACTOR,
      ORG_UUID,
      { executor },
    );
    expect(res.status).toBe(200);
    const data = await body(res);
    const capabilities = data.capabilities as Array<Record<string, unknown>>;
    const cf = capabilities.find((c) => c.provider === "cloudflare")!;
    const ids = (cf.scopeTemplates as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain("prod-deploy");
    expect(ids).toContain("workers-deploy");

    // Store failure → declared catalog only, never a 5xx.
    const failing: SqlExecutor = {
      async execute() {
        throw new Error("boom");
      },
    };
    const res2 = await handleListSecretsCapabilities(
      new Request("https://iw/v1/organizations/org/integrations/secrets-capabilities"),
      createEnv(),
      "req_2",
      ACTOR,
      ORG_UUID,
      { executor: failing },
    );
    expect(res2.status).toBe(200);
    const data2 = await body(res2);
    const cf2 = (data2.capabilities as Array<Record<string, unknown>>).find(
      (c) => c.provider === "cloudflare",
    )!;
    expect((cf2.scopeTemplates as unknown[]).length).toBe(CLOUDFLARE_SCOPE_TEMPLATES.length);
  });
});

describe("toWireTemplate", () => {
  it("inherits params/TTL/custody from the base; identity from the row", () => {
    const base = CLOUDFLARE_SCOPE_TEMPLATES.find((t) => t.id === "dns-edit")!;
    const wire = toWireTemplate(mappedCustom({ baseTemplate: "dns-edit", templateId: "zones-only" }), base);
    expect(wire.id).toBe("zones-only");
    expect(wire.params).toEqual(["zoneIds"]);
    expect(wire.maxTtlSeconds).toBe(base.maxTtlSeconds);
    expect(wire.origin).toBe("custom");
  });
});
