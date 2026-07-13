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
import { uuidToHex } from "@saas/db/ids";

/** The scope orgId is the UUID (authz + DB); the runtime dials the public API,
 * so its env + credential carry the public `org_<hex>` id. */
function orgPublicId(orgUuid: string): string {
  return `org_${uuidToHex(orgUuid)}`;
}

/**
 * Boot-path trace (matching the `[agents-sweep] …` style in index.ts, which
 * likewise emits operational telemetry on console.warn). Every pre-dial-home
 * step is otherwise invisible — a 100%-failing spawn surfaces nothing — so we
 * log the step, the ids, the provider, and (on failure) the redacted reason.
 * NEVER a key, token, or provider body: `extra` is caller-curated non-secret
 * detail only.
 */
function logBoot(sessionPublicId: string, orgPublic: string, step: string, extra = ""): void {
  console.warn(
    `[agents-provision] session=${sessionPublicId} org=${orgPublic} step=${step}${extra ? ` ${extra}` : ""}`,
  );
}

/** Egress the sandbox may reach by default (design §2): the platform, the
 * model provider, the git host, package registries. Extensions are
 * per-profile, audited. */
const DEFAULT_EGRESS = [
  "api.anthropic.com",
  "github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "proxy.golang.org",
];

/**
 * The in-sandbox bootstrap (saas-agents-live AL8, retiring the bash stand-in):
 * install orun if the image lacks it, then hand off to **`orun agent serve`** —
 * the real runtime entrypoint (orun-agents-live AL4). serve IS the supervisor:
 * it hosts the attach plane, dials the per-session relay (heartbeat, token
 * rotation, event ingest, the steer/verdict return-queue all live in the
 * binary now), and seals on terminal state. The control plane stops
 * supervising the agent — it provisions the box, injects the credential, and
 * starts serve, exactly the "orun is the supervisor" split (saas-agents §0).
 *
 * serve reads its identity from the create-time env (ORUN_SESSION_ID/ORG_ID/
 * CLOUD_API/RUN_KIND/TASK_KEY) and the session bearer from ORUN_SESSION_TOKEN
 * on the exec env.
 */
const ORUN_INSTALL_URL = "https://raw.githubusercontent.com/sourceplane/orun/main/install.sh";

function bootstrapScript(): string {
  return [
    "set -u",
    'export PATH="$HOME/.local/bin:$PATH"',
    // ALWAYS install the released binary — never `command -v orun ||` short-
    // circuit. A stale orun baked into a Daytona snapshot used to satisfy that
    // guard, so the install was SKIPPED and the box ran an old binary: relay /
    // pump fixes shipped release after release and never actually ran (the
    // heartbeat "worked" only because it predated the breakage). install.sh is
    // idempotent; running it every boot guarantees the sandbox runs what's
    // released. (#466 follow-up.)
    `curl -fsSL ${ORUN_INSTALL_URL} | sh || { echo 'orun install failed' >&2; exit 1; }`,
    // Loud: record which binary actually ended up here (the diagnostic whose
    // absence cost three release cycles). Echoed to the sandbox log; the
    // control plane also probes it into the provision trace (versionProbe).
    'echo "orun-resolved-version: $(orun --version 2>/dev/null || echo unknown)" >&2',
    // Hand off to the runtime. serve reads ORUN_SESSION_ID/ORG_ID/CLOUD_API/
    // TASK_KEY from the env and the bearer from ORUN_SESSION_TOKEN; it
    // heartbeats, rotates the token, streams events, and serves the relay.
    "exec orun agent serve",
  ].join("\n");
}

/** A synchronous install + `orun --version` the control plane runs BEFORE serve
 * so the resolved binary version lands in the provision trace — no more
 * inferring "which orun is running" from behavior. Best-effort: a cold-pull
 * timeout or a probe failure logs `unknown` and never blocks the spawn. */
