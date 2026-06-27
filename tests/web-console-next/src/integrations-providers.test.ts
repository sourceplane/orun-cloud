import {
  INTEGRATION_PROVIDERS,
  roadmapProviders,
} from "@web-console-next/components/integrations/providers";

describe("integration providers catalog", () => {
  it("ships GitHub as the only available provider today", () => {
    const available = INTEGRATION_PROVIDERS.filter((p) => p.status === "available");
    expect(available.map((p) => p.id)).toEqual(["github"]);
  });

  it("lists Supabase, Cloudflare, and Slack as roadmap (soon) providers", () => {
    expect(roadmapProviders().map((p) => p.id)).toEqual(["supabase", "cloudflare", "slack"]);
    expect(roadmapProviders().every((p) => p.status === "soon")).toBe(true);
  });

  it("gives every provider a name, description, and icon", () => {
    for (const p of INTEGRATION_PROVIDERS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.icon.length).toBeGreaterThan(0);
    }
  });
});
