// IH10 — the pluggability proof. The AWS (broker) and Discord (messaging)
// adapters implement the capability seam but stay dormant: no live path, the
// live registry never resolves them, and every capability call returns the
// typed "unavailable" signal callers already handle. This suite is the
// executable form of the milestone's "Done when: both adapters typecheck with
// zero handler/console changes" — if the seam ever needed a per-provider
// special case, one of these assertions would break.

import {
  DORMANT_PROVIDER_IDS,
  KNOWN_PROVIDER_IDS,
  getConfiguredProvider,
  getDormantProvider,
} from "@integrations-worker/providers/registry";
import { createAwsProvider, AWS_SCOPE_TEMPLATES } from "@integrations-worker/providers/aws";
import { createDiscordProvider } from "@integrations-worker/providers/discord";
import { getCapability } from "@integrations-worker/providers/types";
import type { Env } from "@integrations-worker/env";

// A fully-provisioned env: proves dormancy is about the REGISTRY, not missing
// secrets — even with every credential set, the live path never resolves them.
function fullyConfiguredEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    SECRET_ENCRYPTION_KEY: "ab".repeat(32),
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "s",
    GITHUB_APP_PRIVATE_KEY: "p",
    GITHUB_APP_WEBHOOK_SECRET: "w",
    SLACK_APP_CLIENT_ID: "c",
    SLACK_APP_CLIENT_SECRET: "s",
    SLACK_APP_SIGNING_SECRET: "sig",
    SUPABASE_OAUTH_CLIENT_ID: "c",
    SUPABASE_OAUTH_CLIENT_SECRET: "s",
  } as unknown as Env;
}

describe("dormant provider registry (IH10)", () => {
  it("keeps dormant ids OUT of the live/connectable set", () => {
    expect([...DORMANT_PROVIDER_IDS]).toEqual(["aws", "discord"]);
    for (const id of DORMANT_PROVIDER_IDS) {
      expect(KNOWN_PROVIDER_IDS).not.toContain(id);
    }
  });

  it("never resolves a dormant id to a configured (live) adapter, even fully provisioned", () => {
    const env = fullyConfiguredEnv();
    expect(getConfiguredProvider(env, "aws")).toBeNull();
    expect(getConfiguredProvider(env, "discord")).toBeNull();
  });

  it("instantiates each dormant adapter through the seam", () => {
    expect(getDormantProvider("aws")?.id).toBe("aws");
    expect(getDormantProvider("discord")?.id).toBe("discord");
    expect(getDormantProvider("nope")).toBeNull();
  });
});

describe("AWS dormant broker (IH10)", () => {
  const provider = createAwsProvider();

  it("declares the broker capability with connectKind token", () => {
    expect(provider.connectKind).toBe("token");
    // SP6: `secrets` joined the declaration — the dormant pluggability proof
    // (the secrets plane lights up from this file alone).
    expect(provider.capabilities).toEqual(["connect", "credential-broker", "secrets"]);
    expect(getCapability(provider, "broker")).not.toBeNull();
    expect(provider.secrets).toBeDefined();
    // It does NOT claim messaging.
    expect(getCapability(provider, "messaging")).toBeNull();
  });

  it("publishes STS-shaped templates whose provider is the reserved id", () => {
    const templates = provider.broker!.scopeTemplates();
    expect(templates).toBe(AWS_SCOPE_TEMPLATES);
    expect(templates.map((t) => t.id)).toEqual(["deploy-session", "readonly-session"]);
    for (const t of templates) {
      expect(t.provider).toBe("aws");
      expect(t.maxTtlSeconds).toBeLessThanOrEqual(3600);
    }
  });

  it("refuses every mint with the typed not_implemented dormancy signal", async () => {
    const outcome = await provider.broker!.mintCredential({
      template: "deploy-session",
      params: { roleSessionName: "orun" },
      ttlSeconds: 900,
      nowMs: 0,
      parent: { credential: "arn:aws:iam::role", externalRef: "acct" },
    });
    expect(outcome).toEqual({ ok: false, reason: "not_implemented" });
  });

  it("has no provider-side revoke — TTL is the backstop", async () => {
    await expect(provider.broker!.revokeCredential("ref", 0)).resolves.toBe(false);
  });
});

describe("Discord dormant messaging (IH10)", () => {
  const provider = createDiscordProvider();

  it("declares the messaging capability with connectKind oauth", () => {
    expect(provider.connectKind).toBe("oauth");
    expect(provider.capabilities).toEqual(["connect", "messaging"]);
    expect(getCapability(provider, "messaging")).not.toBeNull();
    // It does NOT claim a broker.
    expect(getCapability(provider, "broker")).toBeNull();
  });

  it("discovers nothing (null) — the dormant unavailable signal", async () => {
    await expect(
      provider.messaging!.listChannels({ accessToken: "tok" }),
    ).resolves.toBeNull();
  });
});
