import { kindTone, lifecycleTone } from "@web-console-next/lib/catalog-kind";

describe("kindTone", () => {
  it("canonicalises every catalog kind", () => {
    for (const kind of ["Component", "API", "Resource", "System", "Domain", "Group"]) {
      expect(kindTone(kind).key).toBe(kind);
    }
  });

  it("uses one calm neutral tint for every kind (told apart by icon, not colour)", () => {
    const tints = new Set(
      ["Component", "API", "Resource", "System", "Domain", "Group"].map((k) => kindTone(k).avatar),
    );
    expect(tints.size).toBe(1);
    expect([...tints][0]).toContain("muted");
  });

  it("matches case-insensitively", () => {
    expect(kindTone("api").key).toBe("API");
    expect(kindTone("component").key).toBe("Component");
  });

  it("degrades unknown kinds without throwing", () => {
    const tone = kindTone("Widget");
    expect(tone.key).toBe("");
    expect(tone.avatar).toContain("muted");
  });
});

describe("lifecycleTone", () => {
  it("keeps every lifecycle chip a neutral outline (no status colours)", () => {
    for (const l of ["production", "staging", "beta", "deprecated", "experimental", "bespoke", null]) {
      expect(lifecycleTone(l).variant).toBe("outline");
    }
  });

  it("uses a faint rail for a missing lifecycle", () => {
    expect(lifecycleTone(null).accent).toBe("bg-border");
    expect(lifecycleTone(undefined).accent).toBe("bg-border");
  });

  it("darkens the neutral rail for more-live stages", () => {
    expect(lifecycleTone("production").accent).toBe("bg-foreground/30");
    expect(lifecycleTone("GA").accent).toBe("bg-foreground/30");
    expect(lifecycleTone("staging").accent).toBe("bg-foreground/15");
  });

  it("uses the faintest rail for end-of-life stages", () => {
    expect(lifecycleTone("deprecated").accent).toBe("bg-foreground/10");
    expect(lifecycleTone("sunset").accent).toBe("bg-foreground/10");
  });

  it("uses a neutral accent for unrecognised free-text", () => {
    expect(lifecycleTone("bespoke").accent).toBe("bg-foreground/15");
  });
});
