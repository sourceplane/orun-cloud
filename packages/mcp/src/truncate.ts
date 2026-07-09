// Byte-cap helper for oversized text payloads (logs, doc bodies). Truncation
// is explicit — the marker tells the agent how to fetch the rest (design §4
// "Output shape").

export const DEFAULT_MAX_TEXT_BYTES = 64 * 1024;

export interface TruncatedText {
  text: string;
  truncated: boolean;
  /** UTF-8 bytes dropped past the cap; 0 when not truncated. */
  truncatedBytes: number;
}

/**
 * Cap `input` at `maxBytes` of UTF-8 (never splitting a code point) and append
 * an explicit continuation marker when anything was dropped.
 */
export function truncateText(input: string, maxBytes: number): TruncatedText {
  const bytes = new TextEncoder().encode(input);
  if (bytes.length <= maxBytes) {
    return { text: input, truncated: false, truncatedBytes: 0 };
  }
  let end = Math.max(maxBytes, 0);
  // Back off any UTF-8 continuation bytes so the cut lands on a boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  const kept = new TextDecoder().decode(bytes.subarray(0, end));
  const truncatedBytes = bytes.length - end;
  return {
    text: `${kept}\n[truncated — ${truncatedBytes} more bytes; refine your query or use fromSeq/cursor]`,
    truncated: true,
    truncatedBytes,
  };
}
