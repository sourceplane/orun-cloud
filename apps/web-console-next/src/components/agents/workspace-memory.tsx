"use client";

// The workspace memory page (saas-agents-native AN6): no hidden memory — the
// console lists exactly what the Workspace Agent's briefs read, every entry
// with a working provenance link, editable and deletable in place.

import * as React from "react";
import Link from "next/link";
import type { AgentMemoryEntry } from "@saas/sdk";
import { Skeleton } from "@/components/ui/skeleton";
import { Breadcrumbs, Kicker, PageHeader, Screen, StatusText } from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";

/** provenanceHref maps a memory source ref to its console surface. */
export function provenanceHref(orgSlug: string, source: string): string | null {
  if (source.startsWith("chat:")) return `/orgs/${orgSlug}/agents/chat/${source.slice("chat:".length)}`;
  if (source.startsWith("session:")) return `/orgs/${orgSlug}/agents/${source.slice("session:".length)}`;
  return null;
}

function MemoryRow({
  entry,
  orgSlug,
  onEdit,
  onDelete,
  busy,
}: {
  entry: AgentMemoryEntry;
  orgSlug: string;
  onEdit: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  busy: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(entry.content);
  const href = provenanceHref(orgSlug, entry.source);

  return (
    <div className="border-t border-border/50 px-4 py-3 first:border-t-0">
      {editing ? (
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2 py-1 text-[13px] outline-none focus:border-primary"
          />
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() => {
              onEdit(entry.id, draft.trim());
              setEditing(false);
            }}
            className="rounded-lg bg-foreground px-2.5 py-1 text-[12px] font-medium text-background disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(entry.content);
              setEditing(false);
            }}
            className="rounded-lg border border-border px-2.5 py-1 text-[12px]"
          >
            Cancel
          </button>
        </div>
      ) : (
        <p className="text-[13.5px]">{entry.content}</p>
      )}
      <div className="mt-1.5 flex items-center gap-3 text-[11.5px] text-muted-foreground">
        <span>by {entry.author}</span>
        <span>{new Date(entry.createdAt).toLocaleDateString()}</span>
        {href ? (
          <Link href={href} className="text-primary hover:underline">
            provenance →
          </Link>
        ) : (
          <span className="font-mono">{entry.source}</span>
        )}
        <span className="ml-auto flex gap-2">
          <button type="button" onClick={() => setEditing(true)} disabled={busy} className="hover:text-foreground">
            Edit
          </button>
          <button type="button" onClick={() => onDelete(entry.id)} disabled={busy} className="text-destructive hover:underline">
            Forget
          </button>
        </span>
      </div>
    </div>
  );
}

export function WorkspaceMemoryPage({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const memory = useApiQuery(qk.orgAgentMemory(orgId), () => wrap(async () => client.agents.listMemory(orgId)));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const reload = memory.reload;

  const onEdit = React.useCallback(
    (id: string, content: string) => {
      setBusy(true);
      setError(null);
      client.agents
        .updateMemory(orgId, id, content)
        .then(() => reload())
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Edit failed"))
        .finally(() => setBusy(false));
    },
    [client, orgId, reload],
  );

  const onDelete = React.useCallback(
    (id: string) => {
      setBusy(true);
      setError(null);
      client.agents
        .deleteMemory(orgId, id)
        .then(() => reload())
        .catch((err: unknown) => setError(err instanceof Error ? err.message : "Delete failed"))
        .finally(() => setBusy(false));
    },
    [client, orgId, reload],
  );

  return (
    <Screen>
      <Breadcrumbs items={[{ label: "Agents", href: `/orgs/${orgSlug}/agents` }, { label: "Memory" }]} />
      <PageHeader
        title="Workspace memory"
        description="What the Workspace Agent remembers — every entry provenanced, nothing hidden. Deleting an entry removes it from all future briefs."
      />
      {error ? <StatusText tone="error">{error}</StatusText> : null}
      <Kicker className="mb-2.5">Entries</Kicker>
      {memory.loading && !memory.data ? (
        <Skeleton className="h-32 w-full rounded-xl" />
      ) : (memory.data?.length ?? 0) === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          Nothing remembered yet — ask the Workspace Agent to remember something in a chat thread.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/60">
          {(memory.data as AgentMemoryEntry[]).map((e) => (
            <MemoryRow key={e.id} entry={e} orgSlug={orgSlug} onEdit={onEdit} onDelete={onDelete} busy={busy} />
          ))}
        </div>
      )}
    </Screen>
  );
}
