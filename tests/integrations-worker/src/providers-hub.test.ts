// IH0: the capability-typed provider seam + dormant adapters.
// - registry: per-provider configuration gates (park-and-continue), unknown
//   ids stay null, GitHub behavior unchanged.
// - slack: OAuth authorize URL + v0 signature verification (±300s window).
// - cloudflare/supabase: template catalogs published; mint refusals typed
//   (both adapters live since IH5/IH6 — a call without parent custody is a
//   typed provider_error, never a throw).

import { webcrypto } from "node:crypto";
import { getConfiguredProvider, KNOWN_PROVIDER_IDS } from "@integrations-worker/providers/registry";
import {
  buildSlackAuthorizeUrl,
  exchangeSlackOauthCode,
  revokeSlackToken,
  SLACK_BOT_SCOPES,
  verifySlackSignature,
} from "@integrations-worker/providers/slack";
import {
  CLOUDFLARE_SCOPE_TEMPLATES,
  getCloudflareTokenPolicies,
  listCloudflareAccountTokens,
} from "@integrations-worker/providers/cloudflare";
import { SUPABASE_SCOPE_TEMPLATES } from "@integrations-worker/providers/supabase";
import { getCapability } from "@integrations-worker/providers/types";
import type { Env } from "@integrations-worker/env";

const GITHUB_ENV: Env = {
  ENVIRONMENT: "test",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_SLUG: "test-app",
  GITHUB_APP_PRIVATE_KEY: "pem",
  GITHUB_APP_WEBHOOK_SECRET: "wh-secret",
} as Env;

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const NOW = 1_750_000_000_000;

async function slackSign(body: string, timestamp: string, secret: string): Promise<string> {
  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await webcrypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return `v0=${hex}`;
}

function bodyBuffer(body: string): ArrayBuffer {
  return new TextEncoder().encode(body).buffer as ArrayBuffer;
}

describe("provider registry (IH0)", () => {
  it("knows all eight provider ids (incl. the IR5 apikey family)", () => {
    expect([...KNOWN_PROVIDER_IDS]).toEqual([
      "github",
      "slack",
      "cloudflare",
      "supabase",
      "anthropic",
      "openai",
      "openrouter",
      "daytona",
    ]);
  });

  it("returns null for an unknown provider id", () => {
    expect(getConfiguredProvider(GITHUB_ENV, "gitlab")).toBeNull();
  });

  it("keeps GitHub behavior: configured with the four App secrets", () => {
    const configured = getConfiguredProvider(GITHUB_ENV, "github");
    expect(configured).not.toBeNull();
    expect(configured!.provider.connectKind).toBe("install");
    expect(configured!.provider.capabilities).toContain("inbound");
    expect(configured!.provider.buildInstallUrl!({ state: "s1" })).toBe(
      "https://github.com/apps/test-app/installations/new?state=s1",
    );
  });

  it("parks slack until the App secrets exist (D1)", () => {
    expect(getConfiguredProvider(GITHUB_ENV, "slack")).toBeNull();
    const configured = getConfiguredProvider(
      {
        ...GITHUB_ENV,
        SLACK_APP_CLIENT_ID: "cid",
        SLACK_APP_CLIENT_SECRET: "cs",
        SLACK_APP_SIGNING_SECRET: SIGNING_SECRET,
      } as Env,
      "slack",
    );
    expect(configured).not.toBeNull();
    expect(configured!.provider.connectKind).toBe("oauth");
    expect(configured!.provider.inbound).toBeDefined();
    expect(configured!.provider.broker).toBeUndefined();
  });

  it("parks supabase until the OAuth app secrets exist (D4)", () => {
    expect(getConfiguredProvider(GITHUB_ENV, "supabase")).toBeNull();
    const configured = getConfiguredProvider(
      {
        ...GITHUB_ENV,
        SUPABASE_OAUTH_CLIENT_ID: "cid",
        SUPABASE_OAUTH_CLIENT_SECRET: "cs",
      } as Env,
      "supabase",
    );
    expect(configured).not.toBeNull();
    expect(configured!.provider.capabilities).toContain("credential-broker");
  });

  it("parks cloudflare until custody (SECRET_ENCRYPTION_KEY) exists", () => {
    expect(getConfiguredProvider(GITHUB_ENV, "cloudflare")).toBeNull();
    const configured = getConfiguredProvider(
      { ...GITHUB_ENV, SECRET_ENCRYPTION_KEY: "0".repeat(64) } as Env,
      "cloudflare",
    );
    expect(configured).not.toBeNull();
    expect(configured!.provider.connectKind).toBe("token");
  });

  it("narrows capabilities with a null miss, never a throw", () => {
    const cf = getConfiguredProvider(
      { ...GITHUB_ENV, SECRET_ENCRYPTION_KEY: "0".repeat(64) } as Env,
      "cloudflare",
    )!.provider;
    expect(getCapability(cf, "broker")).not.toBeNull();
    expect(getCapability(cf, "inbound")).toBeNull();
    expect(getCapability(cf, "messaging")).toBeNull();
  });
});

