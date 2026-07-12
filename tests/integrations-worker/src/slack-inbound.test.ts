// IH3: Slack inbound — ingress (verify-insert-ack, url_verification, the
// slash-command ephemeral ack) and the Slack drain path (team_id attribution,
// lifecycle revoke + zeroize, messaging.* emission, best-effort Slack-side
// follow-through).

import { webcrypto } from "node:crypto";
import {
  handleSlackCommandsIngest,
  handleSlackEventsIngest,
  handleSlackInteractivityIngest,
} from "@integrations-worker/handlers/slack-ingress";
import {
  buildOrunCommandResponse,
  processSlackDelivery,
  teamIdFromSlackPayload,
} from "@integrations-worker/slack-drain";
import type { ProcessCtx } from "@integrations-worker/drain";
import { createEncryptionAdapter } from "@integrations-worker/encryption";
import type { Env } from "@integrations-worker/env";
import {
  createIntegrationsRepository,
  type InboundDelivery,
} from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const SIGNING_SECRET = "slack-signing-secret";
const KEY = "ef".repeat(32);
const NOW = new Date("2026-07-12T12:00:00Z");

type QueryRecord = { text: string; params: unknown[] };
type SqlResponder = (text: string, params: unknown[]) => Record<string, unknown>[] | null;

function fakeExecutor(respond: SqlResponder): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
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

function createEnv(overrides?: Partial<Record<string, unknown>>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    SLACK_APP_CLIENT_ID: "cid",
    SLACK_APP_CLIENT_SECRET: "cs",
    SLACK_APP_SIGNING_SECRET: SIGNING_SECRET,
    SECRET_ENCRYPTION_KEY: KEY,
    CONSOLE_BASE_URL: "https://console.test",
    ...overrides,
  } as unknown as Env;
}

async function v0Signature(body: string, timestamp: string): Promise<string> {
  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await webcrypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return `v0=${hex}`;
}

async function signedRequest(path: string, body: string): Promise<Request> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request(`https://worker.test${path}`, {
    method: "POST",
    headers: {
      "content-type": path.includes("events")
        ? "application/json"
        : "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": await v0Signature(body, timestamp),
    },
    body,
  });
}

// ── Ingress ─────────────────────────────────────────────────

describe("slack ingress (IH3)", () => {
  it("rejects a bad signature before any parse or insert", async () => {
    const { executor, queries } = fakeExecutor(() => []);
    const req = new Request("https://worker.test/ingress/slack/events", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=" + "0".repeat(64),
      },
      body: JSON.stringify({ type: "event_callback" }),
    });
    const res = await handleSlackEventsIngest(req, createEnv(), "req_1", { executor });
    expect(res.status).toBe(401);
    expect(queries).toHaveLength(0);
  });

  it("answers url_verification synchronously and never persists it", async () => {
    const { executor, queries } = fakeExecutor(() => []);
    const body = JSON.stringify({ type: "url_verification", challenge: "chal_123" });
    const res = await handleSlackEventsIngest(
      await signedRequest("/ingress/slack/events", body),
      createEnv(),
      "req_1",
      { executor },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "chal_123" });
    expect(queries).toHaveLength(0);
  });

  it("inserts a verified event with delivery_key = event_id (202, duplicate → 200)", async () => {
    let inserted: unknown[] = [];
    let dup = false;
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("INSERT INTO integrations.inbound_deliveries")) {
        inserted = params;
        return dup ? [] : [{ id: params[0], provider: "slack", delivery_key: params[2] }];
      }
      // Duplicate path re-selects the existing row.
      if (text.includes("FROM integrations.inbound_deliveries")) {
        return [{ id: "existing", provider: "slack", delivery_key: "Ev123" }];
      }
      return [];
    });
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev123",
      team_id: "T0TEAM",
      event: { type: "channel_rename", channel: { id: "C1", name: "renamed" } },
    });
    const first = await handleSlackEventsIngest(
      await signedRequest("/ingress/slack/events", body),
      createEnv(),
      "req_1",
      { executor },
    );
    expect(first.status).toBe(202);
    expect(inserted[1]).toBe("slack"); // provider
    expect(inserted[2]).toBe("Ev123"); // delivery_key
    expect(inserted[3]).toBe("channel_rename"); // event_type

    dup = true;
    const second = await handleSlackEventsIngest(
      await signedRequest("/ingress/slack/events", body),
      createEnv(),
      "req_1",
      { executor },
    );
    expect(second.status).toBe(200);
  });

  it("acks a slash command ephemerally after inserting it", async () => {
    let inserted: unknown[] = [];
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("INSERT INTO integrations.inbound_deliveries")) {
        inserted = params;
        return [{ id: params[0] }];
      }
      return [];
    });
    const body = new URLSearchParams({
      command: "/orun",
      text: "status",
      team_id: "T0TEAM",
      user_id: "U1",
      channel_id: "C1",
      trigger_id: "123.456.abc",
      response_url: "https://hooks.slack.com/commands/T0/1/xyz",
    }).toString();
    const res = await handleSlackCommandsIngest(
      await signedRequest("/ingress/slack/commands", body),
      createEnv(),
      "req_1",
      { executor },
    );
    expect(res.status).toBe(200);
    const ack = (await res.json()) as { response_type: string; text: string };
    expect(ack.response_type).toBe("ephemeral");
    expect(ack.text).toContain("On it");
    expect(inserted[3]).toBe("slash_command");
    expect(inserted[2]).toBe("cmd.123.456.abc");
  });

  it("parses the interactivity form payload and inserts it", async () => {
    let inserted: unknown[] = [];
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("INSERT INTO integrations.inbound_deliveries")) {
        inserted = params;
        return [{ id: params[0] }];
      }
      return [];
    });
    const payload = {
      type: "block_actions",
      trigger_id: "999.888.def",
      team: { id: "T0TEAM" },
      user: { id: "U1" },
      channel: { id: "C1" },
      message: { ts: "1720.1" },
      actions: [{ action_id: "orun_ack", value: "ntf_x" }],
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const res = await handleSlackInteractivityIngest(
      await signedRequest("/ingress/slack/interactivity", body),
      createEnv(),
      "req_1",
      { executor },
    );
    expect(res.status).toBe(202);
    expect(inserted[3]).toBe("interactivity");
    expect(inserted[2]).toBe("act.999.888.def");
  });
});

