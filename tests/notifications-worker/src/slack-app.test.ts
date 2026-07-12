// IH2: the slack_app channel kind — the group-aware chat.update provider and
// its dispatch resolution. Custody rule under test throughout: the bot token
// arrives per send over the service binding and never appears in stored
// config, attempt rows, or error reasons.

import { createSlackAppProvider } from "@notifications-worker/providers/slack-app";
import { resolveSendProvider } from "@notifications-worker/services/dispatch";
import { createEncryptionAdapter } from "@notifications-worker/encryption";
import type {
  NotificationChannelsRepository,
  NotificationsRepository,
  SlackGroupMessage,
  SlackGroupMessagesRepository,
} from "@saas/db/notifications";
import type { NotificationProvider, ProviderSendContext } from "@saas/contracts/notifications";
import { asUuid } from "@saas/db/ids";

const NOW = new Date("2026-07-12T10:00:00.000Z");
const ORG = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const CHAN_ROW = "11111111-2222-4333-8444-555555555555";
const KEY = "ab".repeat(32);
const BOT_TOKEN = "xoxb-secret-token";
const RULE_ID = "rule_0123456789abcdef0123456789abcdef";

function ctx(templateData: Record<string, string | number | boolean | null>): ProviderSendContext {
  return {
    notificationId: "ntf-1",
    orgId: ORG,
    category: "product",
    templateKey: "event.notification",
    templateData,
    recipient: { channel: "slack", address: "chan_x" },
  };
}

