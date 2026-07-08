"use client";

import * as React from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import type {
  PublicNotificationRule,
  TestNotificationRuleRequest,
  TestNotificationRuleResponse,
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
import { Badge } from "@/components/ui/badge";
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
import { RULE_SEVERITY_OPTIONS } from "@/components/notifications/rules";

/**
 * Dry-run test-fire for a rule: synthesize a sample event and show whether the
 * rule would match and which targets would receive it. Never sends anything.
 */
export function RuleTestDialog({
  open,
  onOpenChange,
  orgId,
  rule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  rule: PublicNotificationRule | null;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [type, setType] = React.useState("");
  const [source, setSource] = React.useState("");
  const [severity, setSeverity] = React.useState("info");
  const [payload, setPayload] = React.useState("{}");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<TestNotificationRuleResponse["data"] | null>(null);
  const [payloadError, setPayloadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setType(rule?.eventTypes[0] && !rule.eventTypes[0].includes("*") ? rule.eventTypes[0] : "");
    setSource("");
    setSeverity(rule?.minSeverity ?? "info");
    setPayload("{}");
    setResult(null);
    setPayloadError(null);
  }, [open, rule]);

  const run = async () => {
    if (!rule) return;
    setPayloadError(null);
    let parsedPayload: Record<string, unknown> = {};
    if (payload.trim().length > 0) {
      try {
        parsedPayload = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        setPayloadError("Payload must be valid JSON");
        return;
      }
    }
    const body: TestNotificationRuleRequest = {
      type: type.trim(),
      ...(source.trim() ? { source: source.trim() } : {}),
      severity,
      payload: parsedPayload,
    };
    setBusy(true);
    const res = await wrap(() => client.notificationRules.test(orgId, rule.id, body));
    setBusy(false);
    if (!res.ok) {
      toast({ kind: "error", title: "Test failed", description: res.error.message });
      return;
    }
    setResult(res.data);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Test-fire{rule ? ` · ${rule.name}` : ""}</DialogTitle>
          <DialogDescription>Synthesize a sample event and preview whether this rule would match. Nothing is sent.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="test-type">Event type</Label>
            <Input id="test-type" value={type} onChange={(e) => setType(e.target.value)} placeholder="state.run.failed" className="font-mono text-xs" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="test-source">Source (optional)</Label>
              <Input id="test-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="events-worker" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="test-sev">Severity</Label>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger id="test-sev">
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
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="test-payload">Payload (JSON)</Label>
            <textarea
              id="test-payload"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              rows={4}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {payloadError ? <p className="text-xs text-destructive">{payloadError}</p> : null}
          </div>

          {result ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <div className="flex items-center gap-2">
                {result.matched ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                ) : (
                  <XCircle className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="font-medium">{result.matched ? "Rule matches" : "No match"}</span>
                <Badge variant={result.ruleStatus === "enabled" ? "success" : "secondary"} className="text-[10px]">
                  {result.ruleStatus}
                </Badge>
              </div>
              {result.matched ? (
                <div className="mt-2 text-xs text-muted-foreground">
                  {result.matchedTargets.length > 0
                    ? `Would deliver to: ${result.matchedTargets.map((t) => `${t.kind}:${t.ref}`).join(", ")}`
                    : "No enabled targets would receive it."}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button type="button" onClick={() => void run()} loading={busy} disabled={type.trim().length === 0}>
            Run test
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
