import { kindTone, lifecycleTone } from "@web-console-next/lib/catalog-kind";

describe("kindTone", () => {
  it("maps every catalog kind to a stable tone", () => {
    for (const kind of ["Component", "API", "Resource", "System", "Domain", "Group"]) {
      const tone = kindTone(kind);
      expect(tone.key).toBe(kind);
      expect(tone.avatar).toMatch(/bg-/);
    }
  });

  it("reserves the brand primary tint for Component", () => {
    expect(kindTone("Component").avatar).toContain("text-primary");
  });

  it("matches case-insensitively", () => {
    expect(kindTone("api")).toEqual(kindTone("API"));
    expect(kindTone("component").key).toBe("Component");
  });

  it("degrades unknown kinds to a neutral tone (never throws)", () => {
    const tone = kindTone("Widget");
    expect(tone.key).toBe("");
    expect(tone.avatar).toContain("muted");
  });
});

describe("lifecycleTone", () => {
  it("treats a missing lifecycle as an unknown, neutral accent", () => {
    expect(lifecycleTone(null).variant).toBe("outline");
    expect(lifecycleTone(undefined).accent).toBe("bg-border");
  });

  it("reads production-class lifecycles as success", () => {
    expect(lifecycleTone("production").variant).toBe("success");
    expect(lifecycleTone("GA").variant).toBe("success");
    expect(lifecycleTone("stable").accent).toBe("bg-success");
  });

  it("reads pre-prod lifecycles as warning", () => {
    expect(lifecycleTone("staging").variant).toBe("warning");
    expect(lifecycleTone("beta").variant).toBe("warning");
  });

  it("reads end-of-life lifecycles as destructive", () => {
    expect(lifecycleTone("deprecated").variant).toBe("destructive");
    expect(lifecycleTone("sunset").accent).toBe("bg-destructive");
  });

  it("reads early-stage lifecycles as a secondary tone", () => {
    expect(lifecycleTone("experimental").variant).toBe("secondary");
    expect(lifecycleTone("alpha").variant).toBe("secondary");
  });

  it("falls back to a secondary tone for unrecognised free-text", () => {
    expect(lifecycleTone("bespoke").variant).toBe("secondary");
  });
});
