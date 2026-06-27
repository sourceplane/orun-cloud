import { rankEnvironment, defaultEnvironment } from "@web-console-next/lib/environment-rank";

describe("rankEnvironment", () => {
  it("ranks production-tier highest, local lowest", () => {
    expect(rankEnvironment("prod")).toBeGreaterThan(rankEnvironment("stage"));
    expect(rankEnvironment("stage")).toBeGreaterThan(rankEnvironment("dev"));
    expect(rankEnvironment("dev")).toBeGreaterThan(rankEnvironment("local"));
  });

  it("is case-insensitive and accepts common aliases", () => {
    expect(rankEnvironment("Production")).toBe(rankEnvironment("prod"));
    expect(rankEnvironment("STAGING")).toBe(rankEnvironment("stage"));
  });

  it("ranks an unknown custom env above dev but below qa", () => {
    expect(rankEnvironment("frobnitz")).toBeGreaterThan(rankEnvironment("dev"));
    expect(rankEnvironment("frobnitz")).toBeLessThan(rankEnvironment("qa"));
  });
});

describe("defaultEnvironment", () => {
  it("picks the highest-tier (most production-like) env — the intent.yaml promotion terminal", () => {
    expect(defaultEnvironment(["dev", "stage", "prod"])).toBe("prod");
    expect(defaultEnvironment(["staging", "dev"])).toBe("staging");
  });

  it("returns null for an empty set and ignores blanks", () => {
    expect(defaultEnvironment([])).toBeNull();
    expect(defaultEnvironment([""])).toBeNull();
  });

  it("falls back to a custom env over an explicit dev", () => {
    expect(defaultEnvironment(["dev", "edge"])).toBe("edge");
  });
});
