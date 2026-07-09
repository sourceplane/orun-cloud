"use client";

// The spec document drawer (orun-work-v3 PM0): read/edit the cloud document
// as content-addressed revisions. The digest form equals a repo-imported
// doc_ref, so a spec always states its source honestly — "authored here"
// renders the body; "imported from repo @ digest" renders the pointer (the
// body lives in git; the cloud never pretends otherwise). Forks are surfaced
// with a banner, never silently merged (fork-visible LWW, design §1.4).

import * as React from "react";
import type { GetWorkDocResponse, WorkDocRevisionView } from "@saas/contracts/work";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { AttentionBanner, MonoRef, StatusText } from "@/components/ui/northwind";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { forkParents, shortDigest } from "@/lib/work/doc";

interface DocState {
  loading: boolean;
  doc: GetWorkDocResponse | null;
  history: WorkDocRevisionView[];
  /** The spec has a doc_ref but no cloud body — imported from the repo. */
  importedRef: string | null;
  error: string | null;
}

export function SpecDocSheet({
  orgId,
  specKey,
  docRef,
  open,
  onOpenChange,
  onMutated,
}: {
  orgId: string;
  specKey: string;
  docRef: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMutated: () => void;
}) {
  const { client } = useSession();
  const [state, setState] = React.useState<DocState>({
    loading: true,
    doc: null,
    history: [],
    importedRef: null,
    error: null,
  });
  const [body, setBody] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [verdict, setVerdict] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const history = await client.work.docHistory(orgId, specKey);
      let doc: GetWorkDocResponse | null = null;
      let importedRef: string | null = null;
      if (docRef) {
        try {
          doc = await client.work.getDoc(orgId, specKey);
        } catch {
          // doc_ref exists but no cloud revision → repo-imported body.
          importedRef = docRef;
        }
      }
      setState({ loading: false, doc, history: history.revisions, importedRef, error: null });
      setBody(doc?.body ?? "");
      setEditing(doc === null && importedRef === null);
    } catch (err) {
      const e = err as { message?: string };
      setState({ loading: false, doc: null, history: [], importedRef: null, error: e.message ?? "failed to load" });
    }
  }, [client, orgId, specKey, docRef]);

  React.useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const save = async () => {
    setBusy(true);
    setVerdict(null);
    try {
      const res = await client.work.putDoc(orgId, specKey, {
        body,
        parent: state.doc?.revision,
      });
      if (!res.created) {
        setVerdict("no changes — the body matches the current revision");
      } else {
        setEditing(false);
        onMutated();
        await load();
      }
    } catch (err) {
      const e = err as { message?: string };
      setVerdict(e.message ?? "rejected");
    } finally {
      setBusy(false);
    }
  };

  const forks = forkParents(state.history);
  const forked = state.doc?.parent !== undefined && forks.has(state.doc.parent);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[560px] max-w-[92vw] overflow-y-auto sm:w-[560px]">
        <SheetHeader>
          <SheetTitle className="font-mono text-[13px]">{specKey}</SheetTitle>
          <SheetDescription>
            {state.doc
              ? "Authored here — versioned, content-addressed."
              : state.importedRef
                ? "Imported from the repo — the body lives in git."
                : "No document yet. Write one; it seals content-addressed."}
          </SheetDescription>
        </SheetHeader>

        {state.loading ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : state.error ? (
          <StatusText tone="error" className="mt-4 block">
            {state.error}
          </StatusText>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            {forked ? (
              <AttentionBanner tone="warning">
                This document has forked — two revisions share parent{" "}
                <MonoRef>{shortDigest([...forks][0] ?? "")}</MonoRef>. Save a reconciled revision to
                converge; nothing is overwritten silently.
              </AttentionBanner>
            ) : null}

            {state.importedRef ? (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-[12.5px] text-muted-foreground">
                doc <MonoRef>{shortDigest(state.importedRef)}</MonoRef> — imported. Editing here
                starts a cloud chain; the import never overwrites it (it forks, with a banner).
              </div>
            ) : null}

            {editing || (!state.doc && !state.importedRef) ? (
              <>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={16}
                  className="font-mono text-[12.5px]"
                  placeholder={"# Title\n\nIntent, constraints, contracts…"}
                />
                <div className="flex items-center gap-2">
                  <Button size="sm" loading={busy} disabled={!body.trim()} onClick={() => void save()}>
                    Save revision
                  </Button>
                  {state.doc ? (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </>
            ) : state.doc ? (
              <>
                <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed">
                  {state.doc.body}
                </pre>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                  <span className="text-[11.5px] text-muted-foreground">
                    rev <MonoRef>{shortDigest(state.doc.revision)}</MonoRef>
                  </span>
                </div>
              </>
            ) : (
              <div className="flex">
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  Write the document
                </Button>
              </div>
            )}

            {verdict ? <p className="text-[12px] text-destructive">{verdict}</p> : null}

            {state.history.length > 0 ? (
              <div className="mt-2">
                <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  History
                </div>
                <ul className="flex flex-col gap-1">
                  {[...state.history].reverse().map((r) => (
                    <li key={r.revision} className="flex items-baseline gap-2 text-[12px]">
                      <MonoRef>{shortDigest(r.revision)}</MonoRef>
                      <span className="text-muted-foreground">
                        {r.parent ? `← ${shortDigest(r.parent)}` : "root"} · {r.createdBy.id}
                        {forks.has(r.parent ?? "") ? " · fork" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