describe("github adapter re-expression (IH0)", () => {
  it("verifies via the inbound capability and the legacy alias identically", async () => {
    const provider = getConfiguredProvider(GITHUB_ENV, "github")!.provider;
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const key = await webcrypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("wh-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const bytes = new Uint8Array(sig);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
    const header = `sha256=${hex}`;

    await expect(
      provider.inbound!.verifySignature(
        bodyBuffer(body),
        { "x-hub-signature-256": header },
        NOW,
      ),
    ).resolves.toBe(true);
    await expect(provider.verifyInboundSignature!(bodyBuffer(body), header)).resolves.toBe(true);
    await expect(
      provider.verifyInboundSignature!(bodyBuffer(body), `sha256=${"0".repeat(64)}`),
    ).resolves.toBe(false);
  });
});

describe("slack adapter (IH0 dormant)", () => {
  it("builds the OAuth v2 authorize URL with the D2 scope set + signed state", () => {
    const url = new URL(
      buildSlackAuthorizeUrl({
        clientId: "123.456",
        state: "signed-state",
        redirectUri: "https://edge.example/ingress/slack/oauth",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("123.456");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("scope")).toBe(SLACK_BOT_SCOPES.join(","));
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://edge.example/ingress/slack/oauth",
    );
  });

  it("does not request write-anywhere or history scopes (D2)", () => {
    expect(SLACK_BOT_SCOPES).not.toContain("chat:write.public");
    expect(SLACK_BOT_SCOPES).not.toContain("users:read");
    expect(SLACK_BOT_SCOPES.some((s) => s.includes("history"))).toBe(false);
  });

  it("accepts a valid v0 signature inside the window", async () => {
    const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
    const ts = String(Math.floor(NOW / 1000) - 10);
    const sig = await slackSign(body, ts, SIGNING_SECRET);
    await expect(
      verifySlackSignature(SIGNING_SECRET, bodyBuffer(body), sig, ts, NOW),
    ).resolves.toBe(true);
  });

  it("rejects a stale timestamp (replay defense, ±300s)", async () => {
    const body = "{}";
    const ts = String(Math.floor(NOW / 1000) - 301);
    const sig = await slackSign(body, ts, SIGNING_SECRET);
    await expect(
      verifySlackSignature(SIGNING_SECRET, bodyBuffer(body), sig, ts, NOW),
    ).resolves.toBe(false);
  });

  it("rejects a tampered body, a wrong secret, and malformed headers", async () => {
    const body = "{}";
    const ts = String(Math.floor(NOW / 1000));
    const sig = await slackSign(body, ts, SIGNING_SECRET);
    await expect(
      verifySlackSignature(SIGNING_SECRET, bodyBuffer("{ }"), sig, ts, NOW),
    ).resolves.toBe(false);
    await expect(
      verifySlackSignature("other-secret", bodyBuffer(body), sig, ts, NOW),
    ).resolves.toBe(false);
    await expect(
      verifySlackSignature(SIGNING_SECRET, bodyBuffer(body), null, ts, NOW),
    ).resolves.toBe(false);
    await expect(
      verifySlackSignature(SIGNING_SECRET, bodyBuffer(body), sig, null, NOW),
    ).resolves.toBe(false);
    await expect(
      verifySlackSignature(SIGNING_SECRET, bodyBuffer(body), "v1=abc", ts, NOW),
    ).resolves.toBe(false);
  });
});

describe("credential-broker adapters (IH0 dormant)", () => {
  it("cloudflare publishes the v1 template catalog", () => {
    const ids = CLOUDFLARE_SCOPE_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual([
      "workers-deploy",
      "pages-deploy",
      "dns-edit",
      "r2-data",
      "account-read",
    ]);
    for (const t of CLOUDFLARE_SCOPE_TEMPLATES) {
      expect(t.provider).toBe("cloudflare");
      expect(t.maxTtlSeconds).toBeLessThanOrEqual(3600);
    }
  });

  it("supabase publishes the v1 template catalog with honest param needs", () => {
    const byId = new Map(SUPABASE_SCOPE_TEMPLATES.map((t) => [t.id, t]));
    expect(byId.get("db-migrate")!.params).toContain("projectRef");
    expect(byId.get("functions-deploy")!.params).toContain("projectRef");
    expect(byId.get("management-access")!.params).toHaveLength(0);
  });

  it("mints stay typed — never a throw (cloudflare live since IH5)", async () => {
    const cf = getConfiguredProvider(
      { ...GITHUB_ENV, SECRET_ENCRYPTION_KEY: "0".repeat(64) } as Env,
      "cloudflare",
    )!.provider;
    // Live adapter, but no parent custody handed in — typed refusal.
    await expect(
      cf.broker!.mintCredential({ template: "workers-deploy", params: {}, ttlSeconds: 900, nowMs: NOW }),
    ).resolves.toEqual({ ok: false, reason: "provider_error", detail: expect.any(String) });
    await expect(
      cf.broker!.mintCredential({ template: "nope", params: {}, ttlSeconds: 900, nowMs: NOW }),
    ).resolves.toEqual({ ok: false, reason: "template_unknown" });
  });

  it("supabase mints stay typed — never a throw (live since IH6)", async () => {
    const sb = getConfiguredProvider(
      {
        ...GITHUB_ENV,
        SUPABASE_OAUTH_CLIENT_ID: "cid",
        SUPABASE_OAUTH_CLIENT_SECRET: "cs",
      } as Env,
      "supabase",
    )!.provider;
    // Live adapter, but no parent custody handed in — typed refusal.
    await expect(
      sb.broker!.mintCredential({ template: "management-access", params: {}, ttlSeconds: 900, nowMs: NOW }),
    ).resolves.toEqual({ ok: false, reason: "provider_error", detail: expect.any(String) });
    await expect(
      sb.broker!.mintCredential({ template: "nope", params: {}, ttlSeconds: 900, nowMs: NOW }),
    ).resolves.toEqual({ ok: false, reason: "template_unknown" });
  });
});

// ── Cloudflare sweep support (IH9) ──────────────────────────

describe("cloudflare sweep support (IH9)", () => {
  const PARENT = { credential: "cf-parent-token", externalRef: "acct-1" };

  function tokenRow(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "tok-1",
      name: "orun/org_abc/workers-deploy/mint_1",
      status: "active",
      expires_on: "2026-07-12T11:00:00Z",
      ...overrides,
    };
  }

  it("lists account tokens across pages, mapping name and expiresOn", async () => {
    const urls: string[] = [];
    const auths: Array<string | null> = [];
    const tokens = await listCloudflareAccountTokens(PARENT, (url, init) => {
      urls.push(url);
      auths.push(new Headers(init?.headers).get("authorization"));
      const page = new URL(url).searchParams.get("page");
      const body =
        page === "1"
          ? {
              success: true,
              result: [tokenRow()],
              result_info: { page: 1, total_pages: 2 },
            }
          : {
              success: true,
              result: [tokenRow({ id: "tok-2", name: "customer-token", expires_on: null })],
              result_info: { page: 2, total_pages: 2 },
            };
      return Promise.resolve(Response.json(body));
    });
    expect(tokens).toEqual([
      {
        id: "tok-1",
        name: "orun/org_abc/workers-deploy/mint_1",
        status: "active",
        expiresOn: "2026-07-12T11:00:00Z",
      },
      { id: "tok-2", name: "customer-token", status: "active", expiresOn: null },
    ]);
    expect(urls).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/acct-1/tokens?page=1&per_page=50",
      "https://api.cloudflare.com/client/v4/accounts/acct-1/tokens?page=2&per_page=50",
    ]);
    expect(auths).toEqual(["Bearer cf-parent-token", "Bearer cf-parent-token"]);
  });

  it("stops after one page when result_info says so", async () => {
    let calls = 0;
    const tokens = await listCloudflareAccountTokens(PARENT, () => {
      calls += 1;
      return Promise.resolve(
        Response.json({ success: true, result: [tokenRow()], result_info: { total_pages: 1 } }),
      );
    });
    expect(tokens).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("returns null on API failure, success:false, transport error, or no account anchor", async () => {
    await expect(
      listCloudflareAccountTokens(PARENT, () =>
        Promise.resolve(new Response("nope", { status: 403 })),
      ),
    ).resolves.toBeNull();
    await expect(
      listCloudflareAccountTokens(PARENT, () =>
        Promise.resolve(Response.json({ success: false, errors: [{ message: "denied" }] })),
      ),
    ).resolves.toBeNull();
    await expect(
      listCloudflareAccountTokens(PARENT, () => Promise.reject(new Error("boom"))),
    ).resolves.toBeNull();
    await expect(
      listCloudflareAccountTokens({ credential: "cf-parent-token", externalRef: null }, () =>
        Promise.resolve(Response.json({ success: true, result: [] })),
      ),
    ).resolves.toBeNull();
  });

  it("reads the parent token's own policies for the health cron", async () => {
    let url = "";
    let auth: string | null = null;
    const policies = await getCloudflareTokenPolicies("cf-parent-token", "tok-id-1", (u, init) => {
      url = u;
      auth = new Headers(init?.headers).get("authorization");
      return Promise.resolve(
        Response.json({ success: true, result: { id: "tok-id-1", policies: [{ effect: "allow" }] } }),
      );
    });
    expect(policies).toEqual([{ effect: "allow" }]);
    expect(url).toBe("https://api.cloudflare.com/client/v4/user/tokens/tok-id-1");
    expect(auth).toBe("Bearer cf-parent-token");
  });

  it("policies read returns null when missing, non-array, refused, or unreachable", async () => {
    await expect(
      getCloudflareTokenPolicies("t", "id", () =>
        Promise.resolve(Response.json({ success: true, result: { id: "id" } })),
      ),
    ).resolves.toBeNull();
    await expect(
      getCloudflareTokenPolicies("t", "id", () =>
        Promise.resolve(Response.json({ success: true, result: { policies: "not-an-array" } })),
      ),
    ).resolves.toBeNull();
    await expect(
      getCloudflareTokenPolicies("t", "id", () =>
        Promise.resolve(new Response("nope", { status: 401 })),
      ),
    ).resolves.toBeNull();
    await expect(
      getCloudflareTokenPolicies("t", "id", () => Promise.reject(new Error("boom"))),
    ).resolves.toBeNull();
  });
});

// ── Slack OAuth exchange + revoke (IH1) ─────────────────────

describe("slack oauth.v2.access exchange (IH1)", () => {
  const CREDS = { clientId: "cid", clientSecret: "cs", signingSecret: SIGNING_SECRET };

  function accessResponse(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      ok: true,
      access_token: "xoxb-abc",
      token_type: "bot",
      scope: "chat:write,commands",
      bot_user_id: "U0B",
      app_id: "A0A",
      team: { id: "T0T", name: "Acme" },
      enterprise: { id: "E0E" },
      authed_user: { id: "U0U" },
      ...overrides,
    };
  }

  it("maps a verified grant: token, split scopes, team + enterprise facts", async () => {
    let sentBody = "";
    const grant = await exchangeSlackOauthCode(
      CREDS,
      { code: "c0de", redirectUri: "https://edge.test/ingress/slack/oauth" },
      (_url, init) => {
        sentBody = String(init?.body);
        return Promise.resolve(Response.json(accessResponse()));
      },
    );
    expect(grant).toEqual({
      accessToken: "xoxb-abc",
      grantedScopes: ["chat:write", "commands"],
      teamId: "T0T",
      teamName: "Acme",
      enterpriseId: "E0E",
      botUserId: "U0B",
      appId: "A0A",
      installedByExternalUser: "U0U",
    });
    // The exchange is form-encoded and carries the exact redirect_uri.
    expect(sentBody).toContain("code=c0de");
    expect(sentBody).toContain(encodeURIComponent("https://edge.test/ingress/slack/oauth"));
  });

  it("returns null on ok:false, a missing token/team, or a non-bot token", async () => {
    const cases = [
      { ok: false, error: "invalid_code" },
      accessResponse({ access_token: undefined }),
      accessResponse({ team: null }),
      accessResponse({ token_type: "user" }),
    ];
    for (const body of cases) {
      await expect(
        exchangeSlackOauthCode(CREDS, { code: "c", redirectUri: "https://e/x" }, () =>
          Promise.resolve(Response.json(body)),
        ),
      ).resolves.toBeNull();
    }
  });

  it("returns null on transport failure — never a throw", async () => {
    await expect(
      exchangeSlackOauthCode(CREDS, { code: "c", redirectUri: "https://e/x" }, () =>
        Promise.reject(new Error("boom")),
      ),
    ).resolves.toBeNull();
  });

  it("revokes with a bearer token and reports the provider's verdict", async () => {
    let auth: string | null = null;
    await expect(
      revokeSlackToken("xoxb-abc", (_url, init) => {
        auth = new Headers(init?.headers).get("authorization");
        return Promise.resolve(Response.json({ ok: true, revoked: true }));
      }),
    ).resolves.toBe(true);
    expect(auth).toBe("Bearer xoxb-abc");
    await expect(
      revokeSlackToken("xoxb-abc", () => Promise.resolve(Response.json({ ok: false }))),
    ).resolves.toBe(false);
  });
});
