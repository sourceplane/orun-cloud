// PKCE (RFC 7636) helpers for the MCP3 OAuth 2.1 endpoints. S256 only —
// `plain` is rejected at the authorize step (design §3, MCP3: S256 mandatory).

/** base64url(SHA-256(ascii)) — the S256 code-challenge transform (§4.2). */
export async function computeS256Challenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const bytes = new Uint8Array(digest);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 §4.1: 43–128 chars of [A-Z a-z 0-9 - . _ ~]. */
export function isValidCodeVerifier(codeVerifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier);
}

/** An S256 challenge is base64url(SHA-256(...)) — always exactly 43 chars. */
export function isValidS256Challenge(codeChallenge: string): boolean {
  return /^[A-Za-z0-9\-_]{43}$/.test(codeChallenge);
}

/** Constant-time compare (both inputs are fixed-shape challenge strings). */
export function challengeMatches(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return mismatch === 0;
}
