/**
 * Unit tests for the catalog-portal markdown view-model (CP5).
 */

import { parseInline, parseMarkdown } from "@web-console-next/lib/catalog-portal/markdown";

describe("parseInline", () => {
  it("returns a single plain span for plain text", () => {
    expect(parseInline("just text")).toEqual([{ kind: "plain", text: "just text" }]);
  });

  it("parses bold, code, link and emphasis runs", () => {
    expect(parseInline("a **b** c")).toEqual([
      { kind: "plain", text: "a " },
      { kind: "bold", text: "b" },
      { kind: "plain", text: " c" },
    ]);
    expect(parseInline("call `fn()` now")).toEqual([
      { kind: "plain", text: "call " },
      { kind: "code", text: "fn()" },
      { kind: "plain", text: " now" },
    ]);
    expect(parseInline("see [docs](http://x)")).toEqual([
      { kind: "plain", text: "see " },
      { kind: "link", text: "docs" },
    ]);
    expect(parseInline("_quiet_ word")).toEqual([
      { kind: "em", text: "quiet" },
      { kind: "plain", text: " word" },
    ]);
  });

  it("parses multiple inline runs in order", () => {
    expect(parseInline("**a** and `b`")).toEqual([
      { kind: "bold", text: "a" },
      { kind: "plain", text: " and " },
      { kind: "code", text: "b" },
    ]);
  });
});

describe("parseMarkdown", () => {
  it("parses h1/h2/h3 headings at the right level", () => {
    expect(parseMarkdown("# Title")).toEqual([{ type: "heading", level: 1, text: "Title" }]);
    expect(parseMarkdown("## Section")).toEqual([{ type: "heading", level: 2, text: "Section" }]);
    expect(parseMarkdown("### Sub")).toEqual([{ type: "heading", level: 3, text: "Sub" }]);
  });

  it("folds soft-wrapped lines into one paragraph", () => {
    const blocks = parseMarkdown("line one\nline two\n\nnext");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "para", spans: [{ kind: "plain", text: "line one line two" }] });
    expect(blocks[1]).toEqual({ type: "para", spans: [{ kind: "plain", text: "next" }] });
  });

  it("parses ordered and unordered bullets with their markers", () => {
    const [ordered, unordered] = parseMarkdown("1. first\n- second");
    expect(ordered).toEqual({ type: "bullet", marker: "1.", spans: [{ kind: "plain", text: "first" }] });
    expect(unordered).toEqual({ type: "bullet", marker: "•", spans: [{ kind: "plain", text: "second" }] });
  });

  it("captures fenced code blocks verbatim and stops at the closing fence", () => {
    const blocks = parseMarkdown("~~~\na = 1\nb = 2\n~~~\nafter");
    expect(blocks[0]).toEqual({ type: "code", text: "a = 1\nb = 2" });
    expect(blocks[1]).toEqual({ type: "para", spans: [{ kind: "plain", text: "after" }] });
  });

  it("parses blockquotes with inline spans", () => {
    expect(parseMarkdown("> note **here**")).toEqual([
      { type: "quote", spans: [{ kind: "plain", text: "note " }, { kind: "bold", text: "here" }] },
    ]);
  });

  it("skips blank lines", () => {
    expect(parseMarkdown("\n\n# H\n\n")).toEqual([{ type: "heading", level: 1, text: "H" }]);
  });
});
