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

/** An initiative option for the epic→initiative filing picker. */
export type InitiativeOption = { key: string; title: string };

/** Envelope edit — intent only; nothing here can move a rung (V4-4). One
 *  dialog covers every authored pixel a kind exposes: title always, then the
 *  optional fields the caller opts into (description for initiatives; owner /
 *  target / success criteria as "the only authored pixels" of an initiative;
 *  target + initiative filing for an epic). Reused by task rename, the spec
 *  header, the initiative page, and the epic page. */
export function EditWorkItemDialog({
  orgId,
  itemKey,
  currentTitle,
  currentDescription,
  currentOwner,
  currentTargetDate,
  currentSuccessCriteria,
  currentInitiative,
  withDescription,
  withOwner,
  withTargetDate,
  withSuccessCriteria,
  initiativeOptions,
  open,
  onOpenChange,
  onSaved,
}: {
  orgId: string;
  itemKey: string;
  currentTitle: string;
  currentDescription?: string | undefined;
  currentOwner?: string | undefined;
  currentTargetDate?: string | undefined;
  currentSuccessCriteria?: string[] | undefined;
  currentInitiative?: string | undefined;
  withDescription?: boolean | undefined;
  withOwner?: boolean | undefined;
  withTargetDate?: boolean | undefined;
  withSuccessCriteria?: boolean | undefined;
  /** When present, renders an epic→initiative filing picker (empty = unfiled). */
  initiativeOptions?: InitiativeOption[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { client } = useSession();
  const [title, setTitle] = React.useState(currentTitle);
  const [description, setDescription] = React.useState(currentDescription ?? "");
  const [owner, setOwner] = React.useState(currentOwner ?? "");
  const [targetDate, setTargetDate] = React.useState(currentTargetDate ?? "");
  const [criteria, setCriteria] = React.useState((currentSuccessCriteria ?? []).join("\n"));
  const [initiative, setInitiative] = React.useState(currentInitiative ?? "");
  const [busy, setBusy] = React.useState(false);
  const [verdict, setVerdict] = React.useState<string | null>(null);
  const withInitiative = initiativeOptions !== undefined;

  // Re-seed from the item's current envelope only on the closed→open edge, so
  // a background summary refresh (which hands us new prop identities) never
  // resets fields the user is mid-edit on.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setTitle(currentTitle);
      setDescription(currentDescription ?? "");
      setOwner(currentOwner ?? "");
      setTargetDate(currentTargetDate ?? "");
      setCriteria((currentSuccessCriteria ?? []).join("\n"));
      setInitiative(currentInitiative ?? "");
      setVerdict(null);
    }
    wasOpen.current = open;
  }, [
    open,
    currentTitle,
    currentDescription,
    currentOwner,
    currentTargetDate,
    currentSuccessCriteria,
    currentInitiative,
  ]);

  const save = async () => {
    setBusy(true);
    setVerdict(null);
    try {
      // Each field is sent only when the caller opted into it, so an omitted
      // field never clobbers state the dialog isn't editing. A cleared
      // owner/target sends null (unfile/clear); a cleared filing sends null.
      const criteriaList = criteria
        .split("\n")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      await client.work.editItem(orgId, itemKey, {
        title: title.trim() || undefined,
        ...(withDescription ? { description: description.trim() } : {}),
        ...(withOwner ? { owner: owner.trim() || null } : {}),
        ...(withTargetDate ? { targetDate: targetDate || null } : {}),
        ...(withSuccessCriteria ? { successCriteria: criteriaList } : {}),
        ...(withInitiative ? { initiative: initiative || null } : {}),
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
          {withInitiative ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="work-edit-initiative">Initiative</Label>
              <select
                id="work-edit-initiative"
                value={initiative}
                onChange={(e) => setInitiative(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-[13px]"
              >
                <option value="">Unfiled (no initiative)</option>
                {initiativeOptions!.map((i) => (
                  <option key={i.key} value={i.key}>
                    {i.title} ({i.key})
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {withOwner || withTargetDate ? (
            <div className="flex flex-wrap gap-3">
              {withOwner ? (
                <div className="flex min-w-[10rem] flex-1 flex-col gap-1.5">
                  <Label htmlFor="work-edit-owner">Owner</Label>
                  <Input
                    id="work-edit-owner"
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    placeholder="usr_… or a name"
                  />
                </div>
              ) : null}
              {withTargetDate ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="work-edit-target">Target date</Label>
                  <Input
                    id="work-edit-target"
                    type="date"
                    value={targetDate}
                    onChange={(e) => setTargetDate(e.target.value)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          {withSuccessCriteria ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="work-edit-criteria">Success criteria</Label>
              <Textarea
                id="work-edit-criteria"
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
                placeholder={"One per line — what “done” means for the objective."}
                rows={3}
              />
              <p className="text-[11.5px] text-muted-foreground">One per line. Blank lines are dropped.</p>
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
