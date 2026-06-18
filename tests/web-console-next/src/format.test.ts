import { formatDate, formatTimestamp } from "@web-console-next/lib/format";

describe("formatDate / formatTimestamp", () => {
  it("renders a real date compactly (date-only vs date+time)", () => {
    const iso = "2026-06-18T15:14:00.000Z";
    const date = formatDate(iso);
    const ts = formatTimestamp(iso);
    // Locale-dependent exact string, but: both mention the year, and the
    // timestamp is the longer (carries a time component).
    expect(date).toContain("2026");
    expect(ts).toContain("2026");
    expect(ts.length).toBeGreaterThan(date.length);
  });

  it("returns an em dash for null/undefined/empty", () => {
    for (const v of [null, undefined, ""]) {
      expect(formatDate(v)).toBe("—");
      expect(formatTimestamp(v)).toBe("—");
    }
  });

  it("returns an em dash for an unparseable value (never 'Invalid Date')", () => {
    expect(formatDate("not-a-date")).toBe("—");
    expect(formatTimestamp("not-a-date")).toBe("—");
  });
});
