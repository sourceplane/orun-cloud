// Agent-session access token (saas-agents AG6 §3.2): mint/verify roundtrip,
// the resolve-bearer branch (service_principal actor + session surfaced), and
// the internal mint route's validation. One signing key, one envelope, three
// actor kinds — the assertions pin that an agent-session token can never
// resolve as a user or workflow and vice versa.

import crypto from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}

import {
  mintAgentSessionToken,
  verifyAgentSessionToken,
  verifyCliAccessToken,
  verifyWorkflowAccessToken,
  looksLikeCliAccessToken,
  AGENT_SESSION_TOKEN_TTL_MS,
} from "../../../apps/identity-worker/src/cli/jwt";
import { handleMintAgentSessionToken } from "../../../apps/identity-worker/src/handlers/internal-agent-session-token";
import { handleResolveBearer } from "../../../apps/identity-worker/src/handlers/resolve-bearer";
import type { Env } from "../../../apps/identity-worker/src/env";

const KEY = "k".repeat(40);
const env = (key?: string): Env =>
  ({ ENVIRONMENT: "test", DEBUG_DELIVERY: "false", ...(key ? { CLI_JWT_SIGNING_KEY: key } : {}) }) as Env;

const INPUT = { principalId: "sp_agent1", orgId: "org_1", sessionId: "as_42", now: new Date("2026-07-09T12:00:00Z") };

describe("agent-session JWT (AG6)", () => {
  it("mints and verifies with the session-bound claims", async () => {
    const { token, expiresAt } = await mintAgentSessionToken(env(KEY), INPUT);
    expect(token.split(".")).toHaveLength(3);
    expect(looksLikeCliAccessToken(token)).toBe(true); // same envelope, one bearer path
    expect(expiresAt.getTime()).toBe(INPUT.now.getTime() + AGENT_SESSION_TOKEN_TTL_MS);

    const claims = await verifyAgentSessionToken(env(KEY), token, INPUT.now);
    expect(claims).toMatchObject({
      sub: "sp_agent1",
      actorKind: "agent_session",
      orgId: "org_1",
      sessionId: "as_42",
    });
  });

  it("never verifies as a user or workflow token (kind isolation)", async () => {
    const { token } = await mintAgentSessionToken(env(KEY), INPUT);
    expect(await verifyCliAccessToken(env(KEY), token, INPUT.now)).toBeNull();
    expect(await verifyWorkflowAccessToken(env(KEY), token, INPUT.now)).toBeNull();
  });

  it("fails closed: expiry, wrong key, unset key", async () => {
    const { token } = await mintAgentSessionToken(env(KEY), INPUT);
    const after = new Date(INPUT.now.getTime() + AGENT_SESSION_TOKEN_TTL_MS + 1000);
    expect(await verifyAgentSessionToken(env(KEY), token, after)).toBeNull();
    expect(await verifyAgentSessionToken(env("z".repeat(40)), token, INPUT.now)).toBeNull();
    expect(await verifyAgentSessionToken(env(), token, INPUT.now)).toBeNull();
    await expect(mintAgentSessionToken(env(), INPUT)).rejects.toThrow(/not configured/);
  });
});

describe("resolve-bearer resolves an agent-session token (AG6)", () => {
  it("resolves to a service_principal actor with the session surfaced", async () => {
    const { token } = await mintAgentSessionToken(env(KEY), {
      ...INPUT,
      now: new Date(), // live token for the handler's real clock
    });
    const req = new Request("http://identity-worker/v1/auth/resolve", {
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await handleResolveBearer(req, env(KEY), "req_t");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { actor: Record<string, unknown>; agentSession?: { id: string } };
    };
    expect(body.data.actor).toEqual({
      actorType: "service_principal",
      actorId: "sp_agent1",
      orgId: "org_1",
    });
    expect(body.data.agentSession?.id).toBe("as_42");
  });
});

describe("internal agent-session token mint route (AG6)", () => {
  function mintReq(body: unknown): Request {
    return new Request("http://identity-worker/v1/internal/identity/agent-session-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("mints for a valid (principal, org, session) triple", async () => {
    const res = await handleMintAgentSessionToken(
      mintReq({ principalId: "sp_agent1", orgId: "org_1", sessionId: "as_42" }),
      env(KEY),
      "req_t",
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { token: string; expiresAt: string } };
    const claims = await verifyAgentSessionToken(env(KEY), body.data.token, new Date());
    expect(claims?.sessionId).toBe("as_42");
    expect(claims?.sub).toBe("sp_agent1");
  });

  it("422s malformed ids — the mint never launders arbitrary subjects", async () => {
    for (const body of [
      { principalId: "usr_human", orgId: "org_1", sessionId: "as_42" },
      { principalId: "sp_agent1", orgId: "org_1", sessionId: "session-42" },
      { principalId: "sp_agent1", sessionId: "as_42" },
      {},
    ]) {
      const res = await handleMintAgentSessionToken(mintReq(body), env(KEY), "req_t");
      expect(res.status).toBe(422);
    }
  });

  it("503s when the signing key is unset — never a silent grant", async () => {
    const res = await handleMintAgentSessionToken(
      mintReq({ principalId: "sp_agent1", orgId: "org_1", sessionId: "as_42" }),
      env(),
      "req_t",
    );
    expect(res.status).toBe(503);
  });
});
