// GET /v1/organizations/:orgId/integrations/registry
// (saas-integration-registry IR0, design §3).
//
// The bulk Integration Registry read: every provider's manifest projected per
// environment (connect-method liveness — the `getConfiguredProvider` gate,
// reported instead of hidden) and per org (entitlement, fail-soft). One
// response, one console cache entry; every surface derives from it — the hub,
// the integration spaces, Cmd-K, and the orun CLI's rendered verb trees.
//
// Static per deploy apart from the entitlement projection, so the response is
// ETag'd: If-None-Match → 304 keeps the hub's repeat paints free. Pure
// metadata — never a credential, never a value.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type {
  IntegrationDescriptor,
  IntegrationRegistryResponse,
} from "@saas/contracts/integrations";
import { INTEGRATION_POLICY_ACTIONS } from "@saas/contracts/integrations";
import { checkBillingEntitlement } from "../billing-client.js";
import { successResponse } from "../http.js";
import { orgPublicId } from "../ids.js";
import type { Uuid } from "@saas/db/ids";
import { INTEGRATION_MANIFEST_MODULES } from "../providers/manifests/index.js";
import { authorizeIntegration } from "./connections.js";

/** Entitlement projection, fail-soft: a billing service error omits the flag
 *  (surfaces then rely on the connect gate's own 412) — never a fabricated
 *  `true`/`false`, per the SP-A5 no-silent-fallback rule. Only live manifests
 *  are checked; dormant/roadmap providers have nothing to gate yet. */
async function projectEntitlements(
  env: Env,
  orgId: Uuid,
  requestId: string,
): Promise<ReadonlyMap<string, boolean>> {
  const entitled = new Map<string, boolean>();
  if (!env.BILLING_WORKER) return entitled;
  const live = INTEGRATION_MANIFEST_MODULES.filter((m) => m.manifest.status === "live");
  await Promise.all(
    live.map(async (m) => {
      try {
        const result = await checkBillingEntitlement(
          env.BILLING_WORKER!,
          orgPublicId(orgId),
          m.manifest.entitlement,
          requestId,
        );
        if (result.kind !== "service_error") {
          entitled.set(m.manifest.id, result.decision.allowed);
        }
      } catch {
        // fail-soft: omit
      }
    }),
  );
  return entitled;
}

/** Hex SHA-256 of the serialized registry — the ETag value. */
async function computeEtag(serialized: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleGetIntegrationRegistry(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
): Promise<Response> {
  const denied = await authorizeIntegration(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.READ,
    requestId,
  );
  if (denied) return denied;

  const entitled = await projectEntitlements(env, orgId, requestId);

  const registry: IntegrationDescriptor[] = INTEGRATION_MANIFEST_MODULES.map((module) => {
    const { manifest } = module;
    const flag = entitled.get(manifest.id);
    return {
      ...manifest,
      connect: module.resolveConnect(env),
      ...(flag === undefined ? {} : { entitled: flag }),
    };
  });

  const payload: IntegrationRegistryResponse = { registry };
  const etag = `"${await computeEtag(JSON.stringify(payload))}"`;

  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const response = successResponse(payload, requestId);
  response.headers.set("etag", etag);
  return response;
}
