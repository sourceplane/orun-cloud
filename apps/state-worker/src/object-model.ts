// Object-model reader (OV6 — the catalog projector's framing keystone). The
// hosted ObjectStore holds content-addressed objects exactly as the orun CLI
// frames them (object-store.md §2.1): every object is "<kind> <len>\x00<body>",
// sha256 over the whole frame. A TREE body is a sorted, separator-less run of
// entries, each "<entry-kind> <name>\x00<hex>" where hex is the fixed-width
// (64-char, no "sha256:" prefix) digest of the child.
//
// This module is the TYPESCRIPT mirror of that wire format — deframe an object,
// parse a tree body, decode a JSON blob — so the state-worker can walk a pushed
// catalog snapshot WITHOUT a Go runtime. It is deliberately pure (no R2, no DB):
// callers inject the byte-fetch, which keeps the framing logic exhaustively
// unit-testable against synthetic frames and fail-closed on any corruption.

const SP = 0x20;
const NUL = 0x00;
/** sha256 hex width — the fixed digest length a tree entry carries (no prefix). */
const SHA256_HEX_LEN = 64;
const DIGITS_RE = /^[0-9]+$/;
const HEX_RE = /^[0-9a-f]{64}$/;

const decoder = new TextDecoder();

export type ObjectKind = "blob" | "tree";

export interface DeframedObject {
  /** The frame's declared kind (e.g. 'blob', 'tree', 'catalog-snapshot'). */
  kind: string;
  /** The body bytes (exactly the declared length). */
  body: Uint8Array;
}

export interface TreeEntry {
  name: string;
  kind: ObjectKind;
  /** Child object id, reconstructed as 'sha256:<hex>'. */
  id: string;
}

/**
 * Deframe one stored object: parse "<kind> <len>\x00<body>" and return the kind
 * and the body sliced to exactly <len> bytes. Returns null on any malformation
 * (missing SP/NUL, non-numeric length, or a body shorter than declared) so a
 * corrupt object can never propagate as a partial parse.
 */
export function deframeObject(frame: Uint8Array): DeframedObject | null {
  const sp = frame.indexOf(SP);
  if (sp <= 0) return null;
  const nul = frame.indexOf(NUL, sp + 1);
  if (nul < 0) return null;
  const lenStr = decoder.decode(frame.subarray(sp + 1, nul));
  if (!DIGITS_RE.test(lenStr)) return null;
  const len = Number(lenStr);
  const bodyStart = nul + 1;
  // The frame must hold exactly the declared body (no truncation, no trailing).
  if (bodyStart + len !== frame.length) return null;
  const kind = decoder.decode(frame.subarray(0, sp));
  return { kind, body: frame.subarray(bodyStart, bodyStart + len) };
}

/**
 * Parse a TREE body into its entries. The format is separator-less: each entry
 * is "<entry-kind> <name>\x00<64 hex>", and the fixed hex width is what lets the
 * next entry start immediately. Returns null on any corruption (bad kind, no
 * NUL, a short/non-hex digest), and enforces the canonical strictly-ascending
 * name order so a hand-tampered tree is rejected (matches the Go decoder).
 */
export function parseTreeBody(body: Uint8Array): TreeEntry[] | null {
  const entries: TreeEntry[] = [];
  let i = 0;
  let prevName: string | null = null;
  while (i < body.length) {
    const sp = body.indexOf(SP, i);
    if (sp < 0) return null;
    const kind = decoder.decode(body.subarray(i, sp));
    if (kind !== "blob" && kind !== "tree") return null;
    i = sp + 1;

    const nul = body.indexOf(NUL, i);
    if (nul < 0) return null;
    const name = decoder.decode(body.subarray(i, nul));
    if (name.length === 0) return null;
    if (prevName !== null && name <= prevName) return null; // strictly ascending
    prevName = name;
    i = nul + 1;

    if (i + SHA256_HEX_LEN > body.length) return null;
    const hex = decoder.decode(body.subarray(i, i + SHA256_HEX_LEN));
    if (!HEX_RE.test(hex)) return null;
    i += SHA256_HEX_LEN;

    entries.push({ name, kind, id: `sha256:${hex}` });
  }
  return entries;
}

/** Deframe and JSON-parse a blob body. Returns null unless the frame is a well-
 *  formed 'blob' carrying valid JSON — fail-closed for the projector. */
export function decodeJsonBlob<T>(frame: Uint8Array): T | null {
  const obj = deframeObject(frame);
  if (!obj || obj.kind !== "blob") return null;
  try {
    return JSON.parse(decoder.decode(obj.body)) as T;
  } catch {
    return null;
  }
}

/** Fetch raw frame bytes for a content address; null when absent. */
export type ObjectFetcher = (digest: string) => Promise<Uint8Array | null>;

/**
 * Deframe an object expected to be a tree and return its entries, or null when
 * the object is absent, not a tree, or corrupt. The one-call convenience the
 * catalog walk uses at every tree node.
 */
export async function readTree(fetch: ObjectFetcher, digest: string): Promise<TreeEntry[] | null> {
  const bytes = await fetch(digest);
  if (!bytes) return null;
  const obj = deframeObject(bytes);
  if (!obj || obj.kind !== "tree") return null;
  return parseTreeBody(obj.body);
}

/** Fetch + decode a JSON blob in one call; null on absence/corruption. */
export async function readJsonBlob<T>(fetch: ObjectFetcher, digest: string): Promise<T | null> {
  const bytes = await fetch(digest);
  if (!bytes) return null;
  return decodeJsonBlob<T>(bytes);
}
