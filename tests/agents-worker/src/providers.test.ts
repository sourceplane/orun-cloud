// Provider-connection route tests (saas-agents AG12, design §10): BYO
// Daytona / Anthropic keys. Custody + verification are stubbed at the deps
// seam; the assertions pin the security-relevant ordering — custody first
// (no row on store failure), last4-only hint, redacted failure reasons.

import { route } from "@agents-worker/router";
import type { AgentsDeps, AuditEmitter, IntegrationConnectionsMirror } from "@agents-worker/deps";
import type { ProviderKeyClient } from "@agents-worker/config-client";
import type { ProviderVerifier, VerifyResult } from "@agents-worker/verifiers";
import { MemoryAgentsRepository } from "@saas/db/agents";
import type { IntegrationConnection } from "@saas/db/integrations";
import type { Env } from "@agents-worker/env";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2"; // public org id carried in the URL
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2"; // what the router decodes to (repo scope)
const env: Env = { ENVIRONMENT: "test" };

function actorHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-actor-subject-id": "usr_rahul",
    "x-actor-subject-type": "user",
  };
}

interface StoreCall {
  orgId: string;
  key: string;
  value: string;
}

function makeKeyClient(overrides?: { storeOk?: boolean; resolveValue?: string | null }): {
  client: ProviderKeyClient;
  storeCalls: StoreCall[];
  resolveCalls: string[];
  revokeCalls: string[];
} {
  const storeCalls: StoreCall[] = [];
  const resolveCalls: string[] = [];
  const revokeCalls: string[] = [];
  return {
    storeCalls,
    resolveCalls,
    revokeCalls,
    client: {
      async store(orgId, key, value) {
        storeCalls.push({ orgId, key, value });
        return overrides?.storeOk ?? true;
      },
      async resolve(_orgId, key) {
        resolveCalls.push(key);
        return overrides?.resolveValue !== undefined ? overrides.resolveValue : "dtn_live_key";
      },
      async revoke(_orgId, key) {
        revokeCalls.push(key);
        return true;
      },
    },
  };
}

function makeVerifier(result: VerifyResult = { ok: true }): { verifier: ProviderVerifier; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    verifier: {
      async verify(provider) {
        calls.push(provider);
        return result;
      },
    },
  };
}

/** In-memory IR5 identity mirror: the integrations.connections slice the
 *  dual-write path drives (create → pending, activate, status flips). */
