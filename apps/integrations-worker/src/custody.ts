// Parent-credential custody helpers (saas-integration-hub IH9), lifted out of
// the credential-broker handler so the lifecycle sweeps (expiry, orphan
// reconcile, connection health) share the exact decrypt/re-envelope discipline
// with the mint path. Custody rules unchanged (design §3): decrypted material
// lives only for the one call, is never logged, and never crosses a public
// surface.

import type { Env } from "./env.js";
import {
  createIntegrationHubRepository,
  type ProviderCredentialKind,
} from "@saas/db/integrations";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import type { ParentCredentialContext } from "./providers/types.js";
import { createEncryptionAdapter, type CiphertextEnvelope } from "./encryption.js";
import { generateUuid } from "./ids.js";

/**
 * Providers whose mints derive from a parent credential in custody, and the
 * candidate custody kinds to try IN ORDER. Service identities first (SI1,
 * sub-epics/service-identity-bootstrap): the provisioned account-owned
 * service token, then the pasted parent token.
 *
 * SI5: `cloudflare_refresh_token` is DELIBERATELY absent — a user-derived
 * parent can no longer authorize a Cloudflare mint, structurally. A
 * connection still on refresh custody mints nothing (typed
 * `parent_credential_missing`) until the SI3 backfill upgrades it or the
 * admin re-connects; the health cron and the backfill read that custody
 * explicitly via `readParentCredentialOfKind`, never through this list.
 */
export const PARENT_CREDENTIAL_KIND_CANDIDATES: Record<string, readonly ProviderCredentialKind[]> = {
  cloudflare: ["cloudflare_service_token", "cloudflare_parent_token"],
  supabase: ["supabase_refresh_token"],
};

/** A decrypted parent credential plus the custody kind it was read from (so
 *  the caller re-envelopes a rotation into the SAME kind). Structurally a
 *  ParentCredentialContext, so it passes straight to broker calls. */
export interface ResolvedParentCredential extends ParentCredentialContext {
  kind: ProviderCredentialKind;
}

/** Decrypt the connection's parent credential for one broker call. Returns
 *  undefined when the provider needs none; null when it needs one and custody
 *  cannot supply it (no candidate row / unreadable envelope). */
export async function readParentCredential(
  env: Env,
  executor: SqlExecutor,
  connectionUuid: Uuid,
  providerId: string,
): Promise<ResolvedParentCredential | null | undefined> {
  const candidates = PARENT_CREDENTIAL_KIND_CANDIDATES[providerId];
  if (!candidates) return undefined;
  const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
  if (!encryption) return null;
  const hub = createIntegrationHubRepository(executor);
  for (const kind of candidates) {
    const credential = await hub.getProviderCredential(connectionUuid, kind);
    if (!credential.ok) continue;
    try {
      return {
        credential: await encryption.decrypt(
          JSON.parse(credential.value.ciphertext) as CiphertextEnvelope,
        ),
        externalRef: credential.value.externalRef,
        // The custody ROW is authoritative for the kind (it equals the probed
        // candidate in production; being explicit keeps rotation re-envelope
        // and the SI1 ledger parent_kind honest).
        kind: credential.value.kind,
      };
    } catch {
      // Unreadable envelope for a present row — fail closed rather than fall
      // through to a different posture's stale row.
      return null;
    }
  }
  return null;
}

/**
 * Explicit single-kind custody read (SI5): for lifecycle surfaces (health
 * liveness, the SI3 backfill) that must still SEE deprecated custody kinds
 * the mint candidate list no longer exposes. Same decrypt discipline as
 * `readParentCredential`; null = no readable row of that kind.
 */
export async function readParentCredentialOfKind(
  env: Env,
  executor: SqlExecutor,
  connectionUuid: Uuid,
  kind: ProviderCredentialKind,
): Promise<ResolvedParentCredential | null> {
  const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
  if (!encryption) return null;
  const credential = await createIntegrationHubRepository(executor).getProviderCredential(
    connectionUuid,
    kind,
  );
  if (!credential.ok) return null;
  try {
    return {
      credential: await encryption.decrypt(
        JSON.parse(credential.value.ciphertext) as CiphertextEnvelope,
      ),
      externalRef: credential.value.externalRef,
      kind: credential.value.kind,
    };
  } catch {
    return null;
  }
}

export type CustodyServedRead =
  | { ok: true; value: string }
  | { ok: false; reason: "custody_missing" | "entry_missing" };

/**
 * Custody-served credential read (SI4): decrypt an infrastructure-class
 * custody row and return the value a custody-served template mints. When
 * `selector` is present the ciphertext is an encrypted JSON map (e.g.
 * {projectRef: serviceKey}) and the selector picks the entry; without one
 * the decrypted string IS the value. Read-only — no lock, no rotation.
 */
export async function readCustodyServedCredential(
  env: Env,
  executor: SqlExecutor,
  connectionUuid: Uuid,
  kind: ProviderCredentialKind,
  selector?: string,
): Promise<CustodyServedRead> {
  const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
  if (!encryption) return { ok: false, reason: "custody_missing" };
  const hub = createIntegrationHubRepository(executor);
  const credential = await hub.getProviderCredential(connectionUuid, kind);
  if (!credential.ok) return { ok: false, reason: "custody_missing" };
  let plaintext: string;
  try {
    plaintext = await encryption.decrypt(
      JSON.parse(credential.value.ciphertext) as CiphertextEnvelope,
    );
  } catch {
    return { ok: false, reason: "custody_missing" };
  }
  if (selector === undefined) return { ok: true, value: plaintext };
  try {
    const map = JSON.parse(plaintext) as Record<string, unknown>;
    const entry = map?.[selector];
    return typeof entry === "string" && entry
      ? { ok: true, value: entry }
      : { ok: false, reason: "entry_missing" };
  } catch {
    return { ok: false, reason: "entry_missing" };
  }
}

/** Rotation re-envelope (IH6/IH9): encrypt + upsert a rotated/refreshed
 *  parent. Best-effort; returns false on any failure, never throws. */
export async function reEnvelopeParentCredential(
  env: Env,
  executor: SqlExecutor,
  connectionId: Uuid,
  kind: ProviderCredentialKind,
  credential: string,
  externalRef: string | null,
): Promise<boolean> {
  try {
    const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
    if (!encryption) return false;
    const envelope = await encryption.encrypt(credential);
    const upserted = await createIntegrationHubRepository(executor).upsertProviderCredential({
      id: generateUuid(),
      connectionId,
      kind,
      ciphertext: JSON.stringify(envelope),
      // Keep the custody row anchored to the same provider-side ref.
      externalRef,
    });
    return upserted.ok;
  } catch {
    return false;
  }
}
