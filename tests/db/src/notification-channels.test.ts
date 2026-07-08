import { createNotificationChannelsRepository } from "@saas/db/notifications";
import { asUuid } from "@saas/db/ids";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

type QueryRecord = { text: string; params: unknown[] };

function createFakeExecutor(options?: {
  rows?: Record<string, unknown>[];
  error?: unknown;
}): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      if (options?.error) throw options.error;
      const rows = (options?.rows ?? []) as unknown as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { executor, queries };
}

const NOW = "2026-07-05T10:00:00.000Z";
const ORG = asUuid("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
const CHAN_UUID = "01234567-89ab-cdef-0123-456789abcdef";

const CHANNEL_ROW = {
  id: CHAN_UUID,
  org_id: ORG,
  kind: "slack_incoming_webhook",
  name: "Ops Slack",
  status: "active",
  last_verified_at: null,
  created_by: "11111111-2222-3333-4444-555555555555",
  created_at: NOW,
  updated_at: NOW,
};

describe("notification channels repository", () => {
  it("createChannel returns the safe projection and never selects the ciphertext", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [CHANNEL_ROW] });
    const repo = createNotificationChannelsRepository(executor);
    const result = await repo.createChannel({
      id: CHAN_UUID,
      orgId: ORG,
      kind: "slack_incoming_webhook",
      name: "Ops Slack",
      configCiphertext: '{"alg":"AES-256-GCM","v":1,"iv":"x","ct":"y"}',
      createdBy: asUuid("11111111-2222-3333-4444-555555555555"),
    });
    expect(result.ok).toBe(true);
    // The RETURNING clause must not include config_ciphertext.
    expect(queries[0]!.text).not.toContain("config_ciphertext, status");
    expect(queries[0]!.text).toContain("RETURNING id, org_id, kind, name, status");
    expect(queries[0]!.text).not.toMatch(/RETURNING[^;]*config_ciphertext/);
  });

  it("getChannel omits the ciphertext; getChannelConfigForSend is the only reader", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [CHANNEL_ROW] });
    const repo = createNotificationChannelsRepository(executor);
    await repo.getChannel(ORG, CHAN_UUID);
    expect(queries[0]!.text).not.toContain("config_ciphertext");

    const { executor: ex2, queries: q2 } = createFakeExecutor({
      rows: [{ id: CHAN_UUID, org_id: ORG, kind: "slack_incoming_webhook", status: "active", config_ciphertext: "CIPHER" }],
    });
    const repo2 = createNotificationChannelsRepository(ex2);
    const send = await repo2.getChannelConfigForSend(ORG, CHAN_UUID);
    expect(send.ok).toBe(true);
    if (send.ok) expect(send.value?.configCiphertext).toBe("CIPHER");
    expect(q2[0]!.text).toContain("config_ciphertext");
  });

  it("createChannel maps unique-name violations to conflict", async () => {
    const { executor } = createFakeExecutor({ error: { code: "23505" } });
    const repo = createNotificationChannelsRepository(executor);
    const result = await repo.createChannel({
      id: CHAN_UUID,
      orgId: ORG,
      kind: "slack_incoming_webhook",
      name: "dup",
      configCiphertext: "x",
      createdBy: asUuid("11111111-2222-3333-4444-555555555555"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ kind: "conflict", entity: "notification_channel" });
  });

  it("countChannels returns the org total", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [{ total: 2 }] });
    const repo = createNotificationChannelsRepository(executor);
    const result = await repo.countChannels(ORG);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(2);
    expect(queries[0]!.text).toContain("count(*)::int");
  });

  it("updateChannel builds a partial SET and can stamp last_verified_at only", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [{ ...CHANNEL_ROW, last_verified_at: NOW }] });
    const repo = createNotificationChannelsRepository(executor);
    const result = await repo.updateChannel(ORG, CHAN_UUID, { lastVerifiedAt: new Date(NOW) });
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("SET last_verified_at = $3");
  });

  it("deleteChannel reports whether a row was removed", async () => {
    const { executor } = createFakeExecutor({ rows: [{ id: CHAN_UUID }] });
    const repo = createNotificationChannelsRepository(executor);
    const result = await repo.deleteChannel(ORG, CHAN_UUID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);
  });
});
