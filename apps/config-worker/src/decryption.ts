/**
 * Decrypt path for stored secret envelopes (saas-secret-manager SM2).
 *
 * DORMANT: nothing in src/handlers or the router imports this module — it is
 * wired into the lease-verified internal resolve in SM3, preserving the
 * leak-prevention ordering (no decrypt path exists before the resolve that
 * uses it). Until then it is exercised only by unit tests; a guard test in
 * tests/config-worker asserts the non-import invariant.
 *
 * Supports both envelope formats:
 *   v:1 — decrypts under the static SECRET_ENCRYPTION_KEY (the implicit `k0`),
 *         imported here with usage ["decrypt"] only.
 *   v:2 — unwraps the workspace DEK generation named by `keyId`
 *         ("ws:<org-uuid>:<generation>") under the KEK, then decrypts.
 *
 * Key material and plaintext never appear in errors or logs.
 */

import type { CiphertextEnvelope } from "./encryption.js";
import { base64ToBytes, hexToBytes, importKek, isValidKeyHex, unwrapDek } from "./encryption.js";

const KEY_ID_RE = /^ws:([0-9a-fA-F-]{36}):([1-9][0-9]*)$/;

export interface DecryptEnvelopeDeps {
  /** SECRET_ENCRYPTION_KEY (64-hex) — decrypts v:1 envelopes. */
  staticKeyHex?: string;
  /** SECRET_KEK (64-hex) — unwraps the workspace DEK a v:2 keyId names. */
  kekHex?: string;
  /** Wrapped-DEK document lookup by (orgId, generation); null when unknown. */
  getWrappedDek?(orgId: string, generation: number): Promise<string | null>;
}

function parseEnvelope(raw: Uint8Array | string): CiphertextEnvelope {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Malformed ciphertext envelope");
  }
  const env = parsed as Partial<CiphertextEnvelope>;
  if (
    !env ||
    env.alg !== "AES-256-GCM" ||
    (env.v !== 1 && env.v !== 2) ||
    typeof env.iv !== "string" ||
    typeof env.ct !== "string"
  ) {
    throw new Error("Unsupported ciphertext envelope");
  }
  return env as CiphertextEnvelope;
}

async function importDecryptKey(keyBytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

async function gcmDecrypt(key: CryptoKey, ivB64: string, ctB64: string): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ctB64),
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Decrypt a stored envelope (raw BYTEA bytes or the JSON text) back to the
 * secret plaintext. Throws on any malformed envelope, missing key, unknown DEK
 * generation, or authentication failure — messages carry no key material.
 */
export async function decryptEnvelope(raw: Uint8Array | string, deps: DecryptEnvelopeDeps): Promise<string> {
  const envelope = parseEnvelope(raw);

  if (envelope.v === 1) {
    if (!isValidKeyHex(deps.staticKeyHex)) {
      throw new Error("Static decryption key is not configured");
    }
    const key = await importDecryptKey(hexToBytes(deps.staticKeyHex));
    return gcmDecrypt(key, envelope.iv, envelope.ct);
  }

  const kek = await importKek(deps.kekHex);
  if (!kek) {
    throw new Error("KEK is not configured");
  }
  const match = typeof envelope.keyId === "string" ? KEY_ID_RE.exec(envelope.keyId) : null;
  if (!match) {
    throw new Error("Unsupported envelope keyId");
  }
  if (!deps.getWrappedDek) {
    throw new Error("DEK lookup is not configured");
  }
  const wrappedDek = await deps.getWrappedDek(match[1]!, Number(match[2]!));
  if (wrappedDek === null) {
    throw new Error("Unknown DEK generation");
  }
  const dekBytes = await unwrapDek(kek, wrappedDek);
  const dek = await importDecryptKey(dekBytes);
  return gcmDecrypt(dek, envelope.iv, envelope.ct);
}
