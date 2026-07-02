// POST …/state/runs/{runId}/secrets/resolve — the lease-bound secrets resolve
// (saas-secret-manager SM3; state-api-contract §4). The ONLY value-returning
// machine route on the platform.
//
// Two INDEPENDENT gates, in order (the keystone property):
//   1. Bearer authz — exactly the coordination verbs' `state.run.write` gate
//      (workflow binding OR role policy, deny-as-404 resource-hiding).
//   2. A LIVE job lease matching (runId, jobId, runnerId, leaseEpoch) — the
//      same epoch discipline as :heartbeat/:complete; a lapsed/reassigned
//      lease is `409 lease_lost`. A stolen bearer alone can never pull values.
//
// The route then translates each `secret://<workspace>/<project>/<env>/KEY[@v]`
// ref into the config plane's scope — the workspace/project segments MUST
// name this route's own (org, project) (slug, public id, or ws_ ref; verified
// against membership/projects, never trusted textually), and the environment
// slug resolves to the environment UUID via projects-worker — and forwards the
// verified actor + server-derived run facts to config-worker's internal
// resolve over the CONFIG_WORKER service binding. The decrypt itself lives
// there; this worker never sees key material, only the response it relays.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Run } from "@saas/db/state";
import { createStateRepository } from "@saas/db/state";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { STATE_POLICY_ACTIONS } from "@saas/contracts/state";
import { errorResponse, successResponse, validationError } from "../http.js";
import { authorizeRun } from "../authz.js";
import { parseOrgPublicId, parseProjectPublicId } from "../ids.js";
import { verifyLiveLease, type VerifyLeaseArgs, type VerifyLeaseResult } from "../lease.js";
import { resolveOrgRef } from "../membership-client.js";
import { resolveProject } from "../projects-client.js";
import { listProjectEnvironments, type ResolvedEnvironment } from "../projects-client.js";
import {
  resolveSecretsInternal,
  type InternalResolveKey,
  type InternalResolveSecretsRequest,
} from "../config-client.js";

/** Contract cap: at most 50 refs per resolve call. */
const MAX_REFS = 50;

/** TTL the runner may cache served values for (contract §4). */
const RESOLVE_TTL_SECONDS = 300;

// secret://<workspace>/<project>/<env>/<KEY>[@v] — KEY mirrors config-worker's
// secretKey grammar; the version pin is a positive integer.
const SECRET_REF_RE =
  /^secret:\/\/([^/]+)\/([^/]+)\/([^/]+)\/([A-Za-z][A-Za-z0-9._-]{0,127})(?:@([1-9][0-9]{0,8}))?$/;

interface ParsedRef {
  raw: string;
  workspace: string;
  project: string;
  environment: string;
  key: string;
  version?: number;
}

export interface SecretsResolveDeps {
  executor?: SqlExecutor;
  /** Lease verifier (tests). */
  verifyLease?: (env: Env, args: VerifyLeaseArgs) => Promise<VerifyLeaseResult>;
  /** Workspace-segment resolver: any org spelling → raw org uuid (tests). */
  resolveOrgSegment?: (segment: string) => Promise<string | null>;
  /** Project-segment resolver: slug → raw project uuid or null (tests). */
  resolveProjectSlug?: (slug: string) => Promise<string | null>;
  /** Environment listing (tests). */
  listEnvironments?: () => Promise<ResolvedEnvironment[] | null>;
  /** config-worker internal resolve (tests). */
  configResolve?: (body: InternalResolveSecretsRequest) => Promise<Response>;
}

/** Server-derived platform fact — from the VERIFIED actor kind, never the body. */
export function platformFromActorKind(subjectType: string): "ci-oidc" | "local-cli" | "service" {
  switch (subjectType) {
    case "workflow":
      return "ci-oidc";
    case "user":
      return "local-cli";
    default:
      // service_principal and anything else machine-shaped serves as "service";
      // the personal rung and CI-trust conditions are both closed to it.
      return "service";
  }
}

/** `refs/heads/main` → `main`; a bare ref passes through; null when absent. */
function branchFromGitRef(gitRef: string | null): string | null {
  if (!gitRef) return null;
  return gitRef.startsWith("refs/heads/") ? gitRef.slice("refs/heads/".length) : gitRef;
}

