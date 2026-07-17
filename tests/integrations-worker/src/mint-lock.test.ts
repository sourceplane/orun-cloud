// IH6 custody: per-connection mint serialization. Under test:
//   1. MintLockCore lease semantics (grant / deny / token-checked release /
//      expiry backstop).
//   2. THE RACE (the reason this exists): two concurrent mints on one
//      rotating-parent connection. Unserialized, both read the same parent;
//      the second presents an already-consumed refresh token and the provider
//      refuses (reuse detection — observed live as a 401'd sibling token).
//      Serialized, the second mint reads the ROTATED parent and succeeds.
//   3. A lock-wait timeout maps to the typed `mint_lock_timeout` failure on
//      both mint surfaces.
//   4. The runner degrades OPEN without a namespace (harness/dev posture).

import { MintLockCore, connectionMintLockRunner, type MintLockRunner } from "@integrations-worker/mint-lock";
import { handleMintCredential, handleInternalMintCredential } from "@integrations-worker/handlers/credential-broker";
import type { Env } from "@integrations-worker/env";
import type { IntegrationProvider } from "@integrations-worker/providers/types";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const MINT_UUID = "55555555-5555-4555-8555-555555555555";
const ORG_ID = asUuid(ORG_UUID);
const CONNECTION_ID = asUuid(CONNECTION_UUID);
const CONNECTION_PUBLIC = `int_${CONNECTION_UUID.replace(/-/g, "")}`;
const NOW = new Date("2026-07-17T09:00:00Z");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 1. The pure lease-lock core ─────────────────────────────

describe("MintLockCore", () => {
  it("grants when free, denies while held, frees on token-checked release", () => {
    const core = new MintLockCore(() => "tok-1");
    const grant = core.acquire(1_000, 30_000);
    expect(grant).toEqual({ token: "tok-1", expiresAt: 31_000 });
    expect(core.acquire(2_000, 30_000)).toBeNull();
    // A stale/wrong token can never free someone else's turn.
    expect(core.release("tok-other")).toBe(false);
    expect(core.acquire(3_000, 30_000)).toBeNull();
    expect(core.release("tok-1")).toBe(true);
    expect(core.acquire(4_000, 30_000)).not.toBeNull();
  });

  it("expires a dead holder (the crashed-holder backstop) and re-grants", () => {
    const tokens = ["a", "b"][Symbol.iterator]();
    const core = new MintLockCore(() => tokens.next().value!);
    core.acquire(0, 10_000);
    expect(core.acquire(9_999, 10_000)).toBeNull(); // still leased
    const regrant = core.acquire(10_000, 10_000); // lease lapsed exactly now
    expect(regrant?.token).toBe("b");
    // The expired holder's late release is a no-op against the new grant.
    expect(core.release("a")).toBe(false);
    expect(core.current()?.token).toBe("b");
  });
});

// ── Shared mint harness (mirrors credential-broker.test.ts) ─

type SqlResponder = (text: string, params: unknown[]) => Record<string, unknown>[] | null;

function fakeExecutor(respond: SqlResponder): SqlExecutor {
  return {
    async execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      let rows = respond(text, params ?? []);
      if ((rows === null || rows.length === 0) && text.includes("WITH inserted_event")) {
        rows = [{ _event: { id: "evt", payload: {} }, _audit: { id: "aud", payload: {} } }];
      }
      return { rows: (rows ?? []) as unknown as T[], rowCount: (rows ?? []).length };
    },
  };
}

function jsonFetcher(body: unknown): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json(body)),
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function billingFetcher(): Fetcher {
  return {
    fetch: async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { entitlementKey: string; orgId: string };
      const quantity = body.entitlementKey !== "feature.integrations.credential_broker";
      return Response.json({
        data: {
          allowed: true,
          orgId: body.orgId,
          entitlementKey: body.entitlementKey,
          valueType: quantity ? "quantity" : "boolean",
          limitValue: null,
          source: "plan",
          subscriptionId: "s",
        },
      });
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function createEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: jsonFetcher({
      data: {
        memberships: [{ kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_UUID } }],
      },
    }),
    POLICY_WORKER: jsonFetcher({ data: { allow: true, reason: "org_admin" } }),
    BILLING_WORKER: billingFetcher(),
    SECRET_ENCRYPTION_KEY: "ab".repeat(32),
  } as unknown as Env;
}

