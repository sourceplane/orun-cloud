// PKCE S256 helpers (RFC 7636) for the Supabase OAuth connect flow (IH6).
//
// The code_verifier lives SERVER-SIDE between the authorize redirect and the
// callback — enveloped in custody as kind "supabase_pkce_verifier", bound to
// the pending connection, deleted the moment the exchange consumes it.
// Putting it in the signed state would hand it to every interceptor of the
// redirect, defeating PKCE (migration 810 rationale).

function bytesToBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * A fresh code_verifier: 32 random bytes → 43 base64url chars (RFC 7636
 * requires 43–128 chars from the unreserved set).
 */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64url(bytes);
}

/** S256 code_challenge: base64url(SHA-256(ascii(verifier))). */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64url(new Uint8Array(digest));
}
