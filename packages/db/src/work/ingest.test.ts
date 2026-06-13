import { describe, expect, it } from "vitest";
import type { Status, WorkEvent } from "./model.js";
import { ingestPullRequest, type AffectedSet, type IngestRepo } from "./ingest.js";
import type { CommitOutcome, LinkInput, ProjectScope, SetStatusInput, WorkResult } from "./types.js";
import { parsePullRequestEvent, type GithubPullRequestEvent } from "./webhook.js";

const SCOPE: ProjectScope = { orgId: "org-1", projectId: "proj-1" };

const prEvent = (over: Partial<GithubPullRequestEvent> & { pr?: Partial<GithubPullRequestEvent["pull_request"]> } = {}): GithubPullRequestEvent => ({
  action: over.action ?? "opened",
  repository: over.repository ?? { full_name: "sourceplane/orun" },
  pull_request: {
    number: 412,
    title: "Route catalog reads",
    head: { ref: "feature/route-catalog" },
    ...over.pr,
  },
});

function stubEvent(subject: string): WorkEvent {
  return { eventId: "wev_stub", project: "org-1/proj-1", subject, kind: "link_added", actor: { type: "automation", id: "x" }, at: "2026-06-11T09:00:00Z", seq: 0 };
}

class FakeRepo implements IngestRepo {
  links: LinkInput[] = [];
  statuses: SetStatusInput[] = [];
  constructor(private readonly tasks: Array<{ key: string; status: Status; affects: string[] }>) {}

  async listOpenTasks(): Promise<WorkResult<Array<{ key: string; status: Status; affects: string[] }>>> {
    return { ok: true, value: this.tasks };
  }
  async addLink(input: LinkInput): Promise<WorkResult<CommitOutcome>> {
    this.links.push(input);
    return { ok: true, value: { event: stubEvent(input.from), key: input.from } };
  }
  async setStatus(input: SetStatusInput): Promise<WorkResult<CommitOutcome>> {
    this.statuses.push(input);
    return { ok: true, value: { event: stubEvent(input.key), key: input.key } };
  }
}

const affected = (components: string[]): AffectedSet => ({ pr: "sourceplane/orun#412", components });

describe("PR webhook parsing (W2 ingestion)", () => {
  it("maps actionable PR actions to phases and a stable ref", () => {
    expect(parsePullRequestEvent(prEvent({ action: "opened" }))).toMatchObject({ ref: "sourceplane/orun#412", phase: "opened", branch: "feature/route-catalog" });
    expect(parsePullRequestEvent(prEvent({ action: "reopened" }))?.phase).toBe("opened");
    expect(parsePullRequestEvent(prEvent({ action: "synchronize" }))?.phase).toBe("opened");
    expect(parsePullRequestEvent(prEvent({ action: "ready_for_review" }))?.phase).toBe("ready_for_review");
    expect(parsePullRequestEvent(prEvent({ action: "closed", pr: { merged: true } }))?.phase).toBe("merged");
  });

  it("ignores non-linking actions (unmerged close, labels)", () => {
    expect(parsePullRequestEvent(prEvent({ action: "closed", pr: { merged: false } }))).toBeNull();
    expect(parsePullRequestEvent(prEvent({ action: "labeled" }))).toBeNull();
  });
});

describe("PR auto-link ingestion (W2)", () => {
  it("links and transitions a task matched by component overlap", async () => {
    const repo = new FakeRepo([{ key: "ORN-1", status: "backlog", affects: ["sourceplane/orun/api-edge"] }]);
    const out = await ingestPullRequest(repo, SCOPE, prEvent(), affected(["sourceplane/orun/api-edge"]), "ORN");

    expect(out).toMatchObject({ ingested: true, pr: "sourceplane/orun#412", applied: 2 });
    expect(repo.links).toHaveLength(1);
    expect(repo.links[0]).toMatchObject({ from: "ORN-1", type: "implementedBy", to: "sourceplane/orun#412", actor: { type: "automation" } });
    expect(repo.statuses).toHaveLength(1);
    expect(repo.statuses[0]).toMatchObject({ key: "ORN-1", status: "in_progress", cause: { pr: "sourceplane/orun#412" } });
  });

  it("links a task named in the branch even with no component overlap", async () => {
    const repo = new FakeRepo([{ key: "ORN-142", status: "todo", affects: ["unrelated/x/y"] }]);
    const out = await ingestPullRequest(
      repo,
      SCOPE,
      prEvent({ pr: { number: 412, title: "no key", head: { ref: "feature/ORN-142-foo" } } }),
      affected(["sourceplane/orun/api-edge"]),
      "ORN",
    );
    expect(out).toMatchObject({ ingested: true, applied: 2 });
    expect(repo.links[0]).toMatchObject({ from: "ORN-142", to: "sourceplane/orun#412" });
  });

  it("skips ignored actions without touching the repo", async () => {
    const repo = new FakeRepo([{ key: "ORN-1", status: "backlog", affects: ["c/c/c"] }]);
    const out = await ingestPullRequest(repo, SCOPE, prEvent({ action: "labeled" }), affected(["c/c/c"]), "ORN");
    expect(out).toEqual({ ingested: false, reason: "ignored_action" });
    expect(repo.links).toHaveLength(0);
    expect(repo.statuses).toHaveLength(0);
  });

  it("no-ops when no open task matches", async () => {
    const repo = new FakeRepo([{ key: "ORN-1", status: "backlog", affects: ["other/x/y"] }]);
    const out = await ingestPullRequest(repo, SCOPE, prEvent({ pr: { number: 412, title: "none", head: { ref: "feature/none" } } }), affected(["sourceplane/orun/api-edge"]), "ORN");
    expect(out).toMatchObject({ ingested: true, applied: 0 });
    expect(repo.links).toHaveLength(0);
  });

  it("surfaces a listOpenTasks read failure as zero work, not a thrown webhook", async () => {
    const repo: IngestRepo = {
      async listOpenTasks() {
        return { ok: false, error: { kind: "internal", message: "db unavailable" } };
      },
      async addLink() {
        throw new Error("must not write when the read failed");
      },
      async setStatus() {
        throw new Error("must not write when the read failed");
      },
    };
    const out = await ingestPullRequest(repo, SCOPE, prEvent(), affected(["c/c/c"]), "ORN");
    expect(out).toMatchObject({ ingested: true, pr: "sourceplane/orun#412", applied: 0 });
    if (out.ingested) expect(out.rejected).toEqual([{ key: "*", reason: "db unavailable" }]);
  });
});
