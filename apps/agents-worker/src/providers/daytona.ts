// Daytona adapter for the SandboxProvider seam (saas-agents AG5, design §2).
//
// The workspace's own Daytona account (an AG12 provider connection) supplies
// the credential + config; nothing platform-owned is baked in. The adapter
// speaks the public Daytona REST API (the same host the AG12 verification
// ping proves): sandboxes boot from the snapshot the connection pins — or the
// account's default image when none is (the bootstrap installs orun) —
// commands run through the toolbox exec, and suspend/resume map to Daytona
// stop/start. All error surfaces are redacted to a status code — a provider
// body may echo account details.
//
// No inbound path: the control plane only calls Daytona's API; the in-sandbox
// bootstrap dials out to the platform API.

import type { SandboxHealth, SandboxProvider, SandboxRef, SandboxSpec } from "@saas/contracts/agents";

export const DEFAULT_DAYTONA_API = "https://app.daytona.io/api";

export interface DaytonaConfig {
  apiKey: string;
  /** Override for self-hosted / regional Daytona (connection config.apiUrl). */
  apiUrl?: string;
  /** Daytona target/region (connection config.target), when the account sets one. */
  target?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Session id for the supervisor process inside the sandbox (one per box). */
const EXEC_SESSION = "orun-agent";

/** Boot wait: sandboxes create asynchronously (creating/pulling_snapshot →
 * started); toolbox calls 404 until the box is up. ~60s covers a cold pull. */
const STARTED_POLL_MS = 2000;
const STARTED_POLL_MAX = 30;

/** Toolbox readiness: Daytona flips the SANDBOX to `started` a beat before the
 * in-sandbox toolbox daemon registers its edge route, so the first
 * `/toolbox/…` call 404s for a short window (worse on a cold snapshot pull).
 * `started` is necessary but not sufficient — retry those calls on 404 until
 * the daemon answers, bounded by the same ~60s budget as the start poll,
 * instead of failing the whole spawn on the first miss. A 404 means the
 * request never reached a live daemon, so retrying a POST is side-effect-safe. */
const TOOLBOX_READY_POLL_MS = 2000;
const TOOLBOX_READY_POLL_MAX = 30;

/** States that will never reach `started` — fail fast instead of timing out. */
const DEAD_STATES = new Set(["error", "build_failed", "destroyed", "destroying"]);

interface DaytonaSandbox {
  id: string;
  state?: string;
}

export function createDaytonaProvider(cfg: DaytonaConfig): SandboxProvider {
  const base = (cfg.apiUrl ?? DEFAULT_DAYTONA_API).replace(/\/$/, "");
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const sleep = cfg.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function call(
    method: string,
    path: string,
    body?: unknown,
    opts?: { allow?: number[]; retryUntilReady?: boolean },
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${cfg.apiKey}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch {
        throw new Error(`daytona ${method} ${path.split("/")[1] ?? ""}: provider unreachable`);
      }
      if (res.ok || opts?.allow?.includes(res.status)) return res;
      // A toolbox call can 404 while the daemon is still registering its edge
      // route (see TOOLBOX_READY_* above): wait it out rather than fail the spawn.
      if (res.status === 404 && opts?.retryUntilReady && attempt < TOOLBOX_READY_POLL_MAX) {
        await sleep(TOOLBOX_READY_POLL_MS);
        continue;
      }
      // Redact: status only — never echo the provider body.
      throw new Error(`daytona ${method} ${path.split("/")[1] ?? ""}: ${res.status} from provider`);
    }
  }

  /** Wait for the sandbox itself to reach `started` (creating/pulling_snapshot
   * → started). Necessary before any toolbox call; the toolbox daemon's own
   * registration lag is absorbed separately by the readiness retry in `call`. */
  async function waitForStarted(id: string): Promise<void> {
    for (let i = 0; i < STARTED_POLL_MAX; i++) {
      const res = await call("GET", `/sandbox/${encodeURIComponent(id)}`);
      const state = ((await res.json()) as DaytonaSandbox).state ?? "unknown";
      if (state === "started") return;
      if (DEAD_STATES.has(state)) throw new Error(`daytona GET sandbox: box is ${state}`);
      await sleep(STARTED_POLL_MS);
    }
    throw new Error("daytona GET sandbox: not started in time");
  }

