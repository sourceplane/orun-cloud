// Team command handlers (saas-teams TM4c2b).
//
// Thin adapters over `@saas/sdk` `client.teams.*`, mirroring the org/member
// commands. Reads render a table; writes render a single `key: value` record.
// `--org=ORG_ID` overrides the active org; teams are account-owned, so any org
// in the account resolves to the same account server-side.

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

// team list
export async function teamListCommand(ctx: CommandContext): Promise<CommandResult> {
  const orgId = await resolveOrgId(ctx, true);
  const sdk = await ctx.sdk();
  const result = await sdk.teams.listTeams(orgId);
  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }
  ctx.stdout(formatOutput({
    mode: "human",
    columns: ["id", "name", "handle", "slug", "status"],
    rows: result.teams.map((t) => ({ id: t.id, name: t.name, handle: t.handle ?? "", slug: t.slug, status: t.status })),
    title: `Teams in ${orgId}`,
  }));
  return { exitCode: 0 };
}

// team create <name> [--slug=SLUG] [--handle=HANDLE] [--description=TEXT] [--avatar=REF]
export async function teamCreateCommand(ctx: CommandContext): Promise<CommandResult> {
  const name = requireArg(ctx.args[0], "usage: orun-cloud team create <name> [--slug=SLUG] [--handle=HANDLE] [--description=TEXT] [--avatar=REF] [--org=ORG_ID]");
  const slug = strFlag(ctx, "slug");
  const handle = strFlag(ctx, "handle");
  const description = strFlag(ctx, "description");
  const avatar = strFlag(ctx, "avatar");
  const orgId = await resolveOrgId(ctx, true);
  const idempotencyKey = readIdempotencyKey(ctx);
  const sdk = await ctx.sdk();
  const result = await sdk.teams.createTeam(
    orgId,
    { name, ...(slug ? { slug } : {}), ...(handle ? { handle } : {}), ...(description ? { description } : {}), ...(avatar ? { avatar } : {}) },
    idempotencyKey !== undefined ? { idempotencyKey } : {},
  );
  emitRecord(ctx, { id: result.team.id, name: result.team.name, handle: result.team.handle ?? "", slug: result.team.slug }, result, "Team created");
  return { exitCode: 0 };
}

// team get <teamId>
export async function teamGetCommand(ctx: CommandContext): Promise<CommandResult> {
  const teamId = requireArg(ctx.args[0], "usage: orun-cloud team get <teamId> [--org=ORG_ID]");
  const orgId = await resolveOrgId(ctx, true);
  const sdk = await ctx.sdk();
  const result = await sdk.teams.getTeam(orgId, teamId);
  emitRecord(
    ctx,
    { id: result.team.id, name: result.team.name, handle: result.team.handle ?? "", slug: result.team.slug, description: result.team.description ?? "", status: result.team.status },
    result,
    "Team",
  );
  return { exitCode: 0 };
}

// team update <teamId> [--name=NAME] [--slug=SLUG] [--handle=HANDLE] [--description=TEXT] [--avatar=REF]
export async function teamUpdateCommand(ctx: CommandContext): Promise<CommandResult> {
  const teamId = requireArg(ctx.args[0], "usage: orun-cloud team update <teamId> [--name=NAME] [--slug=SLUG] [--handle=HANDLE] [--description=TEXT] [--avatar=REF] [--org=ORG_ID]");
  const name = strFlag(ctx, "name");
  const slug = strFlag(ctx, "slug");
  const handle = strFlag(ctx, "handle");
  const description = strFlag(ctx, "description");
  const avatar = strFlag(ctx, "avatar");
  if (name === undefined && slug === undefined && handle === undefined && description === undefined && avatar === undefined) {
    throw new UsageError("team update requires at least one of --name, --slug, --handle, --description, --avatar");
  }
  const orgId = await resolveOrgId(ctx, true);
  const sdk = await ctx.sdk();
  const result = await sdk.teams.updateTeam(orgId, teamId, {
    ...(name ? { name } : {}),
    ...(slug ? { slug } : {}),
    ...(handle ? { handle } : {}),
    ...(description ? { description } : {}),
    ...(avatar ? { avatar } : {}),
  });
  emitRecord(ctx, { id: result.team.id, name: result.team.name, handle: result.team.handle ?? "", slug: result.team.slug }, result, "Team updated");
  return { exitCode: 0 };
}

// team delete <teamId>
export async function teamDeleteCommand(ctx: CommandContext): Promise<CommandResult> {
  const teamId = requireArg(ctx.args[0], "usage: orun-cloud team delete <teamId> [--org=ORG_ID]");
  const orgId = await resolveOrgId(ctx, true);
  const sdk = await ctx.sdk();
  const result = await sdk.teams.deleteTeam(orgId, teamId);
  emitRecord(ctx, { id: result.team.id, status: result.team.status }, result, "Team deleted");
  return { exitCode: 0 };
}

// team members <teamId>
export async function teamMembersCommand(ctx: CommandContext): Promise<CommandResult> {
  const teamId = requireArg(ctx.args[0], "usage: orun-cloud team members <teamId> [--org=ORG_ID]");
  const orgId = await resolveOrgId(ctx, true);
  const sdk = await ctx.sdk();
  const result = await sdk.teams.listTeamMembers(orgId, teamId);
  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }
  ctx.stdout(formatOutput({
    mode: "human",
    columns: ["subject", "status"],
    rows: result.members.map((m) => ({ subject: `${m.subjectType}:${m.subjectId}`, status: m.status })),
    title: `Members of ${teamId}`,
  }));
  return { exitCode: 0 };
}

