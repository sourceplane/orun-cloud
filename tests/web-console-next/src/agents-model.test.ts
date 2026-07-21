// Agents presentation model (saas-agents AG7): the tone/label mappings the
// fleet view renders from — every state in the closed vocabulary maps, and
// the provider meta carries the two AG12 providers.

import {
  connectionTone,
  connectionModel,
  connectionReady,
  interfaceTier,
  modelOptions,
  orderFleetRows,
  pickDispatchConnection,
  sessionLabel,
  sessionTone,
  servicePrincipalSubjectId,
  workRefForItem,
  AGENT_TYPES,
  AGENT_MODELS,
  PROVIDER_META,
} from "@web-console-next/lib/agents/model";
import { AGENT_SESSION_STATES, AGENT_PROVIDERS, PROVIDER_CONNECTION_STATUSES } from "@saas/contracts/agents";

describe("agents presentation model", () => {
  it("maps every session state in the closed vocabulary to a tone", () => {
    for (const state of AGENT_SESSION_STATES) {
      expect(["success", "warning", "error", "info", "neutral"]).toContain(sessionTone(state));
    }
  });

  it("reads like a fleet dashboard: running is healthy, failed/expired are errors", () => {
    expect(sessionTone("running")).toBe("success");
    expect(sessionTone("failed")).toBe("error");
    expect(sessionTone("expired")).toBe("error");
    expect(sessionTone("awaiting_approval")).toBe("warning");
    expect(sessionTone("completed")).toBe("neutral");
  });

  it("labels states human-readably", () => {
    expect(sessionLabel("awaiting_approval")).toBe("Awaiting approval");
    expect(sessionLabel("provisioning")).toBe("Provisioning");
  });

  it("maps every connection status to a tone", () => {
    for (const status of PROVIDER_CONNECTION_STATUSES) {
      expect(["success", "warning", "error"]).toContain(connectionTone(status));
    }
    expect(connectionTone("verified")).toBe("success");
    expect(connectionTone("invalid")).toBe("error");
  });

  it("carries card meta for exactly the AG12 providers", () => {
    expect(Object.keys(PROVIDER_META).sort()).toEqual([...AGENT_PROVIDERS].sort());
  });

  it("builds the work:// provenance pointer for spawned sessions (AG8)", () => {
    expect(workRefForItem("org_1", "ORN-142")).toBe("work://org_1/ORN-142");
  });

  it("derives the canonical sp_ subject id from a service principal UUID", () => {
    expect(servicePrincipalSubjectId("3f9b537d-bf98-5f45-bb95-634323e593c7")).toBe(
      "sp_3f9b537dbf985f45bb95634323e593c7",
    );
  });

  it("offers the shipped agent types and at least one model for the profile form", () => {
    expect(AGENT_TYPES.map((t) => t.value)).toEqual(["implementer", "orchestrator"]);
    expect(AGENT_MODELS.length).toBeGreaterThan(0);
    expect(AGENT_MODELS.map((m) => m.value)).toContain("claude-opus-4-8");
  });
});

describe("orderFleetRows (saas-agents-fleet AF4)", () => {
  const s = (id: string, parentSessionId?: string) => ({ id, ...(parentSessionId ? { parentSessionId } : {}) });

  it("nests children directly under their parent with increasing depth", () => {
    const rows = orderFleetRows([s("as_root"), s("as_a", "as_root"), s("as_b", "as_root"), s("as_aa", "as_a")]);
    expect(rows.map((r) => `${r.session.id}:${r.depth}`)).toEqual([
      "as_root:0",
      "as_a:1",
      "as_aa:2",
      "as_b:1",
    ]);
  });

  it("a child whose parent is filtered out renders as a root — never dropped", () => {
    const rows = orderFleetRows([s("as_orphan", "as_gone"), s("as_solo")]);
    expect(rows.map((r) => `${r.session.id}:${r.depth}`)).toEqual(["as_orphan:0", "as_solo:0"]);
  });

  it("every session appears exactly once", () => {
    const input = [s("as_r"), s("as_x", "as_r"), s("as_y", "as_x"), s("as_z")];
    const rows = orderFleetRows(input);
    expect(rows.map((r) => r.session.id).sort()).toEqual(input.map((i) => i.id).sort());
  });
});

