import {
  buildBaseCommands,
  composeCommands,
  groupCommands,
  COMMAND_GROUPS,
  type CommandContext,
  type CommandDescriptor,
} from "@web-console-next/components/shell/command-registry";

const baseCtx: CommandContext = {
  orgSlug: null,
  projectSlug: null,
  isLocked: false,
  targets: [{ name: "stage" }, { name: "prod" }],
};

describe("buildBaseCommands", () => {
  it("always includes org switch, security, and logout regardless of scope", () => {
    const ids = buildBaseCommands(baseCtx).map((c) => c.id);
    expect(ids).toContain("nav.orgs");
    expect(ids).toContain("nav.account.security");
    expect(ids).toContain("session.logout");
  });

  it("omits org-scoped commands when no orgSlug is present", () => {
    const ids = buildBaseCommands(baseCtx).map((c) => c.id);
    expect(ids).not.toContain("nav.projects");
    expect(ids).not.toContain("nav.billing");
  });

  it("adds org-scoped commands when orgSlug is present", () => {
    const cmds = buildBaseCommands({ ...baseCtx, orgSlug: "acme" });
    const byId = new Map(cmds.map((c) => [c.id, c]));
    expect(byId.has("nav.projects")).toBe(true);
    expect(byId.has("nav.billing")).toBe(true);
    const billing = byId.get("nav.billing")!;
    expect(billing.kind).toBe("navigate");
    // Billing now lives under the dedicated Settings surface.
    if (billing.kind === "navigate") expect(billing.to).toBe("/orgs/acme/settings/billing");
  });

  it("points org-administration commands at the Settings surface", () => {
    const cmds = buildBaseCommands({ ...baseCtx, orgSlug: "acme" });
    const byId = new Map(cmds.map((c) => [c.id, c]));
    for (const id of ["nav.members", "nav.webhooks", "nav.api-keys", "nav.audit"]) {
      const cmd = byId.get(id)!;
      expect(cmd.kind).toBe("navigate");
      if (cmd.kind === "navigate") expect(cmd.to).toMatch(/^\/orgs\/acme\/settings\//);
    }
    // Create flows for moved resources target the Settings paths too.
    const invite = byId.get("create.invitation")!;
    if (invite.kind === "navigate") expect(invite.to).toBe("/orgs/acme/settings/people?tab=pending");
  });

  it("exposes the MCP Connect-an-agent surface as a settings navigation command (MCP7)", () => {
    const cmds = buildBaseCommands({ ...baseCtx, orgSlug: "acme" });
    const byId = new Map(cmds.map((c) => [c.id, c]));
    const mcp = byId.get("nav.mcp")!;
    expect(mcp).toBeDefined();
    expect(mcp.kind).toBe("navigate");
    if (mcp.kind === "navigate") expect(mcp.to).toBe("/orgs/acme/settings/mcp");
    expect(mcp.keywords).toEqual(expect.arrayContaining(["mcp", "agent"]));
  });

  it("exposes the Work verbs: jump, layouts, and create-by-kind (orun-work-v3 PM4)", () => {
    const cmds = buildBaseCommands({ ...baseCtx, orgSlug: "acme" });
    const byId = new Map(cmds.map((c) => [c.id, c]));
    const work = byId.get("nav.work")!;
    expect(work.kind).toBe("navigate");
    if (work.kind === "navigate") expect(work.to).toBe("/orgs/acme/work");
    expect(work.keywords).toEqual(expect.arrayContaining(["kanban", "board", "task"]));
    const board = byId.get("nav.work-board")!;
    if (board.kind === "navigate") expect(board.to).toBe("/orgs/acme/work?layout=board");
    const triage = byId.get("nav.work-triage")!;
    if (triage.kind === "navigate") expect(triage.to).toBe("/orgs/acme/work/triage");
    for (const [id, kind] of [
      ["create.work-task", "task"],
      ["create.work-spec", "spec"],
      ["create.work-initiative", "initiative"],
    ] as const) {
      const cmd = byId.get(id)!;
      expect(cmd.group).toBe("Create");
      if (cmd.kind === "navigate") expect(cmd.to).toBe(`/orgs/acme/work?new=${kind}`);
    }
    // No verb can write a rung: the registry has no descriptor whose target
    // carries a status/rung param (the category is unrepresentable).
    for (const c of cmds) {
      if (c.kind === "navigate") expect(c.to).not.toMatch(/rung|status/);
    }
  });

  it("omits Work verbs outside an org scope", () => {
    const ids = buildBaseCommands(baseCtx).map((c) => c.id);
    expect(ids).not.toContain("nav.work");
    expect(ids).not.toContain("create.work-task");
  });

  it("exposes Secrets & Config as a top-level navigation command (not under settings)", () => {
    const cmds = buildBaseCommands({ ...baseCtx, orgSlug: "acme" });
    const byId = new Map(cmds.map((c) => [c.id, c]));
    const secrets = byId.get("nav.secrets")!;
    expect(secrets).toBeDefined();
    expect(secrets.kind).toBe("navigate");
    if (secrets.kind === "navigate") expect(secrets.to).toBe("/orgs/acme/secrets");
    // The old settings-scoped Config command is gone (moved to the top level).
    expect(byId.has("nav.config")).toBe(false);
  });

  it("adds project-scoped commands only when both org and project slugs are present", () => {
    const orgOnly = buildBaseCommands({ ...baseCtx, orgSlug: "acme" }).map((c) => c.id);
    expect(orgOnly).not.toContain("nav.environments");
    const both = buildBaseCommands({ ...baseCtx, orgSlug: "acme", projectSlug: "web" }).map((c) => c.id);
    expect(both).toContain("nav.environments");
  });

  it("emits target commands when unlocked and none when locked", () => {
    const unlocked = buildBaseCommands(baseCtx).filter((c) => c.kind === "target");
    expect(unlocked.map((c) => (c.kind === "target" ? c.targetName : ""))).toEqual(["stage", "prod"]);
    const locked = buildBaseCommands({ ...baseCtx, isLocked: true }).filter((c) => c.kind === "target");
    expect(locked).toHaveLength(0);
  });

  it("references only known icon names and stable group names", () => {
    for (const c of buildBaseCommands({ ...baseCtx, orgSlug: "acme", projectSlug: "web" })) {
      expect(COMMAND_GROUPS).toContain(c.group);
    }
  });
});

describe("composeCommands", () => {
  const extra: CommandDescriptor[] = [
    { id: "x.custom", label: "Custom action", group: "Navigation", kind: "navigate", to: "/x" },
  ];

  it("appends page-contributed commands", () => {
    const out = composeCommands(buildBaseCommands(baseCtx), extra);
    expect(out.map((c) => c.id)).toContain("x.custom");
  });

  it("lets a later registration override an earlier descriptor with the same id", () => {
    const override: CommandDescriptor[] = [
      { id: "nav.orgs", label: "Renamed orgs", group: "Navigation", kind: "navigate", to: "/orgs" },
    ];
    const out = composeCommands(buildBaseCommands(baseCtx), override);
    const orgs = out.filter((c) => c.id === "nav.orgs");
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.label).toBe("Renamed orgs");
  });

  it("orders by stable group precedence", () => {
    const out = composeCommands(buildBaseCommands(baseCtx), extra);
    const groupOrder = out.map((c) => COMMAND_GROUPS.indexOf(c.group));
    const sorted = [...groupOrder].sort((a, b) => a - b);
    expect(groupOrder).toEqual(sorted);
  });
});

describe("groupCommands", () => {
  it("drops empty groups and preserves group order", () => {
    const groups = groupCommands(buildBaseCommands({ ...baseCtx, isLocked: true }));
    const names = groups.map((g) => g.group);
    expect(names).not.toContain("Target"); // locked → no targets
    // Navigation precedes Session
    expect(names.indexOf("Navigation")).toBeLessThan(names.indexOf("Session"));
  });

  it("buckets each command under its declared group", () => {
    const groups = groupCommands(buildBaseCommands(baseCtx));
    for (const g of groups) {
      for (const item of g.items) expect(item.group).toBe(g.group);
    }
  });
});
