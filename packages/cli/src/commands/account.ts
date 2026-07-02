// Account command handlers (teams-hub TH1d).
//
// Thin adapters over `@saas/sdk` `client.account.*` — the Account Hub surface
// from the terminal: the account's child workspaces (IT12), the derived
// account-member roster (TH1b), and account-role grant/list/revoke (WID6 +
// TH1a). `--org=ORG_ID` overrides the active org; every call accepts the
// account org or any child workspace and resolves up to the owning account
// server-side.

import type { CommandContext, CommandResult } from "../router.js";
import { formatOutput } from "../output/index.js";
import { UsageError } from "../errors.js";
import { resolveOrgId, readIdempotencyKey } from "./helpers.js";

function emitRecord(ctx: CommandContext, record: Readonly<Record<string, string>>, jsonData: unknown, title: string): void {
  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: jsonData }));
    return;
  }
  ctx.stdout(formatOutput({ mode: "human", record, title }));
}

function requireArg(value: string | undefined, usage: string): string {
  if (value === undefined || value.length === 0) throw new UsageError(usage);
  return value;
}

function strFlag(ctx: CommandContext, name: string): string | undefined {
  const v = ctx.flags[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// account workspaces
export async function accountWorkspacesCommand(ctx: CommandContext): Promise<CommandResult> {
  const orgId = await resolveOrgId(ctx, true);
  const sdk = await ctx.sdk();
  const result = await sdk.account.workspaces(orgId);
  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }
  ctx.stdout(formatOutput({
    mode: "human",
    columns: ["workspaceRef", "orgId", "name"],
    rows: result.workspaces.map((w) => ({ workspaceRef: w.workspaceRef, orgId: w.orgId, name: w.name })),
    title: `Workspaces under the account of ${orgId}`,
  }));
  return { exitCode: 0 };
}

// account members
export async function accountMembersCommand(ctx: CommandContext): Promise<CommandResult> {
  const orgId = await resolveOrgId(ctx, true);
  const sdk = await ctx.sdk();
  const result = await sdk.account.members(orgId);
  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }
  ctx.stdout(formatOutput({
    mode: "human",
    columns: ["subject", "origin", "accountRoles", "status"],
    rows: result.members.map((m) => ({
      subject: `${m.subjectType}:${m.subjectId}`,
      origin: m.origin,
      accountRoles: m.accountRoles.join(", "),
      status: m.status ?? "",
    })),
    title: `Account members (derived) for ${orgId}`,
  }));
  return { exitCode: 0 };
}

// account roles
export async function accountRolesCommand(ctx: CommandContext): Promise<CommandResult> {
  const orgId = await resolveOrgId(ctx, true);
  const sdk = await ctx.sdk();
  const result = await sdk.account.roles(orgId);
  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }
  ctx.stdout(formatOutput({
    mode: "human",
    columns: ["subject", "role", "since"],
    rows: result.assignments.map((a) => ({
      subject: `${a.subjectType}:${a.subjectId}`,
      role: a.role,
      since: a.createdAt,
    })),
    title: `Account roles for ${orgId}`,
  }));
  return { exitCode: 0 };
}

// account catalog [--kind=K] [--q=TEXT] [--environment=ENV] [--limit=N]
export async function accountCatalogCommand(ctx: CommandContext): Promise<CommandResult> {
  const orgId = await resolveOrgId(ctx, true);
  const sdk = await ctx.sdk();
  const kind = strFlag(ctx, "kind");
  const q = strFlag(ctx, "q");
  const environment = strFlag(ctx, "environment");
  const result = await sdk.account.catalog(orgId, {
    ...(kind ? { kind } : {}),
    ...(q ? { q } : {}),
    ...(environment ? { environment } : {}),
  });
  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }
  const rows = result.workspaces.flatMap((w) =>
    w.entities.map((e) => {
      const ent = e as { ref?: string; name?: string; kind?: string };
      return {
        workspace: w.workspace.workspaceRef || w.workspace.name,
        entity: ent.ref ?? ent.name ?? "",
        kind: ent.kind ?? "",
      };
    }),
  );
  ctx.stdout(formatOutput({
    mode: "human",
    columns: ["workspace", "entity", "kind"],
    rows,
    title: `Catalog across the account of ${orgId}${result.truncated ? " (truncated)" : ""}`,
  }));
  emitSkippedWorkspaces(ctx, result.workspaces.map((w) => ({ status: w.status, tag: w.workspace.workspaceRef || w.workspace.name })));
  return { exitCode: 0 };
}

