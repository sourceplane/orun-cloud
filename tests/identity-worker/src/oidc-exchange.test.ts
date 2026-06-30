// OV3 GitHub Actions OIDC exchange — handler tests. A real RS256 keypair is
// generated in-test to sign GitHub-shaped OIDC tokens, and the JWKS is injected
// (no network), so verification, repo→link resolution, the per-link CI gate, and
// workflow-token minting are exercised end-to-end. The minted token is then run
// back through resolve-bearer to prove api-edge accepts it as a workflow actor.

import crypto from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}

import { handleOidcExchange } from "../../../apps/identity-worker/src/handlers/oidc-exchange";
import { handleResolveBearer } from "../../../apps/identity-worker/src/handlers/resolve-bearer";
import { verifyWorkflowAccessToken } from "../../../apps/identity-worker/src/cli/jwt";
import type { Env } from "../../../apps/identity-worker/src/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const KEY = "k".repeat(40);
const NOW = new Date("2026-06-17T12:00:00.000Z");
const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const ORG2_UUID = "22222222-2222-4222-8222-222222222222";
const PROJECT_UUID = "44444444-4444-4444-8444-444444444444";
const ORG_PUBLIC = `org_${ORG_UUID.replace(/-/g, "")}`;
const REPO_ID = "123456";

function env(): Env {
  return {
    ENVIRONMENT: "test",
    DEBUG_DELIVERY: "false",
    CLI_JWT_SIGNING_KEY: KEY,
    PLATFORM_DB: {},
  } as unknown as Env;
}

// ── base64url + RS256 OIDC token forging (in-test keypair) ──

function b64urlBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
  return b64urlBytes(new TextEncoder().encode(s));
}

interface OidcOverrides {
  aud?: string;
  exp?: number;
  ref?: string;
  environment?: string;
  repository_id?: string;
}

async function forgeOidc(over: OidcOverrides = {}, kid = "kid-1"): Promise<{ token: string; jwks: { keys: JsonWebKey[] } }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & { kid?: string; alg?: string; use?: string };
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";

  const nowSec = Math.floor(NOW.getTime() / 1000);
  const header = { alg: "RS256", kid, typ: "JWT" };
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: over.aud ?? "orun-cloud",
    sub: "repo:acme/platform:ref:refs/heads/main",
    exp: over.exp ?? nowSec + 600,
    iat: nowSec,
    repository: "acme/platform",
    repository_id: over.repository_id ?? REPO_ID,
    repository_owner: "acme",
    repository_owner_id: "789",
    ...(over.ref !== undefined ? { ref: over.ref } : { ref: "refs/heads/main" }),
    ...(over.environment !== undefined ? { environment: over.environment } : {}),
  };
  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    new TextEncoder().encode(signingInput) as BufferSource,
  );
  return { token: `${signingInput}.${b64urlBytes(new Uint8Array(sig))}`, jwks: { keys: [jwk] } };
}

// ── scripted state-repo executor (the workspace_links lookup) ──

function linkRow(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    org_id: ORG_UUID,
    project_id: PROJECT_UUID,
    remote_url: "github.com/acme/platform",
    status: "active",
    provider: "github",
    provider_repo_id: REPO_ID,
    provider_owner_id: "789",
    provider_owner_login: "acme",
    oidc_enabled: true,
    api_key_enabled: true,
    allowed_ref_pattern: null,
    allowed_environments: null,
    created_by: "usr_x",
    created_by_kind: "user",
    last_seen_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  };
}

