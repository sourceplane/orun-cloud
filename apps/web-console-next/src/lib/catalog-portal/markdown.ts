/**
 * Catalog-portal markdown view-model (saas-catalog-portal CP5).
 *
 * The pure, dependency-free markdown parser the dedicated service page renders
 * its README / service-definition documents through. A faithful port of the
 * design's `parseInline` / `parseMd` (`design/Service_Catalog.dc.html`): a tiny
 * CommonMark subset — headings (h1–h3), paragraphs, ordered/unordered bullets,
 * fenced code, blockquotes, and inline **bold** / `code` / [links] / _em_.
 *
 * Typed blocks/spans so the renderer is a flat switch and the parser is unit
 * tested in isolation. Never executes or fetches — markdown in, data out.
 */

/** An inline run within a block: plain text or a styled fragment. */
export type MdSpanKind = "plain" | "bold" | "code" | "link" | "em";

export interface MdSpan {
  kind: MdSpanKind;
  text: string;
}

/** A block-level node. `spans` carries inline runs; `text` is raw (headings/code). */
export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "para"; spans: MdSpan[] }
  | { type: "bullet"; marker: string; spans: MdSpan[] }
  | { type: "code"; text: string }
  | { type: "quote"; spans: MdSpan[] };

const INLINE_RE = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]*)\)|_([^_]+)_)/;

/** Split a line of text into typed inline spans. */
export function parseInline(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let rest = text;
  let m: RegExpMatchArray | null;
  while ((m = rest.match(INLINE_RE))) {
    const idx = m.index ?? 0;
    if (idx > 0) spans.push({ kind: "plain", text: rest.slice(0, idx) });
    if (m[2] != null) spans.push({ kind: "bold", text: m[2] });
    else if (m[3] != null) spans.push({ kind: "code", text: m[3] });
    else if (m[4] != null) spans.push({ kind: "link", text: m[4] });
    else if (m[6] != null) spans.push({ kind: "em", text: m[6] });
    rest = rest.slice(idx + m[0].length);
  }
  if (rest) spans.push({ kind: "plain", text: rest });
  return spans.length ? spans : [{ kind: "plain", text }];
}

const FENCE_RE = /^(```|~~~)/;
const HEADING_RE = /^(#{1,3})\s+(.*)/;
const QUOTE_RE = /^>\s?/;
const ORDERED_RE = /^(\d+)\.\s+(.*)/;
const UNORDERED_RE = /^[-*]\s+/;
const BREAK_RE = /^(#{1,3}\s|[-*]\s|\d+\.\s|```|~~~|>\s?)/;

/** Parse a markdown source string into a flat list of typed blocks. */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r/g, "").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !FENCE_RE.test(lines[i]!)) {
        code.push(lines[i]!);
        i++;
      }
      i++; // closing fence
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = Math.min(3, heading[1]!.length) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, text: heading[2]! });
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      blocks.push({ type: "quote", spans: parseInline(line.replace(QUOTE_RE, "")) });
      i++;
      continue;
    }
    const ordered = line.match(ORDERED_RE);
    if (ordered) {
      blocks.push({ type: "bullet", marker: `${ordered[1]}.`, spans: parseInline(ordered[2]!) });
      i++;
      continue;
    }
    if (UNORDERED_RE.test(line)) {
      blocks.push({ type: "bullet", marker: "•", spans: parseInline(line.replace(UNORDERED_RE, "")) });
      i++;
      continue;
    }
    // paragraph — fold soft-wrapped lines until a blank line or a new block.
    const para = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" && !BREAK_RE.test(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    blocks.push({ type: "para", spans: parseInline(para.join(" ")) });
  }
  return blocks;
}
