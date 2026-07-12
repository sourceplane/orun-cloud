// IH3: channel freshness on Slack archive — the internal slack-disable route
// decrypt-scans the org's slack_app channels and flips every active row
// referencing the archived channel to disabled. Fail-soft throughout: bad
// input degrades to {disabled: 0}; only a missing internal actor is a 403
// (the router's gate).

import { handleSlackChannelDisable } from "@notifications-worker/handlers/channel-freshness";
import { route } from "@notifications-worker/router";
import { createEncryptionAdapter } from "@notifications-worker/encryption";
import type { Env } from "@notifications-worker/env";
import type { InternalActor } from "@notifications-worker/router";
import type {
  NotificationChannelsRepository,
  NotificationChannelConfigForSend,
  StoredNotificationChannel,
  UpdateNotificationChannelPatch,
} from "@saas/db/notifications";

const ORG_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const ORG_PUBLIC = "org_a1b2c3d4e5f67890abcdef1234567890";
const CHAN_UUID = "01234567-89ab-cdef-0123-456789abcdef";
const KEY = "0".repeat(64);
const CONNECTION_ID = "int_00000000000000000000000000000abc";
const CHANNEL_EXTERNAL_ID = "C0123ABCDEF";
const ACTOR: InternalActor = { subjectId: "events-worker", subjectType: "system", internalCaller: "events-worker" };
const REQ = "req_test";

function createEnv(overrides?: Record<string, unknown>): Env {
  const base = {
    SECRET_ENCRYPTION_KEY: KEY,
    ENVIRONMENT: "test",
  } as Record<string, unknown>;
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base as unknown as Env;
}

async function encryptedRef(overrides?: Record<string, unknown>): Promise<string> {
  const adapter = (await createEncryptionAdapter(KEY))!;
  return JSON.stringify(
    await adapter.encrypt(
      JSON.stringify({
        connectionId: CONNECTION_ID,
        channelExternalId: CHANNEL_EXTERNAL_ID,
        channelName: "alerts",
        ...overrides,
      }),
    ),
  );
}

function channel(overrides?: Partial<StoredNotificationChannel>): StoredNotificationChannel {
  return {
    id: CHAN_UUID,
    orgId: ORG_UUID,
    kind: "slack_app",
    name: "Alerts bot",
    status: "disabled",
    lastVerifiedAt: null,
    createdBy: ORG_UUID,
    createdAt: new Date("2026-07-12T10:00:00Z"),
    updatedAt: new Date("2026-07-12T10:00:00Z"),
    ...overrides,
  };
}

function fakeRepo(configs: NotificationChannelConfigForSend[]): {
  repo: NotificationChannelsRepository;
  listCalls: Array<{ orgId: string; kind: string }>;
  updates: Array<{ id: string; patch: UpdateNotificationChannelPatch }>;
} {
  const listCalls: Array<{ orgId: string; kind: string }> = [];
  const updates: Array<{ id: string; patch: UpdateNotificationChannelPatch }> = [];
  const repo = {
    async listChannelConfigsByKind(orgId: string, kind: string) {
      listCalls.push({ orgId, kind });
      return { ok: true as const, value: configs };
    },
    async updateChannel(_orgId: string, id: string, patch: UpdateNotificationChannelPatch) {
      updates.push({ id, patch });
      return { ok: true as const, value: channel({ id, status: "disabled" }) };
    },
  } as unknown as NotificationChannelsRepository;
  return { repo, listCalls, updates };
}

function config(overrides?: Partial<NotificationChannelConfigForSend>): NotificationChannelConfigForSend {
  return {
    id: CHAN_UUID,
    orgId: ORG_UUID,
    kind: "slack_app",
    status: "active",
    configCiphertext: "SET_ME",
    ...overrides,
  };
}