function makeIntegrationsMirror(): {
  mirror: IntegrationConnectionsMirror;
  rows: Map<string, IntegrationConnection>;
  statusCalls: Array<{ id: string; status: string }>;
} {
  const rows = new Map<string, IntegrationConnection>();
  const statusCalls: Array<{ id: string; status: string }> = [];
  const mirror: IntegrationConnectionsMirror = {
    async createConnection(input) {
      const now = new Date();
      const row: IntegrationConnection = {
        id: input.id,
        orgId: input.orgId,
        provider: input.provider,
        status: "pending",
        scope: input.scope ?? "account",
        shareMode: input.shareMode ?? "auto",
        displayName: input.displayName ?? null,
        externalAccountLogin: null,
        externalAccountId: null,
        externalAccountType: null,
        // IR/IX: capability preferences (added by migration 930); a fresh row
        // carries none until the connection's space sets them.
        capabilityPrefs: null,
        createdBy: input.createdBy ?? null,
        stateExpiresAt: null,
        connectedAt: null,
        suspendedAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(input.id, row);
      return { ok: true, value: row };
    },
    async activateConnection(_orgId, id) {
      const row = rows.get(String(id));
      // Guarded like the real repo: only a pending row activates.
      if (!row || row.status !== "pending") return { ok: false, error: { kind: "not_found" } };
      row.status = "active";
      row.connectedAt = new Date();
      return { ok: true, value: row };
    },
    async updateConnectionStatus(_orgId, id, status) {
      statusCalls.push({ id: String(id), status });
      const row = rows.get(String(id));
      if (!row) return { ok: false, error: { kind: "not_found" } };
      row.status = status;
      if (status === "revoked") row.revokedAt = new Date();
      if (status === "suspended") row.suspendedAt = new Date();
      return { ok: true, value: row };
    },
  };
  return { mirror, rows, statusCalls };
}

function makeAuditEmitter(): { emitter: AuditEmitter; events: Array<{ type: string; subjectId: string }> } {
  const events: Array<{ type: string; subjectId: string }> = [];
  return {
    events,
    emitter: {
      async appendEventWithAudit(input) {
        events.push({ type: input.event.type, subjectId: input.event.subjectId });
        return { ok: false, error: { kind: "internal", message: "fake" } };
      },
    },
  };
}

function makeDeps(overrides?: {
  allow?: boolean;
  repo?: MemoryAgentsRepository;
  providerKeys?: ProviderKeyClient | undefined;
  verifier?: ProviderVerifier | undefined;
  integrations?: IntegrationConnectionsMirror | undefined;
  events?: AuditEmitter | undefined;
}): AgentsDeps {
  const repo = overrides?.repo ?? new MemoryAgentsRepository();
  const deps: AgentsDeps = {
    repo,
    async authorize() {
      return overrides?.allow ?? true;
    },
    async dispose() {
      /* no-op */
    },
  };
  const keys = overrides && "providerKeys" in overrides ? overrides.providerKeys : makeKeyClient().client;
  const verifier = overrides && "verifier" in overrides ? overrides.verifier : makeVerifier().verifier;
  if (keys) deps.providerKeys = keys;
  if (verifier) deps.verifier = verifier;
  if (overrides?.integrations) deps.integrations = overrides.integrations;
  if (overrides?.events) deps.events = overrides.events;
  return deps;
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://agents-worker${path}`, {
    method,
    headers: actorHeaders(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function json(res: Response): Promise<{ data?: unknown; error?: { code: string; message?: string } }> {
  return (await res.json()) as { data?: unknown; error?: { code: string; message?: string } };
}

const PROVIDERS_PATH = `/v1/organizations/${ORG}/agents/providers`;

describe("agents-worker provider connections (AG12)", () => {
  it("creates a Daytona connection: custody → row → verified", async () => {
    const keys = makeKeyClient();
    const verifier = makeVerifier({ ok: true });
    const deps = makeDeps({ providerKeys: keys.client, verifier: verifier.verifier });

    const res = await route(
      req("POST", PROVIDERS_PATH, { provider: "daytona", apiKey: "dtn_abcd1234wxyz" }),
      env,
      deps,
    );
    expect(res.status).toBe(201);
    const c = (await json(res)).data as Record<string, unknown>;
    expect(c.id).toMatch(/^apc_/);
    expect(c.provider).toBe("daytona");
    expect(c.name).toBe("default");
    expect(c.status).toBe("verified");
    expect(c.keyHint).toBe("…wxyz");
    // The key itself never appears on the wire shape.
    expect(JSON.stringify(c)).not.toContain("dtn_abcd1234wxyz");

    // Custody happened first, under the reserved namespace.
    expect(keys.storeCalls).toEqual([
      { orgId: ORG_UUID, key: "agents/providers/daytona/default/API_KEY", value: "dtn_abcd1234wxyz" },
    ]);
    expect(verifier.calls).toEqual(["daytona"]);
  });

  it("creates an invalid connection when the verification ping fails (redacted reason)", async () => {
    const deps = makeDeps({ verifier: makeVerifier({ ok: false, reason: "401 from provider" }).verifier });
    const res = await route(
      req("POST", PROVIDERS_PATH, { provider: "anthropic", apiKey: "sk-ant-bad" }),
      env,
      deps,
    );
    expect(res.status).toBe(201);
    const c = (await json(res)).data as Record<string, unknown>;
    expect(c.status).toBe("invalid");
    expect(c.statusReason).toBe("401 from provider");
  });

  it("creates no row when key custody fails", async () => {
    const deps = makeDeps({ providerKeys: makeKeyClient({ storeOk: false }).client });
    const res = await route(
      req("POST", PROVIDERS_PATH, { provider: "daytona", apiKey: "dtn_x" }),
      env,
      deps,
    );
    expect(res.status).toBe(502);

    const list = await route(req("GET", PROVIDERS_PATH), env, deps);
    expect(((await json(list)).data as unknown[]).length).toBe(0);
  });

  it("503s a create when custody is unbound", async () => {
    const deps = makeDeps({ providerKeys: undefined });
    const res = await route(
      req("POST", PROVIDERS_PATH, { provider: "daytona", apiKey: "dtn_x" }),
      env,
      deps,
    );
    expect(res.status).toBe(503);
  });

  it("validates the create body", async () => {
    const res = await route(
      req("POST", PROVIDERS_PATH, { provider: "openai", apiKey: "" }),
      env,
      makeDeps(),
    );
    expect(res.status).toBe(422);
    expect((await json(res)).error?.code).toBe("validation_failed");
  });

  it("409s a duplicate (org, provider, name)", async () => {
    const deps = makeDeps();
    const body = { provider: "daytona", apiKey: "dtn_x", name: "primary" };
    expect((await route(req("POST", PROVIDERS_PATH, body), env, deps)).status).toBe(201);
    const dup = await route(req("POST", PROVIDERS_PATH, body), env, deps);
    expect(dup.status).toBe(409);
    expect((await json(dup)).error?.code).toBe("provider_connection_conflict");
  });

  it("lists connections, filterable by provider", async () => {
    const deps = makeDeps();
    await route(req("POST", PROVIDERS_PATH, { provider: "daytona", apiKey: "d" }), env, deps);
    await route(req("POST", PROVIDERS_PATH, { provider: "anthropic", apiKey: "a" }), env, deps);

    const all = await route(req("GET", PROVIDERS_PATH), env, deps);
    expect(((await json(all)).data as unknown[]).length).toBe(2);

    const daytona = await route(req("GET", `${PROVIDERS_PATH}?provider=daytona`), env, deps);
    const rows = (await json(daytona)).data as Array<{ provider: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.provider).toBe("daytona");
  });

  it("re-verifies via POST /providers/{id}/verify (resolve → ping → status)", async () => {
    const keys = makeKeyClient({ resolveValue: "dtn_live_key" });
    // First ping fails so the row starts invalid; re-verify flips it.
    const failing = makeVerifier({ ok: false, reason: "503 from provider" });
    const deps = makeDeps({ providerKeys: keys.client, verifier: failing.verifier });
    const created = await route(
      req("POST", PROVIDERS_PATH, { provider: "daytona", apiKey: "dtn_live_key" }),
      env,
      deps,
    );
    const id = ((await json(created)).data as { id: string }).id;
    expect(((await json(await route(req("GET", PROVIDERS_PATH), env, deps))).data as Array<{ status: string }>)[0]!.status).toBe("invalid");

    deps.verifier = makeVerifier({ ok: true }).verifier;
    const verify = await route(req("POST", `${PROVIDERS_PATH}/${id}/verify`), env, deps);
    expect(verify.status).toBe(200);
    const v = (await json(verify)).data as { status: string; lastVerifiedAt?: string };
    expect(v.status).toBe("verified");
    expect(v.lastVerifiedAt).toBeTruthy();
    expect(keys.resolveCalls).toEqual(["agents/providers/daytona/default/API_KEY"]);
  });

  it("409s a verify when no key material resolves", async () => {
    const keys = makeKeyClient({ resolveValue: null });
    const deps = makeDeps({ providerKeys: keys.client });
    const created = await route(
      req("POST", PROVIDERS_PATH, { provider: "anthropic", apiKey: "sk-ant-x" }),
      env,
      deps,
    );
    const id = ((await json(created)).data as { id: string }).id;
    const verify = await route(req("POST", `${PROVIDERS_PATH}/${id}/verify`), env, deps);
    expect(verify.status).toBe(409);
    expect((await json(verify)).error?.code).toBe("provider_connection_invalid");
  });

  it("deletes a connection; 404s an unknown one", async () => {
    const deps = makeDeps();
    const created = await route(
      req("POST", PROVIDERS_PATH, { provider: "daytona", apiKey: "dtn_x" }),
      env,
      deps,
    );
    const id = ((await json(created)).data as { id: string }).id;

    const del = await route(req("DELETE", `${PROVIDERS_PATH}/${id}`), env, deps);
    expect(del.status).toBe(200);
    expect(((await json(await route(req("GET", PROVIDERS_PATH), env, deps))).data as unknown[]).length).toBe(0);

    const missing = await route(req("DELETE", `${PROVIDERS_PATH}/apc_missing`), env, deps);
    expect(missing.status).toBe(404);
  });

  it("revokes the custody secret on disconnect (no orphaned key)", async () => {
    const keys = makeKeyClient();
    const deps = makeDeps({ providerKeys: keys.client });
    const created = await route(
      req("POST", PROVIDERS_PATH, { provider: "openrouter", apiKey: "sk-or-x", config: { defaultModel: "m" } }),
      env,
      deps,
    );
    const id = ((await json(created)).data as { id: string }).id;

    const del = await route(req("DELETE", `${PROVIDERS_PATH}/${id}`), env, deps);
    expect(del.status).toBe(200);
    // Disconnect tore down the custody secret under the same reserved ref.
    expect(keys.revokeCalls).toContain("agents/providers/openrouter/default/API_KEY");
  });

  it("clears an orphaned custody secret before storing on (re)connect", async () => {
    const keys = makeKeyClient();
    const deps = makeDeps({ providerKeys: keys.client });
    await route(
      req("POST", PROVIDERS_PATH, { provider: "openrouter", apiKey: "sk-or-x", config: { defaultModel: "m" } }),
      env,
      deps,
    );
    // The orphan-clear revoke runs before the store, under the same ref — this
    // is what unblocks a same-name reconnect after a stale key was left behind.
    expect(keys.revokeCalls).toEqual(["agents/providers/openrouter/default/API_KEY"]);
    expect(keys.storeCalls.map((c) => c.key)).toEqual(["agents/providers/openrouter/default/API_KEY"]);
  });

  it("409s a duplicate name without touching custody (no clobber)", async () => {
    const keys = makeKeyClient();
    const deps = makeDeps({ providerKeys: keys.client });
    const body = { provider: "anthropic", apiKey: "sk-ant-1", name: "primary" };
    expect((await route(req("POST", PROVIDERS_PATH, body), env, deps)).status).toBe(201);

    const dup = await route(req("POST", PROVIDERS_PATH, { provider: "anthropic", apiKey: "sk-ant-2", name: "primary" }), env, deps);
    expect(dup.status).toBe(409);
    expect((await json(dup)).error?.code).toBe("provider_connection_conflict");
    // The existing key was never revoked or overwritten by the rejected dup.
    expect(keys.storeCalls.map((c) => c.value)).toEqual(["sk-ant-1"]);
    expect(keys.revokeCalls).toEqual(["agents/providers/anthropic/primary/API_KEY"]);
  });

  // ── IR5 dual-write (saas-integration-registry): the identity row in
  // integrations.connections rides every lifecycle transition. ──

  it("creates the integrations identity row on connect and stamps connection_id", async () => {
    const { mirror, rows } = makeIntegrationsMirror();
    const audit = makeAuditEmitter();
    const deps = makeDeps({ integrations: mirror, events: audit.emitter });

    const res = await route(
      req("POST", PROVIDERS_PATH, { provider: "anthropic", apiKey: "sk-ant-good", name: "primary" }),
      env,
      deps,
    );
    expect(res.status).toBe(201);
    const c = (await json(res)).data as Record<string, unknown>;

    // Exactly one identity row: workspace-private (IR-D4), auto share, named.
    expect(rows.size).toBe(1);
    const identity = [...rows.values()][0]!;
    expect(identity.orgId).toBe(ORG_UUID);
    expect(identity.provider).toBe("anthropic");
    expect(identity.scope).toBe("workspace");
    expect(identity.shareMode).toBe("auto");
    expect(identity.displayName).toBe("primary");
    // Verified create → activated (connected_at stamped).
    expect(identity.status).toBe("active");
    expect(identity.connectedAt).not.toBeNull();

    // The wire shape carries the identity as its public id (additive).
    expect(c.connectionId).toBe(`int_${identity.id.replace(/-/g, "")}`);

    // Audit gain: integration.connected on the verified create.
    expect(audit.events).toEqual([
      { type: "integration.connected", subjectId: identity.id },
    ]);
  });

  it("suspends the identity row when the create-time verification fails", async () => {
    const { mirror, rows } = makeIntegrationsMirror();
    const audit = makeAuditEmitter();
    const deps = makeDeps({
      integrations: mirror,
      events: audit.emitter,
      verifier: makeVerifier({ ok: false, reason: "401 from provider" }).verifier,
    });

    const res = await route(
      req("POST", PROVIDERS_PATH, { provider: "openai", apiKey: "sk-bad" }),
      env,
      deps,
    );
    expect(res.status).toBe(201);
    const identity = [...rows.values()][0]!;
    expect(identity.status).toBe("suspended");
    // No connected event for an invalid key.
    expect(audit.events).toEqual([]);
  });

  it("delete revokes the identity row and emits integration.revoked", async () => {
    const { mirror, rows, statusCalls } = makeIntegrationsMirror();
    const audit = makeAuditEmitter();
    const deps = makeDeps({ integrations: mirror, events: audit.emitter });

    const created = await route(
      req("POST", PROVIDERS_PATH, { provider: "daytona", apiKey: "dtn_x" }),
      env,
      deps,
    );
    const id = ((await json(created)).data as { id: string }).id;
    const identity = [...rows.values()][0]!;

    const del = await route(req("DELETE", `${PROVIDERS_PATH}/${id}`), env, deps);
    expect(del.status).toBe(200);
    expect(identity.status).toBe("revoked");
    expect(identity.revokedAt).not.toBeNull();
    expect(statusCalls).toContainEqual({ id: identity.id, status: "revoked" });
    expect(audit.events).toContainEqual({ type: "integration.revoked", subjectId: identity.id });
  });

  it("re-verify flips the identity row active ↔ suspended", async () => {
    const { mirror, rows } = makeIntegrationsMirror();
    const keys = makeKeyClient({ resolveValue: "sk-live" });
    const deps = makeDeps({
      integrations: mirror,
      providerKeys: keys.client,
      verifier: makeVerifier({ ok: false, reason: "503 from provider" }).verifier,
    });
    const created = await route(
      req("POST", PROVIDERS_PATH, { provider: "openrouter", apiKey: "sk-live" }),
      env,
      deps,
    );
    const id = ((await json(created)).data as { id: string }).id;
    const identity = [...rows.values()][0]!;
    expect(identity.status).toBe("suspended");

    deps.verifier = makeVerifier({ ok: true }).verifier;
    const verify = await route(req("POST", `${PROVIDERS_PATH}/${id}/verify`), env, deps);
    expect(verify.status).toBe(200);
    expect(identity.status).toBe("active");
  });

  it("tolerates a null connection_id: pre-backfill rows verify and delete without touching the mirror", async () => {
    // Create WITHOUT the integrations seam — the pre-backfill shape (R3).
    const keys = makeKeyClient({ resolveValue: "sk-live" });
    const deps = makeDeps({ providerKeys: keys.client });
    const created = await route(
      req("POST", PROVIDERS_PATH, { provider: "anthropic", apiKey: "sk-live" }),
      env,
      deps,
    );
    const c = (await json(created)).data as Record<string, unknown>;
    expect(c.connectionId).toBeUndefined();
    const id = c.id as string;

    // Now the seam exists (worker deployed post-migration) but the row has no
    // pointer — verify and delete must skip the mirror silently, not throw.
    const { mirror, rows, statusCalls } = makeIntegrationsMirror();
    deps.integrations = mirror;
    const verify = await route(req("POST", `${PROVIDERS_PATH}/${id}/verify`), env, deps);
    expect(verify.status).toBe(200);
    const del = await route(req("DELETE", `${PROVIDERS_PATH}/${id}`), env, deps);
    expect(del.status).toBe(200);
    expect(rows.size).toBe(0);
    expect(statusCalls).toEqual([]);
  });

  it("still creates the agents connection when the identity write fails (best-effort)", async () => {
    const failing: IntegrationConnectionsMirror = {
      async createConnection() {
        return { ok: false, error: { kind: "internal", message: "db down" } };
      },
      async activateConnection() {
        return { ok: false, error: { kind: "not_found" } };
      },
      async updateConnectionStatus() {
        return { ok: false, error: { kind: "not_found" } };
      },
    };
    const deps = makeDeps({ integrations: failing });
    const res = await route(
      req("POST", PROVIDERS_PATH, { provider: "daytona", apiKey: "dtn_x" }),
      env,
      deps,
    );
    expect(res.status).toBe(201);
    const c = (await json(res)).data as Record<string, unknown>;
    expect(c.status).toBe("verified");
    expect(c.connectionId).toBeUndefined();
  });

  it("403s every provider route when policy denies", async () => {
    const deps = makeDeps({ allow: false });
    for (const [method, path, body] of [
      ["GET", PROVIDERS_PATH, undefined],
      ["POST", PROVIDERS_PATH, { provider: "daytona", apiKey: "x" }],
      ["POST", `${PROVIDERS_PATH}/apc_1/verify`, undefined],
      ["DELETE", `${PROVIDERS_PATH}/apc_1`, undefined],
    ] as const) {
      const res = await route(req(method, path, body), env, deps);
      expect(res.status).toBe(403);
    }
  });

  it("405s unsupported methods on provider routes", async () => {
    const deps = makeDeps();
    expect((await route(req("DELETE", PROVIDERS_PATH), env, deps)).status).toBe(405);
    expect((await route(req("GET", `${PROVIDERS_PATH}/apc_1/verify`), env, deps)).status).toBe(405);
    expect((await route(req("POST", `${PROVIDERS_PATH}/apc_1`), env, deps)).status).toBe(405);
  });
});
