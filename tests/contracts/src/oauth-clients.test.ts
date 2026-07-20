// MCP3 OAuth 2.1 public-client allow-list (risks D1, Option A — decided
// 2026-07-09): a static, code-reviewed table of vetted public clients, no open
// dynamic client registration. These tests pin the table's invariants and the
// RFC 8252 §7.3 loopback redirect matching both the identity-worker (enforce)
// and the console consent page (display) rely on.

import {
  OAUTH_PUBLIC_CLIENTS,
  OAUTH_DYNAMIC_CLIENT_ID_PREFIX,
  findOAuthPublicClient,
  oauthRedirectUriMatches,
  isOAuthRedirectUriAllowed,
  isOAuthDynamicClientId,
  isRegistrableDynamicRedirectUri,
} from "@saas/contracts/auth";

describe("OAUTH_PUBLIC_CLIENTS allow-list", () => {
  it("carries unique client ids and only public clients", () => {
    const ids = OAUTH_PUBLIC_CLIENTS.map((c) => c.clientId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of OAUTH_PUBLIC_CLIENTS) {
      expect(c.public).toBe(true);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.redirectUris.length).toBeGreaterThan(0);
    }
  });

  it("seeds the vetted clients: claude-code, claude-web, cursor, vscode, orun-cloud-dev", () => {
    const ids = OAUTH_PUBLIC_CLIENTS.map((c) => c.clientId);
    expect(ids).toEqual(
      expect.arrayContaining(["claude-code", "claude-web", "cursor", "vscode", "orun-cloud-dev"]),
    );
  });

  it("orun-cloud-dev is loopback-only (never a hosted redirect)", () => {
    const dev = findOAuthPublicClient("orun-cloud-dev")!;
    for (const uri of dev.redirectUris) {
      const parsed = new URL(uri);
      expect(parsed.protocol).toBe("http:");
      expect(["127.0.0.1", "localhost"]).toContain(parsed.hostname);
    }
  });

  it("findOAuthPublicClient returns null for unknown ids", () => {
    expect(findOAuthPublicClient("unknown-client")).toBeNull();
    expect(findOAuthPublicClient("")).toBeNull();
  });
});

describe("oauthRedirectUriMatches (RFC 8252 §7.3)", () => {
  it("matches exact URIs", () => {
    expect(
      oauthRedirectUriMatches(
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.ai/api/mcp/auth_callback",
      ),
    ).toBe(true);
  });

  it("ignores the port ONLY for loopback http URIs", () => {
    expect(oauthRedirectUriMatches("http://127.0.0.1/callback", "http://127.0.0.1:49152/callback")).toBe(true);
    expect(oauthRedirectUriMatches("http://localhost/callback", "http://localhost:3999/callback")).toBe(true);
    // Non-loopback hosts get NO port wildcard.
    expect(oauthRedirectUriMatches("https://claude.ai/cb", "https://claude.ai:8443/cb")).toBe(false);
    // https loopback is not the RFC 8252 native-app case either.
    expect(oauthRedirectUriMatches("https://127.0.0.1/callback", "https://127.0.0.1:5000/callback")).toBe(false);
  });

  it("still requires host + path (+ query) to match on loopback", () => {
    expect(oauthRedirectUriMatches("http://127.0.0.1/callback", "http://localhost:5000/callback")).toBe(false);
    expect(oauthRedirectUriMatches("http://127.0.0.1/callback", "http://127.0.0.1:5000/other")).toBe(false);
    expect(oauthRedirectUriMatches("http://127.0.0.1/callback?a=1", "http://127.0.0.1:5000/callback")).toBe(false);
  });

  it("rejects garbage URIs", () => {
    expect(oauthRedirectUriMatches("http://127.0.0.1/callback", "not a uri")).toBe(false);
  });
});

describe("dynamic client registration helpers (MCP11 leg B, D1 → Option B)", () => {
  it("no vetted static clientId ever lives in the dcr_ namespace (the shadowing guard)", () => {
    for (const c of OAUTH_PUBLIC_CLIENTS) {
      expect(isOAuthDynamicClientId(c.clientId)).toBe(false);
    }
    expect(isOAuthDynamicClientId(OAUTH_DYNAMIC_CLIENT_ID_PREFIX + "a".repeat(32))).toBe(true);
    expect(isOAuthDynamicClientId("claude-web")).toBe(false);
  });

  it("isRegistrableDynamicRedirectUri: https non-loopback OR http loopback only", () => {
    // Allowed.
    expect(isRegistrableDynamicRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isRegistrableDynamicRedirectUri("http://127.0.0.1/callback")).toBe(true);
    expect(isRegistrableDynamicRedirectUri("http://localhost:8080/cb")).toBe(true);
    // Rejected: http on a hosted domain, https on loopback, custom schemes,
    // fragments, garbage.
    expect(isRegistrableDynamicRedirectUri("http://evil.example/cb")).toBe(false);
    expect(isRegistrableDynamicRedirectUri("https://127.0.0.1/cb")).toBe(false);
    expect(isRegistrableDynamicRedirectUri("https://localhost/cb")).toBe(false);
    expect(isRegistrableDynamicRedirectUri("cursor://callback")).toBe(false);
    expect(isRegistrableDynamicRedirectUri("https://example.com/cb#frag")).toBe(false);
    expect(isRegistrableDynamicRedirectUri("not a uri")).toBe(false);
    expect(isRegistrableDynamicRedirectUri("")).toBe(false);
    expect(isRegistrableDynamicRedirectUri("https://example.com/" + "a".repeat(3000))).toBe(false);
  });
});

describe("isOAuthRedirectUriAllowed", () => {
  it("accepts registered URIs (incl. loopback any-port) and rejects everything else", () => {
    const claude = findOAuthPublicClient("claude-web")!;
    expect(isOAuthRedirectUriAllowed(claude, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isOAuthRedirectUriAllowed(claude, "https://attacker.example/api/mcp/auth_callback")).toBe(false);

    const dev = findOAuthPublicClient("orun-cloud-dev")!;
    expect(isOAuthRedirectUriAllowed(dev, "http://127.0.0.1:53123/callback")).toBe(true);
    expect(isOAuthRedirectUriAllowed(dev, "https://evil.example/callback")).toBe(false);
  });
});
