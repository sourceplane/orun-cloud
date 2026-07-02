/**
 * Encryption adapter for config-worker secret payloads.
 *
 * Uses Web Crypto AES-256-GCM (authenticated encryption) with a random 12-byte IV
 * per value. Two envelope formats coexist (saas-secret-manager SM2, orun-secrets
 * SD-2′):
 *
 *   v:1 — the shipped static-key path: encrypted under SECRET_ENCRYPTION_KEY
 *         (the implicit `k0`), a 64-hex environment binding.
 *   v:2 — the workspace key hierarchy: encrypted under the workspace's active
 *         data-encryption key (DEK), named by `keyId` ("ws:<org-uuid>:<generation>").
 *         The DEK is stored wrapped under the KEK (the SECRET_KEK binding — the
 *         Cloudflare Secrets Store binding is deferred to saas-secrets-sync SS4)
 *         in config.secret_deks; unwrapped DEK bytes exist only in Worker memory
 *         for the duration of an operation, never logged, never returned.
 *
 * Reads accept both formats (see decryption.ts, dormant until SM3); when
 * SECRET_KEK is configured ALL new writes produce v:2. The stored envelope is a
 * JSON-encoded structure containing algorithm metadata, nonce, and ciphertext —
 * never plaintext.
 */

import type { SecretDekRepository } from "@saas/db/config";
import { createSecretDekRepository } from "@saas/db/config";
import { createSqlExecutor } from "@saas/db/hyperdrive";

// ── Envelope format ──────────────────────────────────────────

/** The shipped static-key envelope (implicit keyId "k0"). */
export interface CiphertextEnvelopeV1 {
  /** Algorithm identifier for future migration */
  alg: "AES-256-GCM";
  /** Envelope format version */
  v: 1;
  /** Base64-encoded 12-byte IV/nonce */
  iv: string;
  /** Base64-encoded ciphertext (includes GCM auth tag) */
  ct: string;
}

/** The workspace-DEK envelope (SM2). */
export interface CiphertextEnvelopeV2 {
  alg: "AES-256-GCM";
  v: 2;
  /** Workspace DEK + generation: "ws:<org-uuid>:<generation>". */
  keyId: string;
  /** Base64-encoded 12-byte IV/nonce */
  iv: string;
  /** Base64-encoded ciphertext (includes GCM auth tag) */
  ct: string;
}

export type CiphertextEnvelope = CiphertextEnvelopeV1 | CiphertextEnvelopeV2;

// ── Encryption adapter interface ─────────────────────────────

export interface EncryptionAdapter {
  encrypt(plaintext: string): Promise<CiphertextEnvelope>;
}

// ── Helpers ──────────────────────────────────────────────────

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const HEX_RE = /^[0-9a-fA-F]{64}$/;

/** True when `keyHex` is a well-formed 64-hex (256-bit) key value. */
export function isValidKeyHex(keyHex: string | undefined): keyHex is string {
  return typeof keyHex === "string" && HEX_RE.test(keyHex);
}

// ── Factory ─────────────────────────────────────────────────

/**
 * Create an encryption adapter from a hex-encoded 256-bit key.
 *
 * @param keyHex 64-character hex string (32 bytes = 256 bits)
 * @returns EncryptionAdapter or null if key is invalid/missing
 */
export async function createEncryptionAdapter(keyHex: string | undefined): Promise<EncryptionAdapter | null> {
  if (!isValidKeyHex(keyHex)) {
    return null;
  }

  const keyBytes = hexToBytes(keyHex);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  return {
    async encrypt(plaintext: string): Promise<CiphertextEnvelope> {
      const iv = new Uint8Array(12);
      crypto.getRandomValues(iv);

      const encoded = new TextEncoder().encode(plaintext);
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        encoded,
      );

      return {
        alg: "AES-256-GCM",
        v: 1,
        iv: bytesToBase64(iv),
        ct: bytesToBase64(new Uint8Array(ciphertext)),
      };
    },
  };
}

// ── Workspace key hierarchy (SM2) ────────────────────────────

/** Wrap format for a DEK at rest (config.secret_deks.wrapped_dek, JSON in BYTEA). */
interface WrappedDekDocument {
  v: 1;
  iv: string;
  ct: string;
}

/** The DEK storage surface the key hierarchy needs (a SecretDekRepository subset). */
export type WorkspaceDekStore = Pick<SecretDekRepository, "getActiveDek" | "insertDek">;

/**
 * Import the KEK (SECRET_KEK). `encrypt` wraps a new DEK, `decrypt` unwraps
 * stored ones — the KEK never touches secret plaintext directly.
 */
