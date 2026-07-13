"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import type {
  PublicNotificationChannel,
  PublicNotificationRule,
} from "@saas/contracts/notifications";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/toast";
import {
  EMPTY_RULE_FORM,
  RULE_FILTER_OPS,
  RULE_SEVERITY_OPTIONS,
  RULE_TARGET_KINDS,
  ruleFormToCreateRequest,
  ruleFormToUpdateRequest,
  ruleToFormValues,
  selectableSlackChannels,
  slackChannelOptionLabel,
  type RuleAttrFilterRow,
  type RuleFormValues,
} from "@/components/notifications/rules";

/**
 * Create/edit dialog for a notification rule. Maps the form to the exact
 * `Create/UpdateNotificationRuleRequest` contract via the pure helpers in
 * `rules.ts`; the Slack target picker is fed by the org's channels.
 */
export function RuleBuilderDialog({
  open,
  onOpenChange,
  orgId,
  rule,
  channels,
  prefillType,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  /** Editing an existing rule, or null to create. */
  rule: PublicNotificationRule | null;
  channels: ReadonlyArray<PublicNotificationChannel>;
  /** Seed event-type glob (the explorer's "create rule from this event"). */
  prefillType?: string | undefined;
  onSaved: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [values, setValues] = React.useState<RuleFormValues>(EMPTY_RULE_FORM);
  const [fieldError, setFieldError] = React.useState<{ field: string; reason: string } | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Re-seed the form whenever the dialog opens (edit prefill or create seed).
  React.useEffect(() => {
    if (!open) return;
    if (rule) {
      setValues(ruleToFormValues(rule));
    } else {
      setValues({ ...EMPTY_RULE_FORM, ...(prefillType ? { eventTypes: prefillType } : {}) });
    }
    setFieldError(null);
  }, [open, rule, prefillType]);

  const set = <K extends keyof RuleFormValues>(key: K, value: RuleFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const setAttr = (i: number, patch: Partial<RuleAttrFilterRow>) =>
    setValues((v) => ({
      ...v,
      attributeFilters: v.attributeFilters.map((row, idx) => (idx === i ? { ...row, ...patch } : row)),
    }));

  const addAttr = () =>
    setValues((v) => ({ ...v, attributeFilters: [...v.attributeFilters, { path: "", op: "eq", value: "" }] }));

  const removeAttr = (i: number) =>
    setValues((v) => ({ ...v, attributeFilters: v.attributeFilters.filter((_, idx) => idx !== i) }));

  const submit = async () => {
    setFieldError(null);
    const built = rule ? ruleFormToUpdateRequest(values) : ruleFormToCreateRequest(values);
    if (!built.ok) {
      setFieldError({ field: built.field, reason: built.reason });
      return;
    }
    setBusy(true);
    const res = rule
      ? await wrap(() => client.notificationRules.update(orgId, rule.id, built.value as never))
      : await wrap(() => client.notificationRules.create(orgId, built.value as never));
    setBusy(false);
    if (!res.ok) {
      toast({ kind: "error", title: rule ? "Update failed" : "Create failed", description: res.error.message });
      return;
    }
    toast({ kind: "success", title: rule ? "Rule updated" : "Rule created" });
    onOpenChange(false);
    onSaved();
  };

  // Every Slack-deliverable channel is a valid rule target — the workspace-bot
  // (slack_app, IH2) exactly as the incoming-webhook. This previously filtered
  // to webhooks only, so a connected workspace's bot channel never appeared.
  const slackChannels = selectableSlackChannels(channels);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "New notification rule"}</DialogTitle>
          <DialogDescription>
            Route matching events to a delivery target. Event types accept globs (<code>scm.*</code>, <code>*</code>).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Name" htmlFor="rule-name" error={fieldError?.field === "name" ? fieldError.reason : undefined}>
            <Input id="rule-name" value={values.name} onChange={(e) => set("name", e.target.value)} placeholder="Failed runs → #alerts" />
          </Field>

          <Field
            label="Event types (one per line, or comma-separated)"
            htmlFor="rule-types"
            error={fieldError?.field === "eventTypes" ? fieldError.reason : undefined}
          >
            <textarea
              id="rule-types"
              value={values.eventTypes}
              onChange={(e) => set("eventTypes", e.target.value)}
              rows={3}
              placeholder={"state.run.failed\nscm.*"}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Minimum severity" htmlFor="rule-sev">
              <Select value={values.minSeverity} onValueChange={(v) => set("minSeverity", v as RuleFormValues["minSeverity"])}>
                <SelectTrigger id="rule-sev">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RULE_SEVERITY_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Scope" htmlFor="rule-scope">
              <Select value={values.scope} onValueChange={(v) => set("scope", v as "org" | "project")}>
                <SelectTrigger id="rule-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="org">Whole workspace</SelectItem>
                  <SelectItem value="project">A single project</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {values.scope === "project" ? (
            <Field
              label="Project id"
              htmlFor="rule-project"
              error={fieldError?.field === "projectId" ? fieldError.reason : undefined}
            >
              <Input id="rule-project" value={values.projectId} onChange={(e) => set("projectId", e.target.value)} placeholder="prj_…" />
            </Field>
          ) : null}

          <Field label="Sources (optional, comma-separated allow-list)" htmlFor="rule-sources">
            <Input id="rule-sources" value={values.sources} onChange={(e) => set("sources", e.target.value)} placeholder="events-worker, scm" />
          </Field>

          {/* Attribute filters */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Attribute filters (optional)</Label>
              <Button type="button" size="sm" variant="ghost" onClick={addAttr}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add
              </Button>
            </div>
            {values.attributeFilters.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={row.path}
                  onChange={(e) => setAttr(i, { path: e.target.value })}
                  placeholder="payload.path"
                  aria-label="Attribute path"
                  className="h-8 flex-1 font-mono text-xs"
                />
                <Select value={row.op} onValueChange={(v) => setAttr(i, { op: v as RuleAttrFilterRow["op"] })}>
                  <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Operator">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RULE_FILTER_OPS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={row.value}
                  onChange={(e) => setAttr(i, { value: e.target.value })}
                  placeholder="value"
                  aria-label="Attribute value"
                  className="h-8 flex-1 text-xs"
                />
                <Button type="button" size="icon" variant="ghost" onClick={() => removeAttr(i)} aria-label="Remove filter">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>

          {/* Throttle */}
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Throttle window (seconds)"
              htmlFor="rule-window"
              error={fieldError?.field === "throttleWindowSeconds" ? fieldError.reason : undefined}
            >
              <Input
                id="rule-window"
                type="number"
                min={0}
                value={values.throttleWindowSeconds}
                onChange={(e) => set("throttleWindowSeconds", e.target.value)}
              />
            </Field>
            <Field
              label="Throttle max"
              htmlFor="rule-max"
              error={fieldError?.field === "throttleMax" ? fieldError.reason : undefined}
            >
              <Input id="rule-max" type="number" min={1} value={values.throttleMax} onChange={(e) => set("throttleMax", e.target.value)} />
            </Field>
          </div>

          {/* Target — creation only (update contract carries no targets). */}
          {rule ? (
            <p className="rounded-md border border-dashed bg-muted/30 p-2.5 text-xs text-muted-foreground">
              Delivery targets are set when the rule is created and are not editable here.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Target" htmlFor="rule-target-kind">
                <Select value={values.targetKind} onValueChange={(v) => set("targetKind", v as RuleFormValues["targetKind"])}>
                  <SelectTrigger id="rule-target-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RULE_TARGET_KINDS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                label={values.targetKind === "email" ? "Email address" : "Slack channel"}
                htmlFor="rule-target-ref"
                error={fieldError?.field === "targetRef" ? fieldError.reason : undefined}
              >
                {values.targetKind === "slack_channel" ? (
                  <Select value={values.targetRef} onValueChange={(v) => set("targetRef", v)}>
                    <SelectTrigger id="rule-target-ref">
                      <SelectValue placeholder={slackChannels.length ? "Select a channel" : "No Slack channels"} />
                    </SelectTrigger>
                    <SelectContent>
                      {slackChannels.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {slackChannelOptionLabel(c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input id="rule-target-ref" type="email" value={values.targetRef} onChange={(e) => set("targetRef", e.target.value)} placeholder="ops@example.com" />
                )}
              </Field>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} loading={busy}>
            {rule ? "Save changes" : "Create rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
