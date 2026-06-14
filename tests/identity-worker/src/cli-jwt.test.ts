import crypto from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}

import {
  mintCliAccessToken,
  verifyCliAccessToken,
  looksLikeCliAccessToken,
  getCliSigningKey,
  CLI_ACCESS_TOKEN_TTL_MS,
} from "../../../apps/identity-worker/src/cli/jwt";
import type { Env } from "../../../apps/identity-worker/src/env";

const KEY = "k".repeat(40);
const env = (key?: string): Env =>
  ({ ENVIRONMENT: "test", DEBUG_DELIVERY: "false", ...(key ? { CLI_JWT_SIGNING_KEY: key } : {}) }) as Env;

describe("CLI access JWT (OP1)", () => {
  const now = new Date("2026-06-14T12:00:00.000Z");

  it("mints a 3-segment HS256 JWT with the expected claims", async () => {
    const { token, expiresAt } = await mintCliAccessToken(env(KEY), {
      sub: "usr_abc",
      sessionId: "clises_xyz",
      orgIds: ["org_1", "org_2"],
      now,
    });
    expect(token.split(".")).toHaveLength(3);
    expect(looksLikeCliAccessToken(token)).toBe(true);
    expect(expiresAt.getTime()).toBe(now.getTime() + CLI_ACCESS_TOKEN_TTL_MS);

    const claims = await verifyCliAccessToken(env(KEY), token, now);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("usr_abc");
    expect(claims!.actorKind).toBe("user");
    expect(claims!.sessionId).toBe("clises_xyz");
    expect(claims!.orgIds).toEqual(["org_1", "org_2"]);
  });

  it("rejects a token signed with a different key", async () => {
    const { token } = await mintCliAccessToken(env(KEY), { sub: "u", sessionId: "s", orgIds: [], now });
    const claims = await verifyCliAccessToken(env("z".repeat(40)), token, now);
    expect(claims).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { token } = await mintCliAccessToken(env(KEY), { sub: "u", sessionId: "s", orgIds: [], now });
    const later = new Date(now.getTime() + CLI_ACCESS_TOKEN_TTL_MS + 1000);
    expect(await verifyCliAccessToken(env(KEY), token, later)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const { token } = await mintCliAccessToken(env(KEY), { sub: "u", sessionId: "s", orgIds: [], now });
    const [h, , sig] = token.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: "attacker", actorKind: "user", sessionId: "s", orgIds: [], exp: 9999999999 })).toString("base64url")}.${sig}`;
    expect(await verifyCliAccessToken(env(KEY), forged, now)).toBeNull();
  });

  it("cannot mint without a configured signing key", async () => {
    await expect(
      mintCliAccessToken(env(), { sub: "u", sessionId: "s", orgIds: [], now }),
    ).rejects.toThrow();
  });

  it("treats a missing/weak key as unavailable", () => {
    expect(getCliSigningKey(env())).toBeNull();
    expect(getCliSigningKey(env("short"))).toBeNull();
    expect(getCliSigningKey(env(KEY))).toBe(KEY);
  });

  it("does not mistake an opaque session token for a CLI JWT", () => {
    expect(looksLikeCliAccessToken("sps_ses_deadbeef.secret")).toBe(false);
    expect(looksLikeCliAccessToken("sk_abc")).toBe(false);
  });
});
