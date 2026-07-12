import {
  availableProviders,
  INTEGRATION_PROVIDERS,
  roadmapProviders,
} from "@web-console-next/components/integrations/providers";

describe("integration providers catalog", () => {
  it("ships GitHub and Slack as the available providers (IH1)", () => {
    expect(availableProviders().map((p) => p.id)).toEqual(["github", "slack"]);
    expect(availableProviders().every((p) => p.status === "available")).toBe(true);
  });

  it("lists Supabase and Cloudflare as roadmap (soon) providers", () => {
    expect(roadmapProviders().map((p) => p.id)).toEqual(["supabase", "cloudflare"]);
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