export async function handleResolveRunSecrets(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  projectId: Uuid,
  runUlid: string,
  deps?: SecretsResolveDeps,
): Promise<Response> {
  // ── Gate 1: bearer authz — the resolve action `secret.value.use`
  //    (state-api-contract §6). authorizeRun handles all actor kinds (workflow
  //    via bound scope, user/service_principal via role policy); deny-as-404. ──
  const authz = await authorizeRun(env, requestId, actor, orgId, projectId, STATE_POLICY_ACTIONS.SECRET_VALUE_USE);
  if (!authz.ok) return authz.response;

  // ── Body validation. ──
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }
  const fields: Record<string, string[]> = {};
  const runnerId = typeof body.runnerId === "string" ? body.runnerId : "";
  if (!runnerId) fields.runnerId = ["Required; non-empty string"];
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  if (!jobId) fields.jobId = ["Required; non-empty string"];
  const leaseEpoch = typeof body.leaseEpoch === "number" ? body.leaseEpoch : NaN;
  if (!Number.isFinite(leaseEpoch)) fields.leaseEpoch = ["Required; number"];
  const refsRaw = body.refs;
  let refs: string[] = [];
  if (!Array.isArray(refsRaw) || refsRaw.length === 0 || !refsRaw.every((r) => typeof r === "string")) {
    fields.refs = ["Required; a non-empty array of secret:// ref strings"];
  } else if (refsRaw.length > MAX_REFS) {
    fields.refs = [`At most ${MAX_REFS} refs per resolve`];
  } else {
    refs = refsRaw as string[];
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  // ── Ref parsing. Every ref must parse and share ONE environment slug (the
  //    resolve is scoped to a single environment per call). ──
  const parsed: ParsedRef[] = [];
  for (const raw of refs) {
    const m = raw.match(SECRET_REF_RE);
    if (!m) {
      return validationError(requestId, {
        refs: [`Malformed ref (expected secret://<workspace>/<project>/<env>/<KEY>[@version]): ${raw}`],
      });
    }
    const ref: ParsedRef = { raw, workspace: m[1]!, project: m[2]!, environment: m[3]!, key: m[4]! };
    if (m[5] !== undefined) ref.version = Number.parseInt(m[5], 10);
    parsed.push(ref);
  }
  const envSlug = parsed[0]!.environment;
  if (parsed.some((r) => r.environment.toLowerCase() !== envSlug.toLowerCase())) {
    return validationError(requestId, {
      refs: ["All refs in one resolve must target the same environment"],
    });
  }
  // Dedupe keys; a key pinned to two different versions is a contradiction.
  const keyMap = new Map<string, InternalResolveKey>();
  for (const r of parsed) {
    const existing = keyMap.get(r.key);
    if (existing) {
      if ((existing.version ?? null) !== (r.version ?? null)) {
        return validationError(requestId, {
          refs: [`Key ${r.key} is requested at conflicting versions`],
        });
      }
      continue;
    }
    const entry: InternalResolveKey = { key: r.key };
    if (r.version !== undefined) entry.version = r.version;
    keyMap.set(r.key, entry);
  }

  const executor = deps?.executor ?? (env.PLATFORM_DB ? createSqlExecutor(env.PLATFORM_DB) : null);
  if (!executor) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const owned = !deps?.executor;
  try {
    // ── Run row: trigger facts + resource-hiding 404 for unknown runs. ──
    const repo = createStateRepository(executor);
    const runResult = await repo.getRunByUlid(orgId, projectId, runUlid);
    if (!runResult.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const run: Run = runResult.value;

    // ── Gate 2: the LIVE lease (both backends; 409 lease_lost on failure —
    //    the same envelope as the :heartbeat/:complete verbs). ──
    const verify = deps?.verifyLease ?? ((e: Env, a: VerifyLeaseArgs) => verifyLiveLease(e, a, { executor }));
    const lease = await verify(env, { orgId, projectId, runUlid, jobId, runnerId, leaseEpoch });
    if (!lease.live) {
      return errorResponse("lease_lost", "Job lease is not live for this runner", 409, requestId);
    }

    // ── Workspace/project segments must name THIS route's scope. Verified
    //    against membership/projects (slug, public id, or ws_ ref) — a ref can
    //    never widen the scope the bearer + lease authorized. ──
    const orgSegmentOk = await verifySegments(
      env,
      requestId,
      deps,
      orgId,
      projectId,
      parsed,
    );
    if (orgSegmentOk !== null) return orgSegmentOk;

    // ── Environment slug → environment UUID (projects-worker seam). ──
    let environments: ResolvedEnvironment[] | null = null;
    if (deps?.listEnvironments) {
      environments = await deps.listEnvironments();
    } else if (env.PROJECTS_WORKER) {
      const listed = await listProjectEnvironments(env.PROJECTS_WORKER, orgId, projectId, requestId);
      environments = listed.ok ? listed.environments : null;
    }
    if (environments === null) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    const environment = environments.find((e) => e.slug.toLowerCase() === envSlug.toLowerCase());
    if (!environment) {
      // Unknown environment hides as a 404, like every other miss.
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    // ── Forward to config-worker's internal resolve with the verified actor
    //    and the server-derived facts (platform from the actor kind; trigger
    //    from the run row — never from the request body). ──
    const internalBody: InternalResolveSecretsRequest = {
      orgId,
      projectId,
      environmentId: environment.id,
      environment: environment.slug,
      keys: [...keyMap.values()],
      platform: platformFromActorKind(actor.subjectType),
      trigger: {
        branch: branchFromGitRef(run.gitRef),
        declared: run.source === "ci",
      },
      runId: runUlid,
      jobId,
    };

    let downstream: Response;
    if (deps?.configResolve) {
      downstream = await deps.configResolve(internalBody);
    } else {
      if (!env.CONFIG_WORKER) {
        return errorResponse("internal_error", "Config service not configured", 503, requestId);
      }
      downstream = await resolveSecretsInternal(
        env.CONFIG_WORKER,
        { subjectId: actor.subjectId, subjectType: actor.subjectType },
        internalBody,
        requestId,
      );
    }

    const text = await downstream.text();
    if (downstream.status === 200) {
      let data: Record<string, unknown>;
      try {
        data = (JSON.parse(text) as { data: Record<string, unknown> }).data;
      } catch {
        return errorResponse("internal_error", "Config service returned an invalid response", 502, requestId);
      }
      // Relay verbatim + the contract's ttlSeconds (§4).
      return successResponse({ ...data, ttlSeconds: RESOLVE_TTL_SECONDS }, requestId);
    }
    // Typed denial / error: relay config-worker's envelope verbatim (it names
    // denied keys' reason codes only — never values).
    return new Response(text, {
      status: downstream.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (owned && "dispose" in executor) {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}

/**
 * Verify every ref's workspace + project segment resolves to exactly the
 * path-scoped (org, project). Returns an error Response on mismatch/failure,
 * or null when all segments check out. Segments are resolved at most once each.
 */
async function verifySegments(
  env: Env,
  requestId: string,
  deps: SecretsResolveDeps | undefined,
  orgId: Uuid,
  projectId: Uuid,
  refs: ParsedRef[],
): Promise<Response | null> {
  const orgSegments = new Set(refs.map((r) => r.workspace));
  for (const segment of orgSegments) {
    let resolved: string | null;
    if (segment.startsWith("org_")) {
      resolved = parseOrgPublicId(segment);
    } else if (deps?.resolveOrgSegment) {
      resolved = await deps.resolveOrgSegment(segment);
    } else if (env.MEMBERSHIP_WORKER) {
      const result = await resolveOrgRef(env.MEMBERSHIP_WORKER, segment, requestId);
      resolved = result.ok ? result.orgUuid : null;
    } else {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    if (resolved !== orgId) {
      return validationError(requestId, {
        refs: [`Ref workspace "${segment}" does not name this run's workspace`],
      });
    }
  }

  const projectSegments = new Set(refs.map((r) => r.project));
  for (const segment of projectSegments) {
    let resolved: string | null;
    if (segment.startsWith("prj_")) {
      resolved = parseProjectPublicId(segment);
    } else if (deps?.resolveProjectSlug) {
      resolved = await deps.resolveProjectSlug(segment);
    } else if (env.PROJECTS_WORKER) {
      const result = await resolveProject(env.PROJECTS_WORKER, orgId, { slug: segment.toLowerCase() }, requestId);
      resolved = result.ok && result.project ? parseProjectPublicId(result.project.id) : null;
    } else {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    if (resolved !== projectId) {
      return validationError(requestId, {
        refs: [`Ref project "${segment}" does not name this run's project`],
      });
    }
  }

  return null;
}
