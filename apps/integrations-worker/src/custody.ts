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

/** Providers whose mints derive from a parent credential in custody. */
export const PARENT_CREDENTIAL_KINDS: Record<string, ProviderCredentialKind> = {
  cloudflare: "cloudflare_parent_token",
  supabase: "supabase_refresh_token",
};

/** Decrypt the connection's parent credential for one broker call. Returns
 *  undefined when the provider needs none; null when it needs one and custody
 *  cannot supply it (missing row / unreadable envelope). */
export async function readParentCredential(
  env: Env,
  executor: SqlExecutor,
  connectionUuid: Uuid,
  providerId: string,
): Promise<ParentCredentialContext | null | undefined> {
  const kind = PARENT_CREDENTIAL_KINDS[providerId];
  if (!kind) return undefined;
  const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
  if (!encryption) return null;
  const hub = createIntegrationHubRepository(executor);
  const credential = await hub.getProviderCredential(connectionUuid, kind);
  if (!credential.ok) return null;
  try {
    return {
      credential: await encryption.decrypt(
        JSON.parse(credential.value.ciphertext) as CiphertextEnvelope,
      ),
      externalRef: credential.value.externalRef,
    };
  } catch {
    return null;
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