function versionProbeScript(): string {
  return [
    'export PATH="$HOME/.local/bin:$PATH"',
    `curl -fsSL ${ORUN_INSTALL_URL} | sh >/dev/null 2>&1 || true`,
    "orun --version 2>/dev/null || echo unknown",
  ].join("\n");
}

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

  const orgPublic = orgPublicId(orgId);
  const cfg = daytona.config;
  const spec: SandboxSpec = {
    // Only a connection-pinned snapshot is ever named; otherwise the account's
    // default image boots and the bootstrap installs orun (a made-up name
    // would 404 the create against the workspace's own Daytona account).
    ...(typeof cfg.snapshot === "string" && cfg.snapshot ? { baseSnapshot: cfg.snapshot } : {}),
    ttlSeconds: typeof cfg.ttlSeconds === "number" && cfg.ttlSeconds > 0 ? cfg.ttlSeconds : 3600,
    egressAllow: DEFAULT_EGRESS,
    // Non-secret only — create-time env can outlive a suspend snapshot. The
    // runtime calls the public API, so ORUN_ORG_ID is the public org id.
    env: {
      ORUN_SESSION_ID: session.publicId,
      ORUN_ORG_ID: orgPublic,
      ORUN_RUN_KIND: session.runKind,
      ...(session.taskKey ? { ORUN_TASK_KEY: session.taskKey } : {}),
      ...(deps.apiBaseUrl ? { ORUN_CLOUD_API: deps.apiBaseUrl } : {}),
    },
  };

  // The session credential the runtime dials home with (AG6 §3.2): minted for
  // the profile's service principal, bound to this session. Its TTL chain is
  // refreshed over the lease; a lapsed lease kills a runaway sandbox's
  // credential within one TTL.
  const profile = await deps.repo.getSessionProfile({ orgId }, sessionId);
  if (!profile) return notFound(requestId, sessionId);
  const sessionToken = deps.sessionTokens
    ? await deps.sessionTokens.mint(profile.principalId, orgPublic, session.publicId, requestId)
    : null;
  if (!sessionToken) {
    return errorResponse("internal_error", "Session credential mint failed", 502, requestId);
  }

  // The step reached when a throw lands, so the failure log names WHERE the
  // boot died (create vs exec) — the pre-dial-home blind spot the audit hit.
  let step = "create";
  try {
    logBoot(session.publicId, orgPublic, "create.start", "provider=daytona");
    const ref = await provider.create(spec);
    logBoot(session.publicId, orgPublic, "create.ok", `provider=daytona sandbox=${ref.id}`);

    // Probe the resolved orun version into the trace BEFORE serve — every run
    // now records which binary it actually runs, so a stale-baked image can
    // never again masquerade as a shipped fix. Best-effort: a probe failure or
    // cold-pull timeout logs `probe_failed`/`unknown` and never blocks the boot
    // (the bootstrap force-installs regardless).
    if (provider.execCapture) {
      try {
        const probe = await provider.execCapture(ref, ["sh", "-lc", versionProbeScript()]);
        const version = (probe.stdout.split("\n").filter(Boolean).pop() ?? "unknown").slice(0, 80);
        logBoot(session.publicId, orgPublic, "orun.version", `provider=daytona sandbox=${ref.id} version=${version}`);
      } catch {
        logBoot(session.publicId, orgPublic, "orun.version", `provider=daytona sandbox=${ref.id} version=probe_failed`);
      }
    }

    step = "exec";
    try {
      // Secrets ride the exec env only (design §10.4): TTL'd with the
      // process, never in the manifest, never surviving suspend.
      await provider.exec(ref, ["sh", "-lc", bootstrapScript()], {
        env: { ANTHROPIC_API_KEY: anthropicKey, ORUN_SESSION_TOKEN: sessionToken.token },
      });
    } catch (e) {
      // Over-destroy on ambiguity (design §2): a half-booted box is reclaimed.
      await provider.destroy(ref).catch(() => {});
      throw e;
    }
    logBoot(session.publicId, orgPublic, "exec.ok", `provider=daytona sandbox=${ref.id}`);
    step = "advance";
    const updated = await deps.repo.advanceSession(
      { orgId },
      {
        publicId: session.publicId,
        to: "provisioning",
        sandbox: { provider: "daytona", id: ref.id, connection: daytona.publicId },
      },
    );
    // The box is up and the bootstrap is running; the session now waits on the
    // runtime's first heartbeat to flip provisioning → running (see runtime.ts).
    logBoot(session.publicId, orgPublic, "provisioning", `provider=daytona sandbox=${ref.id} awaiting=heartbeat`);
    // AG10 §8: one agents.sessions_started per boot. Fire-and-forget — a
    // lost sample is a reconciliation problem, never a failed spawn.
    void deps.usage?.record(
      orgId,
      "agents.sessions_started",
      1,
      { runKind: session.runKind, profile: profile.publicId },
      actor,
      requestId,
    );
    return successResponse(toPublicSession(updated), requestId);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "provider failure";
    // The reason is already redacted at the provider seam (status code only);
    // logging it names the failing step so the next 400/404 is diagnosable.
    logBoot(session.publicId, orgPublic, `${step}.failed`, `provider=daytona reason=${reason}`);
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
