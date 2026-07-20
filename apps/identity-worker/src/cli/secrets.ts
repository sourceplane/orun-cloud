// CLI auth secret + id generation (saas-orun-platform OP1).
//
// All grant/refresh secrets are minted here and hashed at rest (SHA-256, see
// `crypto.ts`). The raw value is returned to the caller exactly once; only the
// hash is stored — mirroring the `sk_` api-key discipline.

import { hexToUuid, uuidToHex } from "@saas/db/ids";

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) hex += buf[i]!.toString(16).padStart(2, "0");
  return hex;
}

/** Opaque loopback redeem code: `oclc_<64 hex>`. */
export function generateCliCode(): string {
  return `oclc_${randomHex(32)}`;
}

/** Opaque device-flow machine code: `ocdc_<64 hex>`. */
export function generateDeviceCode(): string {
  return `ocdc_${randomHex(32)}`;
}

/** Opaque rotating refresh token: `ocrt_<64 hex>`. */
export function generateRefreshToken(): string {
  return `ocrt_${randomHex(32)}`;
}

/** Opaque OAuth 2.1 authorization code (MCP3): `ocac_<64 hex>`. Single-use,
 *  short-TTL, hashed at rest like the loopback cli_code it rides beside. */
export function generateOAuthAuthorizationCode(): string {
  return `ocac_${randomHex(32)}`;
}

/** Dynamically-registered OAuth client id (MCP11 leg B, RFC 7591):
 *  `dcr_<32 hex>`. NOT a secret — it is the public client identifier; the
 *  `dcr_` namespace guarantees it can never collide with (or shadow) a static
 *  allow-list clientId. */
export function generateOAuthDynamicClientId(): string {
  return `dcr_${randomHex(16)}`;
}

/** Internal opaque session-correlation secret hashed into sessions.token_hash
 *  (parity with web sessions; the CLI never sees this — it uses access+refresh). */
export function generateSessionTokenSecret(): string {
  return randomHex(32);
}

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789"; // no vowels/ambiguous chars
/** Human-entered device user code: e.g. `BCDF-GHJK` (RFC-8628 §6.1 shape). */
export function generateUserCode(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += USER_CODE_ALPHABET[buf[i]! % USER_CODE_ALPHABET.length];
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Normalize a user-entered device code (uppercase, strip spaces/dashes) before
 *  hashing — humans type it inconsistently. */
export function normalizeUserCode(raw: string): string {
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== 8) return compact; // hash mismatch will reject
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

// --- Public id encode/parse for CLI grants + sessions ---

export function cliGrantPublicId(uuid: string): string {
  return `oclg_${uuidToHex(uuid)}`;
}

export function parseCliGrantPublicId(publicId: string): string | null {
  if (!publicId.startsWith("oclg_")) return null;
  return hexToUuid(publicId.slice(5));
}

export function cliSessionPublicId(uuid: string): string {
  return `clises_${uuidToHex(uuid)}`;
}

export function parseCliSessionPublicId(publicId: string): string | null {
  if (!publicId.startsWith("clises_")) return null;
  return hexToUuid(publicId.slice(7));
}
