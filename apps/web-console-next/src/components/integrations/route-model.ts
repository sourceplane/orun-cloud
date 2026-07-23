/**
 * The canonical integration route's shape resolver (IR2, epic risks R2).
 *
 * `/integrations/[slug]` handles EXACTLY two shapes and nothing else:
 * a connection public id (`int_<32hex>`) — a legacy deep link that redirects
 * to the nested detail route — or a provider id, rendered as the space.
 * Keeping this a pure module lets the R2 guard test enumerate the contract's
 * provider-id set against the reserved segments.
 */

export const CONNECTION_ID_RE = /^int_[0-9a-f]{32}$/;

/** Static segments nested under `[slug]` — a provider id may never collide. */
export const RESERVED_SLUG_SEGMENTS = ["connections"] as const;

export type SlugResolution =
  | { kind: "connection"; connectionId: string }
  | { kind: "provider"; providerId: string };

export function resolveIntegrationSlug(segment: string): SlugResolution {
  if (CONNECTION_ID_RE.test(segment)) {
    return { kind: "connection", connectionId: segment };
  }
  return { kind: "provider", providerId: segment };
}
