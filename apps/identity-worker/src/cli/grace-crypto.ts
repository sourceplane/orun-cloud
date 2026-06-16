// Reuse-grace ciphertext (saas-orun-platform OP1 hardening, risk R11).
//
// During a rotating-refresh rotation, the successor refresh token is stamped on
// the predecessor session row so a benign replay within the grace window can be
// re-issued the SAME successor idempotently (see services/cli-auth.ts). That
// successor is the one secret we must be able to RETURN later, so it is stored
// recoverably — but encrypted at rest with AES-256-GCM: the key is derived
// (HKDF-SHA256, domain-separated) from the worker-held OAUTH_STATE_SECRET and is
// never stored in the database, so a DB dump alone cannot read it. The envelope
// is a small JSON {alg,v,iv,ct} blob.
//
// Soft-fail by design: if no key material is configured the helpers return null
// so the caller cleanly disables grace (revoke-on-reuse as before) — never a
// hard dependency that could break a deploy.

import type { Env } from "../env.js";

interface GraceEnvelope {
  alg: "AES-256-GCM";
  v: 1;
  iv: string; // base64 12-byte nonce
  ct: string; // base64 ciphertext (includes the GCM auth tag)
}

const GRACE_KEY_INFO = "orun-cli-refresh-grace-v1";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// Derive the AES-256-GCM grace key from the worker's OAUTH_STATE_SECRET via
// HKDF with a domain-separation label, so the grace key is independent of the
// secret's other uses (OAuth state HMAC). Returns null when no secret is set.
async function deriveGraceKey(env: Env): Promise<CryptoKey | null> {
  const secret = env.OAUTH_STATE_SECRET;
  if (!secret || secret.trim().length === 0) return null;
  const ikm = await crypto.subtle.importKey("raw", textEncoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: textEncoder.encode(GRACE_KEY_INFO) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a successor refresh token into a JSON envelope. Returns null when
 * grace is unconfigured (the caller stores null → grace disabled for that
 * rotation, i.e. revoke-on-reuse as before).
 */
export async function encryptGraceSuccessor(env: Env, plaintext: string): Promise<string | null> {
  const key = await deriveGraceKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textEncoder.encode(plaintext));
  const envelope: GraceEnvelope = {
    alg: "AES-256-GCM",
    v: 1,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuf)),
  };
  return JSON.stringify(envelope);
}

/**
 * Decrypt a stored envelope back to the successor refresh token. Returns null on
 * ANY failure (no key, malformed, tampered, wrong key) so the caller falls back
 * to the safe path (revoke-on-reuse) rather than trusting bad input.
 */
export async function decryptGraceSuccessor(env: Env, stored: string): Promise<string | null> {
  try {
    const key = await deriveGraceKey(env);
    if (!key) return null;
    const envelope = JSON.parse(stored) as GraceEnvelope;
    if (envelope.alg !== "AES-256-GCM" || envelope.v !== 1) return null;
    const ptBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
      key,
      base64ToBytes(envelope.ct),
    );
    return textDecoder.decode(ptBuf);
  } catch {
    return null;
  }
}
