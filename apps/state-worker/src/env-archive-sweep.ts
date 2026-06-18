// Stale-environment archival sweep (OV9.2) — the cron driver for OV9.1.
//
// Calls the projects-worker internal archive-stale endpoint, which archives a
// bounded batch of the oldest-inactive active environments (no activity past the
// retention window) and emits an environment.archived event per row. Coalesced
// into state-worker's single scheduled slot as a phase (risk R9), best-effort:
// a failure never breaks the other cron phases. The sweep is reversible — a
// later activity touch revives an archived environment.

import type { Env } from "./env.js";

export interface EnvArchiveSweepSummary {
  archived: number;
}

export async function runEnvArchiveSweep(env: Env): Promise<EnvArchiveSweepSummary | null> {
  if (!env.PROJECTS_WORKER) return null; // dormant without the binding (dev)
  let response: Response;
  try {
    const target = new URL("/v1/internal/projects/environments/archive-stale", "http://projects-worker");
    response = await env.PROJECTS_WORKER.fetch(target.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": `cron-env-archive-${Date.now()}`,
      },
      // Empty body → projects-worker applies its default retention (90d) + batch.
      body: JSON.stringify({}),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    const parsed = (await response.json()) as { data?: { archived?: unknown } };
    const archived = typeof parsed.data?.archived === "number" ? parsed.data.archived : 0;
    return { archived };
  } catch {
    return null;
  }
}
