import {
  ARCHETYPE_LABELS,
  ARCHETYPE_ORDER,
  archetypeForProvider,
  groupByArchetype,
  SCOPE_TEMPLATE_CATALOG,
  type Archetype,
} from "@web-console-next/components/integrations/archetype";

describe("archetype grouping (design §6)", () => {
  it("orders archetypes: source control, messaging, infrastructure", () => {
    expect(ARCHETYPE_ORDER).toEqual(["source-control", "messaging", "infrastructure"]);
  });

  it("labels every archetype", () => {
    expect(ARCHETYPE_LABELS).toEqual({
      "source-control": "Source control",
      messaging: "Messaging",
      infrastructure: "Infrastructure",
    });
  });

  it("maps provider ids to archetypes, null for unknown ids", () => {
    expect(archetypeForProvider("github")).toBe("source-control");
    expect(archetypeForProvider("slack")).toBe("messaging");
    expect(archetypeForProvider("discord")).toBe("messaging");
    expect(archetypeForProvider("cloudflare")).toBe("infrastructure");
    expect(archetypeForProvider("supabase")).toBe("infrastructure");
    expect(archetypeForProvider("aws")).toBe("infrastructure");
    expect(archetypeForProvider("gitlab")).toBeNull();
    expect(archetypeForProvider("")).toBeNull();
  });

  it("groups items in archetype order, labeled, dropping empty archetypes", () => {
    const items: Array<{ id: string; archetype: Archetype }> = [
      { id: "cloudflare", archetype: "infrastructure" },
      { id: "github", archetype: "source-control" },
      { id: "supabase", archetype: "infrastructure" },
    ];
    const groups = groupByArchetype(items);
    expect(groups.map((g) => g.archetype)).toEqual(["source-control", "infrastructure"]);
    expect(groups.map((g) => g.label)).toEqual(["Source control", "Infrastructure"]);
    // Input order preserved within a group.
    expect(groups[1]!.items.map((i) => i.id)).toEqual(["cloudflare", "supabase"]);
  });

  it("returns no groups for no items", () => {
    expect(groupByArchetype([])).toEqual([]);
  });
});

describe("SCOPE_TEMPLATE_CATALOG (display mirror of the worker adapters)", () => {
  it("mirrors the Cloudflare v1 template catalog exactly (cloudflare.ts)", () => {
    const templates = SCOPE_TEMPLATE_CATALOG.cloudflare!;
    expect(templates.map((t) => t.id)).toEqual([
      "workers-deploy",
      "pages-deploy",
      "dns-edit",
      "r2-data",
      "account-read",
    ]);
    const byId = new Map(templates.map((t) => [t.id, t]));
    expect(byId.get("workers-deploy")!.params).toEqual([]);
    expect(byId.get("pages-deploy")!.params).toEqual([]);
    expect(byId.get("dns-edit")!.params).toEqual(["zoneIds"]);
    expect(byId.get("r2-data")!.params).toEqual(["buckets"]);
    expect(byId.get("account-read")!.params).toEqual([]);
    // CLOUDFLARE_MAX_TTL_SECONDS: hard ceiling one hour.
    for (const t of templates) expect(t.maxTtlSeconds).toBe(3600);
  });

  it("mirrors the Supabase v1 template catalog exactly (supabase.ts)", () => {
    const templates = SCOPE_TEMPLATE_CATALOG.supabase!;
    expect(templates.map((t) => t.id)).toEqual([
      "management-access",
      "db-migrate",
      "functions-deploy",
      // SC1: the custody-served project-service-key template — previously
      // omitted from the console mirror (catalog drift), so it could not be
      // bound in the UI at all.
      "project-service-key",
    ]);
    const byId = new Map(templates.map((t) => [t.id, t]));
    expect(byId.get("management-access")!.params).toEqual([]);
    expect(byId.get("db-migrate")!.params).toEqual(["projectRef"]);
    expect(byId.get("functions-deploy")!.params).toEqual(["projectRef"]);
    expect(byId.get("project-service-key")!.params).toEqual(["projectRef"]);
    // SUPABASE_MAX_TTL_SECONDS: one hour.
    for (const t of templates) expect(t.maxTtlSeconds).toBe(3600);
  });

  it("gives every template a display name and description", () => {
    for (const templates of Object.values(SCOPE_TEMPLATE_CATALOG)) {
      for (const t of templates) {
        expect(t.displayName.length).toBeGreaterThan(0);
        expect(t.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("only catalogs the credential-broker providers", () => {
    expect(Object.keys(SCOPE_TEMPLATE_CATALOG).sort()).toEqual(["cloudflare", "supabase"]);
  });
});
