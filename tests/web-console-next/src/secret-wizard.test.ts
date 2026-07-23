// saas-integration-registry IR4: the outcome-first secret wizard
// (design §7 "Secret creation v2").
//
// Pure-logic tests for `secret-wizard-lib.ts` — the step machine (incl. the
// single-mode skip of "How should it live?"), the smart key-name default,
// the plain-language summary builder, and the "Where" step's validation,
// which is REUSED from bind-secret-flow (asserted by exercising the same
// rules through the wizard's gate). No jsdom — nothing is rendered.

import type { IntegrationScopeTemplate } from "@saas/contracts/integrations";
import {
  activeTemplates,
  defaultSecretKey,
  forcedMode,
  nextStepId,
  prevStepId,
  scopeRungLabel,
  seedTemplateId,
  summaryLine,
  whereStepErrors,
  wizardSteps,
  WIZARD_STEP_LABELS,
} from "@web-console-next/components/config/secret-wizard-lib";

const CONNECTION_ID = `int_${"a".repeat(32)}`;

function template(
  overrides: Partial<IntegrationScopeTemplate> & { id: string },
): IntegrationScopeTemplate {
  return {
    provider: "cloudflare" as IntegrationScopeTemplate["provider"],
    version: 1,
    displayName: overrides.id,
    description: "A scope.",
    params: [],
    maxTtlSeconds: 3600,
    ...overrides,
  };
}

describe("wizardSteps (step sequencing, design §7)", () => {
  it("renders all four steps when the provider declares both modes", () => {
    expect(wizardSteps(["brokered", "rotated"]).map((s) => s.id)).toEqual([
      "use-case",
      "where",
      "lifecycle",
      "review",
    ]);
  });

  it("skips the lifecycle step entirely for single-mode providers", () => {
    for (const modes of [["brokered"], ["rotated"]] as const) {
      expect(wizardSteps(modes).map((s) => s.id)).toEqual(["use-case", "where", "review"]);
    }
  });

  it("labels every step with its outcome-first heading", () => {
    for (const step of wizardSteps(["brokered", "rotated"])) {
      expect(step.label).toBe(WIZARD_STEP_LABELS[step.id]);
    }
    expect(WIZARD_STEP_LABELS["use-case"]).toBe("What do you need?");
    expect(WIZARD_STEP_LABELS.review).toBe("Review & create");
  });
});

describe("forcedMode", () => {
  it("is null when both modes are declared — the operator chooses", () => {
    expect(forcedMode(["brokered", "rotated"])).toBeNull();
  });

  it("forces the single declared mode", () => {
    expect(forcedMode(["brokered"])).toBe("binding");
    expect(forcedMode(["rotated"])).toBe("rotated");
  });

  it("fails open to brokered on an empty declaration", () => {
    expect(forcedMode([])).toBe("binding");
  });
});

describe("nextStepId / prevStepId", () => {
  const both = wizardSteps(["brokered", "rotated"]);
  const single = wizardSteps(["brokered"]);

  it("walks the four-step sequence forward and back", () => {
    expect(nextStepId(both, "use-case")).toBe("where");
    expect(nextStepId(both, "where")).toBe("lifecycle");
    expect(nextStepId(both, "lifecycle")).toBe("review");
    expect(nextStepId(both, "review")).toBeNull();
    expect(prevStepId(both, "review")).toBe("lifecycle");
    expect(prevStepId(both, "use-case")).toBeNull();
  });

  it("the single-mode walk goes where → review directly (no lifecycle)", () => {
    expect(nextStepId(single, "where")).toBe("review");
    expect(prevStepId(single, "review")).toBe("where");
    // The lifecycle step is unknown to this sequence.
    expect(nextStepId(single, "lifecycle")).toBeNull();
    expect(prevStepId(single, "lifecycle")).toBeNull();
  });
});

describe("activeTemplates / seedTemplateId (Step 1 cards + ?template= seed)", () => {
  const catalog = [
    template({ id: "workers-deploy" }),
    template({ id: "custom-dns", origin: "custom", status: "active" }),
    template({ id: "old-thing", origin: "custom", status: "retired" }),
  ];

  it("keeps declared and active custom templates, drops retired ones (SP-A6)", () => {
    expect(activeTemplates(catalog).map((t) => t.id)).toEqual(["workers-deploy", "custom-dns"]);
  });

  it("seeds a deep-linked template only when it names an active template", () => {
    expect(seedTemplateId(catalog, "workers-deploy")).toBe("workers-deploy");
    expect(seedTemplateId(catalog, "custom-dns")).toBe("custom-dns");
    // Retired and unknown ids never pre-select.
    expect(seedTemplateId(catalog, "old-thing")).toBe("");
    expect(seedTemplateId(catalog, "nope")).toBe("");
    expect(seedTemplateId(catalog, undefined)).toBe("");
    expect(seedTemplateId(catalog, null)).toBe("");
  });
});

