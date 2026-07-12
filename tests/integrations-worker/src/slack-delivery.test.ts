// IH2: the integrations-worker half of the custody/delivery split —
// the channel picker (MessagingCapability listChannels) and the internal
// slack_app credential read behind the service-binding boundary.

import { route } from "@integrations-worker/router";
import { handleListSlackChannels } from "@integrations-worker/handlers/slack-channels";
import { handleSlackCredentialsInternal } from "@integrations-worker/handlers/slack-credentials-internal";
import { listSlackChannels } from "@integrations-worker/providers/slack";
import { createEncryptionAdapter } from "@integrations-worker/encryption";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_UUID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = asUuid(ORG_UUID);
const CONNECTION_ID = asUuid(CONNECTION_UUID);
const ORG_PUBLIC = `org_${ORG_UUID.replace(/-/g, "")}`;
const CONNECTION_PUBLIC = `int_${CONNECTION_UUID.replace(/-/g, "")}`;
const KEY = "cd".repeat(32);
const BOT_TOKEN = "xoxb-delivery-token";
const NOW = new Date("2026-07-12T11:00:00Z");

type SqlResponder = (text: string, params: unknown[]) => Record<string, unknown>[] | null;

function fakeExecutor(respond: SqlResponder): { executor: SqlExecutor; queries: string[] } {
  const queries: string[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push(text);
      const rows = (respond(text, params ?? []) ?? []) as unknown as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { executor, queries };
}

function jsonFetcher(body: unknown): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json(body)),
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function createEnv(overrides?: Partial<Record<string, unknown>>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: jsonFetcher({
      data: {
        memberships: [
          { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_UUID } },
        ],
      },
    }),
    POLICY_WORKER: jsonFetcher({ data: { allow: true, reason: "org_admin" } }),
    SECRET_ENCRYPTION_KEY: KEY,
    SLACK_APP_CLIENT_ID: "cid",
    SLACK_APP_CLIENT_SECRET: "cs",
    SLACK_APP_SIGNING_SECRET: "signing",
    ...overrides,
  } as unknown as Env;
}

const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

function activeSlackConnectionRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: CONNECTION_UUID,
    org_id: ORG_UUID,
    provider: "slack",
    status: "active",
    scope: "account",
    share_mode: "auto",
    display_name: "Acme Workspace",
    external_account_login: "Acme Workspace",
    external_account_id: "T0TEAM",
    external_account_type: "workspace",
    created_by: "usr_abc",
    connected_at: NOW.toISOString(),
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

