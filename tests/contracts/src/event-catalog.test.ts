import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVENT_CATALOG,
  EVENT_CATEGORIES,
  EVENT_SEVERITIES,
  EVENT_TYPE_PATTERN,
  catalogEntryFor,
  isCatalogedEventType,
  effectiveEventSeverity,
  matchesAnyEventTypeGlob,
  matchesEventTypeGlob,
  renderEventTitle,
  severityRank,
} from "@saas/contracts/event-catalog";
import { NOTIFICATION_EVENT_TYPES } from "@saas/contracts/notifications";
import { SCM_EVENT_TYPES, INTEGRATION_EVENT_TYPES } from "@saas/contracts/integrations";
import { STATE_EVENT_TYPES } from "@saas/contracts/state";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

/**
 * Event types passed to appendEvent as function arguments (not on a
 * `type:`/`eventType:` property line), which the line-scoped source scan
 * below cannot see. Update this list when such a call shape is added.
 */
const FUNCTION_ARG_EMITTED_TYPES = [
  "webhook.delivery_succeeded",
  "webhook.delivery_failed",
];

/**
 * The config-worker secret event vocabulary lives in a worker-local map
 * (apps/config-worker/src/secret-events.ts), not in contracts — assert its
 * known values are registered explicitly.
 */
const SECRET_EVENT_TYPES_SNAPSHOT = [
  "secrets.updated",
  "secret.accessed",
  "secret.denied",
  "secret.revealed",
  "secret.policy.updated",
  "secret.sync.recorded",
  "secret.rotation_due",
  "secret.expiring",
];

function walkTsFiles(dir: string, out: string[]): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsFiles(full, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract event-type string literals from `type:` / `eventType:` lines
 * (including ternary forms) in files that append to the canonical event log.
 * Types passed through contracts constant maps are covered by the map
 * assertions; types passed as bare function arguments must be listed in
 * FUNCTION_ARG_EMITTED_TYPES.
 */
function scanEmittedTypeLiterals(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const roots: string[] = [];
  for (const top of ["apps", "packages"]) {
    const topDir = join(REPO_ROOT, top);
    for (const child of readdirSync(topDir)) {
      const srcDir = join(topDir, child, "src");
      try {
        if (statSync(srcDir).isDirectory()) roots.push(srcDir);
      } catch {
        // no src dir
      }
    }
  }
  const files: string[] = [];
  for (const root of roots) walkTsFiles(root, files);

  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    if (!text.includes("appendEvent")) continue;
    for (const line of text.split("\n")) {
      if (!/\b(type|eventType)\s*:/.test(line)) continue;
      for (const match of line.matchAll(/"([a-z0-9_]+(?:\.[a-z0-9_]+)+)"/g)) {
        const literal = match[1]!;
        const rel = file.slice(REPO_ROOT.length + 1);
        const existing = found.get(literal) ?? [];
        existing.push(rel);
        found.set(literal, existing);
      }
    }
  }
  return found;
}

