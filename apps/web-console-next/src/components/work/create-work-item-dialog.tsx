"use client";

// Create forms for the three item kinds (orun-work-v3 PM0). Every create is
// pure INTENT: a new item lands in Draft/Ready by derivation, never by
// choice — there is no status field on any of these forms, by construction.
// Rejected writes render the mutator's structured verdict inline (the same
// idiom as task-actions.tsx).

import * as React from "react";
import type { WorkSpecView } from "@saas/contracts/work";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/lib/session";
import { isValidPrefix, isValidSlug, slugify, suggestPrefix } from "@/lib/work/doc";

export type WorkItemKind = "spec" | "task" | "initiative";

export function WorkCreateMenu({
  orgId,
  specs,
  onCreated,
  requestedKind = null,
  onRequestConsumed,
}: {
  orgId: string;
  specs: WorkSpecView[];
  onCreated: () => void;
  /** PM4: a Cmd-K verb (?new=…) asks for a dialog by kind. */
  requestedKind?: WorkItemKind | null;
  onRequestConsumed?: (() => void) | undefined;
}) {
  const [open, setOpen] = React.useState<WorkItemKind | null>(null);
  React.useEffect(() => {
    if (requestedKind) {
      setOpen(requestedKind);
      onRequestConsumed?.();
    }
  }, [requestedKind, onRequestConsumed]);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">New</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setOpen("task")}>Task</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen("spec")}>Spec</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOpen("initiative")}>Initiative</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkItemDialog
        orgId={orgId}
        kind={open}
        specs={specs}
        onOpenChange={(o) => {
          if (!o) setOpen(null);
        }}
        onCreated={onCreated}
      />
    </>
  );
}

const KIND_COPY: Record<WorkItemKind, { title: string; description: string }> = {
  task: {
    title: "New task",
    description:
      "A unit of work with a contract. It starts wherever the logs say it is — usually Draft until the contract is complete.",
  },
  spec: {
    title: "New spec",
    description:
      "An epic with a document. Write the doc here (versioned, content-addressed) or import it from the repo — both stay first-class.",
  },
  initiative: {
    title: "New initiative",
    description: "A strategic grouping of specs. No contract, no rung — its progress is a rollup.",
  },
};

export function CreateWorkItemDialog({
  orgId,
  kind,
  specs,
  onOpenChange,
  onCreated,
}: {
  orgId: string;
  kind: WorkItemKind | null;
  specs: WorkSpecView[];
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { client } = useSession();
  const [title, setTitle] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [slugTouched, setSlugTouched] = React.useState(false);
  const [prefix, setPrefix] = React.useState("");
  const [prefixTouched, setPrefixTouched] = React.useState(false);
  const [specKey, setSpecKey] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [verdict, setVerdict] = React.useState<string | null>(null);

  const reset = React.useCallback(() => {
    setTitle("");
    setSlug("");
    setSlugTouched(false);
    setPrefix("");
    setPrefixTouched(false);
    setSpecKey("");
    setDescription("");
    setVerdict(null);
  }, []);

  const derivedSlug = slugTouched ? slug : slugify(title);
  const derivedPrefix = prefixTouched ? prefix : suggestPrefix(title);
  const slugOk = derivedSlug.length > 0 && isValidSlug(derivedSlug);
  const prefixOk = isValidPrefix(derivedPrefix);
  const canSubmit =
    title.trim().length > 0 && (kind === "task" ? prefixOk : slugOk) && !busy;

  const submit = async () => {
    if (!kind) return;
    setBusy(true);
    setVerdict(null);
    try {
      if (kind === "task") {
        await client.work.createTask(orgId, {
          prefix: derivedPrefix,
          title: title.trim(),
          specKey: specKey || undefined,
        });
      } else if (kind === "spec") {
        await client.work.createSpec(orgId, { slug: derivedSlug, title: title.trim() });
      } else {
        await client.work.createInitiative(orgId, {
          slug: derivedSlug,
          title: title.trim(),
          description: description.trim() || undefined,
        });
      }
      reset();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      const e = err as { message?: string };
      setVerdict(e.message ?? "rejected");
    } finally {
      setBusy(false);
    }
  };

  const copy = kind ? KIND_COPY[kind] : null;
  return (
    <Dialog
      open={kind !== null}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        {copy ? (
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
        ) : null}
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="work-new-title">Title</Label>
            <Input
              id="work-new-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={kind === "task" ? "Route reads through the cache" : "Checkout flow"}
              autoFocus
            />
          </div>
          {kind === "task" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="work-new-prefix">Key prefix</Label>
                <Input
                  id="work-new-prefix"
                  value={derivedPrefix}
                  onChange={(e) => {
                    setPrefixTouched(true);
                    setPrefix(e.target.value.toUpperCase());
                  }}
                  placeholder="OGP"
                  className="max-w-[10rem] font-mono uppercase"
                />
                <p className="text-[11.5px] text-muted-foreground">
                  2–5 uppercase letters; the key allocates {derivedPrefix || "PREFIX"}-n.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="work-new-spec">Spec</Label>
                <select
                  id="work-new-spec"
                  value={specKey}
                  onChange={(e) => setSpecKey(e.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-2 text-[13px]"
                >
                  <option value="">Inbox (no spec)</option>
                  {specs.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.title} ({s.key})
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="work-new-slug">Slug</Label>
              <Input
                id="work-new-slug"
                value={derivedSlug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
                placeholder="checkout-flow"
                className="font-mono"
              />
              {!slugOk && derivedSlug ? (
                <p className="text-[11.5px] text-destructive">lowercase kebab only (a–z, 0–9, -)</p>
              ) : null}
            </div>
          )}
          {kind === "initiative" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="work-new-description">Description</Label>
              <Textarea
                id="work-new-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this groups, and why it matters."
                rows={3}
              />
            </div>
          ) : null}
          {verdict ? <p className="text-[12px] text-destructive">verdict: {verdict}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!canSubmit}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Minimal envelope edit (title; +description for initiatives) — intent
 *  only. Reused by task rows, spec headers, and initiative rows. */
export function EditWorkItemDialog({
  orgId,
  itemKey,
  currentTitle,
  currentDescription,
  withDescription,
  open,
  onOpenChange,
  onSaved,
}: {
  orgId: string;
  itemKey: string;
  currentTitle: string;
  currentDescription?: string | undefined;
  withDescription?: boolean | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { client } = useSession();
  const [title, setTitle] = React.useState(currentTitle);
  const [description, setDescription] = React.useState(currentDescription ?? "");
  const [busy, setBusy] = React.useState(false);
  const [verdict, setVerdict] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setTitle(currentTitle);
      setDescription(currentDescription ?? "");
      setVerdict(null);
    }
  }, [open, currentTitle, currentDescription]);

  const save = async () => {
    setBusy(true);
    setVerdict(null);
    try {
      await client.work.editItem(orgId, itemKey, {
        title: title.trim() || undefined,
        description: withDescription ? description.trim() || undefined : undefined,
      });
      onOpenChange(false);
      onSaved();
    } catch (err) {
      const e = err as { message?: string };
      setVerdict(e.message ?? "rejected");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Edit <span className="font-mono text-[13px]">{itemKey}</span>
          </DialogTitle>
          <DialogDescription>Envelope only — nothing here can move a rung.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim() && !busy) void save();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="work-edit-title">Title</Label>
            <Input id="work-edit-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>
          {withDescription ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="work-edit-description">Description</Label>
              <Textarea
                id="work-edit-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>
          ) : null}
          {verdict ? <p className="text-[12px] text-destructive">verdict: {verdict}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!title.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