function stateExecutor(rows: Record<string, unknown>[]): SqlExecutor {
  return {
    execute<T extends SqlRow = SqlRow>(text: string): Promise<SqlExecutorResult<T>> {
      if (text.includes("FROM state.workspace_links")) {
        return Promise.resolve({ rows: rows as unknown as T[], rowCount: rows.length });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as SqlExecutor;
}

function exchangeReq(token: string, org?: string): Request {
  return new Request("https://identity.internal/v1/auth/oidc/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, ...(org ? { org } : {}) }),
  });
}

describe("POST /v1/auth/oidc/exchange (OV3)", () => {
  it("exchanges a valid OIDC token for a workflow access token bound to (org, project)", async () => {
    const { token, jwks } = await forgeOidc();
    const res = await handleOidcExchange(exchangeReq(token), env(), "req_1", {
      executor: stateExecutor([linkRow()]),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { accessToken: string; tokenType: string; orgId: string; projectId: string } };
    expect(body.data.tokenType).toBe("Bearer");
    expect(body.data.orgId).toBe(ORG_PUBLIC);

    // The minted token verifies as a workflow actor bound to the link.
    const claims = await verifyWorkflowAccessToken(env(), body.data.accessToken, NOW);
    expect(claims).not.toBeNull();
    expect(claims!.actorKind).toBe("workflow");
    expect(claims!.orgId).toBe(ORG_PUBLIC);
    expect(claims!.sub).toBe("repo:acme/platform:ref:refs/heads/main");
  });

  it("carries the bound org's durable workspaceId (ws_…) in the token + response (WID5)", async () => {
    const { token, jwks } = await forgeOidc();
    const res = await handleOidcExchange(exchangeReq(token), env(), "req_ws", {
      executor: stateExecutor([linkRow()]),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
      // The handler resolves the bound org's `org_<hex>` → its `ws_…` publicRef.
      resolveOrgRef: async (ref) =>
        ref === ORG_PUBLIC ? { orgId: ORG_PUBLIC, publicRef: "ws_3KF9TQ2P" } : null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { accessToken: string; orgId: string; workspaceId?: string } };
    expect(body.data.orgId).toBe(ORG_PUBLIC);
    expect(body.data.workspaceId).toBe("ws_3KF9TQ2P");

    const claims = await verifyWorkflowAccessToken(env(), body.data.accessToken, NOW);
    expect(claims!.orgId).toBe(ORG_PUBLIC);
    expect(claims!.workspaceId).toBe("ws_3KF9TQ2P");
  });

  it("omits workspaceId when the org's ws_ cannot be resolved (fail-soft)", async () => {
    const { token, jwks } = await forgeOidc();
    const res = await handleOidcExchange(exchangeReq(token), env(), "req_ws2", {
      executor: stateExecutor([linkRow()]),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
      resolveOrgRef: async () => null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { orgId: string; workspaceId?: string } };
    expect(body.data.orgId).toBe(ORG_PUBLIC);
    expect(body.data.workspaceId).toBeUndefined();
  });

  it("resolve-bearer accepts the minted workflow token as a workflow actor", async () => {
    const { token, jwks } = await forgeOidc();
    const exchange = await handleOidcExchange(exchangeReq(token), env(), "req_1", {
      executor: stateExecutor([linkRow()]),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
    });
    const { data } = (await exchange.json()) as { data: { accessToken: string } };

    const resolveReq = new Request("https://identity.internal/v1/auth/resolve", {
      headers: { authorization: `Bearer ${data.accessToken}` },
    });
    const res = await handleResolveBearer(resolveReq, env(), "req_2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { actor: { actorType: string; actorId: string; orgId: string; projectId: string } } };
    expect(body.data.actor.actorType).toBe("workflow");
    expect(body.data.actor.orgId).toBe(ORG_PUBLIC);
  });

  it("denies (404, resource-hiding) a repository not linked to any org", async () => {
    // specs/oidc-ci-tenancy §2.2/§5: "not linked" hides as a 404 not_found — the
    // same shape as the state-worker push gate — so the CLI keys on one stable
    // denial code and never infers "forbidden". Was 403; pinned at 404 here.
    const { token, jwks } = await forgeOidc();
    const res = await handleOidcExchange(exchangeReq(token), env(), "req_1", {
      executor: stateExecutor([]),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("denies (404, resource-hiding) when the declared org matches no link", async () => {
    // A repo linked across two orgs, but the org hint names neither: collapse to
    // the same 404 Not-Found so existence/membership never leak (decision D4).
    const { token, jwks } = await forgeOidc();
    const links = [linkRow(), linkRow({ org_id: ORG2_UUID, id: "66666666-6666-4666-8666-666666666666" })];
    const res = await handleOidcExchange(exchangeReq(token, "org_doesnotmatch"), env(), "req_1", {
      executor: stateExecutor(links),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("never auto-creates a link/project on the workflow path (D1)", async () => {
    // Decision D1: the OIDC exchange is read-only w.r.t. links/projects. On an
    // unlinked repo it must deny, not provision. Assert the handler issues NO
    // write SQL (only the workspace_links SELECT) before returning 404.
    const { token, jwks } = await forgeOidc();
    const statements: string[] = [];
    const trackingExecutor = {
      execute(text: string) {
        statements.push(text);
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    } as unknown as SqlExecutor;
    const res = await handleOidcExchange(exchangeReq(token), env(), "req_1", {
      executor: trackingExecutor,
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
    });
    expect(res.status).toBe(404);
    const mutating = statements.filter((s) => /\b(INSERT|UPDATE|DELETE)\b/i.test(s));
    expect(mutating).toEqual([]);
  });

  it("denies (403) when oidc is disabled on the link", async () => {
    const { token, jwks } = await forgeOidc();
    const res = await handleOidcExchange(exchangeReq(token), env(), "req_1", {
      executor: stateExecutor([linkRow({ oidc_enabled: false })]),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details?: { reason?: string } } };
    expect(body.error.details?.reason).toBe("oidc_disabled");
  });

  it("denies (403) when the ref is outside the allowed pattern", async () => {
    const { token, jwks } = await forgeOidc({ ref: "refs/heads/feature/x" });
    const res = await handleOidcExchange(exchangeReq(token), env(), "req_1", {
      executor: stateExecutor([linkRow({ allowed_ref_pattern: "refs/heads/main" })]),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
    });
    expect(res.status).toBe(403);
  });

  it("allows a glob ref pattern match", async () => {
    const { token, jwks } = await forgeOidc({ ref: "refs/heads/release/1.2" });
    const res = await handleOidcExchange(exchangeReq(token), env(), "req_1", {
      executor: stateExecutor([linkRow({ allowed_ref_pattern: "refs/heads/release/*" })]),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
    });
    expect(res.status).toBe(200);
  });

  it("rejects (401) an expired OIDC token", async () => {
    const nowSec = Math.floor(NOW.getTime() / 1000);
    const { token, jwks } = await forgeOidc({ exp: nowSec - 10 });
    const res = await handleOidcExchange(exchangeReq(token), env(), "req_1", {
      executor: stateExecutor([linkRow()]),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
    });
    expect(res.status).toBe(401);
  });

  it("rejects (401) a token with the wrong audience", async () => {
    const { token, jwks } = await forgeOidc({ aud: "some-other-aud" });
    const res = await handleOidcExchange(exchangeReq(token), env(), "req_1", {
      executor: stateExecutor([linkRow()]),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
    });
    expect(res.status).toBe(401);
  });

  it("resolves a ws_ org hint to the right link (WID3)", async () => {
    // A repo linked across two orgs; the hint is a `ws_` ref that the injected
    // resolver maps to ORG2's canonical `org_<hex>`, so the second link is chosen.
    const { token, jwks } = await forgeOidc();
    const links = [linkRow(), linkRow({ org_id: ORG2_UUID, id: "66666666-6666-4666-8666-666666666666" })];
    const ORG2_PUBLIC = `org_${ORG2_UUID.replace(/-/g, "")}`;
    const res = await handleOidcExchange(exchangeReq(token, "ws_9QM2X7BD"), env(), "req_1", {
      executor: stateExecutor(links),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
      resolveOrgRef: async (ref) =>
        ref === "ws_9QM2X7BD" ? { orgId: ORG2_PUBLIC, publicRef: "ws_9QM2X7BD" } : null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { orgId: string } };
    expect(body.data.orgId).toBe(ORG2_PUBLIC);
  });

  it("resolves a slug org hint to the right link (WID3)", async () => {
    const { token, jwks } = await forgeOidc();
    const links = [linkRow(), linkRow({ org_id: ORG2_UUID, id: "66666666-6666-4666-8666-666666666666" })];
    const res = await handleOidcExchange(exchangeReq(token, "acme"), env(), "req_1", {
      executor: stateExecutor(links),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
      resolveOrgRef: async (ref) =>
        ref === "acme" ? { orgId: ORG_PUBLIC, publicRef: "ws_ACMEROOT" } : null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { orgId: string } };
    expect(body.data.orgId).toBe(ORG_PUBLIC);
  });

  it("requires the org claim to disambiguate a repo linked across orgs (409 → 200)", async () => {
    const { token, jwks } = await forgeOidc();
    const links = [linkRow(), linkRow({ org_id: ORG2_UUID, id: "66666666-6666-4666-8666-666666666666" })];

    const ambiguous = await handleOidcExchange(exchangeReq(token), env(), "req_1", {
      executor: stateExecutor(links),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
    });
    expect(ambiguous.status).toBe(409);

    const disambiguated = await handleOidcExchange(exchangeReq(token, ORG_PUBLIC), env(), "req_2", {
      executor: stateExecutor(links),
      fetchJwks: () => Promise.resolve(jwks),
      now: () => NOW,
    });
    expect(disambiguated.status).toBe(200);
    const body = (await disambiguated.json()) as { data: { orgId: string } };
    expect(body.data.orgId).toBe(ORG_PUBLIC);
  });
});