describe("event catalog registry invariants", () => {
  const entries = Object.entries(EVENT_CATALOG);

  it("is non-empty and keys equal entry.type", () => {
    expect(entries.length).toBeGreaterThan(50);
    for (const [key, entry] of entries) {
      expect(entry.type).toBe(key);
    }
  });

  it("every type matches the envelope type pattern", () => {
    for (const [key] of entries) {
      expect(key).toMatch(EVENT_TYPE_PATTERN);
    }
  });

  it("every entry carries a valid category, severity, version, and title", () => {
    for (const [, entry] of entries) {
      expect(EVENT_CATEGORIES).toContain(entry.category);
      expect(EVENT_SEVERITIES).toContain(entry.severity);
      expect(entry.version).toBeGreaterThanOrEqual(1);
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });

  it("dedup keys are authored templates that embed the org scope", () => {
    for (const [, entry] of entries) {
      if (entry.dedupKey !== undefined) {
        expect(entry.dedupKey).toContain("{tenant.orgId}");
      }
    }
  });

  it("correlates allow-lists only reference registered types", () => {
    for (const [, entry] of entries) {
      for (const sibling of entry.correlates ?? []) {
        expect(EVENT_CATALOG[sibling]).toBeDefined();
      }
    }
  });

  it("severity ladder ranks are ordered", () => {
    expect(severityRank("info")).toBeLessThan(severityRank("notice"));
    expect(severityRank("notice")).toBeLessThan(severityRank("warning"));
    expect(severityRank("warning")).toBeLessThan(severityRank("error"));
    expect(severityRank("error")).toBeLessThan(severityRank("critical"));
  });

  it("resolves tenant custom.* types to the catch-all entry", () => {
    const entry = catalogEntryFor("custom.deploy_marker");
    expect(entry).not.toBeNull();
    expect(entry!.category).toBe("custom");
    expect(isCatalogedEventType("custom.deploy_marker")).toBe(true);
  });

  it("rejects unregistered platform-namespace types", () => {
    expect(catalogEntryFor("billing.totally_new_thing")).toBeNull();
    expect(isCatalogedEventType("custom")).toBe(false);
    expect(isCatalogedEventType("custom.UPPER")).toBe(false);
  });
});

describe("event type glob matching", () => {
  it("* matches everything", () => {
    expect(matchesEventTypeGlob("scm.push", "*")).toBe(true);
  });

  it("exact types match only themselves", () => {
    expect(matchesEventTypeGlob("scm.push", "scm.push")).toBe(true);
    expect(matchesEventTypeGlob("scm.push", "scm.pull_request.opened")).toBe(false);
  });

  it("prefix globs span multiple segments (unlike webhook single-level wildcards)", () => {
    expect(matchesEventTypeGlob("scm.push", "scm.*")).toBe(true);
    expect(matchesEventTypeGlob("scm.pull_request.opened", "scm.*")).toBe(true);
    expect(matchesEventTypeGlob("state.run.completed", "scm.*")).toBe(false);
    // Prefix boundary is the dot: "scm.*" must not match "scmx.push".
    expect(matchesEventTypeGlob("scmx.push", "scm.*")).toBe(false);
  });

  it("mid-pattern wildcards are not supported", () => {
    expect(matchesEventTypeGlob("scm.pull_request.opened", "scm.*.opened")).toBe(false);
  });

  it("empty glob lists match all; otherwise any-of", () => {
    expect(matchesAnyEventTypeGlob("scm.push", [])).toBe(true);
    expect(matchesAnyEventTypeGlob("scm.push", ["billing.*", "scm.*"])).toBe(true);
    expect(matchesAnyEventTypeGlob("scm.push", ["billing.*"])).toBe(false);
  });
});

describe("title rendering and effective severity (ES2)", () => {
  it("renders subject/tenant/payload placeholders and tolerates gaps", () => {
    const rendered = renderEventTitle("Check {payload.checkName} completed: {payload.conclusion}", {
      payload: { checkName: "ci", conclusion: "success" },
    });
    expect(rendered).toBe("Check ci completed: success");
    expect(renderEventTitle("Org {subject.name} created", { subject: { name: "Acme" } })).toBe("Org Acme created");
    expect(renderEventTitle("Missing {payload.absent}", { payload: {} })).toBe("Missing [absent]");
  });

  it("payload severity escalates the catalog default but never lowers it", () => {
    expect(effectiveEventSeverity("scm.push", {})).toBe("info");
    expect(effectiveEventSeverity("scm.push", { severity: "critical" })).toBe("critical");
    expect(effectiveEventSeverity("dead_letter.created", { severity: "info" })).toBe("error");
    expect(effectiveEventSeverity("scm.push", { severity: "bogus" })).toBe("info");
  });
});

describe("event catalog totality (CI guard)", () => {
  it("registers every contracts event-type constant", () => {
    const constantValues = [
      ...Object.values(NOTIFICATION_EVENT_TYPES),
      ...Object.values(SCM_EVENT_TYPES),
      ...Object.values(INTEGRATION_EVENT_TYPES),
      ...Object.values(STATE_EVENT_TYPES),
    ];
    const missing = constantValues.filter((t) => !EVENT_CATALOG[t]);
    expect(missing).toEqual([]);
  });

  it("registers the ES3 notification_channel.* lifecycle events", () => {
    for (const t of [
      "notification_channel.created",
      "notification_channel.updated",
      "notification_channel.deleted",
      "notification_channel.verified",
    ]) {
      expect(EVENT_CATALOG[t]).toBeDefined();
    }
  });

  it("registers the config-worker secret event vocabulary", () => {
    const missing = SECRET_EVENT_TYPES_SNAPSHOT.filter((t) => !EVENT_CATALOG[t]);
    expect(missing).toEqual([]);
  });

  it("registers the function-argument emitted types", () => {
    const missing = FUNCTION_ARG_EMITTED_TYPES.filter((t) => !EVENT_CATALOG[t]);
    expect(missing).toEqual([]);
  });

  it("registers every type literal on emit lines across the workspace", () => {
    const literals = scanEmittedTypeLiterals();
    // Sanity: the scan must actually see the well-known hardcoded emitters —
    // an empty result means the walker broke, not that the workspace is clean.
    expect(literals.has("organization.created")).toBe(true);
    expect(literals.has("webhook.disabled")).toBe(true);
    expect(literals.size).toBeGreaterThan(20);
    const violations: string[] = [];
    for (const [literal, files] of literals) {
      if (!isCatalogedEventType(literal)) {
        violations.push(`${literal} (${[...new Set(files)].join(", ")})`);
      }
    }
    // An entry here means an emitter ships an event type the catalog does not
    // know — register it in packages/contracts/src/event-catalog.ts (routing,
    // severity, and the explorer are blind to unregistered types).
    expect(violations).toEqual([]);
  });
});