// account runs [--status=S] [--environment=ENV] [--limit=N]
export async function accountRunsCommand(ctx: CommandContext): Promise<CommandResult> {
  const orgId = await resolveOrgId(ctx, true);
  const sdk = await ctx.sdk();
  const status = strFlag(ctx, "status");
  const environment = strFlag(ctx, "environment");
  const result = await sdk.account.runs(orgId, {
    ...(status ? { status } : {}),
    ...(environment ? { environment } : {}),
  });
  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }
  const rows = result.workspaces.flatMap((w) =>
    w.runs.map((r) => {
      const run = r as { id?: string; status?: string; environment?: string };
      return {
        workspace: w.workspace.workspaceRef || w.workspace.name,
        run: run.id ?? "",
        status: run.status ?? "",
        environment: run.environment ?? "",
      };
    }),
  );
  ctx.stdout(formatOutput({
    mode: "human",
    columns: ["workspace", "run", "status", "environment"],
    rows,
    title: `Runs across the account of ${orgId}${result.truncated ? " (truncated)" : ""}`,
  }));
  emitSkippedWorkspaces(ctx, result.workspaces.map((w) => ({ status: w.status, tag: w.workspace.workspaceRef || w.workspace.name })));
  return { exitCode: 0 };
}

/** Per-workspace fan-out honesty: name the workspaces that returned nothing
 * because the read was denied or failed, instead of silently omitting them. */
function emitSkippedWorkspaces(ctx: CommandContext, rows: Array<{ status: string; tag: string }>): void {
  const denied = rows.filter((r) => r.status === "denied").map((r) => r.tag);
  const errored = rows.filter((r) => r.status === "error").map((r) => r.tag);
  if (denied.length > 0) ctx.stdout(`(no access: ${denied.join(", ")})`);
  if (errored.length > 0) ctx.stdout(`(unavailable: ${errored.join(", ")})`);
}

// account grant <subjectId> --role=account_owner|account_admin|account_billing_admin
export async function accountGrantCommand(ctx: CommandContext): Promise<CommandResult> {
  const usage = "usage: orun-cloud account grant <subjectId> --role=account_owner|account_admin|account_billing_admin [--org=ORG_ID]";
  const subjectId = requireArg(ctx.args[0], usage);
  const role = requireArg(strFlag(ctx, "role"), "account grant requires --role=ROLE");
  const orgId = await resolveOrgId(ctx, true);
  const idempotencyKey = readIdempotencyKey(ctx);
  const sdk = await ctx.sdk();
  const result = await sdk.account.grantRole(orgId, { subjectId, role }, idempotencyKey !== undefined ? { idempotencyKey } : {});
  emitRecord(ctx, { subjectId, role: result.assignment.role, scope: result.assignment.scopeKind }, result, "Account role granted");
  return { exitCode: 0 };
}

// account revoke <subjectId> --role=ROLE
export async function accountRevokeCommand(ctx: CommandContext): Promise<CommandResult> {
  const usage = "usage: orun-cloud account revoke <subjectId> --role=ROLE [--org=ORG_ID]";
  const subjectId = requireArg(ctx.args[0], usage);
  const role = requireArg(strFlag(ctx, "role"), "account revoke requires --role=ROLE");
  const orgId = await resolveOrgId(ctx, true);
  const sdk = await ctx.sdk();
  const result = await sdk.account.revokeRole(orgId, { subjectId, role });
  emitRecord(ctx, { subjectId, role, revoked: "true" }, result, "Account role revoked");
  return { exitCode: 0 };
}
