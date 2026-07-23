// IC7 — data-backed ⌘K command builders + recency ranking (pure logic).
// The audit's headline: typing an existing service name ("api-edge") into the
// palette returned ZERO results because the registry was a static route list.
// These tests pin the builders that turn cached data into findable commands.

import type { OrgCatalogEntity, CatalogDoc } from "@saas/contracts/state";
import {
  entityCommands,
  docCommands,
  teamCommands,
  secretCommands,
  rankByRecency,
  MAX_ENTITY_COMMANDS,
} from "@web-console-next/lib/palette/entity-commands";
import { decodeEntityKey } from "@web-console-next/lib/catalog-entity-key";
import { COMMAND_GROUPS } from "@web-console-next/components/shell/command-registry";

const entity = (over: Partial<OrgCatalogEntity>): OrgCatalogEntity =>
  ({
    orgId: "org_1",
    entityRef: "component:default/api-edge",
    kind: "component",
    name: "api-edge",
    owner: "team:platform",
    lifecycle: "production",
    relations: [],
    sourceProjectId: "prj_1",
    sourceEnvironment: null,
    sourceCommit: null,
    headDigest: "sha256:" + "a".repeat(64),
    description: null,
    system: null,
    language: null,
    tags: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  }) as unknown as OrgCatalogEntity;

describe("entityCommands", () => {
  it("makes a service findable by name, ref, kind, and owner, navigating to its detail page", () => {
    const [cmd] = entityCommands("acme", [entity({})]);
    expect(cmd!.label).toBe("api-edge");
    expect(cmd!.group).toBe("Catalog");
    expect(cmd!.kind).toBe("navigate");
    expect(cmd!.keywords).toEqual(["component:default/api-edge", "component", "team:platform"]);
    // The route embeds the full merged-graph identity triple.
    const key = (cmd as { to: string }).to.split("/catalog/")[1]!;
    expect(decodeEntityKey(key)).toEqual({
      sourceProjectId: "prj_1",
      sourceEnvironment: null,
      entityRef: "component:default/api-edge",
    });
  });

  it("caps registration (bounded palette) without dropping typical orgs", () => {
    const many = Array.from({ length: MAX_ENTITY_COMMANDS + 50 }, (_, i) =>
      entity({ entityRef: `component:default/svc-${i}`, name: `svc-${i}` }),
    );
    expect(entityCommands("acme", many)).toHaveLength(MAX_ENTITY_COMMANDS);
  });

  it("registers under groups the palette actually orders", () => {
    for (const g of ["Catalog", "Docs", "Teams", "Secrets"]) {
      expect(COMMAND_GROUPS).toContain(g);
    }
  });
});

describe("docCommands / teamCommands / secretCommands", () => {
  it("docs surface title+entity and navigate to the entity's doc shelf", () => {
    const doc = {
      orgId: "org_1",
      projectId: "prj_1",
      sourceEnvironment: null,
      entityRef: "component:default/api-edge",
      entityKind: "component",
      entityName: "api-edge",
      docKey: "runbook",
      title: "On-call runbook",
      role: "runbook",
      path: "docs/runbook.md",
    } as unknown as CatalogDoc;
    const [cmd] = docCommands("acme", [doc]);
    expect(cmd!.label).toBe("api-edge — On-call runbook");
    expect(cmd!.group).toBe("Docs");
    expect(cmd!.keywords).toContain("docs/runbook.md");
    expect((cmd as { to: string }).to).toContain("/orgs/acme/docs/");
  });

  it("teams navigate by id and match on handle", () => {
    const [cmd] = teamCommands("acme", [{ id: "team_1", name: "Platform", handle: "platform" }]);
    expect((cmd as { to: string }).to).toBe("/orgs/acme/teams/team_1");
    expect(cmd!.keywords).toEqual(["platform"]);
  });

  it("secrets dedupe, cap, and navigate to the console — never carrying values", () => {
    const cmds = secretCommands("acme", ["DB_URL", "DB_URL", "API_KEY"]);
    expect(cmds).toHaveLength(2);
    for (const c of cmds) {
      expect((c as { to: string }).to).toBe("/orgs/acme/secrets");
    }
  });
});

describe("rankByRecency", () => {
  const cmds = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  it("moves recent ids to the front in recency order, preserving the rest", () => {
    expect(rankByRecency(cmds, ["c", "a"]).map((c) => c.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores unknown recents and is a no-op without any", () => {
    expect(rankByRecency(cmds, ["zz"]).map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
    expect(rankByRecency(cmds, []).map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });
});
