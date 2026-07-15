/**
 * Internal, lease-verified secret resolve (saas-secret-manager SM3).
 *
 * POST /v1/internal/config/secrets/resolve — reachable ONLY over the
 * state-worker → config-worker service binding. There is NO api-edge path to
 * it; api-edge never forwards /v1/internal/*. It trusts the calling worker (the
 * pattern of every internal endpoint): state-worker has already performed the
 * two independent checks — bearer authz (Layer-1 `secret.value.use` via
 * authorizeRun, which correctly handles user / workflow-bound-scope /
 * service_principal) AND a live job lease — and forwards the verified actor
 * (x-actor-* headers) + server-derived run facts. This handler is therefore the
 * Layer-2 (SecretPolicy) + chain-walk + decrypt half.
 *
 * This is the FIRST and ONLY place a secret VALUE is decrypted. The plaintext
 * touches memory only here; it is NEVER logged, NEVER placed in an event or
 * audit payload, and NEVER returned except inside the `secrets` map.
 */

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ConfigRepository, SecretMetadata } from "@saas/db/config";
import type { EventsRepository } from "@saas/db/events";
import type { MembershipRepository } from "@saas/db/membership";
import { createConfigRepository, createSecretDekRepository } from "@saas/db/config";
import { createMembershipRepository } from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { uuidFromPublicId } from "@saas/db";
import { errorResponse, successResponse } from "../http.js";
import { resolveEffectiveSecret, type SecretServesFrom } from "../config-resolver.js";
import { decryptEnvelope } from "../decryption.js";
import {
  evaluateSecretPolicy,
  parseSecretPolicyDocument,
  type Platform,
  type SecretPolicyDocument,
  type SecretPolicyFacts,
  type ServesFrom,
} from "../secret-policy.js";
import { SECRET_EVENT_TYPES } from "../secret-events.js";
import type { InternalMintCredentialRequest } from "@saas/contracts/integrations";
import { mintBrokeredCredential, type BrokeredMintOutcome } from "../integrations-client.js";

const TTL_SECONDS = 300;
const PLATFORMS: Platform[] = ["local-cli", "ci-oidc", "service"];

/** One requested key, optionally version-pinned. */
interface ResolveKey {
  key: string;
  version?: number;
}

/**
 * The internal resolve body state-worker forwards (config-client.ts). Raw
 * UUIDs; the verified actor rides x-actor-* headers, the platform + trigger are
 * server-derived from the run, and every key shares one environment.
 */
interface ResolveBody {
  orgId: string;
  projectId: string;
  environmentId: string;
  /** Environment slug — the Layer-2 `env` fact. */
  environment: string;
  keys: ResolveKey[];
  platform: Platform;
  trigger: { branch: string | null; declared: boolean };
  runId: string;
  jobId: string;
}

export interface InternalResolveDeps {
  repo: Pick<ConfigRepository, "getSecretMetadataByScopeKey" | "getSecretCiphertext" | "touchSecretLastUsed" | "listSecretPolicies">;
  membershipRepo: Pick<MembershipRepository, "getOrganizationById">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  /** Subject team slugs for Layer-2 `team:` matching (tests / future plumbing). */
  subjectTeams?: string[];
  /** Decrypt injector for tests; production wires decryptEnvelope over the DEK repo. */
  decrypt?: (envelope: string, orgId: string) => Promise<string>;
  /** Brokered mint injector (IH7, tests); production wires mintBrokeredCredential
   * over the INTEGRATIONS_WORKER service binding. A brokered head with no mint
   * seam available fails closed (`binding_unavailable`). */
  mintBrokered?: (req: InternalMintCredentialRequest) => Promise<BrokeredMintOutcome>;
  generateId?: () => string;
  now?: () => Date;
}

/**
 * The brokered envelope pointer (IH7): stored in the version row IN PLACE of a
 * ciphertext envelope. Detected (and short-circuited past decrypt) by
 * `v === "brokered"`. `params` present only when non-empty.
 */
interface BrokeredPointer {
  v: "brokered";
  provider: { connectionId: string; template: string; params?: Record<string, unknown> };
}

function parseBrokeredPointer(envelope: string): BrokeredPointer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== "brokered") return null;
  const provider = obj.provider as Record<string, unknown> | undefined;
  if (!provider || typeof provider !== "object") return null;
  if (typeof provider.connectionId !== "string" || typeof provider.template !== "string") return null;
  return parsed as BrokeredPointer;
}

/** One `resolved[]` provenance entry. Broker fields are ADDITIVE (IH7):
 *  static entries carry exactly the pre-IH7 shape. */
