import { describe, expect, it } from "vitest";
import { workObservationsFromScm } from "./scm.js";

const AT = "2026-07-04T12:00:00Z";
const REPO = { repo: { externalId: "1", fullName: "acme/storefront" } };

describe("scm.* → work observation projection", () => {
  it("maps an opened PR with task keys from branch + title", () => {
    const out = workObservationsFromScm(
      "scm.pull_request.opened",
      { ...REPO, number: 41, title: "route reads for ORN-9", sourceBranch: "feat/ORN-7-route", headSha: "h1" },
      AT,
    );
    expect(out.length).toBe(1);
    expect(out[0]!.kind).toBe("pr_opened");
    expect(out[0]!.dedupeKey).toBe("gh:pr:acme/storefront#41:opened");
    expect(out[0]!.payload).toMatchObject({ pr: "acme/storefront#41", taskKeys: ["ORN-7", "ORN-9"] });
  });

  it("distinguishes updates by head sha so a synchronize redelivers idempotently", () => {
    const a = workObservationsFromScm("scm.pull_request.updated", { ...REPO, number: 41, headSha: "h1" }, AT);
    const b = workObservationsFromScm("scm.pull_request.updated", { ...REPO, number: 41, headSha: "h2" }, AT);
    expect(a[0]!.dedupeKey).not.toBe(b[0]!.dedupeKey);
  });

  it("maps merged to pr_merged with the head revision, closed to pr_closed", () => {
    const merged = workObservationsFromScm("scm.pull_request.merged", { ...REPO, number: 41, headSha: "h9" }, AT);
    expect(merged[0]!.kind).toBe("pr_merged");
    expect(merged[0]!.payload).toMatchObject({ revision: "h9" });
    const closed = workObservationsFromScm("scm.pull_request.closed", { ...REPO, number: 41 }, AT);
    expect(closed[0]!.kind).toBe("pr_closed");
  });

  it("maps branch creation always; pushes only when the branch carries a task key", () => {
    const created = workObservationsFromScm("scm.branch.created", { ...REPO, branch: "feat/ORN-3-x" }, AT);
    expect(created[0]!.kind).toBe("branch_seen");
    expect(created[0]!.payload).toMatchObject({ taskKeys: ["ORN-3"] });
    expect(workObservationsFromScm("scm.push", { ...REPO, branch: "main", afterSha: "a" }, AT)).toEqual([]);
    expect(workObservationsFromScm("scm.push", { ...REPO, branch: "ORN-4-fix", afterSha: "a" }, AT).length).toBe(1);
  });

  it("ignores out-of-taxonomy events and payloads without a repo", () => {
    expect(workObservationsFromScm("scm.release.published", { ...REPO }, AT)).toEqual([]);
    expect(workObservationsFromScm("scm.pull_request.opened", { number: 1 }, AT)).toEqual([]);
  });
});
