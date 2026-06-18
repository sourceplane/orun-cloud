/**
 * Catalog entity URL key codec (saas-service-catalog SC0).
 *
 * The org catalog's merged-graph identity is the triple `(sourceProjectId,
 * sourceEnvironment, entityRef)` — and `entityRef` itself contains `:` and `/`
 * (e.g. `component:default/api`), so it cannot be a raw path segment. We encode
 * the whole triple into a single opaque, URL-safe segment so an entity gets a
 * stable, shareable route (`/orgs/{org}/catalog/{entityKey}`).
 *
 * Dependency-free and isomorphic (browser, edge runtime, and the jest/node test
 * env all provide `btoa`/`atob`/`TextEncoder`/`TextDecoder`) so the codec is
 * unit-testable in isolation and safe to call during SSR.
 */

/** ASCII Unit Separator — never appears in project ids, env slugs, or refs. */
const SEP = "";

export interface EntityIdentity {
  /** Provenance project public id (prj_…). */
  sourceProjectId: string;
  /** Environment scope, or null for the project-wide head. */
  sourceEnvironment: string | null;
  /** Stable entity ref within the catalog (e.g. `component:default/api`). */
  entityRef: string;
}

function base64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(param: string): string | null {
  try {
    let b64 = param.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Encode an entity's identity triple into one URL-safe path segment. */
export function encodeEntityKey(id: EntityIdentity): string {
  const raw = `${id.sourceProjectId}${SEP}${id.sourceEnvironment ?? ""}${SEP}${id.entityRef}`;
  return base64UrlEncode(raw);
}

/** Decode a path segment back to the identity triple, or null if malformed. */
export function decodeEntityKey(param: string): EntityIdentity | null {
  const raw = base64UrlDecode(param);
  if (raw === null) return null;
  const parts = raw.split(SEP);
  if (parts.length !== 3) return null;
  const [sourceProjectId, env, entityRef] = parts;
  if (!sourceProjectId || !entityRef) return null;
  return {
    sourceProjectId,
    sourceEnvironment: env === "" ? null : (env ?? null),
    entityRef,
  };
}

/** The catalog kinds, in their canonical display casing (mirrors the browser). */
const KINDS = ["Component", "API", "Resource", "System", "Domain", "Group"];

/**
 * Parse a catalog `entityRef` (`<kind>:<namespace>/<name>`) into display parts.
 * Best-effort: a ref that does not match the shape degrades to a bare name so
 * the UI never throws on unexpected input.
 */
export function parseEntityRef(entityRef: string): {
  kind: string;
  namespace: string | null;
  name: string;
} {
  const colon = entityRef.indexOf(":");
  if (colon === -1) return { kind: "", namespace: null, name: entityRef };
  const rawKind = entityRef.slice(0, colon);
  const rest = entityRef.slice(colon + 1);
  const slash = rest.indexOf("/");
  const namespace = slash === -1 ? null : rest.slice(0, slash);
  const name = slash === -1 ? rest : rest.slice(slash + 1);
  const kind = KINDS.find((k) => k.toLowerCase() === rawKind.toLowerCase());
  return {
    kind: kind ?? (rawKind ? rawKind[0]!.toUpperCase() + rawKind.slice(1) : ""),
    namespace,
    name,
  };
}
