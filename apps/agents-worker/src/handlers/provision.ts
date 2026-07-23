// Session provisioning (saas-agents AG5 live slice, design §2 + §10.4): boot
// the sandbox a requested session runs in, on the workspace's OWN Daytona
// account, with the workspace's OWN model-provider key injected at exec time.
//
// The model provider is no longer hard-wired to Anthropic (the DX-Q6 posture,
// now on the session path too): the sandbox boots with whichever verified
// model connection the workspace picks — the one the
// `agents.sessions.connection` setting names (Settings › AI providers), else
// the sole verified model connection, else the one named `default`. Anthropic
// keys ride as ANTHROPIC_API_KEY; OpenAI/OpenRouter connections ride their
// Anthropic-compatible gateway (`config.baseUrl`) as ANTHROPIC_BASE_URL +
// ANTHROPIC_AUTH_TOKEN — the claude-code harness convention.
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
import { ManagedAgentsError, type ManagedSpawnSpec } from "../providers/managed-agents.js";
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

/** The default egress plus the hosts THIS boot actually dials: the platform
 * API (dial-home — heartbeat/events/token would be unreachable under an
 * enforced allowlist that omits it) and the model gateway, when one is set. */
function egressAllow(apiBaseUrl?: string, modelBaseUrl?: string): string[] {
  const hosts = new Set(DEFAULT_EGRESS);
  for (const raw of [apiBaseUrl, modelBaseUrl]) {
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).hostname);
    } catch {
      // A malformed URL never blocks the spawn; the default list stands.
    }
  }
  return [...hosts];
}

/** The org setting naming the model connection sandbox sessions boot with
 * (Settings › AI providers — the session mirror of `agents.chat.connection`). */
export const SESSION_MODEL_SETTING_KEY = "agents.sessions.connection";

/** Providers that supply a model key (Daytona is compute, excluded). Keep in
 * lockstep with @saas/db/agents MODEL_PROVIDERS. */
const MODEL_PROVIDERS = new Set<Provider>(["anthropic", "openai", "openrouter"]);

/**
 * pickSessionModelConnection — the session-path mirror of chat-worker
 * custody's rule (DX-Q6): the connection the `agents.sessions.connection`
 * setting names, if present + verified; else the sole verified model
 * connection; else the one named `default`; else an actionable refusal.
 */
function pickSessionModelConnection(
  connections: ProviderConnection[],
  preferredId: string | null,
): ProviderConnection | { error: string } {
  const rows = connections.filter((c) => MODEL_PROVIDERS.has(c.provider) && c.status === "verified");
  if (rows.length === 0) {
    return { error: "no verified model provider connection (connect one under Settings › AI providers)" };
  }
  if (preferredId) {
    const chosen = rows.find((c) => c.publicId === preferredId);
    if (chosen) return chosen;
  }
  if (rows.length === 1) return rows[0]!;
  const byName = rows.find((c) => c.name === "default");
  if (byName) return byName;
  return {
    error:
      "several model provider connections and none selected — pick a session model under Settings › AI providers",
  };
}

/** OpenRouter's Anthropic-compatible endpoint (the "Anthropic skin"): the
 * claude-code harness speaks its native Messages protocol to this base. Any
 * other openrouter.ai URL (the site root, the OpenAI-compatible /api/v1)
 * answers /v1/messages with the WEBSITE's HTML 404 — so a connection pinned
 * at openrouter.ai is canonicalized here rather than left to fail mid-run. */
const OPENROUTER_ANTHROPIC_BASE = "https://openrouter.ai/api";

/** The gateway base a non-Anthropic connection rides: the configured baseUrl,
 * canonicalized for known hosts; OpenRouter defaults when none is set. */
function gatewayBaseUrl(provider: Provider, cfg: Record<string, unknown>): string {
  const raw = typeof cfg.baseUrl === "string" && cfg.baseUrl ? cfg.baseUrl.replace(/\/$/, "") : "";
  if (provider === "openrouter") {
    if (!raw) return OPENROUTER_ANTHROPIC_BASE;
    try {
      if (new URL(raw).hostname === "openrouter.ai") return OPENROUTER_ANTHROPIC_BASE;
    } catch {
      // Malformed → fall through to the raw string; the verify ping caught
      // real garbage at connect time.
    }
  }
  return raw;
}

