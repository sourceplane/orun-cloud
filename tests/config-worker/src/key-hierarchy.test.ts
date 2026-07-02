/**
 * Key hierarchy (saas-secret-manager SM2, orun-secrets SD-2′).
 *
 * Covers: v:2 workspace-DEK envelopes round-trip through the dormant decrypt
 * module, v:1 static-key fallback + back-compat reads, race-safe DEK
 * get-or-create, keyId shape, and the non-import invariant (nothing in
 * src/handlers or the router touches decryption.ts until the SM3 resolve).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

import {
  createSecretEncryptionAdapter,
  getOrCreateActiveDek,
  importKek,
  unwrapDek,
  wrapDek,
  type WorkspaceDekStore,
} from "@config-worker/encryption";
import { decryptEnvelope } from "@config-worker/decryption";
import type { ConfigResult, SecretDek } from "@saas/db/config";

const KEK_HEX = "a".repeat(64);
const STATIC_HEX = "b".repeat(64);
const ORG = "11111111-2222-3333-4444-555555555555";

// ── Fake DEK store ─────────────────────────────────────────

function notFound(): ConfigResult<never> {
  return { ok: false, error: { kind: "not_found" } };
}

/** In-memory WorkspaceDekStore mirroring the ON CONFLICT DO NOTHING semantics. */
function fakeDekStore(): WorkspaceDekStore & { rows: Map<string, SecretDek>; inserts: number } {
  const rows = new Map<string, SecretDek>();
  return {
    rows,
    inserts: 0,
    async getActiveDek(orgId: string): Promise<ConfigResult<SecretDek>> {
      const row = rows.get(orgId);
      return row ? { ok: true, value: row } : notFound();
    },
    async insertDek(orgId: string, generation: number, wrappedDek: string): Promise<ConfigResult<{ inserted: boolean }>> {
      this.inserts += 1;
      if (rows.has(orgId)) {
        return { ok: true, value: { inserted: false } }; // conflict: someone else won
      }
      rows.set(orgId, { orgId, generation, wrappedDek, state: "active", createdAt: new Date() });
      return { ok: true, value: { inserted: true } };
    },
  };
}

// ── v:2 round-trip ─────────────────────────────────────────

describe("workspace-DEK envelopes (v:2)", () => {
  it("encrypts under the workspace DEK and round-trips through decryptEnvelope", async () => {
    const store = fakeDekStore();
    const adapter = await createSecretEncryptionAdapter({ SECRET_KEK: KEK_HEX }, ORG, store);
    expect(adapter).not.toBeNull();

    const envelope = await adapter!.encrypt("postgres://very-secret");
    expect(envelope.v).toBe(2);
    expect((envelope as { keyId: string }).keyId).toBe(`ws:${ORG}:1`);

    const plaintext = await decryptEnvelope(JSON.stringify(envelope), {
      kekHex: KEK_HEX,
      getWrappedDek: async (orgId, generation) => {
        const row = store.rows.get(orgId);
        return row && row.generation === generation ? row.wrappedDek : null;
      },
    });
    expect(plaintext).toBe("postgres://very-secret");
  });

  it("reuses the stored DEK across adapters (one generation per workspace)", async () => {
    const store = fakeDekStore();
    const a1 = await createSecretEncryptionAdapter({ SECRET_KEK: KEK_HEX }, ORG, store);
    const a2 = await createSecretEncryptionAdapter({ SECRET_KEK: KEK_HEX }, ORG, store);
    const e1 = await a1!.encrypt("one");
    const e2 = await a2!.encrypt("two");
    expect((e1 as { keyId: string }).keyId).toBe((e2 as { keyId: string }).keyId);
    expect(store.rows.size).toBe(1);
  });

  it("fails decryption for an unknown DEK generation", async () => {
    const store = fakeDekStore();
    const adapter = await createSecretEncryptionAdapter({ SECRET_KEK: KEK_HEX }, ORG, store);
    const envelope = await adapter!.encrypt("x");
    await expect(
      decryptEnvelope(JSON.stringify(envelope), {
        kekHex: KEK_HEX,
        getWrappedDek: async () => null, // generation shredded / unknown
      }),
    ).rejects.toThrow("Unknown DEK generation");
  });
});