  return {
    id: "daytona",

    async create(spec: SandboxSpec): Promise<SandboxRef> {
      const res = await call("POST", "/sandbox", {
        // No snapshot key when the spec doesn't pin one: Daytona then boots
        // the account's default image (a nonexistent name 404s the create).
        ...(spec.baseSnapshot ? { snapshot: spec.baseSnapshot } : {}),
        ...(spec.env ? { env: spec.env } : {}),
        ...(cfg.target ? { target: cfg.target } : {}),
        // Provider-side reclaim backstops the control plane's lease sweep
        // (minutes; over-destroy on ambiguity is the design posture).
        autoStopInterval: Math.max(1, Math.ceil(spec.ttlSeconds / 60)),
        autoDeleteInterval: Math.max(1, Math.ceil(spec.ttlSeconds / 60)),
        labels: { "orun.dev/managed": "true" },
      });
      const sandbox = (await res.json()) as DaytonaSandbox;
      if (!sandbox.id) throw new Error("daytona POST sandbox: malformed response");
      return { id: sandbox.id, provider: "daytona" };
    },

    async exec(ref: SandboxRef, cmd: string[], opts?: { env?: Record<string, string> }): Promise<void> {
      // The long-running path is the toolbox SESSION api (the plain
      // process/execute endpoint is synchronous with a ~10s timeout and takes
      // no env). Secret material (the model key) rides ONLY here — an export
      // prefix on the session command, exactly how the vendor SDK injects
      // env — never the sandbox's create-time manifest, so it cannot survive
      // a suspend snapshot (design §10.4: re-bootstrap re-resolves). The
      // session lives in the in-sandbox toolbox daemon and dies with the box.
      const id = encodeURIComponent(ref.id);
      await waitForStarted(ref.id);
      // Idempotent: a resume re-exec finds the session already there (409). This
      // is the first real toolbox call, so it carries the readiness retry — it
      // absorbs the daemon-registration window that `started` doesn't cover.
      await call("POST", `/toolbox/${id}/toolbox/process/session`, { sessionId: EXEC_SESSION }, {
        allow: [409],
        retryUntilReady: true,
      });
      const exports = opts?.env
        ? `export ${Object.entries(opts.env)
            .map(([k, v]) => `${k}=${shellQuote(v)}`)
            .join(" ")}; `
        : "";
      await call("POST", `/toolbox/${id}/toolbox/process/session/${EXEC_SESSION}/exec`, {
        command: exports + cmd.map(shellQuote).join(" "),
        runAsync: true,
      });
    },

    async execCapture(ref: SandboxRef, cmd: string[]): Promise<{ stdout: string; exitCode: number }> {
      // The plain process/execute endpoint is SYNCHRONOUS (a ~10s budget) and
      // returns the command's combined output + exit code — used to probe the
      // resolved orun version. No env (none needed for a version check). A
      // cold-pull install may exceed the budget; the caller treats any failure
      // as `unknown` and never blocks the spawn.
      const id = encodeURIComponent(ref.id);
      await waitForStarted(ref.id);
      const res = await call(
        "POST",
        `/toolbox/${id}/toolbox/process/execute`,
        { command: cmd.map(shellQuote).join(" ") },
        { retryUntilReady: true },
      );
      // Redaction posture holds: this output is a version string we log, never
      // the provider's account body. Parse defensively across field names.
      const body = (await res.json()) as { exitCode?: number; result?: string; output?: string; stdout?: string };
      const stdout = (body.result ?? body.output ?? body.stdout ?? "").toString().trim();
      return { stdout, exitCode: typeof body.exitCode === "number" ? body.exitCode : 0 };
    },

    async snapshot(ref: SandboxRef): Promise<string> {
      // Suspend = provider stop; the sandbox id doubles as the resume handle.
      await call("POST", `/sandbox/${encodeURIComponent(ref.id)}/stop`);
      return ref.id;
    },

    async resume(snapshotId: string): Promise<SandboxRef> {
      await call("POST", `/sandbox/${encodeURIComponent(snapshotId)}/start`);
      return { id: snapshotId, provider: "daytona" };
    },

    async destroy(ref: SandboxRef): Promise<void> {
      await call("DELETE", `/sandbox/${encodeURIComponent(ref.id)}?force=true`);
    },

    async health(ref: SandboxRef): Promise<SandboxHealth> {
      try {
        const res = await call("GET", `/sandbox/${encodeURIComponent(ref.id)}`);
        const sandbox = (await res.json()) as DaytonaSandbox;
        const state = sandbox.state ?? "unknown";
        return { healthy: state === "started", detail: state };
      } catch (e) {
        return { healthy: false, detail: e instanceof Error ? e.message : "unreachable" };
      }
    },
  };
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}
