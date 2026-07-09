// PM1 conversation tests: threaded comments, reactions, mention extraction.

import { describe, expect, it } from "vitest";
import { MemoryWorkRepository } from "./memory.js";
import { extractMentions } from "./model.js";

const SCOPE = { orgId: "org-1" };
const USER = { type: "user" as const, id: "usr_1" };
const clock = () => "2026-07-09T00:00:00Z";

async function seed(repo: MemoryWorkRepository) {
  await repo.createSpec(SCOPE, { slug: "s", title: "S", actor: USER });
  const t = await repo.createTask(SCOPE, { prefix: "ORN", title: "t", specKey: "s", actor: USER });
  return t.key;
}

describe("threaded comments (PM1)", () => {
  it("carries parentEvent and anchor through the one mutator", async () => {
    const repo = new MemoryWorkRepository(clock);
    const key = await seed(repo);
    const root = await repo.comment(SCOPE, { key, body: "root", actor: USER });
    const reply = await repo.comment(SCOPE, {
      key,
      body: "reply",
      parentEvent: root.event.eventId,
      anchor: { revision: "sha256:ab", start: 0, end: 4 },
      actor: USER,
    });
    expect(reply.event.payload).toMatchObject({
      parentEvent: root.event.eventId,
      anchor: { revision: "sha256:ab", start: 0, end: 4 },
    });
  });
});

describe("reactions (PM1)", () => {
  it("adds and removes a reaction targeting a comment; one event each", async () => {
    const repo = new MemoryWorkRepository(clock);
    const key = await seed(repo);
    const c = await repo.comment(SCOPE, { key, body: "hi", actor: USER });
    const add = await repo.addReaction(SCOPE, { targetEvent: c.event.eventId!, emoji: "👍", actor: USER });
    expect(add.event.kind).toBe("reaction_added");
    expect(add.event.subject).toBe(key); // reactions live on the item's timeline
    const rm = await repo.removeReaction(SCOPE, { targetEvent: c.event.eventId!, emoji: "👍", actor: USER });
    expect(rm.event.kind).toBe("reaction_removed");
  });

  it("rejects reactions on non-comments and unknown targets", async () => {
    const repo = new MemoryWorkRepository(clock);
    const key = await seed(repo);
    const pin = await repo.pin(SCOPE, { key, rung: "done", actor: USER });
    await expect(
      repo.addReaction(SCOPE, { targetEvent: pin.event.eventId!, emoji: "👍", actor: USER }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      repo.addReaction(SCOPE, { targetEvent: "ghost", emoji: "👍", actor: USER }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      repo.addReaction(SCOPE, { targetEvent: pin.event.eventId!, emoji: "", actor: USER }),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("extractMentions (PM1)", () => {
  it("parses distinct @handles incl. team/handle, in order", () => {
    expect(extractMentions("cc @rahul and @team/platform — thanks @rahul")).toEqual([
      "rahul",
      "team/platform",
    ]);
    expect(extractMentions("no mentions here")).toEqual([]);
    expect(extractMentions("emails a@b.c do not count")).toEqual([]);
  });
});
