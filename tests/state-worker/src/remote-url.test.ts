import {
  githubFullNameFromNormalized,
  normalizeRemoteUrl,
} from "@state-worker/remote-url";

describe("normalizeRemoteUrl", () => {
  const CANONICAL = "github.com/acme/platform";

  it("normalizes ssh scp-like shorthand", () => {
    expect(normalizeRemoteUrl("git@github.com:acme/platform.git")).toBe(CANONICAL);
    expect(normalizeRemoteUrl("git@github.com:acme/platform")).toBe(CANONICAL);
  });

  it("normalizes https with and without .git and trailing slash", () => {
    expect(normalizeRemoteUrl("https://github.com/acme/platform.git")).toBe(CANONICAL);
    expect(normalizeRemoteUrl("https://github.com/acme/platform")).toBe(CANONICAL);
    expect(normalizeRemoteUrl("https://github.com/acme/platform/")).toBe(CANONICAL);
    expect(normalizeRemoteUrl("http://github.com/acme/platform")).toBe(CANONICAL);
  });

  it("strips credentials, ports, and ssh:// scheme", () => {
    expect(normalizeRemoteUrl("https://user:token@github.com/acme/platform.git")).toBe(CANONICAL);
    expect(normalizeRemoteUrl("ssh://git@github.com:22/acme/platform.git")).toBe(CANONICAL);
    expect(normalizeRemoteUrl("git://github.com/acme/platform.git")).toBe(CANONICAL);
  });

  it("lowercases the host and path so spellings collapse to one key", () => {
    expect(normalizeRemoteUrl("git@GitHub.com:Acme/Platform.git")).toBe(CANONICAL);
    expect(normalizeRemoteUrl("HTTPS://GITHUB.COM/ACME/PLATFORM")).toBe(CANONICAL);
  });

  it("all four spellings of the same repo collapse to one normalized value", () => {
    const spellings = [
      "git@github.com:acme/platform.git",
      "https://github.com/acme/platform",
      "https://github.com/acme/platform.git",
      "ssh://git@github.com/acme/platform.git",
    ];
    const normalized = new Set(spellings.map((s) => normalizeRemoteUrl(s)));
    expect(normalized.size).toBe(1);
    expect([...normalized][0]).toBe(CANONICAL);
  });

  it("supports non-github hosts and nested paths (gitlab subgroups)", () => {
    expect(normalizeRemoteUrl("git@gitlab.com:group/subgroup/repo.git")).toBe(
      "gitlab.com/group/subgroup/repo",
    );
    expect(normalizeRemoteUrl("https://bitbucket.org/team/repo")).toBe("bitbucket.org/team/repo");
  });

  it("rejects non-remotes and unsafe input", () => {
    expect(normalizeRemoteUrl("")).toBeNull();
    expect(normalizeRemoteUrl("   ")).toBeNull();
    expect(normalizeRemoteUrl("not a url")).toBeNull();
    expect(normalizeRemoteUrl("github.com")).toBeNull(); // no owner/repo
    expect(normalizeRemoteUrl("https://github.com/acme")).toBeNull(); // missing repo
    expect(normalizeRemoteUrl("https://github.com/acme/../etc")).toBeNull(); // traversal
    expect(normalizeRemoteUrl(42 as unknown)).toBeNull();
    expect(normalizeRemoteUrl(null)).toBeNull();
    expect(normalizeRemoteUrl(`https://github.com/acme/pl${"\n"}atform`)).toBeNull();
  });

  it("rejects an over-long input", () => {
    expect(normalizeRemoteUrl(`https://github.com/acme/${"x".repeat(2000)}`)).toBeNull();
  });
});

describe("githubFullNameFromNormalized", () => {
  it("returns owner/repo for github.com remotes", () => {
    expect(githubFullNameFromNormalized("github.com/acme/platform")).toBe("acme/platform");
  });

  it("returns null for non-github hosts", () => {
    expect(githubFullNameFromNormalized("gitlab.com/acme/platform")).toBeNull();
    expect(githubFullNameFromNormalized("github.com/acme")).toBeNull();
  });
});