describe("modelOptions (saas-dispatch DX6 — connection-aware model picker)", () => {
  const base = AGENT_MODELS.length;
  it("offers the static list plus verified model-connection defaults, provider-labeled", () => {
    const options = modelOptions([
      { provider: "openrouter", status: "verified", config: { defaultModel: "meta-llama/llama-4" } },
      { provider: "openai", status: "verified", config: { defaultModel: "gpt-5.2" } },
    ]);
    expect(options.length).toBe(base + 2);
    expect(options.some((o) => o.value === "meta-llama/llama-4" && o.label.includes("OpenRouter"))).toBe(true);
    expect(options.some((o) => o.value === "gpt-5.2" && o.label.includes("OpenAI"))).toBe(true);
  });
  it("skips unverified connections, non-model providers, empty models, and dedupes", () => {
    const options = modelOptions([
      { provider: "openai", status: "invalid", config: { defaultModel: "gpt-x" } },
      { provider: "daytona", status: "verified", config: { defaultModel: "not-a-model" } },
      { provider: "anthropic", status: "verified", config: {} },
      { provider: "anthropic", status: "verified", config: { defaultModel: "claude-opus-4-8" } }, // already static
    ]);
    expect(options.length).toBe(base);
  });
});

describe("dispatch model resolution (saas-dispatch DX-Q6 — the console mirror of custody)", () => {
  it("connectionModel reads the pinned defaultModel, trimmed, else empty", () => {
    expect(connectionModel({ config: { defaultModel: "  gpt-4o " } })).toBe("gpt-4o");
    expect(connectionModel({ config: {} })).toBe("");
    expect(connectionModel({})).toBe("");
  });

  it("connectionReady: Anthropic is always ready; OpenAI/OpenRouter need a model id", () => {
    expect(connectionReady({ provider: "anthropic", config: {} })).toBe(true);
    expect(connectionReady({ provider: "openrouter", config: {} })).toBe(false);
    expect(connectionReady({ provider: "openrouter", config: { defaultModel: "x" } })).toBe(true);
    expect(connectionReady({ provider: "openai", config: { defaultModel: "gpt-4o" } })).toBe(true);
  });

  it("pickDispatchConnection mirrors custody: preferred → sole → default → null", () => {
    const rows = [
      { id: "apc_a", provider: "anthropic", name: "a", status: "verified" },
      { id: "apc_or", provider: "openrouter", name: "default", status: "verified" },
    ];
    // Preferred by id wins.
    expect(pickDispatchConnection(rows, "apc_a")?.provider).toBe("anthropic");
    // No preference among two → the one named "default".
    expect(pickDispatchConnection(rows)?.provider).toBe("openrouter");
    // Sole verified model connection.
    expect(pickDispatchConnection([{ id: "apc_1", provider: "openai", name: "x", status: "verified" }])?.id).toBe("apc_1");
    // Ambiguous (two, neither "default") → null.
    expect(
      pickDispatchConnection([
        { id: "apc_1", provider: "openai", name: "one", status: "verified" },
        { id: "apc_2", provider: "openrouter", name: "two", status: "verified" },
      ]),
    ).toBeNull();
    // Unverified + non-model providers are excluded.
    expect(pickDispatchConnection([{ id: "apc_x", provider: "anthropic", name: "a", status: "invalid" }])).toBeNull();
    expect(pickDispatchConnection([{ id: "apc_d", provider: "daytona", name: "default", status: "verified" }])).toBeNull();
    // A stale preferred id falls back to the sole connection.
    expect(pickDispatchConnection([{ id: "apc_or", provider: "openrouter", name: "or", status: "verified" }], "apc_gone")?.id).toBe("apc_or");
  });
});

describe("interfaceTier (saas-dispatch DX7 — the rendered trust tier)", () => {
  it("labels both interfaces distinctly and defaults unknown/absent to Sealed", () => {
    expect(interfaceTier("orun-sandbox").label).toBe("Sealed run");
    expect(interfaceTier("anthropic-managed").label).toBe("Managed run");
    expect(interfaceTier(undefined).label).toBe("Sealed run");
    expect(interfaceTier("junk").label).toBe("Sealed run");
  });
  it("states the managed tier's differences — never averaged away", () => {
    const managed = interfaceTier("anthropic-managed");
    expect(managed.blurb).toContain("no mid-run approvals");
    expect(managed.blurb).toContain("ZDR");
    expect(managed.tone).toBe("warning");
  });
});
