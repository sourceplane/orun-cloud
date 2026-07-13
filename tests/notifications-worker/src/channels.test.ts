import {
  handleListChannels,
  handleCreateChannel,
  handleTestChannel,
} from "@notifications-worker/handlers/channels";
import type { Env } from "@notifications-worker/env";
import type { InternalActor } from "@notifications-worker/router";
import type { NotificationChannelsRepository, StoredNotificationChannel } from "@saas/db/notifications";

const ORG_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const ORG_PUBLIC = "org_a1b2c3d4e5f67890abcdef1234567890";
const CHAN_UUID = "01234567-89ab-cdef-0123-456789abcdef";
const CHAN_PUBLIC = "chan_0123456789abcdef0123456789abcdef";
const KEY = "0".repeat(64);
const ACTOR: InternalActor = { subjectId: "usr_00112233445566778899aabbccddeeff", subjectType: "user", internalCaller: "api-edge" };
const REQ = "req_test";

function createMockFetcher(handler?: (req: Request) => Promise<Response>): Fetcher {
  return {
    fetch: (input: string | Request | URL, init?: RequestInit) => {
      if (!handler) return Promise.resolve(new Response(null, { status: 500 }));
      const request = input instanceof Request ? input : new Request(String(input), init);
      return handler(request);
    },
    connect: undefined as never,
  } as unknown as Fetcher;
}

function entitlementFetcher(overrides?: Record<string, { allowed: boolean; limitValue?: number | null; reason?: string }>): Fetcher {
  return createMockFetcher(async (req) => {
    const body = (await req.json()) as { entitlementKey: string; orgId: string };
    const cfg = overrides?.[body.entitlementKey];
    if (cfg) {
      return Response.json({
        data: cfg.allowed
          ? { allowed: true, orgId: body.orgId, entitlementKey: body.entitlementKey, valueType: "quantity", limitValue: cfg.limitValue ?? null, source: "plan", subscriptionId: "s" }
          : { allowed: false, orgId: body.orgId, entitlementKey: body.entitlementKey, reason: cfg.reason ?? "disabled" },
      });
    }
    return Response.json({ data: { allowed: true, orgId: body.orgId, entitlementKey: body.entitlementKey, valueType: "boolean", limitValue: null, source: "plan", subscriptionId: "s" } });
  });
}

function createEnv(overrides?: Record<string, unknown>): Env {
  const base = {
    PLATFORM_DB: { connectionString: "postgresql://t:t@localhost/t" },
    MEMBERSHIP_WORKER: createMockFetcher(async () =>
      Response.json({ data: { memberships: [{ kind: "role_assignment", role: "owner", scope: { kind: "organization", orgId: ORG_UUID } }] } }),
    ),
    POLICY_WORKER: createMockFetcher(async () => Response.json({ data: { allow: true } })),
    BILLING_WORKER: entitlementFetcher(),
    SECRET_ENCRYPTION_KEY: KEY,
    ENVIRONMENT: "test",
  } as Record<string, unknown>;
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base as unknown as Env;
}

function channel(overrides?: Partial<StoredNotificationChannel>): StoredNotificationChannel {
  return {
    id: CHAN_UUID,
    orgId: ORG_UUID,
    kind: "slack_incoming_webhook",
    name: "Ops",
    status: "active",
    lastVerifiedAt: null,
    createdBy: ORG_UUID,
    createdAt: new Date("2026-07-05T10:00:00Z"),
    updatedAt: new Date("2026-07-05T10:00:00Z"),
    ...overrides,
  };
}

function fakeChannelsRepo(opts?: {
  list?: StoredNotificationChannel[];
  count?: number;
  configCiphertext?: string;
}): { repo: NotificationChannelsRepository; created: unknown[] } {
  const created: unknown[] = [];
  const repo = {
    async createChannel(input: unknown) {
      created.push(input);
      return { ok: true as const, value: channel() };
    },
    async listChannels() {
      return { ok: true as const, value: opts?.list ?? [channel()] };
    },
    async countChannels() {
      return { ok: true as const, value: opts?.count ?? 0 };
    },
    async getChannelConfigForSend() {
      return opts?.configCiphertext
        ? { ok: true as const, value: { id: CHAN_UUID, orgId: ORG_UUID, kind: "slack_incoming_webhook" as const, status: "active" as const, configCiphertext: opts.configCiphertext } }
        : { ok: true as const, value: null };
    },
    async updateChannel() {
      return { ok: true as const, value: channel({ lastVerifiedAt: new Date() }) };
    },
    async getChannel() {
      return { ok: true as const, value: channel() };
    },
    async deleteChannel() {
      return { ok: true as const, value: true };
    },
  } as unknown as NotificationChannelsRepository;
  return { repo, created };
}

