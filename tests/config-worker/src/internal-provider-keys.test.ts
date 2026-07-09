// Internal provider-key custody (saas-agents AG12, design §10.2). Invariants
// pinned here: both routes are gated to the RESERVED namespace
// `agents/providers/<provider>/<name>/API_KEY` (this seam is not a general
// secret backdoor), store encrypts before persisting, and resolve returns the
// plaintext only inside the response body.

import {
  handleProviderKeyStore,
  handleProviderKeyResolve,
  type ProviderKeyDeps,
} from "@config-worker/handlers/internal-provider-keys";
import type { Env } from "@config-worker/env";
import type { ActorContext } from "@config-worker/router";
import type { ConfigResult, CreateSecretMetadataInput, SecretMetadata } from "@saas/db/config";

const ORG = "11111111-1111-1111-1111-111111111111";
const RESERVED = "agents/providers/daytona/default/API_KEY";
const PLAINTEXT = "dtn_live_key_never_logged";

const ACTOR: ActorContext = { subjectId: "usr_aabbccdd", subjectType: "user" };
const ENV = {} as Env;

function meta(over: Partial<SecretMetadata> = {}): SecretMetadata {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    orgId: ORG,
    projectId: null,
    environmentId: null,
    scopeKind: "organization",
    secretKey: RESERVED,
    displayName: null,
    status: "active",
    version: 1,
    rotationPolicy: null,
    lastRotatedAt: null,
    expiresAt: null,
    createdBy: "00000000-0000-0000-0000-000000000000",
    personalOwner: null,
    overridable: true,
    lastUsedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  } as SecretMetadata;
}

interface Captured {
  created: CreateSecretMetadataInput[];
  encryptCalls: string[];
  decryptCalls: string[];
}

function makeDeps(over?: {
  capture?: Captured;
  createResult?: ConfigResult<SecretMetadata>;
  headResult?: ConfigResult<SecretMetadata>;
  cipherResult?: ConfigResult<string>;
}): ProviderKeyDeps {
  const capture = over?.capture ?? { created: [], encryptCalls: [], decryptCalls: [] };
  return {
    repo: {
      createSecretMetadata: async (input) => {
        capture.created.push(input);
        return over?.createResult ?? { ok: true, value: meta() };
      },
      getSecretMetadataByScopeKey: async () => over?.headResult ?? { ok: true, value: meta() },
      getSecretCiphertext: async () =>
        over?.cipherResult ?? { ok: true, value: JSON.stringify({ alg: "AES-256-GCM", v: 1 }) },
    },
    encryptionAdapter: {
      encrypt: async (value: string) => {
        capture.encryptCalls.push(value);
        return { alg: "AES-256-GCM", v: 1, iv: "aaa", ct: `enc(${value.length})` } as never;
      },
      decrypt: async () => PLAINTEXT,
    } as never,
    decrypt: async (envelope: string) => {
      capture.decryptCalls.push(envelope);
      return PLAINTEXT;
    },
  };
}

function req(path: string, body: unknown): Request {
  return new Request(`http://config-worker/v1/internal/config/provider-keys/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json(res: Response): Promise<{ data?: Record<string, unknown>; error?: { code: string } }> {
  return (await res.json()) as { data?: Record<string, unknown>; error?: { code: string } };
}

describe("provider-key store", () => {
  it("encrypts and stores under the reserved namespace, org scope", async () => {
    const capture: Captured = { created: [], encryptCalls: [], decryptCalls: [] };
    const res = await handleProviderKeyStore(
      req("store", { orgId: ORG, key: RESERVED, value: PLAINTEXT }),
      ENV,
      "req_t",
      ACTOR,
      makeDeps({ capture }),
    );
    expect(res.status).toBe(201);
    expect((await json(res)).data?.stored).toBe(true);

    expect(capture.encryptCalls).toEqual([PLAINTEXT]);
    expect(capture.created.length).toBe(1);
    const created = capture.created[0]!;
    expect(created.scope).toEqual({ kind: "organization", orgId: ORG });
    expect(created.secretKey).toBe(RESERVED);
    // The persisted envelope is ciphertext, not the plaintext.
    expect(created.ciphertextEnvelope).not.toContain(PLAINTEXT);
  });

  it.each([
    "DATABASE_URL",
    "agents/providers/openai/default/API_KEY",
    "agents/providers/daytona/default/OTHER",
    "agents/providers/daytona//API_KEY",
    "agents/providers/daytona/UPPER/API_KEY",
    "prefix/agents/providers/daytona/default/API_KEY",
  ])("rejects a non-reserved key on store: %s", async (key) => {
    const capture: Captured = { created: [], encryptCalls: [], decryptCalls: [] };
    const res = await handleProviderKeyStore(
      req("store", { orgId: ORG, key, value: "v" }),
      ENV,
      "req_t",
      ACTOR,
      makeDeps({ capture }),
    );
    expect(res.status).toBe(422);
    expect(capture.created.length).toBe(0);
  });

  it("409s a namespace collision as provider_connection_conflict", async () => {
    const res = await handleProviderKeyStore(
      req("store", { orgId: ORG, key: RESERVED, value: "v" }),
      ENV,
      "req_t",
      ACTOR,
      makeDeps({ createResult: { ok: false, error: { kind: "conflict" } } as never }),
    );
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("provider_connection_conflict");
  });

  it("validates value bounds", async () => {
    const deps = makeDeps();
    for (const value of ["", "x".repeat(4097), undefined]) {
      const res = await handleProviderKeyStore(
        req("store", { orgId: ORG, key: RESERVED, value }),
        ENV,
        "req_t",
        ACTOR,
        deps,
      );
      expect(res.status).toBe(422);
    }
  });
});

describe("provider-key resolve", () => {
  it("resolves the plaintext for a stored reserved key", async () => {
    const capture: Captured = { created: [], encryptCalls: [], decryptCalls: [] };
    const res = await handleProviderKeyResolve(
      req("resolve", { orgId: ORG, key: RESERVED }),
      ENV,
      "req_t",
      ACTOR,
      makeDeps({ capture }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data?.value).toBe(PLAINTEXT);
    expect(capture.decryptCalls.length).toBe(1);
  });

  it("rejects a non-reserved key on resolve before touching the repo", async () => {
    const capture: Captured = { created: [], encryptCalls: [], decryptCalls: [] };
    const res = await handleProviderKeyResolve(
      req("resolve", { orgId: ORG, key: "DATABASE_URL" }),
      ENV,
      "req_t",
      ACTOR,
      makeDeps({ capture }),
    );
    expect(res.status).toBe(422);
    expect(capture.decryptCalls.length).toBe(0);
  });

  it("404s a missing key as provider_connection_not_found", async () => {
    const res = await handleProviderKeyResolve(
      req("resolve", { orgId: ORG, key: RESERVED }),
      ENV,
      "req_t",
      ACTOR,
      makeDeps({ headResult: { ok: false, error: { kind: "not_found" } } as never }),
    );
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe("provider_connection_not_found");
  });

  it("redacts decryption failures", async () => {
    const deps = makeDeps();
    deps.decrypt = async () => {
      throw new Error(`boom envelope=${PLAINTEXT}`);
    };
    const res = await handleProviderKeyResolve(
      req("resolve", { orgId: ORG, key: RESERVED }),
      ENV,
      "req_t",
      ACTOR,
      deps,
    );
    expect(res.status).toBe(500);
    const text = JSON.stringify(await json(res));
    expect(text).not.toContain(PLAINTEXT);
  });
});
