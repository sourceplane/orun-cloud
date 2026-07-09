// Session provisioning (saas-agents AG5 live slice, design §2 + §10.4): boot
// the sandbox a requested session runs in, on the workspace's OWN Daytona
// account, with the workspace's OWN Anthropic key injected at exec time.
//
// The gate fails loud (design §10.3): a missing or unverified provider
// connection refuses the spawn here — never mid-run. Key material transits
// this handler once, from custody resolve to the provider exec env; it is
// never persisted on the session (the sandbox JSONB carries the provider ref
// only) and never appears in an error surface.

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import type { ProviderConnection, Provider } from "@saas/db/agents";
import type { SandboxSpec } from "@saas/contracts/agents";
import { errorResponse, notFound, successResponse } from "../http.js";
import { toPublicSession } from "../mappers.js";

/** Egress the sandbox may reach by default (design §2): the platform, the
 * model provider, the git host, package registries. Extensions are
 * per-profile, audited. */
const DEFAULT_EGRESS = [
  "api.anthropic.com",
  "github.com",
  "objects.githubusercontent.com",
  "registry.npmjs.org",
  "proxy.golang.org",
];

/**
 * Connection selection (design §10.4): a workspace's sole connection for the
 * provider, or the one named `default` when several exist.
 */
async function pickConnection(
  deps: AgentsDeps,
  orgId: string,
  provider: Provider,
): Promise<ProviderConnection | { error: string }> {
  const rows = await deps.repo.listConnections({ orgId }, provider);
  if (rows.length === 0) return { error: `no ${provider} connection` };
  const chosen = rows.length === 1 ? rows[0]! : rows.find((c) => c.name === "default");
  if (!chosen) return { error: `several ${provider} connections and none named default` };
  if (chosen.status !== "verified") {
    return { error: `${provider} connection ${chosen.name} is ${chosen.status}` };
  }
  return chosen;
}

export async function handleProvisionSession(
  deps: AgentsDeps,
  orgId: string,
  sessionId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  if (!(await deps.authorize("organization.agent.session.create", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const session = await deps.repo.getSession({ orgId }, sessionId);
  if (!session) return notFound(requestId, sessionId);
  if (session.state !== "requested") {
    return errorResponse(
      "conflict",
      `Session is ${session.state}; only a requested session provisions`,
      409,
      requestId,
    );
  }
  if (!deps.providerKeys || !deps.sandboxes) {
    return errorResponse("internal_error", "Provisioning unavailable", 503, requestId);
  }

  // The spawn gate: both connections proven before anything boots.
  const daytona = await pickConnection(deps, orgId, "daytona");
  if ("error" in daytona) {
    return errorResponse("provider_connection_invalid", `Cannot provision: ${daytona.error}`, 409, requestId);
  }
  const anthropic = await pickConnection(deps, orgId, "anthropic");
  if ("error" in anthropic) {
    return errorResponse("provider_connection_invalid", `Cannot provision: ${anthropic.error}`, 409, requestId);
  }

  const daytonaKey = await deps.providerKeys.resolve(orgId, daytona.secretRef, actor, requestId);
  const anthropicKey = await deps.providerKeys.resolve(orgId, anthropic.secretRef, actor, requestId);
  if (!daytonaKey || !anthropicKey) {
    return errorResponse(
      "provider_connection_invalid",
      "No key material for a required provider connection",
      409,
      requestId,
    );
  }

  const provider = deps.sandboxes("daytona", daytonaKey, daytona.config);
  if (!provider) {
    return errorResponse("provider_unsupported", "No sandbox adapter for daytona", 503, requestId);
  }

  const cfg = daytona.config;
  const spec: SandboxSpec = {
    baseSnapshot: typeof cfg.snapshot === "string" && cfg.snapshot ? cfg.snapshot : "agents-base",
    ttlSeconds: typeof cfg.ttlSeconds === "number" && cfg.ttlSeconds > 0 ? cfg.ttlSeconds : 3600,
    egressAllow: DEFAULT_EGRESS,
    // Non-secret only — create-time env can outlive a suspend snapshot.
    env: {
      ORUN_SESSION_ID: session.publicId,
      ORUN_ORG_ID: orgId,
      ORUN_RUN_KIND: session.runKind,
      ...(session.taskKey ? { ORUN_TASK_KEY: session.taskKey } : {}),
    },
  };

  // The session credential the runtime dials home with (AG6 §3.2): minted for
  // the profile's service principal, bound to this session. Its TTL chain is
  // refreshed over the lease; a lapsed lease kills a runaway sandbox's
  // credential within one TTL.
  const profile = await deps.repo.getSessionProfile({ orgId }, sessionId);
  if (!profile) return notFound(requestId, sessionId);
  const sessionToken = deps.sessionTokens
    ? await deps.sessionTokens.mint(profile.principalId, orgId, session.publicId, requestId)
    : null;
  if (!sessionToken) {
    return errorResponse("internal_error", "Session credential mint failed", 502, requestId);
  }

  try {
    const ref = await provider.create(spec);
    try {
      // Secrets ride the exec env only (design §10.4): TTL'd with the
      // process, never in the manifest, never surviving suspend.
      await provider.exec(ref, ["orun", "agent", "serve"], {
        env: { ANTHROPIC_API_KEY: anthropicKey, ORUN_SESSION_TOKEN: sessionToken.token },
      });
    } catch (e) {
      // Over-destroy on ambiguity (design §2): a half-booted box is reclaimed.
      await provider.destroy(ref).catch(() => {});
      throw e;
    }
    const updated = await deps.repo.advanceSession(
      { orgId },
      {
        publicId: session.publicId,
        to: "provisioning",
        sandbox: { provider: "daytona", id: ref.id, connection: daytona.publicId },
      },
    );
    return successResponse(toPublicSession(updated), requestId);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "provider failure";
    await deps.repo.advanceSession(
      { orgId },
      {
        publicId: session.publicId,
        to: "failed",
        sandbox: { provider: "daytona", error: reason },
      },
    );
    return errorResponse("provider_verification_failed", `Provisioning failed: ${reason}`, 502, requestId);
  }
}
