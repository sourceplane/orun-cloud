"use client";

// The integration space's Activity tab (saas-integration-registry IR2): the
// provider's operational record, per connection — the mint ledger for
// credential-broker providers (template, purpose, actor/run attribution,
// expiry, revoke) and the inbound delivery log for inbound providers
// (verify → inbox → emit, with replay). Values never appear here — the
// ledger is metadata by construction.

import * as React from "react";
import type {
  PublicConnection,
  PublicInboundDelivery,
  PublicMintedCredential,
} from "@saas/contracts/integrations";
import { Button } from "@/components/ui/button";
import { Kicker, Pill, type Tone } from "@/components/ui/northwind";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { connectionDisplayName } from "./connections";

const MINT_STATUS_TONE: Record<string, Tone> = {
  pending: "success", // live (not yet expired/revoked)
  revoked: "neutral",
  expired: "neutral",
  orphaned: "warning",
};

const DELIVERY_STATUS_TONE: Record<string, Tone> = {
  received: "neutral",
  emitted: "success",
  failed: "error",
  skipped: "neutral",
};

export function SpaceActivity({
  orgId,
  connections,
  showMints,
  showDeliveries,
}: {
  orgId: string;
  connections: readonly PublicConnection[];
  showMints: boolean;
  showDeliveries: boolean;
}) {
  const active = connections.filter((c) => c.status === "active" || c.status === "suspended");
  const [connectionId, setConnectionId] = React.useState<string>(active[0]?.id ?? "");
  React.useEffect(() => {
    if (!connectionId && active[0]) setConnectionId(active[0].id);
  }, [active, connectionId]);

  if (active.length === 0) {
    return (
      <div className="mt-4 rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
        Activity appears once a connection exists.
      </div>
    );
  }

  return (
    <div className="mt-4">
      {active.length > 1 ? (
        <div className="mb-4 flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Connection</span>
          <select
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
            className="h-8 rounded-md border bg-card px-2"
            aria-label="Connection"
          >
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {connectionDisplayName(c)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {connectionId && showMints ? <MintLedger orgId={orgId} connectionId={connectionId} /> : null}
      {connectionId && showDeliveries ? (
        <DeliveryLog orgId={orgId} connectionId={connectionId} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mint ledger (credential-broker capability)
// ---------------------------------------------------------------------------

function mintState(m: PublicMintedCredential): { label: string; tone: Tone } {
  if (m.revokedAt) return { label: "revoked", tone: MINT_STATUS_TONE.revoked ?? "neutral" };
  if (new Date(m.expiresAt).getTime() < Date.now())
    return { label: "expired", tone: "neutral" };
  return { label: "live", tone: "success" };
}

function MintLedger({ orgId, connectionId }: { orgId: string; connectionId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const ledger = useApiQuery(qk.mintedCredentials(orgId, connectionId), () =>
    wrap(async () => (await client.integrations.listMintedCredentials(orgId, connectionId)).mints),
  );

  const revoke = async (mintId: string) => {
    const r = await wrap(() => client.integrations.revokeMintedCredential(orgId, connectionId, mintId));
    if (!r.ok) {
      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Credential revoked" });
    ledger.reload();
  };

  return (
    <>
      <Kicker className="mb-2.5">Minted credentials</Kicker>
      {ledger.loading ? (
        <p className="text-sm text-muted-foreground">Loading the mint ledger…</p>
      ) : ledger.error ? (
        <div className="rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
          Mint ledger unavailable — {ledger.error.message}
        </div>
      ) : (ledger.data ?? []).length === 0 ? (
        <div className="rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
          Nothing minted from this connection yet. Every credential a run or operator mints is
          recorded here — template, purpose, attribution, expiry — never the value.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">
                  <th className="px-4 py-2.5">Template</th>
                  <th className="px-4 py-2.5">Purpose</th>
                  <th className="px-4 py-2.5">Attribution</th>
                  <th className="px-4 py-2.5">Minted</th>
                  <th className="px-4 py-2.5">Expiry</th>
                  <th className="px-4 py-2.5">State</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {(ledger.data ?? []).map((m: PublicMintedCredential) => {
                  const state = mintState(m);
                  return (
                    <tr key={m.id} className="border-t border-border/50 first:border-t-0 align-top">
                      <td className="px-4 py-2.5">
                        <span className="block font-mono text-[12px]">{m.template}</span>
                        <span className="block font-mono text-[10.5px] text-muted-foreground">{m.id}</span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{m.purpose}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {m.runId ? (
                          <span className="font-mono text-[11px]">run {m.runId}</span>
                        ) : m.requestedBy ? (
                          <span className="font-mono text-[11px]">{m.requestedBy}</span>
                        ) : (
                          "platform"
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                        {new Date(m.mintedAt).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                        {new Date(m.expiresAt).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="px-4 py-2.5">
                        <Pill tone={state.tone}>{state.label}</Pill>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {state.label === "live" ? (
                          <Button size="sm" variant="outline" onClick={() => void revoke(m.id)}>
                            Revoke
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Inbound delivery log (inbound capability)
// ---------------------------------------------------------------------------

function DeliveryLog({ orgId, connectionId }: { orgId: string; connectionId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const deliveries = useApiQuery(qk.inboundDeliveries(orgId, connectionId), () =>
    wrap(async () => (await client.integrations.listDeliveries(orgId, connectionId)).deliveries),
  );

  const replay = async (deliveryId: string) => {
    const r = await wrap(() => client.integrations.replayDelivery(orgId, connectionId, deliveryId));
    if (!r.ok) {
      toast({ kind: "error", title: "Replay failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Delivery replayed" });
    deliveries.reload();
  };

  return (
    <>
      <Kicker className="mb-2.5 mt-6">Inbound deliveries</Kicker>
      {deliveries.loading ? (
        <p className="text-sm text-muted-foreground">Loading deliveries…</p>
      ) : deliveries.error ? (
        <div className="rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
          Delivery log unavailable — {deliveries.error.message}
        </div>
      ) : (deliveries.data ?? []).length === 0 ? (
        <div className="rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
          No provider deliveries yet. Verified events land here (inbox → normalized event), with
          replay for failures.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-left text-sm">
              <thead>
                <tr className="border-b text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">
                  <th className="px-4 py-2.5">Event</th>
                  <th className="px-4 py-2.5">Received</th>
                  <th className="px-4 py-2.5">Attempts</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {(deliveries.data ?? []).map((d: PublicInboundDelivery) => (
                  <tr key={d.id} className="border-t border-border/50 first:border-t-0 align-top">
                    <td className="px-4 py-2.5">
                      <span className="block font-mono text-[12px]">
                        {d.eventType}
                        {d.action ? `.${d.action}` : ""}
                      </span>
                      {d.failureReason ? (
                        <span className="block text-[11px] text-muted-foreground">{d.failureReason}</span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                      {new Date(d.receivedAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{d.attempts}</td>
                    <td className="px-4 py-2.5">
                      <Pill tone={DELIVERY_STATUS_TONE[d.status] ?? "neutral"}>{d.status}</Pill>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {d.status === "failed" ? (
                        <Button size="sm" variant="outline" onClick={() => void replay(d.id)}>
                          Replay
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