const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

function connectionRow(): Record<string, unknown> {
  return {
    id: CONNECTION_UUID,
    org_id: ORG_UUID,
    provider: "cloudflare",
    status: "active",
    scope: "account",
    share_mode: "auto",
    display_name: "CF Account",
    created_by: "usr_abc",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function mintRow(): Record<string, unknown> {
  return {
    id: MINT_UUID,
    org_id: ORG_UUID,
    connection_id: CONNECTION_UUID,
    provider: "cloudflare",
    template: "workers-deploy",
    params: null,
    purpose: "api",
    requested_by: ACTOR.subjectId,
    run_id: null,
    job_id: null,
    ttl_seconds: 900,
    provider_ref: "ref",
    minted_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 900_000).toISOString(),
    revoked_at: null,
    revoke_status: "pending",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function mintRequest(): Request {
  return new Request("https://worker.test/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ template: "workers-deploy" }),
  });
}

/**
 * A ROTATING-parent provider with reuse detection — the Supabase refresh
 * discipline distilled: each mint consumes the presented parent; presenting an
 * already-consumed one fails `parent_grant_insufficient`. The 25ms hold before
 * the check gives unserialized concurrent mints time to BOTH read the same
 * custody row — the live race, made deterministic.
 */
function rotatingProvider(): { provider: IntegrationProvider; minted: string[] } {
  let providerCurrent = "refresh-0";
  let n = 0;
  const minted: string[] = [];
  const provider: IntegrationProvider = {
    id: "cloudflare",
    displayName: "Cloudflare",
    connectKind: "token",
    capabilities: ["connect", "credential-broker"],
    broker: {
      scopeTemplates: () => [
        {
          id: "workers-deploy",
          provider: "cloudflare",
          version: 1,
          displayName: "Workers deploy",
          description: "Deploy Workers scripts",
          params: [],
          maxTtlSeconds: 900,
        },
      ],
      async mintCredential(input) {
        await sleep(25);
        if (input.parent?.credential !== providerCurrent) {
          return { ok: false, reason: "parent_grant_insufficient" };
        }
        n += 1;
        providerCurrent = `refresh-${n}`;
        minted.push(`tok-${n}`);
        return {
          ok: true,
          value: {
            credential: { token: `tok-${n}` },
            providerRef: `ref-${n}`,
            expiresAt: new Date(input.nowMs + input.ttlSeconds * 1000),
            rotatedParentCredential: providerCurrent,
          },
        };
      },
      async revokeCredential() {
        return true;
      },
    },
  };
  return { provider, minted };
}

/** Stateful custody: the executor serves the CURRENT ciphertext and captures
 *  the re-envelope upsert, exactly like the provider_credentials row. */
async function statefulCustodyExecutor(initialPlain: string): Promise<SqlExecutor> {
  const { createEncryptionAdapter } = await import("@integrations-worker/encryption");
  const adapter = (await createEncryptionAdapter("ab".repeat(32)))!;
  let ciphertext = JSON.stringify(await adapter.encrypt(initialPlain));
  return fakeExecutor((text, params) => {
    if (text.includes("FROM integrations.connections")) return [connectionRow()];
    if (text.includes("FROM integrations.provider_credentials")) {
      return [
        {
          id: "cred",
          connection_id: CONNECTION_UUID,
          kind: "cloudflare_refresh_token",
          ciphertext,
          external_ref: "acc-1",
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        },
      ];
    }
    if (text.includes("INSERT INTO integrations.provider_credentials")) {
      ciphertext = String(params[4]); // the rotated envelope lands
      return [{ id: "cred" }];
    }
    if (text.includes("INSERT INTO integrations.minted_credentials")) return [mintRow()];
    return [];
  });
}

/** A real in-memory FIFO mutex — the DO's semantics, locally. */
function serializingRunner(): MintLockRunner {
  const tails = new Map<string, Promise<void>>();
  return async (key, fn) => {
    const prev = tails.get(key) ?? Promise.resolve();
    let done!: () => void;
    tails.set(
      key,
      new Promise<void>((r) => {
        done = r;
      }),
    );
    await prev;
    try {
      return { ok: true, value: await fn() };
    } finally {
      done();
    }
  };
}

const unlockedRunner: MintLockRunner = async (_key, fn) => ({ ok: true, value: await fn() });

// ── 2. The race regression ──────────────────────────────────

describe("concurrent mints on one rotating-parent connection", () => {
  it("UNSERIALIZED: the second mint presents a consumed parent and fails (the live race)", async () => {
    const executor = await statefulCustodyExecutor("refresh-0");
    const { provider } = rotatingProvider();
    const deps = { executor, provider, mintLock: unlockedRunner };
    const env = createEnv();
    const [a, b] = await Promise.all([
      handleMintCredential(mintRequest(), env, "req_a", ACTOR, ORG_ID, CONNECTION_ID, deps),
      handleMintCredential(mintRequest(), env, "req_b", ACTOR, ORG_ID, CONNECTION_ID, deps),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 412]);
  });

  it("SERIALIZED: both mints succeed — the second reads the rotated parent", async () => {
    const executor = await statefulCustodyExecutor("refresh-0");
    const { provider, minted } = rotatingProvider();
    const deps = { executor, provider, mintLock: serializingRunner() };
    const env = createEnv();
    const [a, b] = await Promise.all([
      handleMintCredential(mintRequest(), env, "req_a", ACTOR, ORG_ID, CONNECTION_ID, deps),
      handleMintCredential(mintRequest(), env, "req_b", ACTOR, ORG_ID, CONNECTION_ID, deps),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    // Two distinct mints, two rotations — nothing shared, nothing reused.
    expect(minted).toEqual(["tok-1", "tok-2"]);
  });
});

// ── 3. Timeout maps to the typed failure on both surfaces ───

describe("mint_lock_timeout mapping", () => {
  const timeoutRunner: MintLockRunner = async () => ({ ok: false, reason: "mint_lock_timeout" });

  it("public mint surface → 503 with reason mint_lock_timeout", async () => {
    const executor = await statefulCustodyExecutor("refresh-0");
    const { provider } = rotatingProvider();
    const res = await handleMintCredential(mintRequest(), createEnv(), "req_t", ACTOR, ORG_ID, CONNECTION_ID, {
      executor,
      provider,
      mintLock: timeoutRunner,
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { details: { reason: string } } };
    expect(json.error.details.reason).toBe("mint_lock_timeout");
  });

  it("internal secret_resolve surface → 503 with reason mint_lock_timeout", async () => {
    const executor = await statefulCustodyExecutor("refresh-0");
    const { provider } = rotatingProvider();
    const req = new Request("https://worker.test/internal/credentials/mint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        purpose: "secret_resolve",
        orgId: ORG_UUID,
        connectionId: CONNECTION_PUBLIC,
        template: "workers-deploy",
        requestedBy: ACTOR.subjectId,
      }),
    });
    const res = await handleInternalMintCredential(req, createEnv(), "req_i", {
      executor,
      provider,
      mintLock: timeoutRunner,
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { details: { reason: string } } };
    expect(json.error.details.reason).toBe("mint_lock_timeout");
  });
});

// ── 4. Runner fallback posture ──────────────────────────────

describe("connectionMintLockRunner", () => {
  it("degrades OPEN without a namespace — runs the section unlocked", async () => {
    const run = connectionMintLockRunner(undefined);
    const out = await run(CONNECTION_UUID, async () => "ran");
    expect(out).toEqual({ ok: true, value: "ran" });
  });
});