const VALID_URL = "https://hooks.slack.com/services/T00/B00/secretbits";

function createReq(method = "GET", body?: unknown): Request {
  return new Request("https://notifications.internal/x", {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("notification channels handler", () => {
  it("lists channels without ever exposing the ciphertext", async () => {
    const { repo } = fakeChannelsRepo({ list: [channel()] });
    const res = await handleListChannels(createEnv(), REQ, ACTOR, ORG_PUBLIC, { channelsRepo: repo });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("ciphertext");
    expect(body).not.toContain("config_ciphertext");
    expect(body).toContain(CHAN_PUBLIC);
  });

  it("creates a Slack channel, encrypting the URL (never echoed)", async () => {
    const { repo, created } = fakeChannelsRepo();
    const emitted: string[] = [];
    const res = await handleCreateChannel(
      createReq("POST", { name: "Ops", webhookUrl: VALID_URL }),
      createEnv(),
      REQ,
      ACTOR,
      ORG_PUBLIC,
      { channelsRepo: repo, emit: (async (_e: unknown, i: { type: string }) => { emitted.push(i.type); }) as never },
    );
    expect(res.status).toBe(201);
    const body = await res.text();
    expect(body).not.toContain(VALID_URL);
    // The stored ciphertext is not the plaintext URL.
    expect((created[0] as { configCiphertext: string }).configCiphertext).not.toContain("hooks.slack.com");
    expect(emitted).toEqual(["notification_channel.created"]);
  });

  it("rejects a non-Slack URL", async () => {
    const { repo } = fakeChannelsRepo();
    const res = await handleCreateChannel(
      createReq("POST", { name: "Ops", webhookUrl: "https://evil.test/hook" }),
      createEnv(),
      REQ,
      ACTOR,
      ORG_PUBLIC,
      { channelsRepo: repo },
    );
    expect(res.status).toBe(422);
  });

  it("412s when the slack feature entitlement is disabled", async () => {
    const { repo } = fakeChannelsRepo();
    const env = createEnv({ BILLING_WORKER: entitlementFetcher({ "feature.notifications.slack": { allowed: false, reason: "disabled" } }) });
    const res = await handleCreateChannel(
      createReq("POST", { name: "Ops", webhookUrl: VALID_URL }),
      env,
      REQ,
      ACTOR,
      ORG_PUBLIC,
      { channelsRepo: repo },
    );
    expect(res.status).toBe(412);
  });

  it("412s when the channel limit is reached", async () => {
    const { repo } = fakeChannelsRepo({ count: 3 });
    const env = createEnv({ BILLING_WORKER: entitlementFetcher({ "limit.notification_channels": { allowed: true, limitValue: 3 } }) });
    const res = await handleCreateChannel(
      createReq("POST", { name: "Ops", webhookUrl: VALID_URL }),
      env,
      REQ,
      ACTOR,
      ORG_PUBLIC,
      { channelsRepo: repo },
    );
    expect(res.status).toBe(412);
  });

  it("404s on policy deny", async () => {
    const { repo } = fakeChannelsRepo();
    const env = createEnv({ POLICY_WORKER: createMockFetcher(async () => Response.json({ data: { allow: false } })) });
    const res = await handleListChannels(env, REQ, ACTOR, ORG_PUBLIC, { channelsRepo: repo });
    expect(res.status).toBe(404);
  });

  it("test-send delivers to Slack, stamps verified, and emits verified", async () => {
    // Encrypt a URL so the handler can decrypt it.
    const { createEncryptionAdapter } = await import("@notifications-worker/encryption");
    const adapter = (await createEncryptionAdapter(KEY))!;
    const envelope = await adapter.encrypt(VALID_URL);
    const { repo } = fakeChannelsRepo({ configCiphertext: JSON.stringify(envelope) });

    const slackCalls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      slackCalls.push(String(url));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const emitted: string[] = [];
    const res = await handleTestChannel(createEnv(), REQ, ACTOR, ORG_PUBLIC, CHAN_PUBLIC, {
      channelsRepo: repo,
      fetchImpl,
      emit: (async (_e: unknown, i: { type: string }) => { emitted.push(i.type); }) as never,
    });
    expect(res.status).toBe(200);
    expect(slackCalls[0]).toBe(VALID_URL);
    expect(emitted).toEqual(["notification_channel.verified"]);
  });
});

// ── slack_app channel creation (IH2) ────────────────────────

describe("handleCreateChannel (slack_app)", () => {
  function slackAppBody(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      name: "Alerts bot",
      kind: "slack_app",
      connectionId: "int_00000000000000000000000000000abc",
      channelExternalId: "C0123ABCDEF",
      channelName: "alerts",
      ...overrides,
    };
  }

  function credentialsBinding(outcome: Record<string, unknown>): Fetcher {
    return createMockFetcher(async () =>
      Response.json({ data: outcome, meta: { requestId: REQ } }),
    );
  }

  function requestOf(body: unknown): Request {
    return new Request("https://worker.test/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("validates the connection reference shape", async () => {
    const { repo } = fakeChannelsRepo();
    const res = await handleCreateChannel(
      requestOf(slackAppBody({ channelExternalId: "not-a-channel-id" })),
      createEnv({ INTEGRATIONS_WORKER: credentialsBinding({ ok: true, botToken: "t", teamId: "T" }) }),
      REQ,
      ACTOR,
      ORG_PUBLIC,
      { channelsRepo: repo },
    );
    expect(res.status).toBe(422);
  });

  it("accepts a #-prefixed channel label (the console auto-fills #<channel>)", async () => {
    // Regression: NAME_RE required a leading word char, so the picker's default
    // name `#alerts` 422'd on create.
    const { repo, created } = fakeChannelsRepo();
    const res = await handleCreateChannel(
      requestOf(slackAppBody({ name: "#alerts" })),
      createEnv({ INTEGRATIONS_WORKER: credentialsBinding({ ok: true, botToken: "xoxb-t", teamId: "T" }) }),
      REQ,
      ACTOR,
      ORG_PUBLIC,
      { channelsRepo: repo },
    );
    expect(res.status).toBe(201);
    expect(created).toHaveLength(1);
  });

  it("refuses a connection the org cannot use (412 with the read's reason)", async () => {
    const { repo, created } = fakeChannelsRepo();
    const res = await handleCreateChannel(
      requestOf(slackAppBody()),
      createEnv({ INTEGRATIONS_WORKER: credentialsBinding({ ok: false, reason: "not_found" }) }),
      REQ,
      ACTOR,
      ORG_PUBLIC,
      { channelsRepo: repo },
    );
    expect(res.status).toBe(412);
    expect(created).toHaveLength(0);
  });

  it("stores an encrypted REFERENCE — connection + channel ids, no credential", async () => {
    const { repo, created } = fakeChannelsRepo();
    const res = await handleCreateChannel(
      requestOf(slackAppBody()),
      createEnv({ INTEGRATIONS_WORKER: credentialsBinding({ ok: true, botToken: "xoxb-t", teamId: "T" }) }),
      REQ,
      ACTOR,
      ORG_PUBLIC,
      { channelsRepo: repo },
    );
    expect(res.status).toBe(201);
    expect(created).toHaveLength(1);
    const input = created[0] as { kind: string; configCiphertext: string };
    expect(input.kind).toBe("slack_app");
    // Ciphertext is an AES envelope — the reference (and certainly no token)
    // must not be readable from the stored value.
    expect(input.configCiphertext).not.toContain("C0123ABCDEF");
    expect(input.configCiphertext).not.toContain("xoxb-t");
    const { createEncryptionAdapter } = await import("@notifications-worker/encryption");
    const adapter = (await createEncryptionAdapter(KEY))!;
    const ref = JSON.parse(await adapter.decrypt(JSON.parse(input.configCiphertext)));
    expect(ref).toEqual({
      connectionId: "int_00000000000000000000000000000abc",
      channelExternalId: "C0123ABCDEF",
      channelName: "alerts",
    });
  });

  it("parks 412 when the integrations binding is absent", async () => {
    const { repo } = fakeChannelsRepo();
    const res = await handleCreateChannel(
      requestOf(slackAppBody()),
      createEnv(),
      REQ,
      ACTOR,
      ORG_PUBLIC,
      { channelsRepo: repo },
    );
    expect(res.status).toBe(412);
  });
});
