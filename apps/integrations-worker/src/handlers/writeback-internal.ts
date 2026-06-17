// IG9.3 — the internal write-back endpoint. state-worker drives this on a
// run-result event (OV5): it POSTs a Check Run / commit-status projection and
// this worker — which alone holds the App key — resolves the installation,
// mints a SCOPED token, posts to GitHub, and audits. state-worker never sees
// the credential and never calls GitHub directly.
//
// Authentication is the service-binding boundary (x-internal-caller, checked in
// the router), NOT a user bearer. The body carries the org as a public id and
// the repo by its rename-stable provider id; the "owner/repo" GitHub path is
// resolved server-side from the authoritative repo link, never trusted from the
// caller.
//
// Fail-soft contract: the underlying service NEVER throws — an unlinked repo or
// an un-granted permission is "skipped", a GitHub error is "failed". So this
// handler returns 200 with the outcome as data; only a malformed body is a 4xx.

import type { Env } from "../env.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { parseOrgPublicId } from "../ids.js";
import { postCheckRun, postCommitStatus, type WritebackDeps, type WritebackOutcome } from "../writeback.js";
import type {
  WritebackCheckRun,
  WritebackCommitStatus,
  WritebackResponse,
} from "@saas/contracts/integrations";

const CHECK_STATUSES = new Set(["queued", "in_progress", "completed"]);
const COMMIT_STATES = new Set(["error", "failure", "pending", "success"]);

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

type Validated<T> = { ok: true; value: T } | { ok: false; fields: Record<string, string[]> };

function validateCheckRun(raw: unknown): Validated<WritebackCheckRun> {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, fields: { checkRun: ["Required object"] } };
  }
  const o = raw as Record<string, unknown>;
  const name = str(o.name);
  const headSha = str(o.headSha);
  const title = str(o.title);
  const summary = str(o.summary);
  const status = str(o.status);
  const fields: Record<string, string[]> = {};
  if (!name) fields.name = ["Required"];
  if (!headSha) fields.headSha = ["Required"];
  if (title === null) fields.title = ["Required"];
  if (summary === null) fields.summary = ["Required"];
  if (!status || !CHECK_STATUSES.has(status)) fields.status = ["Must be queued|in_progress|completed"];
  // A completed check run must carry a conclusion (GitHub requires it).
  const conclusion = o.conclusion === undefined ? undefined : str(o.conclusion);
  if (status === "completed" && !conclusion) fields.conclusion = ["Required when status is completed"];
  if (o.conclusion !== undefined && conclusion === null) fields.conclusion = ["Must be a non-empty string"];
  const detailsUrl = o.detailsUrl === undefined ? undefined : str(o.detailsUrl);
  if (o.detailsUrl !== undefined && detailsUrl === null) fields.detailsUrl = ["Must be a non-empty string"];
  if (Object.keys(fields).length > 0) return { ok: false, fields };

  const value: WritebackCheckRun = {
    name: name!,
    headSha: headSha!,
    status: status as WritebackCheckRun["status"],
    title: title!,
    summary: summary!,
  };
  if (conclusion) value.conclusion = conclusion;
  if (detailsUrl) value.detailsUrl = detailsUrl;
  return { ok: true, value };
}

function validateCommitStatus(raw: unknown): Validated<WritebackCommitStatus> {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, fields: { status: ["Required object"] } };
  }
  const o = raw as Record<string, unknown>;
  const sha = str(o.sha);
  const state = str(o.state);
  const context = str(o.context);
  const fields: Record<string, string[]> = {};
  if (!sha) fields.sha = ["Required"];
  if (!context) fields.context = ["Required"];
  if (!state || !COMMIT_STATES.has(state)) fields.state = ["Must be error|failure|pending|success"];
  const description = o.description === undefined ? undefined : str(o.description);
  if (o.description !== undefined && description === null) fields.description = ["Must be a non-empty string"];
  const targetUrl = o.targetUrl === undefined ? undefined : str(o.targetUrl);
  if (o.targetUrl !== undefined && targetUrl === null) fields.targetUrl = ["Must be a non-empty string"];
  if (Object.keys(fields).length > 0) return { ok: false, fields };

  const value: WritebackCommitStatus = {
    sha: sha!,
    state: state as WritebackCommitStatus["state"],
    context: context!,
  };
  if (description) value.description = description;
  if (targetUrl) value.targetUrl = targetUrl;
  return { ok: true, value };
}

function toResponse(outcome: WritebackOutcome): WritebackResponse {
  switch (outcome.kind) {
    case "posted":
      return { outcome: "posted", resource: outcome.resource };
    case "skipped":
      return { outcome: "skipped", reason: outcome.reason };
    case "failed":
      return { outcome: "failed", reason: outcome.reason };
  }
}

export async function handleWritebackInternal(
  request: Request,
  env: Env,
  requestId: string,
  deps?: WritebackDeps,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  // Common fields: org (public id → uuid) and the rename-stable repo id. The
  // "owner/repo" path is resolved server-side from the repo link, not here.
  const orgId = parseOrgPublicId(str(body.orgId) ?? "");
  if (!orgId) return validationError(requestId, { orgId: ["Invalid or missing organization id"] });
  const repoExternalId = str(body.repoExternalId);
  if (!repoExternalId) return validationError(requestId, { repoExternalId: ["Required"] });

  if (body.kind === "check_run") {
    const v = validateCheckRun(body.checkRun);
    if (!v.ok) return validationError(requestId, v.fields);
    const outcome = await postCheckRun(env, { orgId, repoExternalId, checkRun: v.value }, deps);
    return successResponse(toResponse(outcome), requestId);
  }

  if (body.kind === "commit_status") {
    const v = validateCommitStatus(body.status);
    if (!v.ok) return validationError(requestId, v.fields);
    const outcome = await postCommitStatus(env, { orgId, repoExternalId, status: v.value }, deps);
    return successResponse(toResponse(outcome), requestId);
  }

  return validationError(requestId, { kind: ['Must be "check_run" or "commit_status"'] });
}
