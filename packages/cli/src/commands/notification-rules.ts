// Notification-rules commands (saas-event-streaming ES5b):
//
//   - notification-rules list   → `client.notificationRules.list`
//   - notification-rules create → map flags onto CreateNotificationRuleRequest
//   - notification-rules test   → dry-run a synthetic event against a rule id
//
// Structured fields (targets, attribute filters) are supplied as JSON and
// parsed here (bad JSON → UsageError, exit 2); the worker is the authoritative
// validator for everything else. Output honours `--output=human|json`.

import type { CommandContext, CommandResult } from "../router.js";
import type {
  CreateNotificationRuleRequest,
  NotificationRuleTargetInput,
  TestNotificationRuleRequest,
} from "@saas/sdk";
import { formatOutput } from "../output/index.js";
import { UsageError } from "../errors.js";
import { resolveOrgId, readIdempotencyKey } from "./helpers.js";

function strFlag(flag: string | boolean | undefined): string | undefined {
  return typeof flag === "string" && flag.length > 0 ? flag : undefined;
}

/** Split a comma-separated flag into trimmed non-empty tokens. */
function csvFlag(flag: string | boolean | undefined): string[] {
  const raw = strFlag(flag);
  if (raw === undefined) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseIntFlag(flag: string | boolean | undefined, label: string): number | undefined {
  const raw = strFlag(flag);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new UsageError(`${label} must be a non-negative integer (got ${raw})`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// notification-rules list
// ---------------------------------------------------------------------------

export async function notificationRulesListCommand(ctx: CommandContext): Promise<CommandResult> {
  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const sdk = await ctx.sdk();
  const result = await sdk.notificationRules.list(orgId);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }

  const rows = result.notificationRules.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    eventTypes: r.eventTypes.join(","),
    minSeverity: r.minSeverity,
    targets: String(r.targets?.length ?? 0),
  }));
  ctx.stdout(
    formatOutput({
      mode: "human",
      columns: ["id", "name", "status", "eventTypes", "minSeverity", "targets"],
      rows,
      title: `Notification rules for ${orgId}`,
    }),
  );
  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// notification-rules create
// ---------------------------------------------------------------------------

/**
 * Parse `--target '<json>'` — a single target object `{kind, ref}` or an array
 * of them. Bad JSON is a UsageError; the worker validates kind/ref shape.
 */
function parseTargetsFlag(flag: string | boolean | undefined): NotificationRuleTargetInput[] | undefined {
  const raw = strFlag(flag);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError("--target must be valid JSON (an object or array of {kind, ref})");
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr as NotificationRuleTargetInput[];
}

export async function notificationRulesCreateCommand(ctx: CommandContext): Promise<CommandResult> {
  const name = strFlag(ctx.flags["name"]);
  const eventTypes = csvFlag(ctx.flags["event-type"]);
  if (name === undefined || eventTypes.length === 0) {
    throw new UsageError(
      "usage: orun-cloud notification-rules create --name <NAME> --event-type <GLOB[,GLOB2,...]> [--min-severity S] [--source S[,S2]] [--target '<json>'] [--attribute-filters '<json>'] [--throttle-window N] [--throttle-max N] [--project prj_…] [--idempotency-key K]",
    );
  }

  let attributeFilters: CreateNotificationRuleRequest["attributeFilters"];
  const afRaw = strFlag(ctx.flags["attribute-filters"]);
  if (afRaw !== undefined) {
    try {
      attributeFilters = JSON.parse(afRaw) as CreateNotificationRuleRequest["attributeFilters"];
    } catch {
      throw new UsageError("--attribute-filters must be valid JSON (an array of {path, op, value})");
    }
  }

  const sources = csvFlag(ctx.flags["source"]);
  const targets = parseTargetsFlag(ctx.flags["target"]);
  const throttleWindowSeconds = parseIntFlag(ctx.flags["throttle-window"], "--throttle-window");
  const throttleMax = parseIntFlag(ctx.flags["throttle-max"], "--throttle-max");

  const minSeverity = strFlag(ctx.flags["min-severity"]);
  const project = strFlag(ctx.flags["project"]);
  const body: CreateNotificationRuleRequest = {
    name,
    eventTypes,
    ...(minSeverity !== undefined ? { minSeverity } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    ...(attributeFilters !== undefined ? { attributeFilters } : {}),
    ...(targets !== undefined ? { targets } : {}),
    ...(throttleWindowSeconds !== undefined ? { throttleWindowSeconds } : {}),
    ...(throttleMax !== undefined ? { throttleMax } : {}),
    ...(project !== undefined ? { projectId: project } : {}),
  };

  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const idempotencyKey = readIdempotencyKey(ctx);

  const sdk = await ctx.sdk();
  const result = await sdk.notificationRules.create(
    orgId,
    body,
    idempotencyKey !== undefined ? { idempotencyKey } : {},
  );

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }
  const r = result.notificationRule;
  ctx.stdout(
    formatOutput({
      mode: "human",
      record: {
        id: r.id,
        name: r.name,
        status: r.status,
        eventTypes: r.eventTypes.join(","),
        minSeverity: r.minSeverity,
        targets: String(r.targets?.length ?? 0),
      },
      title: `Notification rule created in ${orgId}`,
    }),
  );
  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// notification-rules test <ruleId>
// ---------------------------------------------------------------------------

export async function notificationRulesTestCommand(ctx: CommandContext): Promise<CommandResult> {
  const ruleId = ctx.args[0];
  const type = strFlag(ctx.flags["type"]);
  if (ruleId === undefined || ruleId.length === 0 || type === undefined) {
    throw new UsageError(
      "usage: orun-cloud notification-rules test <ruleId> --type <event.type> [--severity S] [--source S] [--project prj_…] [--payload '<json>']",
    );
  }

  let payload: Record<string, unknown> | undefined;
  const payloadRaw = strFlag(ctx.flags["payload"]);
  if (payloadRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadRaw);
    } catch {
      throw new UsageError("--payload must be valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new UsageError("--payload must be a JSON object");
    }
    payload = parsed as Record<string, unknown>;
  }

  const severity = strFlag(ctx.flags["severity"]);
  const source = strFlag(ctx.flags["source"]);
  const project = strFlag(ctx.flags["project"]);
  const body: TestNotificationRuleRequest = {
    type,
    ...(severity !== undefined ? { severity } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(project !== undefined ? { projectId: project } : {}),
    ...(payload !== undefined ? { payload } : {}),
  };

  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const sdk = await ctx.sdk();
  const result = await sdk.notificationRules.test(orgId, ruleId, body);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }
  ctx.stdout(
    formatOutput({
      mode: "human",
      record: {
        matched: result.matched ? "yes" : "no",
        ruleStatus: result.ruleStatus,
        matchedTargets: String(result.matchedTargets.length),
      },
      title: `Rule ${ruleId} test`,
    }),
  );
  return { exitCode: 0 };
}
