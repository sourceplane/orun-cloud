// PM0 authoring tests (orun-work-v3): initiatives + cloud document revisions
// against the in-memory repository (the executable two-log design), plus the
// invariant-1 replay proof for the new envelope state.

import { describe, expect, it } from "vitest";
import { canonicalDocBody, docDigest } from "./doc.js";
import { MemoryWorkRepository } from "./memory.js";
import { WorkError } from "./model.js";

const SCOPE = { orgId: "org-1" };
const USER = { type: "user" as const, id: "usr_1" };
const AGENT = { type: "agent" as const, id: "sp_1" };
const clock = () => "2026-07-09T00:00:00Z";

describe("doc digest (V3-2: one digest form for both sources)", () => {
  it("hashes the canonical body as sha256:<hex> with CRLF normalized", async () => {
    const a = await docDigest(canonicalDocBody("# Title\r\n\r\nBody\r\n"));
    const b = await docDigest(canonicalDocBody("# Title\n\nBody\n"));
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("initiatives (the third item kind — envelope-only)", () => {
  it("creates from one event and derives from the log alone", async () => {
    const repo = new MemoryWorkRepository(clock);
    const out = await repo.createInitiative(SCOPE, {
      slug: "platform-q3",
      title: "Platform Q3",
      description: "The quarter's spine.",
      actor: USER,
    });
    expect(out.event.kind).toBe("item_created");
    expect(out.initiative.kind).toBe("Initiative");
    const { initiatives } = repo.envelopes(SCOPE);
    expect(initiatives).toHaveLength(1);
    expect(initiatives[0]!.description).toBe("The quarter's spine.");
  });

  it("shares the key namespace with specs and tasks (conflict)", async () => {
    const repo = new MemoryWorkRepository(clock);
    await repo.createSpec(SCOPE, { slug: "checkout", title: "Checkout", actor: USER });
    await expect(
      repo.createInitiative(SCOPE, { slug: "checkout", title: "X", actor: USER }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("edits title/description through the one mutator (item_edited)", async () => {
    const repo = new MemoryWorkRepository(clock);
    await repo.createInitiative(SCOPE, { slug: "plat", title: "Plat", actor: USER });
    await repo.editItem(SCOPE, {
      key: "plat",
      title: "Platform",
      description: "The quarter's spine.",
      actor: USER,
    });
    const { initiatives } = repo.envelopes(SCOPE);
    expect(initiatives[0]!.title).toBe("Platform");
    expect(initiatives[0]!.description).toBe("The quarter's spine.");
  });

  it("edits the v4 authored pixels (owner/target/criteria) — the fold reads them", async () => {
    const repo = new MemoryWorkRepository(clock);
    await repo.createInitiative(SCOPE, { slug: "plat", title: "Plat", actor: USER });
    await repo.editItem(SCOPE, {
      key: "plat",
      owner: "usr_pm",
      targetDate: "2026-09-30",
      successCriteria: ["p95 < 200ms", "zero Sev1s"],
      actor: USER,
    });
    const { initiatives } = repo.envelopes(SCOPE);
    expect(initiatives[0]!.owner).toBe("usr_pm");
    expect(initiatives[0]!.targetDate).toBe("2026-09-30");
    expect(initiatives[0]!.successCriteria).toEqual(["p95 < 200ms", "zero Sev1s"]);
  });

  it("refuses to cancel an initiative — it has no lifecycle to retire", async () => {
    const repo = new MemoryWorkRepository(clock);
    await repo.createInitiative(SCOPE, { slug: "plat", title: "Plat", actor: USER });
    await expect(repo.cancel(SCOPE, { key: "plat", actor: USER })).rejects.toMatchObject({
      code: "invalid",
    });
  });
});

describe("cloud document revisions (fork-visible LWW)", () => {
  it("saves a revision: one doc_edited event, docRef follows, replay agrees", async () => {
    const repo = new MemoryWorkRepository(clock);
    await repo.createSpec(SCOPE, { slug: "checkout", title: "Checkout", actor: USER });
    const out = await repo.putDocRevision(SCOPE, {
      specKey: "checkout",
      body: "# Checkout\n\nIntent.\n",
      actor: USER,
    });
    expect(out.created).toBe(true);
    expect(out.event?.kind).toBe("doc_edited");
    expect(out.parent).toBeUndefined();

    // Invariant 1: the envelope's docRef reproduces from the log alone.
    const { specs } = repo.envelopes(SCOPE);
    expect(specs[0]!.docRef).toBe(out.revision);

    const doc = await repo.getDocRevision(SCOPE, "checkout");
    expect(doc.body).toBe("# Checkout\n\nIntent.\n");
    expect(doc.revision).toBe(out.revision);
  });

  it("an identical save is a no-op: created=false, NO event appended", async () => {
    const repo = new MemoryWorkRepository(clock);
    await repo.createSpec(SCOPE, { slug: "s", title: "S", actor: USER });
    const first = await repo.putDocRevision(SCOPE, { specKey: "s", body: "same\n", actor: USER });
    const before = (await repo.listEvents(SCOPE)).length;
    const again = await repo.putDocRevision(SCOPE, { specKey: "s", body: "same\n", actor: USER });
    expect(again.created).toBe(false);
    expect(again.event).toBeNull();
    expect(again.revision).toBe(first.revision);
    expect((await repo.listEvents(SCOPE)).length).toBe(before);
  });

  it("a concurrent edit forks visibly: two children of one parent in history", async () => {
    const repo = new MemoryWorkRepository(clock);
    await repo.createSpec(SCOPE, { slug: "s", title: "S", actor: USER });
    const root = await repo.putDocRevision(SCOPE, { specKey: "s", body: "root\n", actor: USER });
    // Two writers both based on root — the second's stale parent still applies.
    const a = await repo.putDocRevision(SCOPE, { specKey: "s", body: "root + a\n", parent: root.revision, actor: USER });
    const b = await repo.putDocRevision(SCOPE, { specKey: "s", body: "root + b\n", parent: root.revision, actor: AGENT });
    expect(a.parent).toBe(root.revision);
    expect(b.parent).toBe(root.revision);
    const history = await repo.listDocHistory(SCOPE, "s");
    const children = history.filter((r) => r.parent === root.revision);
    expect(children).toHaveLength(2); // the fork is visible, never silently merged
    // Latest pointer is last-writer-wins:
    const { specs } = repo.envelopes(SCOPE);
    expect(specs[0]!.docRef).toBe(b.revision);
  });

  it("getDoc on an imported doc_ref (no cloud body) is a distinguishable 404", async () => {
    const repo = new MemoryWorkRepository(clock);
    await repo.createSpec(SCOPE, {
      slug: "imported",
      title: "Imported",
      docRef: "sha256:" + "ab".repeat(32),
      actor: USER,
    });
    await expect(repo.getDocRevision(SCOPE, "imported")).rejects.toMatchObject({ code: "not_found" });
  });

  it("agents can author documents (writing docs is work, not a pin)", async () => {
    const repo = new MemoryWorkRepository(clock);
    await repo.createSpec(SCOPE, { slug: "s", title: "S", actor: USER });
    const out = await repo.putDocRevision(SCOPE, { specKey: "s", body: "by agent\n", actor: AGENT });
    expect(out.created).toBe(true);
  });

  it("rejects a doc on an unknown spec", async () => {
    const repo = new MemoryWorkRepository(clock);
    await expect(
      repo.putDocRevision(SCOPE, { specKey: "ghost", body: "x\n", actor: USER }),
    ).rejects.toBeInstanceOf(WorkError);
  });
});