/**
 * Model env for the exec (claude-code harness convention): Anthropic keys ride
 * natively as ANTHROPIC_API_KEY; OpenAI/OpenRouter connections ride an
 * Anthropic-compatible gateway as ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
 * (OpenRouter's skin is the default; OpenAI needs an explicit gateway). The
 * pinned model (connection defaultModel, else the profile's) rides as
 * ANTHROPIC_MODEL so the harness runs what the profile says — never its own
 * default.
 */
function modelEnvForConnection(
  connection: ProviderConnection,
  key: string,
  profileModel: string,
): { env: Record<string, string>; baseUrl?: string } | { error: string } {
  const cfg = connection.config;
  const pinned = typeof cfg.defaultModel === "string" && cfg.defaultModel.trim() ? cfg.defaultModel.trim() : "";
  const model = pinned || profileModel;
  if (connection.provider === "anthropic") {
    const baseUrl = typeof cfg.baseUrl === "string" && cfg.baseUrl ? cfg.baseUrl.replace(/\/$/, "") : "";
    return {
      env: {
        ANTHROPIC_API_KEY: key,
        ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
        ...(model ? { ANTHROPIC_MODEL: model } : {}),
      },
      ...(baseUrl ? { baseUrl } : {}),
    };
  }
  const baseUrl = gatewayBaseUrl(connection.provider, cfg);
  if (!baseUrl) {
    return {
      error: `${connection.provider} connection ${connection.name} needs a Base URL (an Anthropic-compatible endpoint) to power sandbox sessions — set one under Settings › AI providers, or select an Anthropic connection`,
    };
  }
  if (!model) {
    return {
      error: `${connection.provider} connection ${connection.name} has no model set — pin a Default model under Settings › AI providers`,
    };
  }
  return { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: model }, baseUrl };
}

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
  if (!deps.providerKeys) {
    return errorResponse("internal_error", "Provisioning unavailable", 503, requestId);
  }

  const profile = await deps.repo.getSessionProfile({ orgId }, sessionId);
  if (!profile) return notFound(requestId, sessionId);

  // DX7 — the second executor: a profile on the anthropic-managed interface
  // provisions a Claude Managed Agents cloud session instead of a sandbox.
  if (profile.interface === "anthropic-managed") {
    return provisionManaged(deps, orgId, session, profile, actor, requestId);
  }

  if (!deps.sandboxes) {
    return errorResponse("internal_error", "Provisioning unavailable", 503, requestId);
  }

  // The spawn gate: both connections proven before anything boots.
  const daytona = await pickConnection(deps, orgId, "daytona");
  if ("error" in daytona) {
    return errorResponse("provider_connection_invalid", `Cannot provision: ${daytona.error}`, 409, requestId);
  }

  // The model connection: the workspace's explicit session choice (the
  // `agents.sessions.connection` setting, read best-effort — a settings
  // outage falls back to sole-or-default), else sole, else `default`.
  const orgPublicForSetting = orgPublicId(orgId);
  const preferredModelId = deps.orgSettings
    ? await deps.orgSettings(orgPublicForSetting, SESSION_MODEL_SETTING_KEY, actor, requestId)
    : null;
  const modelConnection = pickSessionModelConnection(
    await deps.repo.listConnections({ orgId }),
    preferredModelId,
  );
  if ("error" in modelConnection) {
    return errorResponse("provider_connection_invalid", `Cannot provision: ${modelConnection.error}`, 409, requestId);
  }

  const daytonaKey = await deps.providerKeys.resolve(orgId, daytona.secretRef, actor, requestId);
  const modelKey = await deps.providerKeys.resolve(orgId, modelConnection.secretRef, actor, requestId);
  if (!daytonaKey || !modelKey) {
    return errorResponse(
      "provider_connection_invalid",
      "No key material for a required provider connection",
      409,
      requestId,
    );
  }

  const modelEnv = modelEnvForConnection(modelConnection, modelKey, profile.model);
  if ("error" in modelEnv) {
    return errorResponse("provider_connection_invalid", `Cannot provision: ${modelEnv.error}`, 409, requestId);
  }

  const provider = deps.sandboxes("daytona", daytonaKey, daytona.config);
  if (!provider) {
    return errorResponse("provider_unsupported", "No sandbox adapter for daytona", 503, requestId);
  }

  const orgPublic = orgPublicId(orgId);
  const cfg = daytona.config;
  // Non-secret identity/config the runtime needs to dial home. It rides BOTH
  // the create-time manifest (so a suspend snapshot keeps it) AND the exec env
  // below: Daytona's toolbox session exec does NOT inherit the create-time
  // sandbox env, so a serve started with manifest-only identity booted blind —
  // checkServeIdentity exited before the first heartbeat and every session
  // was swept `failed(lease_lost)` ("task rung untouched"). The exec env is
  // the copy that actually reaches the process.
  const identityEnv: Record<string, string> = {
    ORUN_SESSION_ID: session.publicId,
    ORUN_ORG_ID: orgPublic,
    ORUN_RUN_KIND: session.runKind,
    ...(session.taskKey ? { ORUN_TASK_KEY: session.taskKey } : {}),
    ...(deps.apiBaseUrl ? { ORUN_CLOUD_API: deps.apiBaseUrl } : {}),
  };
  const spec: SandboxSpec = {
    // Only a connection-pinned snapshot is ever named; otherwise the account's
    // default image boots and the bootstrap installs orun (a made-up name
    // would 404 the create against the workspace's own Daytona account).
    ...(typeof cfg.snapshot === "string" && cfg.snapshot ? { baseSnapshot: cfg.snapshot } : {}),
    ttlSeconds: typeof cfg.ttlSeconds === "number" && cfg.ttlSeconds > 0 ? cfg.ttlSeconds : 3600,
    egressAllow: egressAllow(deps.apiBaseUrl, "baseUrl" in modelEnv ? modelEnv.baseUrl : undefined),
    env: identityEnv,
  };

  // The session credential the runtime dials home with (AG6 §3.2): minted for
  // the profile's service principal, bound to this session. Its TTL chain is
  // refreshed over the lease; a lapsed lease kills a runaway sandbox's
  // credential within one TTL.
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
    logBoot(session.publicId, orgPublic, "create.start", `provider=daytona model=${modelConnection.provider}`);
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
      // process, never in the manifest, never surviving suspend. The
      // identity env rides here TOO — the toolbox session exec is the only
      // env the serve process is guaranteed to see (the lease_lost fix).
      await provider.exec(ref, ["sh", "-lc", bootstrapScript()], {
        env: { ...identityEnv, ...modelEnv.env, ORUN_SESSION_TOKEN: sessionToken.token },
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
        sandbox: {
          provider: "daytona",
          id: ref.id,
          connection: daytona.publicId,
          // Which model connection this boot rode (observability; never a key).
          modelConnection: modelConnection.publicId,
          modelProvider: modelConnection.provider,
        },
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

// ── DX7: the anthropic-managed executor (saas-dispatch design §10) ──────────

/** The definition-time tool allowlist a managed run gets. The managed
 * runtime has NO verdict channel, so narrowing at agent-definition time is
 * the only enforcement — a profile without an explicit ceiling cannot ride
 * this interface (the no-ask rule, structural). */
function managedToolAllowlist(capability: Record<string, unknown>): string[] | null {
  const raw = capability.tools;
  if (!Array.isArray(raw)) return null;
  const tools = raw.filter((t): t is string => typeof t === "string");
  return tools.length > 0 ? tools : null;
}

function managedSystemPrompt(orgPublic: string, runKind: string): string {
  return [
    "You are a governed delegation run for a sourceplane workspace, executing on the anthropic-managed interface.",
    "Your toolset was narrowed at definition time and cannot widen mid-run; there is no approval channel — if a step",
    "needs a permission you do not hold, state exactly what is missing and end. You cannot assert work-plane progress:",
    "your transcript is the record, and anything you ship is judged by the platform's own gates like everyone else's.",
    `Workspace: ${orgPublic}. Run kind: ${runKind}. Be direct; cite ids; never fabricate a capability.`,
  ].join(" ");
}

function managedBrief(session: { runKind: string; taskKey?: string; workRef?: string }): string {
  const target = session.taskKey
    ? `task ${session.taskKey}${session.workRef ? ` (${session.workRef})` : ""}`
    : "the operator's request";
  return `Run kind: ${session.runKind}. Target: ${target}. Work within your toolset; summarize findings and proposed changes; an open question you cannot resolve ends the run with the question stated.`;
}

type ProvisionProfile = NonNullable<Awaited<ReturnType<AgentsDeps["repo"]["getSessionProfile"]>>>;
type ProvisionSession = NonNullable<Awaited<ReturnType<AgentsDeps["repo"]["getSession"]>>>;

async function provisionManaged(
  deps: AgentsDeps,
  orgId: string,
  session: ProvisionSession,
  profile: ProvisionProfile,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  const orgPublic = orgPublicId(orgId);

  // Gate 1 — the no-ask rule (interface_requires_ask): definition-time
  // narrowing is the managed runtime's ONLY enforcement, so an explicit
  // tools allowlist on the profile ceiling is mandatory. Actionable refusal.
  const tools = managedToolAllowlist(profile.capability);
  if (tools === null) {
    return errorResponse(
      "interface_requires_ask",
      "The anthropic-managed interface has no approval channel: set an explicit capability.tools allowlist on the profile (definition-time narrowing), or switch the profile to orun-sandbox",
      422,
      requestId,
    );
  }

  // Gate 2 — the model credential, same custody as every path.
  const anthropic = await pickConnection(deps, orgId, "anthropic");
  if ("error" in anthropic) {
    return errorResponse("provider_connection_invalid", `Cannot provision: ${anthropic.error}`, 409, requestId);
  }
  const anthropicKey = await deps.providerKeys!.resolve(orgId, anthropic.secretRef, actor, requestId);
  if (!anthropicKey) {
    return errorResponse("provider_connection_invalid", "No key material for the anthropic connection", 409, requestId);
  }
  const adapter = deps.managedAgents?.(anthropicKey, anthropic.config);
  if (!adapter) {
    return errorResponse("provider_unsupported", "No anthropic-managed adapter", 503, requestId);
  }

  const spec: ManagedSpawnSpec = {
    model: profile.model,
    system: managedSystemPrompt(orgPublic, session.runKind),
    tools,
    brief: managedBrief(session),
    ...(session.taskKey ? { title: session.taskKey } : {}),
  };

  try {
    logBoot(session.publicId, orgPublic, "create.start", "provider=anthropic-managed");
    const ref = await adapter.spawn(spec);
    logBoot(session.publicId, orgPublic, "create.ok", `provider=anthropic-managed session=${ref.sessionId}`);
    // Managed sessions have no heartbeat: the first user event already ran,
    // so the control plane advances straight through provisioning → running.
    await deps.repo.advanceSession(
      { orgId },
      {
        publicId: session.publicId,
        to: "provisioning",
        sandbox: {
          provider: "anthropic-managed",
          id: ref.sessionId,
          agentId: ref.agentId,
          connection: anthropic.publicId,
        },
      },
    );
    const running = await deps.repo.advanceSession(
      { orgId },
      { publicId: session.publicId, to: "running" },
    );
    void deps.usage?.record(
      orgId,
      "agents.sessions_started",
      1,
      { runKind: session.runKind, profile: profile.publicId },
      actor,
      requestId,
    );
    return successResponse(toPublicSession(running), requestId);
  } catch (e) {
    const reason = e instanceof ManagedAgentsError ? `${e.step}: ${e.message}` : "provider unreachable";
    logBoot(session.publicId, orgPublic, "create.failed", `provider=anthropic-managed reason=${reason}`);
    await deps.repo.advanceSession(
      { orgId },
      {
        publicId: session.publicId,
        to: "failed",
        sandbox: { provider: "anthropic-managed", error: reason },
      },
    );
    return errorResponse("provider_verification_failed", `Provisioning failed: ${reason}`, 502, requestId);
  }
}