interface ResolvedEntry {
  key: string;
  version: number;
  scope: string;
  personal: boolean;
  decisionId: string;
  source?: "broker";
  mintId?: string;
  provider?: string;
  template?: string;
}

export async function handleInternalResolveSecrets(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  deps?: InternalResolveDeps,
): Promise<Response> {
  let body: ResolveBody;
  try {
    body = (await request.json()) as ResolveBody;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  const validationErr = validate(body);
  if (validationErr) return errorResponse("bad_request", validationErr, 400, requestId);

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const genId = deps?.generateId ?? (() => crypto.randomUUID());
  const now = deps?.now ? deps.now() : new Date();

  // Subject facts from the VERIFIED actor headers. Teams: the evaluator fully
  // supports `team:<slug>` matching; the integration path forwards no team
  // slugs yet (MembershipFact carries team ids, not slugs), so team-scoped
  // Layer-2 rules are evaluated with an empty team set here — a documented
  // limitation, not a leak (deny-by-default still holds). Tests inject teams.
  const subject: SecretPolicyFacts["subject"] = {
    id: actor.subjectId,
    kind: normalizeKind(actor.subjectType),
    teams: deps?.subjectTeams ?? [],
  };

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createConfigRepository(executor!);
    const membershipRepo = deps?.membershipRepo ?? createMembershipRepository(executor!);
    const eventsRepo = deps?.eventsRepo ?? (executor ? createEventsRepository(executor) : null);

    // Decrypt dependency: the ONLY decrypt path in the codebase. In production it
    // reads the wrapped DEK a v:2 keyId names; v:1 uses the static key.
    const dekRepo = executor ? createSecretDekRepository(executor) : null;
    const decrypt = deps?.decrypt
      ? deps.decrypt
      : async (envelope: string): Promise<string> =>
          decryptEnvelope(envelope, {
            ...(env.SECRET_ENCRYPTION_KEY ? { staticKeyHex: env.SECRET_ENCRYPTION_KEY } : {}),
            ...(env.SECRET_KEK ? { kekHex: env.SECRET_KEK } : {}),
            getWrappedDek: async (o: string, gen: number) => {
              const r = await dekRepo!.getWrappedDek(o, gen);
              return r.ok ? r.value : null;
            },
          });

    // Layer-2 documents for the run's scope, tier-ordered by the repository.
    const policiesResult = await repo.listSecretPolicies({ orgId: body.orgId, projectId: body.projectId });
    if (!policiesResult.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const documents: SecretPolicyDocument[] = policiesResult.value.map((r) =>
      parseSecretPolicyDocument(r.tier, r.document),
    );

    // Personal rung is gated by the SERVER-DERIVED platform fact: only a
    // local-cli user may be served their own overlay (Invariant 9). The viewer
    // uuid enables the personal rung in the chain walk; withheld otherwise so a
    // CI/service resolve can never touch a personal row.
    const viewerSubjectId =
      body.platform === "local-cli" && subject.kind === "user"
        ? uuidFromPublicId(actor.subjectId) ?? undefined
        : undefined;

    // Brokered mint seam (IH7): deps injector in tests; the service binding in
    // production. A missing binding is a mint failure (fail closed), not a 500.
    const mintBrokered: (req: InternalMintCredentialRequest) => Promise<BrokeredMintOutcome> =
      deps?.mintBrokered ??
      (env.INTEGRATIONS_WORKER
        ? (req) => mintBrokeredCredential(env.INTEGRATIONS_WORKER!, req, requestId)
        : async () => ({ ok: false, status: 503, reason: "unavailable" }));

    const secrets: Record<string, string> = {};
    const resolved: ResolvedEntry[] = [];

    for (const ref of body.keys) {
      const decisionId = `dec_${genId().replace(/-/g, "")}`;

      // ── Chain walk (metadata only — no value touched yet). ──
      const walk = await resolveEffectiveSecret(
        { repo, membershipRepo },
        {
          orgId: body.orgId,
          projectId: body.projectId,
          environmentId: body.environmentId,
          key: ref.key,
          ...(viewerSubjectId ? { viewerSubjectId } : {}),
        },
      );
      if (!walk.secret || !walk.servesFrom) {
        // Unknown reference — resource-hiding (never reveal beyond the code).
        await auditDenied(eventsRepo, genId, now, body, subject, ref.key, "unknown-reference", decisionId, null, requestId);
        return errorResponse("not_found", "Secret not found", 404, requestId, { key: ref.key, reason: "unknown-reference", decisionId });
      }
      const head = walk.secret;
      const personal = walk.servesFrom === "personal";

      // ── Layer 2 (SecretPolicy conditions) — BEFORE any decrypt. ──
      const facts: SecretPolicyFacts = {
        subject,
        env: body.environment,
        servesFrom: toServesFrom(walk.servesFrom),
        platform: body.platform,
        trigger: { ...(body.trigger.branch !== null ? { branch: body.trigger.branch } : {}), declared: body.trigger.declared },
      };
      const decision = evaluateSecretPolicy(documents, ref.key, facts);
      if (!decision.allow) {
        // A protected-env / policy deny returns BEFORE any decrypt attempt. The
        // runner is fail-closed, so a single denial fails the whole resolve
        // (partial success would be worse). Never reveal beyond the reason code.
        await auditDenied(eventsRepo, genId, now, body, subject, ref.key, decision.reason, decisionId, head, requestId, decision.ruleId);
        return errorResponse("forbidden", "Policy denied", 403, requestId, {
          key: ref.key,
          reason: decision.reason,
          ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
          decisionId,
        });
      }

      // ── Decrypt (the ONLY place a value materializes). ──
      const version = ref.version ?? head.version;
      const cipherResult = await repo.getSecretCiphertext(head.id, version);
      if (!cipherResult.ok) {
        await auditDenied(eventsRepo, genId, now, body, subject, ref.key, "version-unavailable", decisionId, head, requestId);
        return errorResponse("not_found", "Secret version not found", 404, requestId, { key: ref.key, reason: "version-unavailable", decisionId });
      }
      // ── Brokered head (IH7): the stored envelope is a POINTER, not
      //    ciphertext — short-circuit decrypt and mint just-in-time. ──
      const pointer = parseBrokeredPointer(cipherResult.value);
      if (pointer) {
        const mintReq: InternalMintCredentialRequest = {
          orgId: body.orgId,
          connectionId: pointer.provider.connectionId,
          template: pointer.provider.template,
          ...(pointer.provider.params ? { params: pointer.provider.params } : {}),
          // No ttlSeconds: the broker's own default + clamp governs — the 300s
          // resolve TTL re-resolves well inside the default mint lifetime.
          purpose: "secret_resolve",
          requestedBy: actor.subjectId,
          runId: body.runId,
          jobId: body.jobId,
        };
        const outcome = await mintBrokered(mintReq);
        if (!outcome.ok) {
          // Fail the WHOLE resolve fail-closed — the same posture as a policy
          // deny. The typed error names the connection, never a value.
          //
          // brokered-orphan-safety (Feature 1, run-time surface): when the mint
          // failed because the connection is no longer active (revoked /
          // suspended / gone), the head is ORPHANED — its binding points at a
          // connection that can no longer mint. Surface that precisely as
          // `binding_orphaned` (the broker's `connection_inactive` /
          // `connection_not_found`) so the run log and plan say *why* the key
          // could not resolve, rather than a generic "unavailable". Every other
          // mint failure keeps the generic `binding_unavailable`.
          const orphaned =
            outcome.reason === "connection_inactive" || outcome.reason === "connection_not_found";
          const reason = orphaned ? "binding_orphaned" : "binding_unavailable";
          const message = orphaned
            ? "Brokered secret is orphaned — its integration connection is no longer active"
            : "Brokered secret binding unavailable";
          await auditDenied(eventsRepo, genId, now, body, subject, ref.key, reason, decisionId, head, requestId);
          return errorResponse("precondition_failed", message, 412, requestId, {
            key: ref.key,
            reason,
            connectionId: pointer.provider.connectionId,
            decisionId,
          });
        }

        // The minted value exists ONLY in the secrets map — never in an
        // event, audit payload, provenance entry, or error.
        secrets[ref.key] = outcome.value;
        resolved.push({
          key: ref.key,
          version,
          scope: walk.servesFrom,
          personal,
          decisionId,
          source: "broker",
          mintId: outcome.mintId,
          provider: outcome.provider,
          template: outcome.template,
        });

        // Stamp last_used_at on the served head (best-effort — never fails the resolve).
        await repo.touchSecretLastUsed(head.orgId, head.id, now);

        // Doubly visible (design §5.4): secret.accessed carries the mintId
        // join key onto the broker's ledger entry. NEVER the value.
        await auditAccessed(eventsRepo, genId, now, body, subject, ref.key, version, walk.servesFrom, personal, decisionId, head, requestId, decision.ruleId, {
          mintId: outcome.mintId,
          provider: outcome.provider,
          template: outcome.template,
        });
        continue;
      }

      let plaintext: string;
      try {
        plaintext = await decrypt(cipherResult.value, head.orgId);
      } catch {
        // Never surface key material or ciphertext in the error.
        return errorResponse("internal_error", "Decryption failed", 503, requestId, { key: ref.key, decisionId });
      }

      secrets[ref.key] = plaintext;
      resolved.push({ key: ref.key, version, scope: walk.servesFrom, personal, decisionId });

      // Stamp last_used_at on the served head (best-effort — never fails the resolve).
      await repo.touchSecretLastUsed(head.orgId, head.id, now);

      // Audit the access — key-name + version + scope + decisionId, NEVER the value.
      await auditAccessed(eventsRepo, genId, now, body, subject, ref.key, version, walk.servesFrom, personal, decisionId, head, requestId, decision.ruleId);
    }

    return successResponse({ secrets, resolved, ttlSeconds: TTL_SECONDS }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

// ── Audit (key-name-only; never the value) ───────────────────

async function auditAccessed(
  eventsRepo: Pick<EventsRepository, "appendEventWithAudit"> | null,
  genId: () => string,
  now: Date,
  body: ResolveBody,
  subject: SecretPolicyFacts["subject"],
  key: string,
  version: number,
  scope: string,
  personal: boolean,
  decisionId: string,
  head: SecretMetadata,
  requestId: string,
  ruleId?: string,
  broker?: { mintId: string; provider: string; template: string },
): Promise<void> {
  if (!eventsRepo) return;
  await eventsRepo.appendEventWithAudit({
    event: {
      id: genId(),
      type: SECRET_EVENT_TYPES.ACCESSED,
      version: 1,
      source: "config-worker",
      occurredAt: now,
      actorType: subject.kind,
      actorId: subject.id,
      orgId: body.orgId,
      projectId: body.projectId,
      environmentId: body.environmentId,
      subjectKind: "secret",
      subjectId: head.id,
      subjectName: key,
      requestId,
      // Key-name + version + scope + decisionId (+ broker mint join key for a
      // brokered head, IH7) only. NEVER the value.
      payload: {
        key,
        version,
        scope,
        personal,
        decisionId,
        runId: body.runId,
        jobId: body.jobId,
        ...(ruleId ? { ruleId } : {}),
        ...(broker ? { source: "broker", mintId: broker.mintId, provider: broker.provider, template: broker.template } : {}),
      },
    },
    audit: {
      id: genId(),
      category: "config",
      description: `Secret accessed: ${key} (v${version}, ${scope})`,
      projectId: body.projectId,
      environmentId: body.environmentId,
    },
  });
}

async function auditDenied(
  eventsRepo: Pick<EventsRepository, "appendEventWithAudit"> | null,
  genId: () => string,
  now: Date,
  body: ResolveBody,
  subject: SecretPolicyFacts["subject"],
  key: string,
  reason: string,
  decisionId: string,
  head: SecretMetadata | null,
  requestId: string,
  ruleId?: string,
): Promise<void> {
  if (!eventsRepo) return;
  await eventsRepo.appendEventWithAudit({
    event: {
      id: genId(),
      type: SECRET_EVENT_TYPES.DENIED,
      version: 1,
      source: "config-worker",
      occurredAt: now,
      actorType: subject.kind,
      actorId: subject.id,
      orgId: body.orgId,
      projectId: body.projectId,
      environmentId: body.environmentId,
      subjectKind: "secret",
      subjectId: head?.id ?? key,
      subjectName: key,
      requestId,
      // Stable reason code only — never reveal existence beyond it, never a value.
      payload: { key, reason, decisionId, runId: body.runId, jobId: body.jobId, ...(ruleId ? { ruleId } : {}) },
    },
    audit: {
      id: genId(),
      category: "config",
      description: `Secret denied: ${key} (${reason})`,
      projectId: body.projectId,
      environmentId: body.environmentId,
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────

function validate(body: ResolveBody): string | null {
  if (!body || typeof body !== "object") return "Request body must be a JSON object";
  if (typeof body.orgId !== "string" || typeof body.projectId !== "string" || typeof body.environmentId !== "string") {
    return "orgId, projectId, environmentId are required";
  }
  if (typeof body.environment !== "string" || body.environment.length === 0) return "environment (slug) is required";
  if (!PLATFORMS.includes(body.platform)) return "platform must be one of: local-cli, ci-oidc, service";
  if (!body.trigger || typeof body.trigger !== "object") return "trigger is required";
  if (!Array.isArray(body.keys) || body.keys.length === 0) return "keys must be a non-empty array";
  for (const ref of body.keys) {
    if (!ref || typeof ref.key !== "string") return "each key requires a key name";
  }
  return null;
}

function normalizeKind(kind: string): SecretPolicyFacts["subject"]["kind"] {
  if (kind === "workflow" || kind === "service_principal") return kind;
  return "user";
}

/** Chain-walk servesFrom → the Layer-2 where-axis fact (personal lives at env). */
function toServesFrom(s: SecretServesFrom): ServesFrom {
  return s === "personal" ? "environment" : s;
}
