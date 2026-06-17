// OV4 inbound bridge — the scm.* → state.triggers drain. Verifies the consumer
// projects push/PR event_log rows into triggers (resolving the project via the
// rename-stable repo federation), advances the cursor over the batch, and is
// idempotent. DB is a scripted executor dispatching on the SQL each repository
// method emits.

import { drainScmTriggers } from "@state-worker/scm-bridge";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "44444444-4444-4444-8444-444444444444";

interface EventRow {
  id: string;
  type: string;
  org_id: string;
  occurred_at: string;
  payload: string; // JSONB column (string)
  // mapEvent reads many columns; the projector only needs id/type/org/occurred/payload.
  [k: string]: unknown;
}

function eventRow(over: {
  id: string;
  type: string;
  occurred_at?: string;
  org_id?: string;
  payload: Record<string, unknown>;
}): EventRow {
  return {
    id: over.id,
    type: over.type,
    version: 1,
    source: "integrations-worker",
    occurred_at: over.occurred_at ?? "2026-06-17T10:00:00.000Z",
    actor_type: "github",
    actor_id: "gh",
    org_id: over.org_id ?? ORG,
    project_id: null,
    subject_kind: "repository",
    subject_id: "777001",
    request_id: "req",
    created_at: "2026-06-17T10:00:00.000Z",
    redact_paths: "[]",
    payload: JSON.stringify(over.payload),
  } as EventRow;
}

function scmExecutor(events: EventRow[], opts?: { linked?: boolean }): {
  executor: SqlExecutor;
  triggers: Map<string, Record<string, unknown>>;
  cursor: Record<string, unknown>;
} {
  const triggers = new Map<string, Record<string, unknown>>();
  const cursor: Record<string, unknown> = {};
  const executor: SqlExecutor = {
    execute<T extends SqlRow = SqlRow>(text: string, params: unknown[] = []): Promise<SqlExecutorResult<T>> {
      const rows = run(text, params) as unknown as T[];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  } as unknown as SqlExecutor;

  function run(text: string, p: unknown[]): Record<string, unknown>[] {
    if (text.includes("FROM state.scm_ingest_cursor")) {
      return cursor.last_event_id ? [cursor] : [];
    }
    if (text.includes("FROM events.event_log")) {
      return events as unknown as Record<string, unknown>[];
    }
    if (text.includes("FROM state.workspace_links") && text.includes("provider_repo_id")) {
      // Federation lookup: resolve the repo → an active link in this org.
      return opts?.linked
        ? [{ id: "l1", org_id: ORG, project_id: PROJECT, remote_url: "github.com/acme/platform", status: "active", provider: "github", provider_repo_id: p[1] }]
        : [];
    }
    if (text.includes("INSERT INTO state.triggers")) {
      const eventId = p[13] as string;
      if (triggers.has(eventId)) return [];
      const row = {
        id: p[0],
        org_id: p[1],
        project_id: (p[2] as string) ?? null,
        provider: p[3],
        provider_repo_id: p[4],
        repo_full_name: (p[5] as string) ?? null,
        kind: p[6],
        action: (p[7] as string) ?? null,
        ref: (p[8] as string) ?? null,
        commit_sha: p[9],
        base_sha: (p[10] as string) ?? null,
        pr_number: (p[11] as number) ?? null,
        actor_login: (p[12] as string) ?? null,
        event_id: eventId,
        status: "recorded",
        occurred_at: String(p[14]),
        created_at: "2026-06-17T00:00:00.000Z",
      };
      triggers.set(eventId, row);
      return [row];
    }
    if (text.includes("INSERT INTO state.scm_ingest_cursor")) {
      cursor.last_occurred_at = p[0];
      cursor.last_event_id = p[1];
      return [];
    }
    return [];
  }

  return { executor, triggers, cursor };
}

const PUSH = eventRow({
  id: "evt_push_1",
  type: "scm.push",
  occurred_at: "2026-06-17T10:00:00.000Z",
  payload: {
    version: 1,
    orgId: "org_x",
    repo: { provider: "github", externalId: "777001", fullName: "acme/platform", ownerId: "42042" },
    ref: "refs/heads/main",
    afterSha: "aaa111",
    pusherLogin: "octocat",
  },
});

const PR = eventRow({
  id: "evt_pr_1",
  type: "scm.pull_request.opened",
  occurred_at: "2026-06-17T11:00:00.000Z",
  payload: {
    version: 1,
    orgId: "org_x",
    repo: { provider: "github", externalId: "777001", fullName: "acme/platform", ownerId: "42042" },
    number: 42,
    headSha: "bbb222",
    baseSha: "ccc333",
    authorLogin: "hubber",
  },
});

describe("drainScmTriggers (OV4 inbound)", () => {
  it("projects a push and a PR into triggers, resolving the project, and advances the cursor", async () => {
    const { executor, triggers, cursor } = scmExecutor([PUSH, PR], { linked: true });
    const summary = await drainScmTriggers(executor);

    expect(summary.scanned).toBe(2);
    expect(summary.recorded).toBe(2);
    expect(triggers.size).toBe(2);

    const push = triggers.get("evt_push_1")!;
    expect(push.kind).toBe("push");
    expect(push.action).toBeNull();
    expect(push.commit_sha).toBe("aaa111");
    expect(push.ref).toBe("refs/heads/main");
    expect(push.actor_login).toBe("octocat");
    expect(push.project_id).toBe(PROJECT); // resolved via federation

    const pr = triggers.get("evt_pr_1")!;
    expect(pr.kind).toBe("pull_request");
    expect(pr.action).toBe("opened");
    expect(pr.commit_sha).toBe("bbb222");
    expect(pr.base_sha).toBe("ccc333");
    expect(pr.pr_number).toBe(42);
    expect(pr.actor_login).toBe("hubber");

    // Cursor advanced to the last (newest) event.
    expect(cursor.last_event_id).toBe("evt_pr_1");
    expect(cursor.last_occurred_at).toBe("2026-06-17T11:00:00.000Z");
  });

  it("records org-level triggers (project_id null) when the repo is not linked", async () => {
    const { executor, triggers } = scmExecutor([PUSH], { linked: false });
    const summary = await drainScmTriggers(executor);
    expect(summary.recorded).toBe(1);
    expect(triggers.get("evt_push_1")!.project_id).toBeNull();
  });

  it("ignores non-trigger scm.* events but still advances the cursor over them", async () => {
    const check = eventRow({
      id: "evt_check_1",
      type: "scm.check.completed",
      occurred_at: "2026-06-17T12:00:00.000Z",
      payload: { version: 1, repo: { provider: "github", externalId: "777001", fullName: "acme/platform", ownerId: null } },
    });
    const { executor, triggers, cursor } = scmExecutor([check], { linked: true });
    const summary = await drainScmTriggers(executor);
    expect(summary.recorded).toBe(0);
    expect(triggers.size).toBe(0);
    // The cursor still advances so a non-trigger event never stalls the drain.
    expect(cursor.last_event_id).toBe("evt_check_1");
  });

  it("does nothing when there are no new scm.* events", async () => {
    const { executor, triggers } = scmExecutor([], { linked: true });
    const summary = await drainScmTriggers(executor);
    expect(summary.scanned).toBe(0);
    expect(triggers.size).toBe(0);
  });
});
