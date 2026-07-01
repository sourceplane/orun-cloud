import { describe, it, expect } from "vitest";
import { generateWorkspaceRef, isWorkspaceRef, generateTeamId, isTeamId } from "./index.js";

describe("Workspace ID codec (saas-workspace-id WID2)", () => {
  it("generateWorkspaceRef produces a value that isWorkspaceRef accepts", () => {
    for (let i = 0; i < 100; i++) {
      const ref = generateWorkspaceRef();
      expect(isWorkspaceRef(ref)).toBe(true);
    }
  });

  it("has the ws_ prefix and an 8-char Crockford-base32 body", () => {
    const ref = generateWorkspaceRef();
    expect(ref.startsWith("ws_")).toBe(true);
    const body = ref.slice(3);
    expect(body).toHaveLength(8);
    expect(ref).toMatch(/^ws_[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it("never emits the ambiguous Crockford characters I, L, O, U", () => {
    for (let i = 0; i < 500; i++) {
      const body = generateWorkspaceRef().slice(3);
      expect(body).not.toMatch(/[ILOU]/);
    }
  });

  it("produces distinct values across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateWorkspaceRef());
    }
    // Collisions over 1000 draws from a ~1.1e12 space are astronomically
    // unlikely; treat any as a generator defect.
    expect(seen.size).toBe(1000);
  });

  describe("isWorkspaceRef", () => {
    it("accepts well-formed refs", () => {
      expect(isWorkspaceRef("ws_3KF9TQ2P")).toBe(true);
      expect(isWorkspaceRef("ws_00000000")).toBe(true);
      expect(isWorkspaceRef("ws_ZZZZZZZZ")).toBe(true);
    });

    it("rejects malformed refs", () => {
      expect(isWorkspaceRef("ws_3KF9TQ2")).toBe(false); // 7 chars
      expect(isWorkspaceRef("ws_3KF9TQ2PA")).toBe(false); // 9 chars
      expect(isWorkspaceRef("3KF9TQ2P")).toBe(false); // no prefix
      expect(isWorkspaceRef("org_3KF9TQ2P")).toBe(false); // wrong prefix
      expect(isWorkspaceRef("ws_3kf9tq2p")).toBe(false); // lowercase body
      expect(isWorkspaceRef("ws_ILOU0000")).toBe(false); // excluded letters
      expect(isWorkspaceRef("")).toBe(false);
    });
  });
});

describe("Team ID codec (saas-teams TM1)", () => {
  it("generateTeamId produces a value that isTeamId accepts", () => {
    for (let i = 0; i < 100; i++) {
      expect(isTeamId(generateTeamId())).toBe(true);
    }
  });

  it("has the team_ prefix and an 8-char Crockford-base32 body", () => {
    const id = generateTeamId();
    expect(id.startsWith("team_")).toBe(true);
    expect(id.slice(5)).toHaveLength(8);
    expect(id).toMatch(/^team_[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it("never emits the ambiguous Crockford characters I, L, O, U", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateTeamId().slice(5)).not.toMatch(/[ILOU]/);
    }
  });

  it("produces distinct values across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateTeamId());
    expect(seen.size).toBe(1000);
  });

  describe("isTeamId", () => {
    it("accepts well-formed ids", () => {
      expect(isTeamId("team_3KF9TQ2P")).toBe(true);
      expect(isTeamId("team_00000000")).toBe(true);
      expect(isTeamId("team_ZZZZZZZZ")).toBe(true);
    });

    it("rejects malformed ids", () => {
      expect(isTeamId("team_3KF9TQ2")).toBe(false); // 7 chars
      expect(isTeamId("team_3KF9TQ2PA")).toBe(false); // 9 chars
      expect(isTeamId("3KF9TQ2P")).toBe(false); // no prefix
      expect(isTeamId("ws_3KF9TQ2P")).toBe(false); // wrong prefix
      expect(isTeamId("team_3kf9tq2p")).toBe(false); // lowercase body
      expect(isTeamId("team_ILOU0000")).toBe(false); // excluded letters
      expect(isTeamId("")).toBe(false);
    });
  });
});