async function credentialRow(): Promise<Record<string, unknown>> {
  const adapter = (await createEncryptionAdapter(KEY))!;
  const envelope = await adapter.encrypt(BOT_TOKEN);
  return {
    id: "cred-1",
    connection_id: CONNECTION_UUID,
    kind: "slack_bot_token",
    ciphertext: JSON.stringify(envelope),
    scopes: null,
    external_ref: "T0TEAM",
    expires_at: null,
    rotated_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

const conversationsFetch =
  (channels?: Array<Record<string, unknown>>, nextCursor?: string) => (input: string) => {
    if (input.includes("conversations.list")) {
      return Promise.resolve(
        Response.json({
          ok: true,
          channels: channels ?? [
            { id: "C0AAA", name: "alerts", is_private: false },
            { id: "G0BBB", name: "ops-private", is_private: true },
          ],
          response_metadata: { next_cursor: nextCursor ?? "" },
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

// ── conversations.list adapter unit ─────────────────────────

describe("listSlackChannels (conversations.list)", () => {
  it("maps channels, filters by query, and surfaces the cursor", async () => {
    const page = await listSlackChannels(
      { accessToken: BOT_TOKEN, query: "alert" },
      conversationsFetch(undefined, "cur_2"),
    );
    expect(page).toEqual({
      channels: [{ externalId: "C0AAA", name: "alerts", isPrivate: false }],
      nextCursor: "cur_2",
    });
  });

  it("returns null when Slack refuses the token", async () => {
    await expect(
      listSlackChannels({ accessToken: "bad" }, () =>
        Promise.resolve(Response.json({ ok: false, error: "invalid_auth" })),
      ),
    ).resolves.toBeNull();
  });
});

// ── Channel picker route ────────────────────────────────────

describe("GET .../integrations/{id}/slack/channels", () => {
  function pickerRequest(qs = ""): Request {
    return new Request(
      `https://worker.test/v1/organizations/x/integrations/y/slack/channels${qs}`,
      { method: "GET" },
    );
  }

  it("denies via policy as 404", async () => {
    const env = createEnv({ POLICY_WORKER: jsonFetcher({ data: { allow: false, reason: "no" } }) });
    const { executor } = fakeExecutor(() => []);
    const res = await handleListSlackChannels(pickerRequest(), env, "req_1", ACTOR, ORG_ID, CONNECTION_ID, {
      executor,
    });
    expect(res.status).toBe(404);
  });

  it("parks 412 while the Slack App secrets are unset", async () => {
    const env = createEnv({ SLACK_APP_CLIENT_ID: undefined });
    const { executor } = fakeExecutor(() => []);
    const res = await handleListSlackChannels(pickerRequest(), env, "req_1", ACTOR, ORG_ID, CONNECTION_ID, {
      executor,
    });
    expect(res.status).toBe(412);
  });

  it("409s a connection that is not active", async () => {
    const env = createEnv();
    const { executor } = fakeExecutor((text) =>
      text.includes("FROM integrations.connections") ? [activeSlackConnectionRow({ status: "revoked" })] : [],
    );
    const res = await handleListSlackChannels(pickerRequest(), env, "req_1", ACTOR, ORG_ID, CONNECTION_ID, {
      executor,
      fetchImpl: conversationsFetch(),
    });
    expect(res.status).toBe(409);
  });

  it("decrypts custody and returns the channel page", async () => {
    const env = createEnv();
    const cred = await credentialRow();
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections")) return [activeSlackConnectionRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [cred];
      return [];
    });
    const res = await handleListSlackChannels(
      pickerRequest("?query=alert"),
      env,
      "req_1",
      ACTOR,
      ORG_ID,
      CONNECTION_ID,
      { executor, fetchImpl: conversationsFetch() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { channels: unknown[]; nextCursor: string | null } };
    expect(body.data.channels).toEqual([{ id: "C0AAA", name: "alerts", isPrivate: false }]);
    expect(body.data.nextCursor).toBeNull();
  });
});

// ── Internal credential read ────────────────────────────────

describe("POST /internal/slack/credentials", () => {
  function internalRequest(body: unknown, headers?: Record<string, string>): Request {
    return new Request("https://worker.test/internal/slack/credentials", {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify(body),
    });
  }

  it("403s without an allowlisted internal caller (router boundary)", async () => {
    const res = await route(internalRequest({}), createEnv());
    expect(res.status).toBe(403);
    const bad = await route(
      internalRequest({}, { "x-internal-caller": "api-edge" }),
      createEnv(),
    );
    expect(bad.status).toBe(403);
  });

  it("returns the decrypted bot token for a usable active connection", async () => {
    const env = createEnv();
    const cred = await credentialRow();
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations.connections")) return [activeSlackConnectionRow()];
      if (text.includes("FROM integrations.provider_credentials")) return [cred];
      return [];
    });
    const res = await handleSlackCredentialsInternal(
      internalRequest({ orgId: ORG_PUBLIC, connectionId: CONNECTION_PUBLIC }),
      env,
      "req_1",
      { executor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({ ok: true, botToken: BOT_TOKEN, teamId: "T0TEAM" });
  });

  it("refuses a connection the org cannot use (fail-soft outcome)", async () => {
    // The org-scoped read finds nothing and the read-up path is closed (no
    // membership worker ⇒ no parent resolution): not_found, no token.
    const env = createEnv({ MEMBERSHIP_WORKER: undefined });
    const { executor } = fakeExecutor(() => []);
    const res = await handleSlackCredentialsInternal(
      internalRequest({ orgId: `org_${OTHER_ORG_UUID.replace(/-/g, "")}`, connectionId: CONNECTION_PUBLIC }),
      env,
      "req_1",
      { executor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({ ok: false, reason: "not_found" });
  });

  it("reports not_active for a revoked connection", async () => {
    const env = createEnv();
    const { executor } = fakeExecutor((text) =>
      text.includes("FROM integrations.connections")
        ? [activeSlackConnectionRow({ status: "revoked" })]
        : [],
    );
    const res = await handleSlackCredentialsInternal(
      internalRequest({ orgId: ORG_PUBLIC, connectionId: CONNECTION_PUBLIC }),
      env,
      "req_1",
      { executor },
    );
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({ ok: false, reason: "not_active" });
  });
});
