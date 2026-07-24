/**
 * Pure view-model for a connection's brokered/rotated secrets (saas-integrations-
 * console IX3). The infrastructure detail's Secrets tab lists the secrets a
 * connection produces — brokered (minted per resolve) and rotated (a stored
 * value whose next version the connection mints). Derived by filtering the org
 * secrets list on the binding/rotation connection id; dependency-free so it is
 * unit-testable.
 */

import type { PublicSecretMetadata } from "@saas/contracts/config";
import type { Tone } from "@/components/ui/northwind";

export type SecretProducerMode = "brokered" | "rotated";

/** A secret produced from a connection, with its normalized producer facts. */
export interface ConnectionSecret {
  secret: PublicSecretMetadata;
  mode: SecretProducerMode;
  provider: string;
  template: string;
}

/** The producer facts for a secret, or null when it is neither brokered nor rotated. */
export function secretProducer(
  secret: Pick<PublicSecretMetadata, "source" | "binding" | "rotation">,
): { mode: SecretProducerMode; provider: string; template: string } | null {
  if (secret.source === "brokered" && secret.binding) {
    return { mode: "brokered", provider: secret.binding.provider, template: secret.binding.template };
  }
  if (secret.rotation) {
    return { mode: "rotated", provider: secret.rotation.provider, template: secret.rotation.template };
  }
  return null;
}

/** The brokered + rotated secrets produced from a given connection id. */
export function connectionSecrets(
  secrets: readonly PublicSecretMetadata[] | null | undefined,
  connectionId: string,
): ConnectionSecret[] {
  const out: ConnectionSecret[] = [];
  for (const secret of secrets ?? []) {
    const producer = secretProducer(secret);
    if (!producer) continue;
    const boundTo = secret.binding?.connectionId ?? secret.rotation?.connectionId ?? null;
    if (boundTo !== connectionId) continue;
    out.push({ secret, ...producer });
  }
  return out;
}

/** "brokered · supabase · db-ro" — the producer meta line. */
export function secretMetaLine(item: ConnectionSecret): string {
  return `${item.mode} · ${item.provider} · ${item.template}`;
}

/** Whole-days cadence parsed from a rotation policy ("P90D", "90d", "90"); null if none. */
export function rotationDays(rotationPolicy: string | null | undefined): number | null {
  if (!rotationPolicy) return null;
  const m = /(\d+)\s*d/i.exec(rotationPolicy) ?? /^P?(\d+)D$/i.exec(rotationPolicy) ?? /^(\d+)$/.exec(rotationPolicy);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** The status badge for a secret row: orphaned → error; brokered → Fresh per run; rotated → cadence. */
export function secretBadge(item: ConnectionSecret): { label: string; tone: Tone } {
  if (item.secret.orphaned) return { label: "Orphaned", tone: "error" };
  if (item.mode === "brokered") return { label: "Fresh per run", tone: "success" };
  const days = rotationDays(item.secret.rotationPolicy);
  return { label: days != null ? `Rotated · ${days}d` : "Rotated", tone: "info" };
}

/** Count of brokered vs rotated for the overview "managed secrets" stat. */
export function producerCounts(items: readonly ConnectionSecret[]): {
  total: number;
  brokered: number;
  rotated: number;
} {
  let brokered = 0;
  let rotated = 0;
  for (const i of items) i.mode === "brokered" ? brokered++ : rotated++;
  return { total: items.length, brokered, rotated };
}
