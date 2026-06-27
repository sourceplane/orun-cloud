"use client";

// A searchable picker over a GitHub connection's available repositories. Shared
// by the per-repo Git tab (which links a repo to GitHub-App events) and the
// "Git Repos → Add repo" flow (which onboards a repo: project placeholder +
// allow-list entry). The caller owns what "picking" means via `onPick`.

import * as React from "react";
import { Search } from "lucide-react";
import type { PublicConnection, PublicRepository } from "@saas/contracts/integrations";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { wrap, type ApiErrorBody } from "@/lib/api";
import { useSession } from "@/lib/session";

export function RepoPickerDialog({
  open,
  onOpenChange,
  orgId,
  connection,
  linkedExternalIds,
  onPick,
  title = "Link a repository",
  pickLabel = "Link",
  pickingLabel = "Linking…",
  pickedLabel = "Linked",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  connection: PublicConnection;
  /** Repos already onboarded/linked — shown disabled. */
  linkedExternalIds: Set<string>;
  onPick: (repo: PublicRepository) => Promise<void>;
  title?: string;
  pickLabel?: string;
  pickingLabel?: string;
  pickedLabel?: string;
}) {
  const { client } = useSession();
  const [query, setQuery] = React.useState("");
  const [repos, setRepos] = React.useState<PublicRepository[] | null>(null);
  const [error, setError] = React.useState<ApiErrorBody | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        const r = await wrap(() =>
          client.integrations.listRepositories(orgId, connection.id, query || undefined),
        );
        if (cancelled) return;
        if (!r.ok) {
          setError(r.error);
          setRepos([]);
          return;
        }
        setError(null);
        setRepos(r.data.repositories);
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, query, orgId, connection.id, client]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Repositories visible to the {connection.externalAccountLogin ?? "GitHub"} installation.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search repositories…"
            className="pl-8"
            autoFocus
          />
        </div>
        {error ? (
          <div className="py-3 text-sm text-destructive">{error.message}</div>
        ) : repos === null ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : repos.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">No repositories match.</div>
        ) : (
          <ul className="max-h-72 divide-y divide-border overflow-y-auto">
            {repos.map((repo) => {
              const linked = linkedExternalIds.has(repo.externalId);
              return (
                <li key={repo.externalId} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm">{repo.fullName}</div>
                    <div className="text-xs text-muted-foreground">
                      {repo.private ? "Private" : "Public"}
                      {repo.defaultBranch ? ` · default ${repo.defaultBranch}` : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={linked ? "outline" : "default"}
                    disabled={linked || busy === repo.externalId}
                    onClick={() => {
                      setBusy(repo.externalId);
                      void onPick(repo).finally(() => setBusy(null));
                    }}
                  >
                    {linked ? pickedLabel : busy === repo.externalId ? pickingLabel : pickLabel}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Don&apos;t see a repository? Adjust the installation&apos;s repository access on GitHub.
        </p>
      </DialogContent>
    </Dialog>
  );
}
