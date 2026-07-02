import type { Env } from "./env.js";
import { errorResponse } from "./http.js";
import { resolveActor } from "./resolve-actor.js";

// teams-hub TH2 — the cross-workspace read layer. Account-scoped aggregation
// that fans out over the account's workspace set across the PER-ORG catalog and
// run indexes (design §3): no denormalized cross-workspace store, and no new
// authority — each per-workspace read goes through that workspace's own
// deny-by-default policy gate in the owning worker, so a workspace the viewer
// cannot read reports `denied` rather than leaking or silently vanishing
// (gate TH-C). The edge is the composition point because it already fronts
// both membership-worker (the workspace set) and state-worker (the indexes).

const ORG_ACCOUNT_CATALOG_RE = /^\/v1\/organizations\/([^/]+)\/account-catalog$/;
const ORG_ACCOUNT_RUNS_RE = /^\/v1\/organizations\/([^/]+)\/account-runs$/;

/** Fan-out bounds (gate TH-B): how many workspaces one aggregate call reads,
 * and how many downstream reads are in flight at once. */
const MAX_FANOUT_WORKSPACES = 20;
const FANOUT_CONCURRENCY = 4;

export function isAccountAggregateRoute(pathname: string): boolean {
  return ORG_ACCOUNT_CATALOG_RE.test(pathname) || ORG_ACCOUNT_RUNS_RE.test(pathname);
}

interface WorkspaceTag {
  orgId: string;
  workspaceRef: string;
  name: string;
}

/** Run `fn` over `items` with at most `limit` invocations in flight. */
async function boundedMap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function handleAccountAggregateRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }
  const catalogMatch = pathname.match(ORG_ACCOUNT_CATALOG_RE);
  const runsMatch = pathname.match(ORG_ACCOUNT_RUNS_RE);
  const orgIdParam = (catalogMatch ?? runsMatch)![1]!;
  const kind: "catalog" | "runs" = catalogMatch ? "catalog" : "runs";

  if (!env.IDENTITY_WORKER) {
    return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
  }
  if (!env.MEMBERSHIP_WORKER) {
    return errorResponse("internal_error", "Membership service unavailable", 503, requestId);
  }
  if (!env.STATE_WORKER) {
    return errorResponse("internal_error", "State service unavailable", 503, requestId);
  }

  const sessionResult = await resolveActor(request, env, requestId);
  if ("error" in sessionResult) {
    return sessionResult.error;
  }

  const headers = new Headers();
  headers.set("x-request-id", requestId);
  headers.set("x-actor-subject-id", sessionResult.subjectId);
  headers.set("x-actor-subject-type", sessionResult.subjectType);
  headers.set("x-actor-email", sessionResult.email);

  const membership = env.MEMBERSHIP_WORKER;
  const state = env.STATE_WORKER;

  // The fan-out set is {path org} ∪ children(path org): called on the account
  // root it spans the whole account; called on a child it degrades to that
  // workspace alone. The children read is gated (organization.member.list on
  // the path org) by membership-worker — its denial is OUR denial.
  let self: WorkspaceTag;
  let children: WorkspaceTag[];
  try {
    const [selfRes, childrenRes] = await Promise.all([
      membership.fetch(`https://membership.internal/v1/organizations/${encodeURIComponent(orgIdParam)}`, { headers }),
      membership.fetch(`https://membership.internal/v1/organizations/${encodeURIComponent(orgIdParam)}/workspaces`, { headers }),
    ]);
    if (!selfRes.ok || !childrenRes.ok) {
      const status = !selfRes.ok ? selfRes.status : childrenRes.status;
      if (status === 404) return errorResponse("not_found", "Organization not found", 404, requestId);
      if (status === 401) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      return errorResponse("internal_error", "Membership service unavailable", 503, requestId);
    }
    const selfBody = (await selfRes.json()) as { data?: { organization?: { id?: string; workspaceRef?: string; name?: string } } };
    const org = selfBody.data?.organization;
    self = { orgId: org?.id ?? orgIdParam, workspaceRef: org?.workspaceRef ?? "", name: org?.name ?? "" };
    const childrenBody = (await childrenRes.json()) as { data?: { workspaces?: WorkspaceTag[] } };
    children = childrenBody.data?.workspaces ?? [];
  } catch {
    return errorResponse("internal_error", "Membership service unavailable", 503, requestId);
  }

  const all = [self, ...children.filter((c) => c.orgId !== self.orgId)];
  const truncated = all.length > MAX_FANOUT_WORKSPACES;
  const fanout = all.slice(0, MAX_FANOUT_WORKSPACES);

  // Per-workspace read through the workspace's own authorized org endpoint,
  // with the caller's query (filters, limit) forwarded verbatim to each.
  const search = new URL(request.url).search;
  const pathFor = (w: WorkspaceTag): string =>
    kind === "catalog"
      ? `/v1/organizations/${encodeURIComponent(w.orgId)}/catalog/entities${search}`
      : `/v1/organizations/${encodeURIComponent(w.orgId)}/state/runs${search}`;

  const rows = await boundedMap(fanout, FANOUT_CONCURRENCY, async (w) => {
    try {
      const res = await state.fetch(`https://state.internal${pathFor(w)}`, { headers });
      if (res.status === 404 || res.status === 403) {
        return { workspace: w, status: "denied" as const, items: [] as unknown[] };
      }
      if (!res.ok) {
        return { workspace: w, status: "error" as const, items: [] as unknown[] };
      }
      const body = (await res.json()) as { data?: { entities?: unknown[]; runs?: unknown[] } };
      const items = (kind === "catalog" ? body.data?.entities : body.data?.runs) ?? [];
      return { workspace: w, status: "ok" as const, items };
    } catch {
      return { workspace: w, status: "error" as const, items: [] as unknown[] };
    }
  });

  const workspaces = rows.map((r) =>
    kind === "catalog"
      ? { workspace: r.workspace, status: r.status, entities: r.items }
      : { workspace: r.workspace, status: r.status, runs: r.items },
  );

  return Response.json(
    { data: { workspaces, truncated }, meta: { requestId, cursor: null } },
    { headers: { "content-type": "application/json" } },
  );
}
