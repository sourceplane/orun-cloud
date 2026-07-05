import {
  attrRowsToFilters,
  EMPTY_RULE_FORM,
  parseTokenList,
  ruleFormToCreateRequest,
  ruleFormToUpdateRequest,
  ruleToFormValues,
  summarizeThrottle,
  type RuleFormValues,
} from "@web-console-next/components/notifications/rules";
import type { PublicNotificationRule } from "@saas/contracts/notifications";

function form(over: Partial<RuleFormValues> = {}): RuleFormValues {
  return {
    ...EMPTY_RULE_FORM,
    name: "Failed runs",
    eventTypes: "state.run.failed\nscm.*",
    targetRef: "ops@example.com",
    ...over,
  };
}

describe("parseTokenList", () => {
  it("splits on commas, whitespace and newlines, de-duping", () => {
    expect(parseTokenList("scm.*, state.run.failed\n scm.*  x")).toEqual(["scm.*", "state.run.failed", "x"]);
  });

  it("returns [] for a blank string", () => {
    expect(parseTokenList("   ")).toEqual([]);
  });
});

describe("attrRowsToFilters", () => {
  it("returns null when there are no usable rows", () => {
    expect(attrRowsToFilters([])).toBeNull();
    expect(attrRowsToFilters([{ path: "  ", op: "eq", value: "x" }])).toBeNull();
  });

  it("coerces scalars for eq/neq and arrays for in", () => {
    const filters = attrRowsToFilters([
      { path: "payload.count", op: "eq", value: "3" },
      { path: "payload.flag", op: "neq", value: "true" },
      { path: "payload.env", op: "in", value: "prod, staging" },
    ]);
    expect(filters).toEqual([
      { path: "payload.count", op: "eq", value: 3 },
      { path: "payload.flag", op: "neq", value: true },
      { path: "payload.env", op: "in", value: ["prod", "staging"] },
    ]);
  });
});

describe("ruleFormToCreateRequest", () => {
  it("maps a valid form to the create contract", () => {
    const res = ruleFormToCreateRequest(form({ minSeverity: "error", sources: "state-worker" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual({
      name: "Failed runs",
      eventTypes: ["state.run.failed", "scm.*"],
      minSeverity: "error",
      sources: ["state-worker"],
      attributeFilters: null,
      throttleWindowSeconds: 300,
      throttleMax: 10,
      targets: [{ kind: "email", ref: "ops@example.com" }],
    });
  });

  it("includes projectId only for a project-scoped rule", () => {
    const res = ruleFormToCreateRequest(form({ scope: "project", projectId: "prj_9" }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.projectId).toBe("prj_9");
  });

  it("rejects a blank name / no event types / blank target", () => {
    expect(ruleFormToCreateRequest(form({ name: " " }))).toMatchObject({ ok: false, field: "name" });
    expect(ruleFormToCreateRequest(form({ eventTypes: "" }))).toMatchObject({ ok: false, field: "eventTypes" });
    expect(ruleFormToCreateRequest(form({ targetRef: "" }))).toMatchObject({ ok: false, field: "targetRef" });
  });

  it("rejects a project scope with no project id", () => {
    expect(ruleFormToCreateRequest(form({ scope: "project", projectId: "" }))).toMatchObject({
      ok: false,
      field: "projectId",
    });
  });

  it("rejects a non-numeric throttle", () => {
    expect(ruleFormToCreateRequest(form({ throttleMax: "0" }))).toMatchObject({ ok: false, field: "throttleMax" });
  });
});

describe("ruleFormToUpdateRequest", () => {
  it("omits targets and nulls projectId for an org-scoped edit", () => {
    const res = ruleFormToUpdateRequest(form());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).not.toHaveProperty("targets");
    expect(res.value.projectId).toBeNull();
  });
});

describe("ruleToFormValues", () => {
  it("round-trips a rule into editable form values", () => {
    const rule: PublicNotificationRule = {
      id: "nr_1",
      orgId: "org_1",
      projectId: "prj_2",
      name: "R",
      status: "enabled",
      eventTypes: ["scm.*"],
      minSeverity: "warning",
      sources: ["scm"],
      attributeFilters: [{ path: "payload.x", op: "in", value: ["a", "b"] }],
      throttleWindowSeconds: 60,
      throttleMax: 5,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      targets: [{ id: "t1", kind: "slack_channel", ref: "nc_9", enabled: true, createdAt: "2026-01-01T00:00:00.000Z" }],
    };
    const v = ruleToFormValues(rule);
    expect(v.scope).toBe("project");
    expect(v.projectId).toBe("prj_2");
    expect(v.eventTypes).toBe("scm.*");
    expect(v.targetKind).toBe("slack_channel");
    expect(v.targetRef).toBe("nc_9");
    expect(v.attributeFilters).toEqual([{ path: "payload.x", op: "in", value: "a, b" }]);
  });
});

describe("summarizeThrottle", () => {
  it("renders compact windows", () => {
    expect(summarizeThrottle({ throttleMax: 10, throttleWindowSeconds: 300 })).toBe("10 / 5m");
    expect(summarizeThrottle({ throttleMax: 3, throttleWindowSeconds: 3600 })).toBe("3 / 1h");
    expect(summarizeThrottle({ throttleMax: 1, throttleWindowSeconds: 45 })).toBe("1 / 45s");
  });
});
