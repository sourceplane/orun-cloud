import { qk } from "@web-console-next/lib/query-keys";

describe("query cache keys (qk)", () => {
  it("produces a stable, equal key for the same resource+scope", () => {
    expect(qk.projects("org_1")).toEqual(qk.projects("org_1"));
    expect(qk.environments("org_1", "prj_1")).toEqual(qk.environments("org_1", "prj_1"));
    expect(qk.orgs()).toEqual(qk.orgs());
  });

  it("scopes keys by id so different scopes don't share a cache entry", () => {
    expect(qk.projects("org_1")).not.toEqual(qk.projects("org_2"));
    expect(qk.environments("org_1", "prj_1")).not.toEqual(qk.environments("org_1", "prj_2"));
  });

  it("never collides across resources sharing the same scope id", () => {
    const org = "org_1";
    const keys = [
      qk.projects(org),
      qk.members(org),
      qk.invitations(org),
      qk.apiKeys(org),
      qk.webhooks(org),
      qk.billingSummary(org),
      qk.entitlements(org),
      qk.invoices(org),
    ].map((k) => JSON.stringify(k));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("each key starts with a distinct resource tag", () => {
    expect(qk.orgs()[0]).toBe("orgs");
    expect(qk.projects("o")[0]).toBe("projects");
    expect(qk.environments("o", "p")[0]).toBe("environments");
    expect(qk.webhookEndpoint("o", "e")[0]).toBe("webhookEndpoint");
    expect(qk.billingSummary("o")[0]).toBe("billingSummary");
  });

  it("webhook endpoint key carries both org and endpoint id", () => {
    expect(qk.webhookEndpoint("org_1", "ep_9")).toEqual(["webhookEndpoint", "org_1", "ep_9"]);
  });

  it("scopes the org runs feed key by org and never collides with the catalog", () => {
    expect(qk.orgRuns("org_1")).toEqual(["orgRuns", "org_1"]);
    expect(qk.orgWork("org_1")).toEqual(["orgWork", "org_1"]);
    expect(qk.orgWork("org_1")).not.toEqual(qk.orgWork("org_2"));
    expect(qk.orgRuns("org_1")).not.toEqual(qk.orgRuns("org_2"));
    expect(JSON.stringify(qk.orgRuns("org_1"))).not.toEqual(JSON.stringify(qk.orgCatalog("org_1")));
  });

  it("keys the connection-detail surfaces by (org, connection) without colliding (IH8)", () => {
    expect(qk.integration("org_1", "int_1")).toEqual(["integration", "org_1", "int_1"]);
    expect(qk.mintedCredentials("org_1", "int_1")).toEqual(["mintedCredentials", "org_1", "int_1"]);
    expect(qk.slackChannels("org_1", "int_1")).toEqual(["slackChannels", "org_1", "int_1"]);
    expect(qk.integration("org_1", "int_1")).not.toEqual(qk.integration("org_1", "int_2"));
    const sameScope = [
      qk.integrations("org_1"),
      qk.integration("org_1", "int_1"),
      qk.mintedCredentials("org_1", "int_1"),
      qk.slackChannels("org_1", "int_1"),
      qk.connectionGrants("org_1", "int_1"),
    ].map((k) => JSON.stringify(k));
    expect(new Set(sameScope).size).toBe(sameScope.length);
  });

  it("keys repo facets by org and doc objects by (org, project, digest)", () => {
    expect(qk.repoFacets("org_1")).toEqual(["repoFacets", "org_1"]);
    expect(qk.docObject("org_1", "prj_1", "sha256:d")).toEqual(["docObject", "org_1", "prj_1", "sha256:d"]);
    expect(qk.docObject("org_1", "prj_1", "sha256:d")).not.toEqual(qk.docObject("org_1", "prj_1", "sha256:e"));
  });
});
