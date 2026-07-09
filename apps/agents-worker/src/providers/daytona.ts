// Daytona adapter for the SandboxProvider seam (saas-agents AG5, design §2).
//
// The workspace's own Daytona account (an AG12 provider connection) supplies
// the credential + config; nothing platform-owned is baked in. The adapter
// speaks the public Daytona REST API (the same host the AG12 verification
// ping proves): sandboxes boot from the agents-base snapshot (the orun binary
// + drivers, no credentials), commands run through the toolbox exec, and
// suspend/resume map to Daytona stop/start. All error surfaces are redacted
// to a status code — a provider body may echo account details.
//
// No inbound path: the control plane only calls Daytona's API; the in-sandbox
// `orun agent serve` dials out to the session relay.

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
}

interface DaytonaSandbox {
  id: string;
  state?: string;
}

export function createDaytonaProvider(cfg: DaytonaConfig): SandboxProvider {
  const base = (cfg.apiUrl ?? DEFAULT_DAYTONA_API).replace(/\/$/, "");
  const fetchImpl = cfg.fetchImpl ?? fetch;

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
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
    if (!res.ok) {
      // Redact: status only — never echo the provider body.
      throw new Error(`daytona ${method} ${path.split("/")[1] ?? ""}: ${res.status} from provider`);
    }
    return res;
  }

  return {
    id: "daytona",

    async create(spec: SandboxSpec): Promise<SandboxRef> {
      const res = await call("POST", "/sandbox", {
        snapshot: spec.baseSnapshot,
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
      // Secret material (the model key) rides ONLY here — process env on the
      // exec, never the sandbox's create-time env, so it cannot survive a
      // suspend snapshot (design §10.4: re-bootstrap re-resolves).
      await call("POST", `/toolbox/${encodeURIComponent(ref.id)}/process/execute`, {
        command: cmd.map(shellQuote).join(" "),
        ...(opts?.env ? { env: opts.env } : {}),
        async: true,
      });
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