// team member-add <teamId> <subjectId> [--type=user|service_principal]
export async function teamMemberAddCommand(ctx: CommandContext): Promise<CommandResult> {
  const teamId = requireArg(ctx.args[0], "usage: orun-cloud team member-add <teamId> <subjectId> [--type=user|service_principal] [--org=ORG_ID]");
  const subjectId = requireArg(ctx.args[1], "usage: orun-cloud team member-add <teamId> <subjectId> [--type=user|service_principal] [--org=ORG_ID]");
  const subjectType = strFlag(ctx, "type");
  const orgId = await resolveOrgId(ctx, true);
  const idempotencyKey = readIdempotencyKey(ctx);
  const sdk = await ctx.sdk();
  const result = await sdk.teams.addTeamMember(orgId, teamId, { subjectId, ...(subjectType ? { subjectType } : {}) }, idempotencyKey !== undefined ? { idempotencyKey } : {});
  emitRecord(ctx, { subject: `${result.member.subjectType}:${result.member.subjectId}`, status: result.member.status }, result, "Member added");
  return { exitCode: 0 };
}

// team member-remove <teamId> <subjectId>
export async function teamMemberRemoveCommand(ctx: CommandContext): Promise<CommandResult> {
  const teamId = requireArg(ctx.args[0], "usage: orun-cloud team member-remove <teamId> <subjectId> [--org=ORG_ID]");
  const subjectId = requireArg(ctx.args[1], "usage: orun-cloud team member-remove <teamId> <subjectId> [--org=ORG_ID]");
  const orgId = await resolveOrgId(ctx, true);
  const sdk = await ctx.sdk();
  const result = await sdk.teams.removeTeamMember(orgId, teamId, subjectId);
  emitRecord(ctx, { subject: `${result.member.subjectType}:${result.member.subjectId}`, status: result.member.status }, result, "Member removed");
  return { exitCode: 0 };
}

function formatVia(via?: { kind: string; teamId?: string }): string {
  if (!via) return "";
  if (via.kind === "team") return `team ${via.teamId ?? ""}`.trim();
  if (via.kind === "account_cascade") return "account";
  return "direct";
}

// team access [subjectId] [--project=ID]
export async function teamAccessCommand(ctx: CommandContext): Promise<CommandResult> {
  const subjectId = ctx.args[0];
  const project = strFlag(ctx, "project");
  const orgId = await resolveOrgId(ctx, true);
  const sdk = await ctx.sdk();
  const result = await sdk.teams.effectiveAccess(orgId, {
    ...(subjectId ? { subjectId } : {}),
    ...(project ? { projectId: project } : {}),
  });
  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }
  const allowed = result.permissions.filter((p) => p.allow);
  ctx.stdout(formatOutput({
    mode: "human",
    columns: ["action", "via"],
    rows: allowed.map((p) => ({ action: p.action, via: formatVia(p.via) })),
    title: `Effective access for ${subjectId ?? "you"} in ${orgId}`,
  }));
  return { exitCode: 0 };
}

// team grant <teamId> --role=ROLE --scope=account|organization|project [--scope-ref=PROJECT_ID]
export async function teamGrantCommand(ctx: CommandContext): Promise<CommandResult> {
  const teamId = requireArg(ctx.args[0], "usage: orun-cloud team grant <teamId> --role=ROLE --scope=account|organization|project [--scope-ref=PROJECT_ID] [--org=ORG_ID]");
  const role = requireArg(strFlag(ctx, "role"), "team grant requires --role=ROLE");
  const scope = requireArg(strFlag(ctx, "scope"), "team grant requires --scope=account|organization|project");
  const scopeRef = strFlag(ctx, "scope-ref");
  const orgId = await resolveOrgId(ctx, true);
  const idempotencyKey = readIdempotencyKey(ctx);
  const sdk = await ctx.sdk();
  const result = await sdk.teams.grantTeamRole(
    orgId,
    { teamId, role, scopeKind: scope as "account" | "organization" | "project", ...(scopeRef ? { scopeRef } : {}) },
    idempotencyKey !== undefined ? { idempotencyKey } : {},
  );
  emitRecord(ctx, { teamId, role: result.grant.role, scope: result.grant.scopeKind, scopeRef: result.grant.scopeRef ?? "" }, result, "Team granted");
  return { exitCode: 0 };
}

// team revoke <teamId> --role=ROLE --scope=account|organization|project [--scope-ref=PROJECT_ID]
export async function teamRevokeCommand(ctx: CommandContext): Promise<CommandResult> {
  const teamId = requireArg(ctx.args[0], "usage: orun-cloud team revoke <teamId> --role=ROLE --scope=account|organization|project [--scope-ref=PROJECT_ID] [--org=ORG_ID]");
  const role = requireArg(strFlag(ctx, "role"), "team revoke requires --role=ROLE");
  const scope = requireArg(strFlag(ctx, "scope"), "team revoke requires --scope=account|organization|project");
  const scopeRef = strFlag(ctx, "scope-ref");
  const orgId = await resolveOrgId(ctx, true);
  const sdk = await ctx.sdk();
  const result = await sdk.teams.revokeTeamRole(
    orgId,
    { teamId, role, scopeKind: scope as "account" | "organization" | "project", ...(scopeRef ? { scopeRef } : {}) },
  );
  emitRecord(ctx, { teamId, role, scope }, result, "Team grant revoked");
  return { exitCode: 0 };
}