function disableReq(body: unknown): Request {
  return new Request("https://notifications.internal/internal/notification-channels/slack-disable", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const GOOD_BODY = {
  orgId: ORG_PUBLIC,
  connectionId: CONNECTION_ID,
  channelExternalId: CHANNEL_EXTERNAL_ID,
};

async function dataOf(res: Response): Promise<{ disabled: number }> {
  const body = (await res.json()) as { data: { disabled: number } };
  return body.data;
}

describe("handleSlackChannelDisable (IH3)", () => {
  it("disables the active channel whose decrypted reference matches and emits notification_channel.updated", async () => {
    const { repo, listCalls, updates } = fakeRepo([config({ configCiphertext: await encryptedRef() })]);
    const emitted: Array<Record<string, unknown>> = [];
    const res = await handleSlackChannelDisable(disableReq(GOOD_BODY), createEnv(), REQ, ACTOR, {
      channelsRepo: repo,
      emit: (async (_e: unknown, i: Record<string, unknown>) => {
        emitted.push(i);
      }) as never,
    });
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({ disabled: 1 });
    expect(listCalls).toEqual([{ orgId: ORG_UUID, kind: "slack_app" }]);
    expect(updates).toEqual([{ id: CHAN_UUID, patch: { status: "disabled" } }]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe("notification_channel.updated");
    expect(emitted[0]!.orgId).toBe(ORG_PUBLIC);
  });

  it("counts every matching channel, skipping non-matching and already-disabled rows", async () => {
    const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const THIRD = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const { repo, updates } = fakeRepo([
      config({ configCiphertext: await encryptedRef() }),
      // Same channel, different connection: not a match.
      config({ id: OTHER, configCiphertext: await encryptedRef({ connectionId: "int_" + "f".repeat(32) }) }),
      // Matching reference but already disabled: idempotent skip.
      config({ id: THIRD, status: "disabled", configCiphertext: await encryptedRef() }),
    ]);
    const res = await handleSlackChannelDisable(disableReq(GOOD_BODY), createEnv(), REQ, ACTOR, {
      channelsRepo: repo,
      emit: (async () => {}) as never,
    });
    expect(await dataOf(res)).toEqual({ disabled: 1 });
    expect(updates.map((u) => u.id)).toEqual([CHAN_UUID]);
  });

  it("reports 0 when nothing matches the archived channel", async () => {
    const { repo, updates } = fakeRepo([
      config({ configCiphertext: await encryptedRef({ channelExternalId: "C0OTHER" }) }),
    ]);
    const res = await handleSlackChannelDisable(disableReq(GOOD_BODY), createEnv(), REQ, ACTOR, {
      channelsRepo: repo,
      emit: (async () => {}) as never,
    });
    expect(await dataOf(res)).toEqual({ disabled: 0 });
    expect(updates).toEqual([]);
  });

  it("fails soft on a malformed body (200 {disabled: 0}, no scan)", async () => {
    const { repo, listCalls } = fakeRepo([config({ configCiphertext: await encryptedRef() })]);
    for (const body of [
      { ...GOOD_BODY, orgId: "not-an-org" },
      { ...GOOD_BODY, connectionId: "conn-123" },
      { ...GOOD_BODY, channelExternalId: "" },
      {},
    ]) {
      const res = await handleSlackChannelDisable(disableReq(body), createEnv(), REQ, ACTOR, {
        channelsRepo: repo,
        emit: (async () => {}) as never,
      });
      expect(res.status).toBe(200);
      expect(await dataOf(res)).toEqual({ disabled: 0 });
    }
    expect(listCalls).toEqual([]);
  });

  it("fails soft when the encryption key is absent", async () => {
    const { repo, listCalls } = fakeRepo([config({ configCiphertext: await encryptedRef() })]);
    const res = await handleSlackChannelDisable(
      disableReq(GOOD_BODY),
      createEnv({ SECRET_ENCRYPTION_KEY: undefined }),
      REQ,
      ACTOR,
      { channelsRepo: repo, emit: (async () => {}) as never },
    );
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({ disabled: 0 });
    expect(listCalls).toEqual([]);
  });

  it("skips unreadable ciphertexts without failing the scan", async () => {
    const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const { repo, updates } = fakeRepo([
      config({ id: OTHER, configCiphertext: "not-json" }),
      config({ configCiphertext: await encryptedRef() }),
    ]);
    const res = await handleSlackChannelDisable(disableReq(GOOD_BODY), createEnv(), REQ, ACTOR, {
      channelsRepo: repo,
      emit: (async () => {}) as never,
    });
    expect(await dataOf(res)).toEqual({ disabled: 1 });
    expect(updates.map((u) => u.id)).toEqual([CHAN_UUID]);
  });
});

describe("router — internal slack-disable route", () => {
  it("403s without a valid internal actor", async () => {
    const res = await route(disableReq(GOOD_BODY), createEnv());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("403s an internal actor that is not on the allowlist", async () => {
    const req = new Request("https://notifications.internal/internal/notification-channels/slack-disable", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-actor": "console-ui",
        "x-actor-subject-id": "x",
        "x-actor-subject-type": "user",
      },
      body: JSON.stringify(GOOD_BODY),
    });
    expect((await route(req, createEnv())).status).toBe(403);
  });

  it("admits events-worker and fails soft without a DB binding", async () => {
    const req = new Request("https://notifications.internal/internal/notification-channels/slack-disable", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-actor": "events-worker",
        "x-actor-subject-id": "events-worker",
        "x-actor-subject-type": "system",
      },
      body: JSON.stringify(GOOD_BODY),
    });
    const res = await route(req, createEnv());
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toEqual({ disabled: 0 });
  });

  it("405s non-POST methods", async () => {
    const req = new Request("https://notifications.internal/internal/notification-channels/slack-disable", {
      method: "GET",
      headers: {
        "x-internal-actor": "events-worker",
        "x-actor-subject-id": "events-worker",
        "x-actor-subject-type": "system",
      },
    });
    expect((await route(req, createEnv())).status).toBe(405);
  });
});