export async function importKek(kekHex: string | undefined): Promise<CryptoKey | null> {
  if (!isValidKeyHex(kekHex)) {
    return null;
  }
  return crypto.subtle.importKey(
    "raw",
    hexToBytes(kekHex).buffer as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Wrap DEK bytes under the KEK into the stored JSON document. */
export async function wrapDek(kek: CryptoKey, dekBytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, dekBytes);
  const doc: WrappedDekDocument = { v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
  return JSON.stringify(doc);
}

/** Unwrap a stored DEK document under the KEK back to raw DEK bytes (in memory only). */
export async function unwrapDek(kek: CryptoKey, wrappedDek: string): Promise<Uint8Array<ArrayBuffer>> {
  let doc: WrappedDekDocument;
  try {
    doc = JSON.parse(wrappedDek) as WrappedDekDocument;
  } catch {
    throw new Error("Malformed wrapped-DEK document");
  }
  if (doc.v !== 1 || typeof doc.iv !== "string" || typeof doc.ct !== "string") {
    throw new Error("Unsupported wrapped-DEK format");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(doc.iv) },
    kek,
    base64ToBytes(doc.ct),
  );
  return new Uint8Array(plaintext);
}

/**
 * Get-or-create the workspace's active DEK (SM2): SELECT the active
 * generation; when none exists, generate 32 random bytes, wrap them under the
 * KEK, INSERT with ON CONFLICT DO NOTHING, and re-SELECT — so two concurrent
 * first writers converge on one stored row (the loser adopts the winner's DEK).
 * The unwrapped bytes exist only in memory for the caller's operation.
 */
export async function getOrCreateActiveDek(
  store: WorkspaceDekStore,
  kek: CryptoKey,
  orgId: string,
): Promise<{ generation: number; dekBytes: Uint8Array }> {
  const existing = await store.getActiveDek(orgId);
  if (existing.ok) {
    return { generation: existing.value.generation, dekBytes: await unwrapDek(kek, existing.value.wrappedDek) };
  }
  if (existing.error.kind !== "not_found") {
    throw new Error("DEK lookup failed");
  }

  const dekBytes = new Uint8Array(32);
  crypto.getRandomValues(dekBytes);
  const insertResult = await store.insertDek(orgId, 1, await wrapDek(kek, dekBytes));
  if (!insertResult.ok) {
    throw new Error("DEK insert failed");
  }
  // Re-SELECT regardless of who won the insert race — the stored row is the
  // single source of truth for the generation and wrapped bytes.
  const winner = await store.getActiveDek(orgId);
  if (!winner.ok) {
    throw new Error("DEK lookup failed after insert");
  }
  return { generation: winner.value.generation, dekBytes: await unwrapDek(kek, winner.value.wrappedDek) };
}

async function withDbDekStore<T>(
  db: Hyperdrive | undefined,
  fn: (store: WorkspaceDekStore) => Promise<T>,
): Promise<T> {
  if (!db) {
    throw new Error("DEK store unavailable");
  }
  const executor = createSqlExecutor(db);
  try {
    return await fn(createSecretDekRepository(executor));
  } finally {
    await executor.dispose();
  }
}

/**
 * Per-request encryption adapter for the secret write paths (create/rotate/
 * import), bound to the request's workspace. With SECRET_KEK configured every
 * encrypt goes under the workspace's active DEK and emits a v:2 envelope;
 * otherwise this is exactly the shipped v:1 static-key adapter (no behavior
 * change for un-seeded environments). The DEK is resolved lazily on the first
 * encrypt — i.e. after the handler's authorization gate, so unauthorized
 * requests never mint DEK rows — and cached for the rest of the request.
 */
export async function createSecretEncryptionAdapter(
  env: { SECRET_KEK?: string; SECRET_ENCRYPTION_KEY?: string; PLATFORM_DB?: Hyperdrive },
  orgId: string,
  dekStore?: WorkspaceDekStore,
): Promise<EncryptionAdapter | null> {
  const kek = await importKek(env.SECRET_KEK);
  if (!kek) {
    return createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
  }

  let dekKeyPromise: Promise<{ generation: number; key: CryptoKey }> | null = null;
  const resolveDekKey = (): Promise<{ generation: number; key: CryptoKey }> =>
    (dekKeyPromise ??= (async () => {
      const { generation, dekBytes } = dekStore
        ? await getOrCreateActiveDek(dekStore, kek, orgId)
        : await withDbDekStore(env.PLATFORM_DB, (store) => getOrCreateActiveDek(store, kek, orgId));
      const key = await crypto.subtle.importKey(
        "raw",
        dekBytes.buffer as ArrayBuffer,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"],
      );
      return { generation, key };
    })());

  return {
    async encrypt(plaintext: string): Promise<CiphertextEnvelope> {
      const { generation, key } = await resolveDekKey();
      const iv = new Uint8Array(12);
      crypto.getRandomValues(iv);
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(plaintext),
      );
      return {
        alg: "AES-256-GCM",
        v: 2,
        keyId: `ws:${orgId}:${generation}`,
        iv: bytesToBase64(iv),
        ct: bytesToBase64(new Uint8Array(ciphertext)),
      };
    },
  };
}