describe("defaultSecretKey (smart key-name default)", () => {
  it("derives <PROVIDER>_API_TOKEN", () => {
    expect(defaultSecretKey("cloudflare")).toBe("CLOUDFLARE_API_TOKEN");
    expect(defaultSecretKey("supabase")).toBe("SUPABASE_API_TOKEN");
    expect(defaultSecretKey("github")).toBe("GITHUB_API_TOKEN");
  });

  it("normalizes non-alphanumeric provider ids to underscore", () => {
    expect(defaultSecretKey("open-router")).toBe("OPEN_ROUTER_API_TOKEN");
    expect(defaultSecretKey("  weird..id  ")).toBe("WEIRD_ID_API_TOKEN");
  });

  it("falls back to API_TOKEN without a provider", () => {
    expect(defaultSecretKey(undefined)).toBe("API_TOKEN");
    expect(defaultSecretKey(null)).toBe("API_TOKEN");
    expect(defaultSecretKey("")).toBe("API_TOKEN");
    expect(defaultSecretKey("---")).toBe("API_TOKEN");
  });
});

describe("scopeRungLabel", () => {
  it("labels the three rungs", () => {
    expect(scopeRungLabel({ kind: "organization" })).toBe("workspace scope");
    expect(scopeRungLabel({ kind: "project" })).toBe("project scope");
    expect(scopeRungLabel({ kind: "environment" })).toBe("environment scope");
  });
});

describe("summaryLine (plain-language review summary)", () => {
  const deploy = {
    displayName: "Deploy Workers",
    description: "Edit Workers scripts and KV.",
  };

  it("builds from the template's own displayName + description (single source)", () => {
    expect(
      summaryLine({
        template: deploy,
        connectionName: "Acme-prod",
        scopeLabel: "workspace scope",
        mode: "binding",
      }),
    ).toBe(
      "Deploy Workers — Edit Workers scripts and KV. Minted from Acme-prod, used at workspace scope; fresh per run, nothing stored.",
    );
  });

  it("states the rotated lifecycle honestly", () => {
    expect(
      summaryLine({
        template: deploy,
        connectionName: "Acme-prod",
        scopeLabel: "environment scope",
        mode: "rotated",
      }),
    ).toBe(
      "Deploy Workers — Edit Workers scripts and KV. Minted from Acme-prod, used at environment scope; stored encrypted and re-minted on the rotation schedule.",
    );
  });

  it("degrades gracefully before choices are made", () => {
    const line = summaryLine({
      template: null,
      connectionName: null,
      scopeLabel: "workspace scope",
      mode: "binding",
    });
    expect(line).toContain("No use case selected");
    expect(line).toContain("Minted from the connection");
  });
});

describe("whereStepErrors (validation REUSED from bind-secret-flow)", () => {
  const templates = [
    template({ id: "workers-deploy" }),
    template({ id: "dns-edit", params: ["zoneIds"] }),
  ];

  it("passes with a picked connection, template, and filled params", () => {
    expect(
      whereStepErrors(
        { connectionId: CONNECTION_ID, template: "dns-edit", params: { zoneIds: "zone1" } },
        templates,
      ),
    ).toEqual({});
    expect(
      whereStepErrors({ connectionId: CONNECTION_ID, template: "workers-deploy", params: {} }, templates),
    ).toEqual({});
  });

  it("applies the same connection-id rule (int_<32hex>)", () => {
    const errors = whereStepErrors(
      { connectionId: "not-a-connection", template: "workers-deploy", params: {} },
      templates,
    );
    expect(errors.connectionId).toBe("Pick a connection");
  });

  it("applies the same template + per-param rules, keyed by param name", () => {
    expect(
      whereStepErrors({ connectionId: CONNECTION_ID, template: "unknown", params: {} }, templates).template,
    ).toBe("Pick a scope template");
    const errors = whereStepErrors(
      { connectionId: CONNECTION_ID, template: "dns-edit", params: { zoneIds: "   " } },
      templates,
    );
    expect(errors.zoneIds).toBe("Required");
  });

  it("never surfaces review-step errors (key/display name belong to Step 4)", () => {
    const errors = whereStepErrors({ connectionId: "", template: "", params: {} }, templates);
    expect(Object.keys(errors).sort()).toEqual(["connectionId", "template"]);
    expect(errors.secretKey).toBeUndefined();
    expect(errors.displayName).toBeUndefined();
  });
});
