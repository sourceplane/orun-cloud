import {
  attrRowsToFilters,
  EMPTY_RULE_FORM,
  parseTokenList,
  ruleFormToCreateRequest,
  ruleFormToUpdateRequest,
  ruleToFormValues,
  selectableSlackChannels,
  slackChannelOptionLabel,
  summarizeTargets,
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

describe("selectableSlackChannels (the rule target picker)", () => {
  const channels = [
    { id: "chan_a", name: "#alerts", kind: "slack_app" },
    { id: "chan_b", name: "#ops", kind: "slack_incoming_webhook" },
    { id: "chan_c", name: "pager", kind: "email" },
  ];

  it("includes BOTH the workspace-bot and webhook Slack kinds (regression: bot channels were dropped)", () => {
    expect(selectableSlackChannels(channels).map((c) => c.id)).toEqual(["chan_a", "chan_b"]);
  });

  it("surfaces a connected workspace's slack_app channel as a target", () => {
    // The exact reported break: a user connects Slack, adds a workspace-bot
    // channel, and it must appear in the rule picker.
    const onlyBot = [{ id: "chan_a", name: "#alerts", kind: "slack_app" }];
    expect(selectableSlackChannels(onlyBot)).toHaveLength(1);
  });

  it("excludes non-Slack kinds", () => {
    expect(selectableSlackChannels([{ id: "chan_c", name: "x", kind: "email" }])).toEqual([]);
  });

  it("labels the delivery mechanism so bot and webhook rows are distinguishable", () => {
    expect(slackChannelOptionLabel({ name: "#alerts", kind: "slack_app" })).toBe("#alerts · Workspace bot");
    expect(slackChannelOptionLabel({ name: "#ops", kind: "slack_incoming_webhook" })).toBe("#ops · Webhook");
  });
});

describe("summarizeTargets", () => {
  function ruleWith(targets: PublicNotificationRule["targets"]): PublicNotificationRule {
    return {
      id: "rule_1",
      orgId: "org_1",
      projectId: null,
      name: "r",
      eventTypes: ["*"],
      minSeverity: "warning",
      sources: null,
      attributeFilters: null,
      throttleWindowSeconds: 300,
      throttleMax: 10,
      enabled: true,
      targets,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as PublicNotificationRule;
  }

  it("resolves a slack_channel ref to the channel name when channels are supplied", () => {
    const rule = ruleWith([
      { id: "t1", kind: "slack_channel", ref: "chan_a", enabled: true, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(summarizeTargets(rule, [{ id: "chan_a", name: "#alerts" }])).toBe("slack: #alerts");
  });

  it("falls back to the raw id for an unknown (e.g. deleted) channel", () => {
    const rule = ruleWith([
      { id: "t1", kind: "slack_channel", ref: "chan_gone", enabled: true, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(summarizeTargets(rule, [])).toBe("slack: chan_gone");
  });

  it("renders email targets verbatim", () => {
    const rule = ruleWith([
      { id: "t1", kind: "email", ref: "ops@x.com", enabled: true, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(summarizeTargets(rule)).toBe("email: ops@x.com");
  });
});
