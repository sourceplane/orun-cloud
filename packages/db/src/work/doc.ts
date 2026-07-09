// Cloud document canonicalization + content address (orun-work-v3 §1.4).
//
// V3-2: the digest form matches the digest `orun work import` computes for a
// repo README (`sha256:<hex>` over the raw UTF-8 bytes), so a cloud-authored
// document and a repo-imported one share one doc_ref column and one sealing
// path. Canonicalization here is line endings only (CRLF → LF) — no other
// mutation, so what you hash is what you read back.

export function canonicalDocBody(body: string): string {
  return body.replace(/\r\n/g, "\n");
}

export async function docDigest(canonicalBody: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalBody);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const b of new Uint8Array(hash)) hex += b.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}
