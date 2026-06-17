// OV6 — the object-model reader (the catalog projector's framing keystone).
// Builds synthetic frames byte-for-byte the way the orun CLI does ("<kind>
// <len>\x00<body>"; tree entries "<kind> <name>\x00<64 hex>") and verifies the
// TS reader round-trips them and FAILS CLOSED on every corruption — so a
// tampered or partial object can never project bad catalog rows.

import {
  deframeObject,
  parseTreeBody,
  decodeJsonBlob,
  readTree,
  readJsonBlob,
  type ObjectFetcher,
} from "@state-worker/object-model";

const enc = new TextEncoder();
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
const NUL = new Uint8Array([0]);

/** Frame a body exactly as the object store does: "<kind> <len>\x00<body>". */
function frame(kind: string, body: Uint8Array | string): Uint8Array {
  const b = typeof body === "string" ? enc.encode(body) : body;
  return concat(enc.encode(`${kind} ${b.length}`), NUL, b);
}
/** One tree entry: "<entry-kind> <name>\x00<hex>" (fixed 64-char hex). */
function entry(kind: "blob" | "tree", name: string, hex: string): Uint8Array {
  return concat(enc.encode(`${kind} ${name}`), NUL, enc.encode(hex));
}

describe("deframeObject", () => {
  it("parses kind + body for a blob frame", () => {
    const out = deframeObject(frame("blob", "hello"));
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("blob");
    expect(new TextDecoder().decode(out!.body)).toBe("hello");
  });

  it("parses a non-structural kind (catalog-snapshot) and an empty body", () => {
    expect(deframeObject(frame("catalog-snapshot", ""))!.kind).toBe("catalog-snapshot");
    expect(deframeObject(frame("blob", ""))!.body.length).toBe(0);
  });

  it("returns null on a missing NUL terminator", () => {
    expect(deframeObject(enc.encode("blob 5 hello"))).toBeNull();
  });

  it("returns null on a non-numeric length", () => {
    expect(deframeObject(concat(enc.encode("blob x"), NUL, enc.encode("hi")))).toBeNull();
  });

  it("returns null when the declared length does not match the body (truncation/trailing)", () => {
    // Declares 99 bytes but only 2 follow.
    expect(deframeObject(concat(enc.encode("blob 99"), NUL, enc.encode("hi")))).toBeNull();
    // Declares 2 but 5 follow.
    expect(deframeObject(concat(enc.encode("blob 2"), NUL, enc.encode("hello")))).toBeNull();
  });
});

describe("parseTreeBody", () => {
  it("parses entries and reconstructs sha256:<hex> ids, preserving kind", () => {
    const body = concat(entry("tree", "components", A), entry("tree", "entities", B));
    const entries = parseTreeBody(body);
    expect(entries).toEqual([
      { name: "components", kind: "tree", id: `sha256:${A}` },
      { name: "entities", kind: "tree", id: `sha256:${B}` },
    ]);
  });

  it("parses a mix of blob and tree children", () => {
    const body = concat(entry("blob", "catalog.json", A), entry("tree", "entities", B));
    const entries = parseTreeBody(body)!;
    expect(entries[0]!.kind).toBe("blob");
    expect(entries[1]!.kind).toBe("tree");
  });

  it("rejects a non-ascending (tampered) name order", () => {
    const body = concat(entry("blob", "zeta", A), entry("blob", "alpha", B));
    expect(parseTreeBody(body)).toBeNull();
  });

  it("rejects a bad entry kind", () => {
    expect(parseTreeBody(concat(enc.encode("commit name"), NUL, enc.encode(A)))).toBeNull();
  });

  it("rejects a short or non-hex digest", () => {
    expect(parseTreeBody(concat(enc.encode("blob n"), NUL, enc.encode("a".repeat(10))))).toBeNull();
    expect(parseTreeBody(concat(enc.encode("blob n"), NUL, enc.encode("Z".repeat(64))))).toBeNull();
  });

  it("parses an empty tree body to an empty list", () => {
    expect(parseTreeBody(new Uint8Array(0))).toEqual([]);
  });
});

describe("decodeJsonBlob", () => {
  it("decodes a JSON blob body", () => {
    const obj = decodeJsonBlob<{ kind: string; name: string }>(
      frame("blob", JSON.stringify({ kind: "System", name: "identity" })),
    );
    expect(obj).toEqual({ kind: "System", name: "identity" });
  });

  it("returns null for a tree frame (not a blob)", () => {
    expect(decodeJsonBlob(frame("tree", entry("blob", "x", A)))).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    expect(decodeJsonBlob(frame("blob", "{not json"))).toBeNull();
  });
});

describe("readTree / readJsonBlob (injected fetch)", () => {
  function fetcher(map: Record<string, Uint8Array>): ObjectFetcher {
    return (digest: string) => Promise.resolve(map[digest] ?? null);
  }

  it("readTree fetches + deframes + parses a tree", async () => {
    const treeBytes = frame("tree", concat(entry("blob", "a.json", B), entry("blob", "b.json", C)));
    const entries = await readTree(fetcher({ [`sha256:${A}`]: treeBytes }), `sha256:${A}`);
    expect(entries).toHaveLength(2);
    expect(entries![0]!.id).toBe(`sha256:${B}`);
  });

  it("readTree returns null when the object is absent or not a tree", async () => {
    expect(await readTree(fetcher({}), `sha256:${A}`)).toBeNull();
    const blobBytes = frame("blob", "x");
    expect(await readTree(fetcher({ [`sha256:${A}`]: blobBytes }), `sha256:${A}`)).toBeNull();
  });

  it("readJsonBlob fetches + decodes a JSON blob", async () => {
    const blobBytes = frame("blob", JSON.stringify({ entityKey: "ns/repo/api" }));
    const out = await readJsonBlob<{ entityKey: string }>(fetcher({ [`sha256:${A}`]: blobBytes }), `sha256:${A}`);
    expect(out!.entityKey).toBe("ns/repo/api");
  });

  it("readJsonBlob returns null on a missing object", async () => {
    expect(await readJsonBlob(fetcher({}), `sha256:${A}`)).toBeNull();
  });
});
