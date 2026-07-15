import { describe, expect, it } from "vitest";

import { classifyRevoke, type BrokeredSecretRef } from "../src/revoke-guard.js";

const refs: BrokeredSecretRef[] = [
  { id: "sec_1", secretKey: "SUPABASE_ACCESS_TOKEN", scope: "project" },
  { id: "sec_2", secretKey: "SUPABASE_ACCESS_TOKEN-PROD", scope: "environment (prod)" },
];

describe("classifyRevoke (brokered-orphan-safety)", () => {
  it("allows revoke when no brokered secrets reference the connection", () => {
    expect(classifyRevoke([], { force: false })).toEqual({
      allow: true,
      orphans: [],
      forced: false,
    });
  });

  it("blocks revoke and returns blockers when references exist and not forced", () => {
    const d = classifyRevoke(refs, { force: false });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.blockers).toHaveLength(2);
      expect(d.blockers.map((b) => b.secretKey)).toContain("SUPABASE_ACCESS_TOKEN-PROD");
    }
  });

  it("allows a forced revoke but reports the orphaned casualties", () => {
    const d = classifyRevoke(refs, { force: true });
    expect(d.allow).toBe(true);
    if (d.allow) {
      expect(d.forced).toBe(true);
      expect(d.orphans).toHaveLength(2);
    }
  });

  it("does not mutate the caller's reference array", () => {
    const input: BrokeredSecretRef[] = [...refs];
    classifyRevoke(input, { force: true });
    expect(input).toHaveLength(2);
  });
});
