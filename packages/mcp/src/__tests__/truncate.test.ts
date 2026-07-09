import { describe, expect, it } from "vitest";

import { truncateText } from "../truncate.js";

describe("truncateText", () => {
  it("returns text under the cap unchanged", () => {
    const res = truncateText("hello", 64);
    expect(res).toEqual({ text: "hello", truncated: false, truncatedBytes: 0 });
  });

  it("caps at the byte limit and appends an explicit continuation marker", () => {
    const res = truncateText("a".repeat(100), 10);
    expect(res.truncated).toBe(true);
    expect(res.truncatedBytes).toBe(90);
    expect(res.text.startsWith("a".repeat(10))).toBe(true);
    expect(res.text).toContain(
      "[truncated — 90 more bytes; refine your query or use fromSeq/cursor]",
    );
  });

  it("never splits a multi-byte code point", () => {
    // "é" is 2 bytes in UTF-8; a 3-byte cap lands mid-code-point.
    const res = truncateText("aéé", 3);
    expect(res.text.startsWith("aé")).toBe(true);
    expect(res.text).not.toContain("�");
    expect(res.truncatedBytes).toBe(2);
  });
});
