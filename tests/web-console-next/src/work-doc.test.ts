// Pure-lib tests for the work document helpers (orun-work-v3 PM0).

import { forkParents, isValidPrefix, isValidSlug, shortDigest, slugify, suggestPrefix } from "@web-console-next/lib/work/doc";

describe("shortDigest", () => {
  it("shortens sha256 refs and tolerates bare hex", () => {
    expect(shortDigest("sha256:abcdef0123456789")).toBe("abcdef0");
    expect(shortDigest("abcdef0123456789")).toBe("abcdef0");
  });
});

describe("forkParents (fork-visible LWW)", () => {
  it("flags parents with more than one child, ignores roots", () => {
    const forks = forkParents([
      { revision: "sha256:r", parent: undefined },
      { revision: "sha256:a", parent: "sha256:r" },
      { revision: "sha256:b", parent: "sha256:r" },
      { revision: "sha256:c", parent: "sha256:a" },
    ]);
    expect(forks.has("sha256:r")).toBe(true);
    expect(forks.has("sha256:a")).toBe(false);
    expect(forks.size).toBe(1);
  });
});

describe("slug/prefix rules mirror the mutator", () => {
  it("slugify produces mutator-valid kebab", () => {
    expect(slugify("Checkout Flow (v2)!")).toBe("checkout-flow-v2");
    expect(isValidSlug(slugify("Checkout Flow (v2)!"))).toBe(true);
    expect(isValidSlug("Bad Slug")).toBe(false);
  });

  it("suggestPrefix yields 2–5 uppercase or the WRK fallback", () => {
    expect(suggestPrefix("Checkout flow")).toBe("CHECK");
    expect(suggestPrefix("auth")).toBe("AUTH");
    expect(suggestPrefix("x")).toBe("WRK");
    expect(isValidPrefix(suggestPrefix("Checkout flow"))).toBe(true);
  });
});