/** Fake Slack Web API recording chat.postMessage / chat.update calls. */
function slackApi(overrides?: {
  updateError?: string;
  postTs?: string;
}): {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; body: Record<string, unknown>; auth: string | null }>;
} {
  const calls: Array<{ method: string; body: Record<string, unknown>; auth: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = url.split("/api/")[1] ?? url;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({
      method,
      body,
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (method === "chat.update" && overrides?.updateError) {
      return Response.json({ ok: false, error: overrides.updateError });
    }
    return Response.json({
      ok: true,
      channel: body.channel,
      ts: method === "chat.update" ? body.ts : (overrides?.postTs ?? "1720780800.000100"),
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function groupStore(existing?: Partial<SlackGroupMessage>): {
  repo: SlackGroupMessagesRepository;
  upserts: Array<Record<string, unknown>>;
} {
  const upserts: Array<Record<string, unknown>> = [];
  const row: SlackGroupMessage | null = existing
    ? {
        channelId: CHAN_ROW,
        groupKey: "g1",
        slackChannel: "C0AAA",
        slackTs: "1720000000.000001",
        lastSeverity: "notice",
        createdAt: NOW,
        updatedAt: NOW,
        ...existing,
      }
    : null;
  const repo: SlackGroupMessagesRepository = {
    async get() {
      return { ok: true, value: row };
    },
    async upsert(input) {
      upserts.push(input as unknown as Record<string, unknown>);
      return {
        ok: true,
        value: {
          channelId: input.channelId,
          groupKey: input.groupKey,
          slackChannel: input.slackChannel,
          slackTs: input.slackTs,
          lastSeverity: input.lastSeverity ?? null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      };
    },
  };
  return { repo, upserts };
}

/** The IH3 action buttons of a message body (attachment blocks), or null. */
function actionsOf(body: Record<string, unknown>): Array<Record<string, unknown>> | null {
  const attachments = body.attachments as
    | Array<{ blocks?: Array<Record<string, unknown>> }>
    | undefined;
  const block = attachments?.[0]?.blocks?.find((b) => b.type === "actions");
  return block ? (block.elements as Array<Record<string, unknown>>) : null;
}

function provider(opts?: {
  groups?: SlackGroupMessagesRepository;
  api?: ReturnType<typeof slackApi>;
}): { p: NotificationProvider; api: ReturnType<typeof slackApi> } {
  const api = opts?.api ?? slackApi();
  return {
    p: createSlackAppProvider({
      botToken: BOT_TOKEN,
      channelExternalId: "C0AAA",
      channelRowId: CHAN_ROW,
      groupsRepo: opts?.groups,
      fetchImpl: api.fetchImpl,
    }),
    api,
  };
}

describe("slack-app provider (IH2)", () => {
  it("posts a plain message for a non-grouped notification", async () => {
    const { p, api } = provider();
    const result = await p.send(ctx({ title: "Deploy finished", severity: "info" }));
    expect(result.ok).toBe(true);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.method).toBe("chat.postMessage");
    expect(api.calls[0]!.auth).toBe(`Bearer ${BOT_TOKEN}`);
    expect(api.calls[0]!.body.channel).toBe("C0AAA");
    // IH3: non-grouped posts stay button-less.
    expect(actionsOf(api.calls[0]!.body)).toBeNull();
    if (result.ok) expect(result.providerMessageId).toContain("slack:C0AAA:");
  });

  it("first fire of a story posts and records the message coordinates", async () => {
    const { repo, upserts } = groupStore();
    const { p, api } = provider({ groups: repo });
    const result = await p.send(
      ctx({ title: "Run failed", severity: "notice", groupKey: "g1", escalation: false, ruleId: RULE_ID }),
    );
    expect(result.ok).toBe(true);
    expect(api.calls.map((c) => c.method)).toEqual(["chat.postMessage"]);
    // IH3: grouped story posts carry Acknowledge + Mute rule 1h buttons.
    const buttons = actionsOf(api.calls[0]!.body);
    expect(buttons).toEqual([
      expect.objectContaining({ action_id: "orun_ack", value: "ntf-1" }),
      expect.objectContaining({ action_id: "orun_mute", value: RULE_ID }),
    ]);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      channelId: CHAN_ROW,
      groupKey: "g1",
      slackTs: "1720780800.000100",
      lastSeverity: "notice",
    });
  });

  it("a subsequent group fire edits the story's message in place (buttons included)", async () => {
    const { repo, upserts } = groupStore({});
    const { p, api } = provider({ groups: repo });
    const result = await p.send(
      ctx({ title: "Run failed", severity: "notice", groupKey: "g1", escalation: false, ruleId: RULE_ID }),
    );
    expect(result.ok).toBe(true);
    expect(api.calls.map((c) => c.method)).toEqual(["chat.update"]);
    expect(api.calls[0]!.body.ts).toBe("1720000000.000001");
    const buttons = actionsOf(api.calls[0]!.body);
    expect(buttons?.map((b) => b.action_id)).toEqual(["orun_ack", "orun_mute"]);
    expect(upserts).toHaveLength(1); // severity high-water refresh, same ts
    expect(upserts[0]!.replaceTs).toBeUndefined();
  });

  it("omits the mute button when templateData carries no rule id", async () => {
    const { repo } = groupStore();
    const { p, api } = provider({ groups: repo });
    const result = await p.send(ctx({ title: "Run failed", severity: "notice", groupKey: "g1", escalation: false }));
    expect(result.ok).toBe(true);
    const buttons = actionsOf(api.calls[0]!.body);
    expect(buttons?.map((b) => b.action_id)).toEqual(["orun_ack"]);
  });

  it("a severity escalation edits the root AND replies in its thread", async () => {
    const { repo } = groupStore({});
    const { p, api } = provider({ groups: repo });
    const result = await p.send(
      ctx({ title: "Run failed", severity: "error", groupKey: "g1", escalation: true, ruleId: RULE_ID }),
    );
    expect(result.ok).toBe(true);
    expect(api.calls.map((c) => c.method)).toEqual(["chat.update", "chat.postMessage"]);
    const reply = api.calls[1]!.body;
    expect(reply.thread_ts).toBe("1720000000.000001");
    expect(String(reply.text)).toContain("escalated");
    // The thread reply overrides blocks/attachments — no buttons ride it.
    expect(actionsOf(reply)).toBeNull();
    expect((reply.blocks as Array<{ type: string }>).every((b) => b.type !== "actions")).toBe(true);
  });

  it("re-roots the story when the original message is gone", async () => {
    const api = slackApi({ updateError: "message_not_found", postTs: "1720999999.000009" });
    const { repo, upserts } = groupStore({});
    const { p } = provider({ groups: repo, api });
    const result = await p.send(ctx({ title: "Run failed", severity: "notice", groupKey: "g1", escalation: false }));
    expect(result.ok).toBe(true);
    expect(api.calls.map((c) => c.method)).toEqual(["chat.update", "chat.postMessage"]);
    expect(upserts[0]).toMatchObject({ slackTs: "1720999999.000009", replaceTs: true });
  });

  it("bounds provider errors to Slack's error token — never the bot token", async () => {
    const api = slackApi({ updateError: "channel_not_found" });
    const { repo } = groupStore({});
    const { p } = provider({ groups: repo, api });
    const result = await p.send(ctx({ title: "x", severity: "info", groupKey: "g1" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorReason).toBe("slack_api_channel_not_found");
      expect(result.errorReason).not.toContain(BOT_TOKEN);
    }
  });
});

// ── Dispatch resolution for kind slack_app ──────────────────

const OK = { ok: true as const, providerMessageId: "m" };

function emailProvider(): NotificationProvider {
  return { name: "email", async send() { return OK; } };
}

function channelsRepoFor(kind: string, ciphertext: string): NotificationChannelsRepository {
  return {
    async getChannelConfigForSend() {
      return {
        ok: true as const,
        value: { id: CHAN_ROW, orgId: ORG, kind, status: "active", configCiphertext: ciphertext },
      };
    },
  } as unknown as NotificationChannelsRepository;
}

function credentialsBinding(outcome: Record<string, unknown>): {
  binding: Fetcher;
  requests: Array<Record<string, unknown>>;
} {
  const requests: Array<Record<string, unknown>> = [];
  const binding = {
    fetch: async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ data: outcome, meta: { requestId: "req" } });
    },
  } as unknown as Fetcher;
  return { binding, requests };
}

describe("resolveSendProvider (slack_app)", () => {
  const CHAN = "chan_0123456789abcdef0123456789abcdef";
  const REF = {
    connectionId: "int_00000000000000000000000000000abc",
    channelExternalId: "C0AAA",
    channelName: "alerts",
  };

  async function encryptedRef(): Promise<string> {
    const adapter = (await createEncryptionAdapter(KEY))!;
    return JSON.stringify(await adapter.encrypt(JSON.stringify(REF)));
  }

  it("fetches the bot token over the binding and builds the slack-app provider", async () => {
    const { binding, requests } = credentialsBinding({ ok: true, botToken: BOT_TOKEN, teamId: "T1" });
    const resolution = await resolveSendProvider(
      {
        repo: {} as NotificationsRepository,
        emailProvider: emailProvider(),
        channelsRepo: channelsRepoFor("slack_app", await encryptedRef()),
        encryptionKey: KEY,
        integrationsBinding: binding,
      },
      asUuid(ORG),
      "slack",
      CHAN,
    );
    expect(resolution.ok).toBe(true);
    expect(resolution.provider?.name).toBe("slack-app");
    // The read is org-scoped: the notification's org rides the request, so
    // admission (IT10) is re-checked at every send.
    expect(requests[0]).toMatchObject({ connectionId: REF.connectionId });
    expect(String(requests[0]!.orgId)).toMatch(/^org_/);
  });

  it("surfaces a bounded reason when the credential read is refused", async () => {
    const { binding } = credentialsBinding({ ok: false, reason: "not_active" });
    const resolution = await resolveSendProvider(
      {
        repo: {} as NotificationsRepository,
        emailProvider: emailProvider(),
        channelsRepo: channelsRepoFor("slack_app", await encryptedRef()),
        encryptionKey: KEY,
        integrationsBinding: binding,
      },
      asUuid(ORG),
      "slack",
      CHAN,
    );
    expect(resolution.ok).toBe(false);
    expect(resolution.errorReason).toBe("credentials_not_active");
  });

  it("parks with slack_app_not_configured when the binding is absent", async () => {
    const resolution = await resolveSendProvider(
      {
        repo: {} as NotificationsRepository,
        emailProvider: emailProvider(),
        channelsRepo: channelsRepoFor("slack_app", await encryptedRef()),
        encryptionKey: KEY,
      },
      asUuid(ORG),
      "slack",
      CHAN,
    );
    expect(resolution.ok).toBe(false);
    expect(resolution.errorReason).toBe("slack_app_not_configured");
  });
});