// ── Drain ───────────────────────────────────────────────────

function delivery(overrides?: Partial<InboundDelivery>): InboundDelivery {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    orgId: null,
    connectionId: null,
    provider: "slack",
    deliveryKey: "Ev123",
    eventType: "channel_archive",
    action: null,
    payload: {},
    signatureOk: true,
    status: "received",
    attempts: 0,
    nextAttemptAt: null,
    failureReason: null,
    emittedEventId: null,
    receivedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function connectionRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: CONNECTION_UUID,
    org_id: ORG_UUID,
    provider: "slack",
    status: "active",
    scope: "account",
    share_mode: "auto",
    display_name: "Acme Workspace",
    created_by: "usr_abc",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function workspaceRow(): Record<string, unknown> {
  return {
    id: "ws-row",
    connection_id: CONNECTION_UUID,
    team_id: "T0TEAM",
    team_name: "Acme Workspace",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function inboxRow(): Record<string, unknown> {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    org_id: ORG_UUID,
    connection_id: CONNECTION_UUID,
    provider: "slack",
    delivery_key: "Ev123",
    event_type: "channel_archive",
    action: null,
    payload: {},
    signature_ok: true,
    status: "emitted",
    attempts: 0,
    next_attempt_at: null,
    failure_reason: null,
    emitted_event_id: null,
    received_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function makeCtx(respond: SqlResponder, env?: Env): { ctx: ProcessCtx; queries: QueryRecord[] } {
  // Every drain path finishes by appending to event_log and marking the
  // inbox row — answer those shapes here so per-case responders only describe
  // the interesting reads (they still see every query for capture).
  const eventRow = () => ({
    id: "evt-1",
    type: "x",
    version: 1,
    source: "integrations-worker",
    occurred_at: NOW.toISOString(),
    actor_type: "system",
    actor_id: "integrations-worker",
    org_id: ORG_UUID,
    subject_kind: "integration_connection",
    subject_id: CONNECTION_UUID,
    request_id: "req",
    payload: {},
  });
  const withMark: SqlResponder = (text, params) => {
    const rows = respond(text, params);
    if (text.includes("WITH inserted_event")) {
      return [{ _event: eventRow(), _audit: { ...eventRow(), id: "aud-1" } }];
    }
    if (text.includes("INSERT INTO events.event_log")) {
      return [eventRow()];
    }
    if ((rows === null || rows.length === 0) && text.includes("UPDATE integrations.inbound_deliveries")) {
      return [inboxRow()];
    }
    return rows;
  };
  const { executor, queries } = fakeExecutor(withMark);
  const ctx: ProcessCtx = {
    executor,
    repo: createIntegrationsRepository(executor),
    events: createEventsRepository(executor),
    state: { listActiveWorkspaceLinksForProviderRepo: async () => ({ ok: true, value: [] }) },
    membership: {
      getOrganizationById: async () => ({ ok: false, error: { kind: "not_found" } }),
    } as unknown as ProcessCtx["membership"],
    env: env ?? createEnv(),
    now: () => NOW,
  };
  return { ctx, queries };
}

/** Route global fetch to a recorder for the drain's best-effort Slack calls. */
function captureFetch(): { calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }>; restore: () => void } {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      auth: new Headers(init?.headers).get("authorization"),
    });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

describe("slack drain (IH3)", () => {
  it("extracts team ids across all three ingress shapes", () => {
    expect(teamIdFromSlackPayload({ team_id: "T1" })).toBe("T1");
    expect(teamIdFromSlackPayload({ team: { id: "T2" } })).toBe("T2");
    expect(teamIdFromSlackPayload({})).toBeNull();
  });

  it("skips deliveries from an unknown workspace (unattributed, fail closed)", async () => {
    const { ctx, queries } = makeCtx((text) =>
      text.includes("slack_workspaces") ? [] : [],
    );
    const outcome = await processSlackDelivery(ctx, delivery({ payload: { team_id: "T?"} }));
    expect(outcome).toEqual({ kind: "skipped", reason: "unattributed_workspace" });
    expect(queries.some((q) => q.text.includes("UPDATE integrations.inbound_deliveries"))).toBe(true);
  });

  it("app_uninstalled revokes the connection, zeroizes custody, and emits integration.revoked", async () => {
    const { ctx, queries } = makeCtx((text) => {
      if (text.includes("slack_workspaces")) return [workspaceRow()];
      if (text.includes("FROM integrations.connections WHERE id")) return [connectionRow()];
      if (text.includes("SET status = $3")) return [connectionRow({ status: "revoked" })];
      if (text.includes("INSERT INTO")) return [{ id: "evt" }];
      return [];
    });
    const outcome = await processSlackDelivery(
      ctx,
      delivery({ eventType: "app_uninstalled", payload: { team_id: "T0TEAM", event: { type: "app_uninstalled" } } }),
    );
    expect(outcome).toEqual({ kind: "emitted", eventType: "integration.revoked" });
    expect(queries.some((q) => q.text.includes("SET status = $3"))).toBe(true);
    expect(
      queries.some((q) => q.text.includes("DELETE FROM integrations.provider_credentials")),
    ).toBe(true);
  });

  it("channel_archive emits messaging.channel.archived with the channel reference", async () => {
    let eventInsert: unknown[] = [];
    const { ctx } = makeCtx((text, params) => {
      if (text.includes("slack_workspaces")) return [workspaceRow()];
      if (text.includes("FROM integrations.connections WHERE id")) return [connectionRow()];
      if (text.includes("INSERT INTO events.event_log") || text.includes("INSERT INTO events.")) {
        if (!eventInsert.length) eventInsert = params;
        return [{ id: "evt" }];
      }
      if (text.includes("INSERT INTO")) return [{ id: "row" }];
      return [];
    });
    const outcome = await processSlackDelivery(
      ctx,
      delivery({
        eventType: "channel_archive",
        payload: { team_id: "T0TEAM", event: { type: "channel_archive", channel: { id: "C9", name: "old-alerts" } } },
      }),
    );
    expect(outcome).toEqual({ kind: "emitted", eventType: "messaging.channel.archived" });
  });

  it("slash_command emits messaging.command.invoked and answers via response_url", async () => {
    const fetchSpy = captureFetch();
    try {
      const { ctx } = makeCtx((text) => {
        if (text.includes("slack_workspaces")) return [workspaceRow()];
        if (text.includes("FROM integrations.connections WHERE id")) return [connectionRow()];
        if (text.includes("INSERT INTO")) return [{ id: "evt" }];
        return [];
      });
      const outcome = await processSlackDelivery(
        ctx,
        delivery({
          eventType: "slash_command",
          deliveryKey: "cmd.1",
          payload: {
            team_id: "T0TEAM",
            command: "/orun",
            text: "status",
            user_id: "U1",
            channel_id: "C1",
            response_url: "https://hooks.slack.com/commands/T0/1/xyz",
          },
        }),
      );
      expect(outcome).toEqual({ kind: "emitted", eventType: "messaging.command.invoked" });
      expect(fetchSpy.calls).toHaveLength(1);
      expect(fetchSpy.calls[0]!.url).toContain("hooks.slack.com/commands");
      expect(fetchSpy.calls[0]!.body.response_type).toBe("ephemeral");
      expect(String(fetchSpy.calls[0]!.body.text)).toContain("status");
    } finally {
      fetchSpy.restore();
    }
  });

  it("orun_ack emits acknowledge and thread-replies with the custody token", async () => {
    const adapter = (await createEncryptionAdapter(KEY))!;
    const envelope = await adapter.encrypt("xoxb-drain-token");
    const fetchSpy = captureFetch();
    try {
      const { ctx } = makeCtx((text) => {
        if (text.includes("slack_workspaces")) return [workspaceRow()];
        if (text.includes("FROM integrations.connections WHERE id")) return [connectionRow()];
        if (text.includes("FROM integrations.provider_credentials")) {
          return [
            {
              id: "cred",
              connection_id: CONNECTION_UUID,
              kind: "slack_bot_token",
              ciphertext: JSON.stringify(envelope),
              created_at: NOW.toISOString(),
              updated_at: NOW.toISOString(),
            },
          ];
        }
        if (text.includes("INSERT INTO")) return [{ id: "evt" }];
        return [];
      });
      const outcome = await processSlackDelivery(
        ctx,
        delivery({
          eventType: "interactivity",
          deliveryKey: "act.1",
          payload: {
            type: "block_actions",
            team: { id: "T0TEAM" },
            user: { id: "U7" },
            channel: { id: "C1" },
            message: { ts: "1720.42" },
            actions: [{ action_id: "orun_ack", value: "ntf_x" }],
          },
        }),
      );
      expect(outcome).toEqual({ kind: "emitted", eventType: "messaging.action.invoked" });
      const reply = fetchSpy.calls.find((c) => c.url.includes("chat.postMessage"));
      expect(reply).toBeDefined();
      expect(reply!.auth).toBe("Bearer xoxb-drain-token");
      expect(reply!.body.thread_ts).toBe("1720.42");
      expect(String(reply!.body.text)).toContain("<@U7>");
    } finally {
      fetchSpy.restore();
    }
  });

  it("orun_mute emits mute_rule with the rule reference and confirms ephemerally", async () => {
    const fetchSpy = captureFetch();
    try {
      let eventParams: unknown[] = [];
      const { ctx } = makeCtx((text, params) => {
        if (text.includes("slack_workspaces")) return [workspaceRow()];
        if (text.includes("FROM integrations.connections WHERE id")) return [connectionRow()];
        if (text.includes("INSERT INTO events.")) {
          eventParams = params;
          return [{ id: "evt" }];
        }
        if (text.includes("INSERT INTO")) return [{ id: "row" }];
        return [];
      });
      const outcome = await processSlackDelivery(
        ctx,
        delivery({
          eventType: "interactivity",
          deliveryKey: "act.2",
          payload: {
            type: "block_actions",
            team: { id: "T0TEAM" },
            user: { id: "U7" },
            channel: { id: "C1" },
            message: { ts: "1720.42" },
            response_url: "https://hooks.slack.com/actions/T0/2/abc",
            actions: [{ action_id: "orun_mute", value: "rule_abc123" }],
          },
        }),
      );
      expect(outcome).toEqual({ kind: "emitted", eventType: "messaging.action.invoked" });
      expect(JSON.stringify(eventParams)).toContain("mute_rule");
      expect(JSON.stringify(eventParams)).toContain("rule_abc123");
      const confirm = fetchSpy.calls.find((c) => c.url.includes("hooks.slack.com/actions"));
      expect(confirm).toBeDefined();
      expect(String(confirm!.body.text)).toContain("muted");
    } finally {
      fetchSpy.restore();
    }
  });
});

describe("/orun command responses", () => {
  it("answers status/runs/help with ephemeral, deep-linked summaries", () => {
    const links = { events: "https://console.test/events", console: "https://console.test/" };
    const status = buildOrunCommandResponse("status", "Acme", links);
    expect(status.response_type).toBe("ephemeral");
    expect(JSON.stringify(status)).toContain("console.test/events");
    const runs = buildOrunCommandResponse("runs api", "Acme", links);
    expect(JSON.stringify(runs)).toContain("Recent runs");
    const help = buildOrunCommandResponse("", null, links);
    expect(JSON.stringify(help)).toContain("/orun status");
  });
});
