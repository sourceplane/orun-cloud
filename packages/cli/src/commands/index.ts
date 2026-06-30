// Pilot read-only command handlers.
//
// Each handler is a thin adapter over the SDK + the output formatter. Per
// PR Boundary §3 this PR ships only:
//   - login / logout / whoami   (auth)
//   - org list / org use / org members
//   - project list
//
// Write commands (org invite, project create, env create, …) are Task 0101.

import type { CommandContext, CommandResult } from "../router.js";
import { formatOutput } from "../output/index.js";
import { MissingOrgContextError, UsageError } from "../errors.js";
import { loginFlow } from "../auth/login.js";
import { whoamiFlow } from "../auth/whoami.js";
import { logoutFlow } from "../auth/logout.js";
import { readBearerTokenFromStdin } from "../prompt.js";

export async function loginCommand(ctx: CommandContext): Promise<CommandResult> {
  const apiUrlFlag = ctx.flags["api-url"];
  const tokenFlag = ctx.flags["token"];
  const apiUrl = typeof apiUrlFlag === "string" ? apiUrlFlag : undefined;
  const token = typeof tokenFlag === "string" ? tokenFlag : undefined;

  await loginFlow({
    ...(apiUrl !== undefined ? { apiUrl } : {}),
    ...(token !== undefined ? { token } : {}),
    outputMode: ctx.outputMode,
    tokenStore: ctx.tokenStore,
    contextStore: ctx.contextStore,
    stdout: ctx.stdout,
    readToken: () => readBearerTokenFromStdin(),
  });
  return { exitCode: 0 };
}

export async function logoutCommand(ctx: CommandContext): Promise<CommandResult> {
  await logoutFlow({
    outputMode: ctx.outputMode,
    tokenStore: ctx.tokenStore,
    contextStore: ctx.contextStore,
    stdout: ctx.stdout,
  });
  return { exitCode: 0 };
}

export async function whoamiCommand(ctx: CommandContext): Promise<CommandResult> {
  await whoamiFlow({
    outputMode: ctx.outputMode,
    tokenStore: ctx.tokenStore,
    contextStore: ctx.contextStore,
    stdout: ctx.stdout,
  });
  return { exitCode: 0 };
}

export async function orgListCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const result = await sdk.organizations.list();
  const cliCtx = await ctx.contextStore.load();
  const active = cliCtx.activeOrgId ?? null;

  // Human table leads with the durable Workspace ID (`ws_…`, WID5); the legacy
  // `org_<hex>` stays available in `--json`. `active` still keys on the stored
  // `org_<hex>` id (the context store holds that spelling).
  const rows = result.organizations.map((org) => ({
    active: org.id === active ? "*" : "",
    workspace: org.workspaceRef ?? org.id,
    name: org.name,
    slug: org.slug,
  }));

  if (ctx.outputMode === "json") {
    ctx.stdout(
      formatOutput({
        mode: "json",
        data: {
          activeOrgId: active,
          organizations: result.organizations,
        },
      }),
    );
  } else {
    ctx.stdout(
      formatOutput({
        mode: "human",
        columns: ["active", "workspace", "name", "slug"],
        rows,
      }),
    );
  }

  return { exitCode: 0 };
}

export async function orgUseCommand(ctx: CommandContext): Promise<CommandResult> {
  const orgId = ctx.args[0];
  if (orgId === undefined || orgId.length === 0) {
    throw new UsageError("usage: orun-cloud org use <org-id>");
  }
  // Validate the org exists by hitting the SDK; surface 404 as
  // OrunCloudError → friendly CLI message. The arg may be a `ws_`, slug, or
  // `org_<hex>` (the edge resolves all three, WID3); we store the canonical
  // `org_<hex>` the response carries as `id`.
  const sdk = await ctx.sdk();
  const { organization } = await sdk.organizations.get(orgId);
  await ctx.contextStore.setActiveOrg(organization.id);
  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: { activeOrgId: organization.id } }));
  } else {
    // Lead with the durable Workspace ID; show the legacy `org_<hex>` secondarily.
    const label = organization.workspaceRef
      ? `${organization.workspaceRef} (${organization.id})`
      : organization.id;
    ctx.stdout(`✓ Active workspace set to ${label}.`);
  }
  return { exitCode: 0 };
}

export async function orgMembersCommand(ctx: CommandContext): Promise<CommandResult> {
  const cliCtx = await ctx.contextStore.load();
  const orgId = cliCtx.activeOrgId;
  if (orgId === undefined || orgId.length === 0) {
    throw new MissingOrgContextError();
  }
  const sdk = await ctx.sdk();
  const result = await sdk.memberships.listMembers(orgId);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }

  // Lead the title with the durable Workspace ID (`ws_…`, WID5), showing the
  // legacy `org_<hex>` secondarily; fall back to the stored id if the lookup
  // fails (failure-soft — the member listing already succeeded).
  let title = `Members of ${orgId}`;
  try {
    const { organization } = await sdk.organizations.get(orgId);
    if (organization.workspaceRef) {
      title = `Members of ${organization.workspaceRef} (${organization.id})`;
    }
  } catch {
    // keep the orgId-only title
  }

  const rows = result.members.map((m) => ({
    id: m.id,
    subject: `${m.subjectType}:${m.subjectId}`,
    roles: m.roles.map((r) => r.role).join(","),
    status: m.status,
  }));
  ctx.stdout(
    formatOutput({
      mode: "human",
      columns: ["id", "subject", "roles", "status"],
      rows,
      title,
    }),
  );
  return { exitCode: 0 };
}

export async function projectListCommand(ctx: CommandContext): Promise<CommandResult> {
  const cliCtx = await ctx.contextStore.load();
  const orgId = cliCtx.activeOrgId;
  if (orgId === undefined || orgId.length === 0) {
    throw new MissingOrgContextError();
  }
  const sdk = await ctx.sdk();
  const result = await sdk.projects.list(orgId);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }

  const rows = result.projects.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    status: p.status,
  }));
  ctx.stdout(
    formatOutput({
      mode: "human",
      columns: ["id", "name", "slug", "status"],
      rows,
      title: `Projects in ${orgId}`,
    }),
  );
  return { exitCode: 0 };
}
