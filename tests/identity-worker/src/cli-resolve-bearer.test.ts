import crypto from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}

import { handleResolveBearer } from "../../../apps/identity-worker/src/handlers/resolve-bearer";
import { mintCliAccessToken } from "../../../apps/identity-worker/src/cli/jwt";
import type { Env } from "../../../apps/identity-worker/src/env";

const KEY = "j".repeat(48);
const env: Env = { ENVIRONMENT: "test", DEBUG_DELIVERY: "false", CLI_JWT_SIGNING_KEY: KEY } as Env;

function req(token: string): Request {
  return new Request("https://identity.internal/v1/auth/resolve", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("resolveBearer — CLI access JWT (OP1)", () => {
  const now = new Date();

  it("resolves a valid CLI access token to a user ActorContext without a DB hop", async () => {
    const { token } = await mintCliAccessToken(env, {
      sub: "usr_" + "a".repeat(32),
      sessionId: "clises_xyz",
      orgIds: ["org_" + "b".repeat(32)],
      now,
    });
    // No PLATFORM_DB set: a valid CLI token must still resolve (JWT path is
    // verified locally before any DB access).
    const res = await handleResolveBearer(req(token), env, "req-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { actor: { actorType: string; actorId: string; orgId?: string }; cliOrgIds?: string[]; session?: { id: string } };
    };
    expect(body.data.actor.actorType).toBe("user");
    expect(body.data.actor.actorId).toBe("usr_" + "a".repeat(32));
    expect(body.data.actor.orgId).toBe("org_" + "b".repeat(32));
    expect(body.data.cliOrgIds).toEqual(["org_" + "b".repeat(32)]);
    expect(body.data.session?.id).toBe("clises_xyz");
  });

  it("rejects a CLI-shaped token that fails verification", async () => {
    const { token } = await mintCliAccessToken(env, { sub: "u", sessionId: "s", orgIds: [], now });
    // Same token, wrong signing key on the verifying side.
    const otherEnv: Env = { ENVIRONMENT: "test", DEBUG_DELIVERY: "false", CLI_JWT_SIGNING_KEY: "z".repeat(48) } as Env;
    const res = await handleResolveBearer(req(token), otherEnv, "req-2");
    expect(res.status).toBe(401);
  });

  it("rejects an expired CLI token", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const { token } = await mintCliAccessToken(env, { sub: "u", sessionId: "s", orgIds: [], now: past });
    const res = await handleResolveBearer(req(token), env, "req-3");
    expect(res.status).toBe(401);
  });
});
