// Write-back proxy service (IG9 — outbound bridge, bridge-to-state.md
// "Outbound"). integrations-worker owns the App private key; it resolves a
// repo's installation, mints a SCOPED checks/statuses:write token, posts the
// run/PR result back to GitHub, and audits. state-worker drives this via the
// internal endpoint (IG9.3) on a run-result event — it never calls GitHub and
// never sees the App credential.
//
// Fail-soft: a repo with no active App link, an App lacking the write grant, a
// token-mint miss, or a GitHub error all resolve to a benign "skipped"/"failed"
// outcome — write-back is best-effort and NEVER breaks a run.

import type { Env } from "./env.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { asUuid } from "@saas/db/ids";
import { createIntegrationsRepository } from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import { INTEGRATION_EVENT_TYPES } from "@saas/contracts/integrations";
import {
  mintAppJwt,
  createScopedInstallationToken,
  createCheckRun,
  createCommitStatus,
  type CheckRunInput,
  type CommitStatusInput,
  type FetchLike,
  type PostedResource,
} from "./github-app.js";
import { permissionsWithinGrant } from "./handlers/token-broker.js";
import { generateUuid, orgPublicId } from "./ids.js";

export interface WritebackDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
}

export type WritebackOutcome =
  | { kind: "posted"; resource: PostedResource }
  /** Repo not App-linked, or App lacks the write grant — benign no-op. */
  | { kind: "skipped"; reason: string }
  /** Resolution/mint/GitHub failure — logged, never thrown. */
  | { kind: "failed"; reason: string };

async function dispose(executor: SqlExecutor): Promise<void> {
  if ("dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
    await (executor as unknown as { dispose: () => Promise<void> }).dispose();
  }
}

interface ResolvedInstall {
  installationId: number;
  connectionId: string;
  permissions: Record<string, unknown> | null;
}

// Resolve a repo's active App installation (repo_link → connection → installation)
// within an org, or null when the repo is not App-linked.
async function resolveInstallation(
  executor: SqlExecutor,
  orgId: Uuid,
  repoExternalId: string,
): Promise<ResolvedInstall | null> {
  const repo = createIntegrationsRepository(executor);
  const links = await repo.listActiveRepoLinksForRepo(orgId, repoExternalId);
  if (!links.ok || links.value.length === 0) return null;
  const connectionId = links.value[0]!.connectionId;
  const installation = await repo.getGithubInstallationByConnectionId(asUuid(connectionId));
  if (!installation.ok) return null;
  return {
    installationId: installation.value.installationId,
    connectionId,
    permissions: installation.value.permissions,
  };
}

async function mintScoped(
  env: Env,
  install: ResolvedInstall,
  repoExternalId: string,
  permissions: Record<string, "read" | "write">,
  fetchImpl: FetchLike | undefined,
): Promise<string | null> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return null;
  if (!permissionsWithinGrant(permissions, install.permissions)) return null;
  const jwt = await mintAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, Date.now());
  if (!jwt) return null;
  const repoId = Number(repoExternalId);
  if (!Number.isFinite(repoId)) return null;
  const minted = await createScopedInstallationToken(jwt, install.installationId, { repositoryIds: [repoId], permissions }, fetchImpl);
  return minted ? minted.token : null;
}

async function audit(
  executor: SqlExecutor,
  type: string,
  orgId: Uuid,
  connectionId: string,
  description: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const events = createEventsRepository(executor);
    await events.appendEventWithAudit({
      event: {
        id: generateUuid(),
        type,
        version: 1,
        source: "integrations-worker",
        occurredAt: new Date(),
        actorType: "system",
        actorId: "system:writeback",
        orgId,
        subjectKind: "integration_connection",
        subjectId: connectionId,
        requestId: generateUuid(),
        payload: { provider: "github", orgId: orgPublicId(orgId), ...payload },
      },
      audit: { id: generateUuid(), category: "integrations", description },
    });
  } catch {
    // Best-effort audit — the post already succeeded.
  }
}

export interface CheckRunWritebackInput {
  orgId: Uuid;
  repoExternalId: string;
  ownerRepo: string;
  checkRun: CheckRunInput;
}

/** Post a Check Run back to a linked repo. Fail-soft. */
export async function postCheckRun(env: Env, input: CheckRunWritebackInput, deps?: WritebackDeps): Promise<WritebackOutcome> {
  if (!env.PLATFORM_DB && !deps?.executor) return { kind: "failed", reason: "db_unavailable" };
  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const install = await resolveInstallation(executor, input.orgId, input.repoExternalId);
    if (!install) return { kind: "skipped", reason: "repo_not_app_linked" };
    const token = await mintScoped(env, install, input.repoExternalId, { checks: "write" }, deps?.fetchImpl);
    if (!token) return { kind: "skipped", reason: "checks_write_not_granted" };
    const posted = await createCheckRun(token, input.ownerRepo, input.checkRun, deps?.fetchImpl);
    if (!posted) return { kind: "failed", reason: "github_rejected" };
    await audit(executor, INTEGRATION_EVENT_TYPES.CHECKRUN_POSTED, input.orgId, install.connectionId,
      `Check Run "${input.checkRun.name}" posted to ${input.ownerRepo}@${input.checkRun.headSha.slice(0, 8)}`,
      { repo: input.ownerRepo, headSha: input.checkRun.headSha, name: input.checkRun.name, conclusion: input.checkRun.conclusion ?? null, checkRunId: posted.id });
    return { kind: "posted", resource: posted };
  } finally {
    if (owned) await dispose(executor);
  }
}

export interface CommitStatusWritebackInput {
  orgId: Uuid;
  repoExternalId: string;
  ownerRepo: string;
  status: CommitStatusInput;
}

/** Post a commit status back to a linked repo. Fail-soft. */
export async function postCommitStatus(env: Env, input: CommitStatusWritebackInput, deps?: WritebackDeps): Promise<WritebackOutcome> {
  if (!env.PLATFORM_DB && !deps?.executor) return { kind: "failed", reason: "db_unavailable" };
  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB!);
  const owned = !deps?.executor;
  try {
    const install = await resolveInstallation(executor, input.orgId, input.repoExternalId);
    if (!install) return { kind: "skipped", reason: "repo_not_app_linked" };
    const token = await mintScoped(env, install, input.repoExternalId, { statuses: "write" }, deps?.fetchImpl);
    if (!token) return { kind: "skipped", reason: "statuses_write_not_granted" };
    const posted = await createCommitStatus(token, input.ownerRepo, input.status, deps?.fetchImpl);
    if (!posted) return { kind: "failed", reason: "github_rejected" };
    await audit(executor, INTEGRATION_EVENT_TYPES.COMMIT_STATUS_POSTED, input.orgId, install.connectionId,
      `Commit status "${input.status.context}" (${input.status.state}) posted to ${input.ownerRepo}@${input.status.sha.slice(0, 8)}`,
      { repo: input.ownerRepo, sha: input.status.sha, context: input.status.context, state: input.status.state });
    return { kind: "posted", resource: posted };
  } finally {
    if (owned) await dispose(executor);
  }
}
