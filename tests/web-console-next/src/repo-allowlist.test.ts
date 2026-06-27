import {
  githubRemoteForFullName,
  ownerOf,
  repoNameOf,
  repoFullNameFromRemote,
} from "@web-console-next/components/integrations/repo-allowlist";

describe("repo allow-list helpers", () => {
  it("builds a github remote from a full name", () => {
    expect(githubRemoteForFullName("acme/web")).toBe("github.com/acme/web");
  });

  it("splits owner and repo name from a full name", () => {
    expect(ownerOf("acme/web")).toBe("acme");
    expect(repoNameOf("acme/web")).toBe("web");
  });

  it("falls back to the input for a malformed full name", () => {
    expect(ownerOf("web")).toBe("web");
    expect(repoNameOf("web")).toBe("web");
  });

  it("recovers owner/repo from a normalized remote (host stripped)", () => {
    expect(repoFullNameFromRemote("github.com/acme/web")).toBe("acme/web");
    expect(repoFullNameFromRemote("https://github.com/acme/web.git")).toBe("acme/web");
    expect(repoFullNameFromRemote("gitlab.com/group/sub/repo")).toBe("sub/repo");
  });

  it("round-trips a full name through a remote and back", () => {
    const full = "acme/storefront";
    expect(repoFullNameFromRemote(githubRemoteForFullName(full))).toBe(full);
  });
});
