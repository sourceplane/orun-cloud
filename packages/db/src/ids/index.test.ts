import { describe, it, expect } from "vitest";
import { generateWorkspaceRef, isWorkspaceRef, isTeamId, uuidToHex } from "./index.js";

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

describe("Team ID codec (saas-teams TM1/TM2)", () => {
  it("isTeamId accepts team_ + the 32-hex form of a UUID", () => {
    const hex = uuidToHex("00000000-0000-0000-0000-0000000000a1");
    expect(isTeamId(`team_${hex}`)).toBe(true);
  });

  it("accepts well-formed ids (upper/lower hex)", () => {
    expect(isTeamId("team_0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isTeamId("team_0123456789ABCDEF0123456789ABCDEF")).toBe(true);
  });

  it("rejects malformed ids", () => {
    expect(isTeamId("team_0123456789abcdef0123456789abcde")).toBe(false); // 31 chars
    expect(isTeamId("team_0123456789abcdef0123456789abcdeff")).toBe(false); // 33 chars
    expect(isTeamId("0123456789abcdef0123456789abcdef")).toBe(false); // no prefix
    expect(isTeamId("org_0123456789abcdef0123456789abcdef")).toBe(false); // wrong prefix
    expect(isTeamId("team_ZZZZZZZZ")).toBe(false); // base32, not hex
    expect(isTeamId("team_3KF9TQ2P")).toBe(false); // not 32 hex
    expect(isTeamId("")).toBe(false);
  });
});
