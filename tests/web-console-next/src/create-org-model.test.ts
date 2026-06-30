import {
  GIT_PROVIDERS,
  PLAN_OPTIONS,
  createButtonLabel,
  flowSteps,
  postCreatePath,
  sourceSummary,
  type PlanOption,
} from "@web-console-next/components/orgs/create-org-model";

const plan = (code: string): PlanOption => {
  const p = PLAN_OPTIONS.find((x) => x.code === code);
  if (!p) throw new Error(`unknown plan ${code}`);
  return p;
};

describe("flowSteps", () => {
  it("gives a parent (first) org the full path: plan AND starting point", () => {
    expect(flowSteps("parent").map((s) => s.id)).toEqual([
      "details",
      "plan",
      "source",
      "review",
    ]);
  });

  it("gives a child (additional) org the same path minus the plan step", () => {
    expect(flowSteps("child").map((s) => s.id)).toEqual(["details", "source", "review"]);
  });

  it("shares the details/starting-point/review spine across both modes", () => {
    const child = flowSteps("child").map((s) => s.id);
    const parent = flowSteps("parent").map((s) => s.id);
    expect(child.every((id) => parent.includes(id))).toBe(true);
  });
});

describe("PLAN_OPTIONS", () => {
  it("starts on Free and ends on the contact-sales tier", () => {
    expect(PLAN_OPTIONS[0]?.code).toBe("free");
    expect(PLAN_OPTIONS[PLAN_OPTIONS.length - 1]?.contact).toBe(true);
  });

  it("only the contact-sales tier skips self-serve checkout", () => {
    expect(PLAN_OPTIONS.filter((p) => p.contact).map((p) => p.code)).toEqual(["enterprise"]);
  });
});

describe("GIT_PROVIDERS", () => {
  it("only GitHub is available today (org-scoped GitHub App install)", () => {
    expect(GIT_PROVIDERS.filter((p) => p.available).map((p) => p.id)).toEqual(["github"]);
  });
});

describe("sourceSummary", () => {
  it("labels each starting point", () => {
    expect(sourceSummary({ kind: "scratch" })).toBe("Start from scratch");
    expect(sourceSummary({ kind: "git", provider: "github" })).toBe("Import from GitHub");
    expect(sourceSummary({ kind: "git", provider: "gitlab" })).toBe("Import from GitLab");
    expect(sourceSummary({ kind: "template", templateId: "web-app" })).toBe(
      "Template: Web App Starter",
    );
  });

  it("falls back to the raw id for an unknown template", () => {
    expect(sourceSummary({ kind: "template", templateId: "mystery" })).toBe("Template: mystery");
  });
});

describe("createButtonLabel", () => {
  it("names the hand-off the create triggers", () => {
    expect(createButtonLabel("parent", plan("free"), { kind: "scratch" })).toBe(
      "Create workspace",
    );
    expect(createButtonLabel("parent", plan("pro"), { kind: "scratch" })).toBe(
      "Create & continue to checkout",
    );
    expect(createButtonLabel("parent", plan("enterprise"), { kind: "scratch" })).toBe(
      "Create & contact sales",
    );
    expect(createButtonLabel("child", plan("free"), { kind: "git", provider: "github" })).toBe(
      "Create & connect GitHub",
    );
    expect(createButtonLabel("child", plan("free"), { kind: "scratch" })).toBe(
      "Create workspace",
    );
  });

  it("names the GitHub hand-off for a free parent org too (unified flow)", () => {
    expect(createButtonLabel("parent", plan("free"), { kind: "git", provider: "github" })).toBe(
      "Create & connect GitHub",
    );
  });

  it("lets a paid/contact plan hand-off win over the source in parent mode", () => {
    expect(createButtonLabel("parent", plan("business"), { kind: "git", provider: "github" })).toBe(
      "Create & continue to checkout",
    );
    expect(createButtonLabel("child", plan("business"), { kind: "scratch" })).toBe(
      "Create workspace",
    );
  });
});

describe("postCreatePath", () => {
  it("routes the GitHub starting point to the new org's integrations page (either mode)", () => {
    expect(postCreatePath("child", { kind: "git", provider: "github" }, "acme")).toBe(
      "/orgs/acme/settings/integrations",
    );
    expect(postCreatePath("parent", { kind: "git", provider: "github" }, "acme")).toBe(
      "/orgs/acme/settings/integrations",
    );
  });

  it("routes everything else to the new org's projects dashboard", () => {
    expect(postCreatePath("parent", { kind: "scratch" }, "acme")).toBe("/orgs/acme/projects");
    expect(postCreatePath("child", { kind: "scratch" }, "acme")).toBe("/orgs/acme/projects");
    expect(postCreatePath("child", { kind: "template", templateId: "web-app" }, "acme")).toBe(
      "/orgs/acme/projects",
    );
  });
});