// ── v:1 fallback + back-compat ─────────────────────────────

describe("static-key fallback (v:1)", () => {
  it("emits v:1 envelopes when SECRET_KEK is absent (un-seeded environments)", async () => {
    const adapter = await createSecretEncryptionAdapter(
      { SECRET_ENCRYPTION_KEY: STATIC_HEX },
      ORG,
      fakeDekStore(),
    );
    const envelope = await adapter!.encrypt("legacy-path");
    expect(envelope.v).toBe(1);
    expect("keyId" in envelope).toBe(false);

    const plaintext = await decryptEnvelope(JSON.stringify(envelope), { staticKeyHex: STATIC_HEX });
    expect(plaintext).toBe("legacy-path");
  });

  it("decrypts a v:1 envelope even when the KEK is also configured (lazy k0 migration)", async () => {
    const v1Adapter = await createSecretEncryptionAdapter({ SECRET_ENCRYPTION_KEY: STATIC_HEX }, ORG, fakeDekStore());
    const envelope = await v1Adapter!.encrypt("pre-kek-row");
    const plaintext = await decryptEnvelope(JSON.stringify(envelope), {
      staticKeyHex: STATIC_HEX,
      kekHex: KEK_HEX,
      getWrappedDek: async () => null,
    });
    expect(plaintext).toBe("pre-kek-row");
  });
});

// ── get-or-create race ─────────────────────────────────────

describe("getOrCreateActiveDek", () => {
  it("adopts the winner's DEK when the insert loses the race", async () => {
    const kek = (await importKek(KEK_HEX))!;
    const winnerDek = new Uint8Array(32).fill(7);
    const winnerWrapped = await wrapDek(kek, winnerDek);
    const winnerRow: SecretDek = { orgId: ORG, generation: 1, wrappedDek: winnerWrapped, state: "active", createdAt: new Date() };

    // First getActiveDek misses; the insert "loses" (row appeared meanwhile);
    // the re-SELECT returns the winner's row.
    let lookups = 0;
    const store: WorkspaceDekStore = {
      async getActiveDek() {
        lookups += 1;
        return lookups === 1 ? notFound() : { ok: true, value: winnerRow };
      },
      async insertDek() {
        return { ok: true, value: { inserted: false } };
      },
    };

    const { generation, dekBytes } = await getOrCreateActiveDek(store, kek, ORG);
    expect(generation).toBe(1);
    expect(Array.from(dekBytes)).toEqual(Array.from(winnerDek));
  });

  it("round-trips wrap/unwrap without exposing raw bytes in the document", async () => {
    const kek = (await importKek(KEK_HEX))!;
    const dek = new Uint8Array(32);
    crypto.getRandomValues(dek);
    const wrapped = await wrapDek(kek, dek);
    expect(wrapped).not.toContain(Buffer.from(dek).toString("base64"));
    const unwrapped = await unwrapDek(kek, wrapped);
    expect(Array.from(unwrapped)).toEqual(Array.from(dek));
  });
});

// ── The non-import invariant ───────────────────────────────

describe("decryption stays dormant until SM3", () => {
  it("no handler or router imports the decryption module", () => {
    const srcRoot = join(testDir, "..", "..", "..", "apps", "config-worker", "src");
    const files = [
      join(srcRoot, "router.ts"),
      ...readdirSync(join(srcRoot, "handlers")).map((f) => join(srcRoot, "handlers", f)),
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect({ file, imports: /from\s+["'].*decryption/.test(text) }).toEqual({ file, imports: false });
    }
  });
});
