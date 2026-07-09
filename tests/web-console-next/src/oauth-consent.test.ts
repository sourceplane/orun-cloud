// Console OAuth consent-page logic (saas-mcp-server MCP3) — the pure module
// behind /oauth/authorize: authorize-request parsing against the vetted
// client allow-list, redirect building (approve/deny), and the sessions-list
// client label for MCP grants.

import {
  parseAuthorizeRequest,
  buildApproveRedirect,
  buildDenyRedirect,
  sessionClientLabel,
} from "@web-console-next/lib/oauth-consent";

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function params(overrides: Record<string, string | undefined> = {}): URLSearchParams {
  const base: Record<string, string | undefined> = {
    client_id: "claude-web",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    response_type: "code",
    state: "xyz",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    ...overrides,
  };
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) sp.set(k, v);
  }
  return sp;
}

describe("parseAuthorizeRequest", () => {
  it("accepts a standard authorize request for a vetted client", () => {
    const r = parseAuthorizeRequest(params());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.client.name).toBe("Claude");
    expect(r.params.clientId).toBe("claude-web");
    expect(r.params.state).toBe("xyz");
    expect(r.params.codeChallengeMethod).toBe("S256");
    expect(r.params.scope).toBeNull();
  });

  it("rejects an unknown client_id (never redirects)", () => {
    const r = parseAuthorizeRequest(params({ client_id: "evil" }));
    expect(r.ok).toBe(false);
  });

  it("rejects a redirect_uri that is not registered for the client (never redirects)", () => {
    const r = parseAuthorizeRequest(params({ redirect_uri: "https://evil.example/cb" }));
    expect(r.ok).toBe(false);
  });

  it("accepts loopback redirects on any port for loopback-registered clients", () => {
    const r = parseAuthorizeRequest(
      params({ client_id: "orun-cloud-dev", redirect_uri: "http://127.0.0.1:61234/callback" }),
    );
    expect(r.ok).toBe(true);
  });

  it("requires PKCE S256 (plain and missing are rejected)", () => {
    expect(parseAuthorizeRequest(params({ code_challenge_method: "plain" })).ok).toBe(false);
    expect(parseAuthorizeRequest(params({ code_challenge_method: undefined })).ok).toBe(false);
    expect(parseAuthorizeRequest(params({ code_challenge: "short" })).ok).toBe(false);
  });

  it("rejects non-code response types and a missing params object", () => {
    expect(parseAuthorizeRequest(params({ response_type: "token" })).ok).toBe(false);
    expect(parseAuthorizeRequest(null).ok).toBe(false);
  });
});

describe("redirect builders", () => {
  it("approve appends code + state to the redirect_uri", () => {
    const url = new URL(buildApproveRedirect("http://127.0.0.1:5000/callback", "ocac_abc", "xyz"));
    expect(url.origin + url.pathname).toBe("http://127.0.0.1:5000/callback");
    expect(url.searchParams.get("code")).toBe("ocac_abc");
    expect(url.searchParams.get("state")).toBe("xyz");
  });

  it("approve omits state when the client sent none", () => {
    const url = new URL(buildApproveRedirect("https://claude.ai/api/mcp/auth_callback", "ocac_abc", null));
    expect(url.searchParams.has("state")).toBe(false);
  });

  it("deny redirects with error=access_denied and the echoed state", () => {
    const url = new URL(buildDenyRedirect("https://claude.ai/api/mcp/auth_callback", "xyz"));
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(url.searchParams.has("code")).toBe(false);
  });
});

describe("sessionClientLabel", () => {
  it("labels mcp:<clientId> sessions with the vetted client name", () => {
    expect(sessionClientLabel("mcp:claude-web")).toEqual({ label: "Claude", kind: "mcp" });
    expect(sessionClientLabel("mcp:cursor")).toEqual({ label: "Cursor", kind: "mcp" });
  });

  it("falls back to the raw client id for unrecognized mcp labels", () => {
    expect(sessionClientLabel("mcp:someday-client")).toEqual({ label: "someday-client", kind: "mcp" });
  });

  it("keeps CLI sessions on the host label", () => {
    expect(sessionClientLabel("macbook-pro")).toEqual({ label: "macbook-pro", kind: "cli" });
    expect(sessionClientLabel(null)).toEqual({ label: "Unknown device", kind: "cli" });
  });
});
