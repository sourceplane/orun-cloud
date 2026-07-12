// IH0: the capability-typed provider seam + dormant adapters.
// - registry: per-provider configuration gates (park-and-continue), unknown
//   ids stay null, GitHub behavior unchanged.
// - slack: OAuth authorize URL + v0 signature verification (±300s window).
// - cloudflare/supabase: template catalogs published; mint parks typed.

import { webcrypto } from "node:crypto";
import { getConfiguredProvider, KNOWN_PROVIDER_IDS } from "@integrations-worker/providers/registry";
import {
  buildSlackAuthorizeUrl,
  exchangeSlackOauthCode,
  revokeSlackToken,
  SLACK_BOT_SCOPES,
  verifySlackSignature,
} from "@integrations-worker/providers/slack";
import { CLOUDFLARE_SCOPE_TEMPLATES } from "@integrations-worker/providers/cloudflare";
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
  it("knows all four provider ids", () => {
    expect([...KNOWN_PROVIDER_IDS]).toEqual(["github", "slack", "cloudflare", "supabase"]);
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

  it("mints park with a typed reason — never a throw (IH5/IH6 fill them in)", async () => {
    const cf = getConfiguredProvider(
      { ...GITHUB_ENV, SECRET_ENCRYPTION_KEY: "0".repeat(64) } as Env,
      "cloudflare",
    )!.provider;
    await expect(
      cf.broker!.mintCredential({ template: "workers-deploy", params: {}, ttlSeconds: 900, nowMs: NOW }),
    ).resolves.toEqual({ ok: false, reason: "not_implemented", detail: expect.any(String) });
    await expect(
      cf.broker!.mintCredential({ template: "nope", params: {}, ttlSeconds: 900, nowMs: NOW }),
    ).resolves.toEqual({ ok: false, reason: "template_unknown" });
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
