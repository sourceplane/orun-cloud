// Rotation / expiry reminder sweep (saas-secret-manager SEC7, orun-secrets SD-3).
//
// Asserts the sweep emits a value-free secret.rotation_due / secret.expiring
// event per due secret, stamps last_reminded_at only on the reminded ones
// (idempotency), passes a bounded batch limit through, and is best-effort (a
// single failing reminder never breaks the batch and is not marked reminded).

import { runRotationSweep } from "@config-worker/rotation-sweep";
import type { Env } from "@config-worker/env";
import type { ConfigResult, SecretRotationDue } from "@saas/db/config";
import type {
  AppendEventWithAuditInput,
  EventsResult,
  StoredEvent,
  StoredAuditEntry,
} from "@saas/db/events";

const ORG = "11111111-1111-1111-1111-111111111111";
const FIXED_NOW = new Date("2026-07-02T00:00:00Z");
const FAKE_ENV = {} as Env;

const PLACEHOLDER_EVENT = { id: "evt_x" } as unknown as StoredEvent;
const PLACEHOLDER_AUDIT = { id: "aud_x" } as unknown as StoredAuditEntry;

function due(overrides?: Partial<SecretRotationDue>): SecretRotationDue {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    orgId: ORG,
    projectId: null,
    environmentId: null,
    scopeKind: "organization",
    secretKey: "API_KEY",
    rotationPolicy: "90d",
    lastRotatedAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: null,
    createdAt: new Date("2025-12-01T00:00:00Z"),
    ageDays: 183,
    dueKind: "rotation",
    ...overrides,
  };
}

type FakeEventsRepo = {
  calls: AppendEventWithAuditInput[];
  appendEventWithAudit: (
    input: AppendEventWithAuditInput,
  ) => Promise<EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>>;
};

function fakeEventsRepo(failKeys: Set<string> = new Set()): FakeEventsRepo {
  const calls: AppendEventWithAuditInput[] = [];
  return {
    calls,
    appendEventWithAudit(input) {
      calls.push(input);
      const key = (input.event.payload as { key?: string }).key ?? "";
      return Promise.resolve(
        failKeys.has(key)
          ? { ok: false as const, error: { kind: "internal" as const, message: "down" } }
          : { ok: true as const, value: { event: PLACEHOLDER_EVENT, audit: PLACEHOLDER_AUDIT } },
      );
    },
  };
}

interface FakeRepoOpts {
  rows: SecretRotationDue[];
  listResult?: ConfigResult<SecretRotationDue[]>;
}

function fakeRepo(opts: FakeRepoOpts) {
  const listArgs: { now: Date; leadWindowSeconds: number; suppressSeconds: number; limit: number }[] = [];
  const markedIds: string[][] = [];
  return {
    listArgs,
    markedIds,
    repo: {
      listSecretsDueForRotation: (now: Date, leadWindowSeconds: number, suppressSeconds: number, limit: number) => {
        listArgs.push({ now, leadWindowSeconds, suppressSeconds, limit });
        return Promise.resolve(opts.listResult ?? ({ ok: true as const, value: opts.rows }));
      },
      markSecretsReminded: (ids: string[]) => {
        markedIds.push(ids);
        return Promise.resolve({ ok: true as const, value: undefined });
      },
    },
  };
}

describe("runRotationSweep", () => {
  it("is dormant (returns null) without a DB binding and no deps", async () => {
    expect(await runRotationSweep(FAKE_ENV)).toBeNull();
  });

  it("emits secret.rotation_due for an overdue-by-policy secret and stamps last_reminded_at", async () => {
    const { repo, markedIds } = fakeRepo({ rows: [due()] });
    const eventsRepo = fakeEventsRepo();
    const summary = await runRotationSweep(FAKE_ENV, { repo, eventsRepo, now: () => FIXED_NOW });
    expect(summary).toEqual({ scanned: 1, reminded: 1 });
    expect(eventsRepo.calls[0]!.event.type).toBe("secret.rotation_due");
    expect(markedIds).toEqual([[due().id]]);
  });

  it("emits secret.expiring for an expiring secret", async () => {
    const { repo } = fakeRepo({
      rows: [due({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", dueKind: "expiry", expiresAt: new Date("2026-07-05T00:00:00Z") })],
    });
    const eventsRepo = fakeEventsRepo();
    await runRotationSweep(FAKE_ENV, { repo, eventsRepo, now: () => FIXED_NOW });
    expect(eventsRepo.calls[0]!.event.type).toBe("secret.expiring");
  });

  it("event payload is value-free and carries the rotation metadata", async () => {
    const { repo } = fakeRepo({ rows: [due()] });
    const eventsRepo = fakeEventsRepo();
    await runRotationSweep(FAKE_ENV, { repo, eventsRepo, now: () => FIXED_NOW });
    const payload = eventsRepo.calls[0]!.event.payload as Record<string, unknown>;
    expect(payload.key).toBe("API_KEY");
    expect(payload.scope).toBe("organization");
    expect(payload.rotationPolicy).toBe("90d");
    expect(payload.ageDays).toBe(183);
    expect(payload.value).toBeUndefined();
    expect(payload.plaintext).toBeUndefined();
    expect(eventsRepo.calls[0]!.audit.description).not.toContain("value");
  });

  it("passes a bounded batch limit + windows through to the repo", async () => {
    const { repo, listArgs } = fakeRepo({ rows: [] });
    await runRotationSweep(FAKE_ENV, {
      repo,
      eventsRepo: fakeEventsRepo(),
      now: () => FIXED_NOW,
      limit: 25,
      leadWindowSeconds: 3600,
      suppressSeconds: 60,
    });
    expect(listArgs[0]!.limit).toBe(25);
    expect(listArgs[0]!.leadWindowSeconds).toBe(3600);
    expect(listArgs[0]!.suppressSeconds).toBe(60);
  });

  it("best-effort: a failed reminder does not break the batch and is not marked reminded", async () => {
    const a = due({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", secretKey: "GOOD" });
    const b = due({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", secretKey: "BAD" });
    const { repo, markedIds } = fakeRepo({ rows: [a, b] });
    const eventsRepo = fakeEventsRepo(new Set(["BAD"]));
    const summary = await runRotationSweep(FAKE_ENV, { repo, eventsRepo, now: () => FIXED_NOW });
    // Both attempted; only the good one counts + is stamped.
    expect(eventsRepo.calls).toHaveLength(2);
    expect(summary).toEqual({ scanned: 2, reminded: 1 });
    expect(markedIds).toEqual([[a.id]]);
  });

  it("returns null when the due-query fails (never throws out of the cron)", async () => {
    const { repo } = fakeRepo({ rows: [], listResult: { ok: false, error: { kind: "internal", message: "db down" } } });
    const summary = await runRotationSweep(FAKE_ENV, { repo, eventsRepo: fakeEventsRepo(), now: () => FIXED_NOW });
    expect(summary).toBeNull();
  });
});
