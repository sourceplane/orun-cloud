import {
  availableProviders,
  INTEGRATION_PROVIDERS,
  popupConnectMethod,
  providerById,
  roadmapProviders,
} from "@web-console-next/components/integrations/providers";

describe("integration providers catalog", () => {
  it("ships GitHub, Supabase, Cloudflare, and Slack as the available providers (IH8)", () => {
    expect(availableProviders().map((p) => p.id)).toEqual([
      "github",
      "supabase",
      "cloudflare",
      "slack",
    ]);
    expect(availableProviders().every((p) => p.status === "available")).toBe(true);
  });

  it("lists Discord and AWS as the roadmap (soon) providers", () => {
    expect(roadmapProviders().map((p) => p.id)).toEqual(["discord", "aws"]);
    expect(roadmapProviders().every((p) => p.status === "soon")).toBe(true);
  });

  it("assigns each live provider its archetype and connect kind (design §2/§6)", () => {
    const byId = new Map(INTEGRATION_PROVIDERS.map((p) => [p.id, p]));
    expect(byId.get("github")).toMatchObject({ archetype: "source-control", connectKind: "install" });
    expect(byId.get("slack")).toMatchObject({ archetype: "messaging", connectKind: "oauth" });
    expect(byId.get("cloudflare")).toMatchObject({ archetype: "infrastructure", connectKind: "oauth" });
    expect(byId.get("supabase")).toMatchObject({ archetype: "infrastructure", connectKind: "oauth" });
    expect(byId.get("discord")?.archetype).toBe("messaging");
    expect(byId.get("aws")?.archetype).toBe("infrastructure");
  });

  it("gives every provider a name, description, and icon", () => {
    for (const p of INTEGRATION_PROVIDERS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.icon.length).toBeGreaterThan(0);
    }
  });

  it("looks providers up by id, null for unknown ids", () => {
    expect(providerById("cloudflare")?.name).toBe("Cloudflare");
    expect(providerById("aws")?.status).toBe("soon");
    expect(providerById("gitlab")).toBeNull();
  });

  it("describes the broker providers honestly (OAuth + short-lived mints)", () => {
    expect(providerById("cloudflare")?.description).toMatch(/OAuth/i);
    expect(providerById("cloudflare")?.description).toMatch(/short-lived/i);
    expect(providerById("supabase")?.description).toMatch(/OAuth/i);
    expect(providerById("supabase")?.description).toMatch(/short-lived/i);
  });
});

describe("popupConnectMethod — connect dispatch mapping", () => {
  it("routes each named provider to its own IntegrationsClient method", () => {
    expect(popupConnectMethod("slack")).toBe("connectSlack");
    expect(popupConnectMethod("supabase")).toBe("connectSupabase");
    expect(popupConnectMethod("cloudflare")).toBe("connectCloudflare");
    expect(popupConnectMethod("github")).toBe("connectGithub");
  });

  it("maps Cloudflare to connectCloudflare, not connectGithub (OAuth-Cloudflare regression)", () => {
    // #463 flipped cloudflare to connectKind:"oauth"; the old inline ternary
    // then fell through to connectGithub, redirecting Connect Cloudflare to the
    // GitHub install page. This mapping is the guard against that recurrence.
    expect(popupConnectMethod("cloudflare")).toBe("connectCloudflare");
    expect(popupConnectMethod("cloudflare")).not.toBe("connectGithub");
  });

  it("keeps roadmap providers on connectGithub without an accidental branch", () => {
    // discord/aws are display-only ghosts; they never start a real popup connect,
    // but the closed union must still map somewhere deterministic.
    expect(popupConnectMethod("discord")).toBe("connectGithub");
    expect(popupConnectMethod("aws")).toBe("connectGithub");
  });

  it("assigns every catalog provider a dispatch target (no silent fall-through)", () => {
    for (const p of INTEGRATION_PROVIDERS) {
      expect(popupConnectMethod(p.id)).toMatch(
        /^connect(Github|Slack|Supabase|Cloudflare)$/,
      );
    }
  });
});
