import { encryptGraceSuccessor, decryptGraceSuccessor } from "../../../apps/identity-worker/src/cli/grace-crypto";
import type { Env } from "../../../apps/identity-worker/src/env";

const KEYED = { OAUTH_STATE_SECRET: "g".repeat(48) } as Env;
const NO_KEY = {} as Env;

describe("grace-crypto (R11 successor encryption)", () => {
  it("round-trips a successor token under a configured key", async () => {
    const token = "ocrt_" + "a".repeat(64);
    const envelope = await encryptGraceSuccessor(KEYED, token);
    expect(envelope).not.toBeNull();
    // The envelope is JSON and never contains the plaintext.
    expect(envelope!).not.toContain(token);
    const parsed = JSON.parse(envelope!);
    expect(parsed.alg).toBe("AES-256-GCM");
    expect(await decryptGraceSuccessor(KEYED, envelope!)).toBe(token);
  });

  it("disables (returns null) when no key is configured — grace soft-off", async () => {
    expect(await encryptGraceSuccessor(NO_KEY, "x")).toBeNull();
    // Decrypt also yields null with no key, so the caller falls back to revoke.
    const envelope = await encryptGraceSuccessor(KEYED, "x");
    expect(await decryptGraceSuccessor(NO_KEY, envelope!)).toBeNull();
  });

  it("rejects a tampered or wrong-key ciphertext (returns null, never throws)", async () => {
    const envelope = await encryptGraceSuccessor(KEYED, "ocrt_secret");
    const tampered = JSON.parse(envelope!);
    tampered.ct = tampered.ct.slice(0, -4) + "AAAA"; // corrupt the GCM tag/ciphertext
    expect(await decryptGraceSuccessor(KEYED, JSON.stringify(tampered))).toBeNull();
    // A different derived key cannot decrypt.
    const otherKey = { OAUTH_STATE_SECRET: "h".repeat(48) } as Env;
    expect(await decryptGraceSuccessor(otherKey, envelope!)).toBeNull();
    expect(await decryptGraceSuccessor(KEYED, "not-json")).toBeNull();
  });
});
