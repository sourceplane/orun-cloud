"use client";

import * as React from "react";
import { ShieldCheck, ShieldX, FileText } from "lucide-react";
import type { ConfigScope } from "@saas/sdk";
import type {
  PublicSecretPolicy,
  SecretPolicyTier,
  EvaluateSecretPolicyResponse,
} from "@saas/contracts/config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Kicker, ListCard, Pill } from "@/components/ui/northwind";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { useApiQuery } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { ListSkeleton, LoadError } from "./config-shared";
import {
  policyTestRequest,
  EMPTY_POLICY_TEST_FORM,
  type PolicyTestFormValues,
} from "./secrets-view";

const TIERS: { id: SecretPolicyTier; label: string; hint: string }[] = [
  { id: "composition", label: "Composition", hint: "Platform-wide guardrails" },
  { id: "stack", label: "Stack", hint: "Reusable stack policy" },
  { id: "intent", label: "Intent", hint: "Per-component declarations" },
];

/**
 * The console face of `orun policy test` (saas-secret-manager SM3, Layer 2).
 * Lists the tier-ordered SecretPolicy documents in scope, and runs the dry-run
 * evaluation reporting BOTH layers. Secret-policies live at organization/project
 * scope only. No secret value is involved anywhere here.
 */
export function SecretPoliciesPanel({ scope, scopeKey }: { scope: ConfigScope; scopeKey: string }) {
  const { client } = useSession();
  const policies = useApiQuery(["configSecretPolicies", scopeKey], () =>
    wrap(async () => (await client.config.listSecretPolicies(scope)).policies),
  );

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <div>
          <h3 className="text-[13.5px] font-semibold">Policy documents</h3>
          <p className="mt-1 text-[12.5px] leading-normal text-muted-foreground">
            Layer-2 conditions the resolve evaluates, in tier order (composition → stack → intent).
            Pushed via <span className="font-mono text-[11.5px]">orun policy push</span>.
          </p>
        </div>
        {policies.loading ? (
          <ListSkeleton />
        ) : policies.error ? (
          <LoadError title="Failed to load policies" message={policies.error.message} />
        ) : !policies.data || policies.data.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No policy documents"
            description="Push a SecretPolicy document with the orun CLI to add Layer-2 conditions on top of role-based access."
          />
        ) : (
          <PolicyList policies={policies.data} />
        )}
      </div>

      <PolicyTester scope={scope} />
    </div>
  );
}

function PolicyList({ policies }: { policies: PublicSecretPolicy[] }) {
  return (
    <div className="space-y-4">
      {TIERS.map((tier) => {
        const inTier = policies.filter((p) => p.tier === tier.id);
        if (inTier.length === 0) return null;
        return (
          <div key={tier.id} className="space-y-2">
            <div className="flex items-center gap-2">
              <Kicker>{tier.label}</Kicker>
              <span className="text-[11px] text-muted-foreground/80">{tier.hint}</span>
            </div>
            <ListCard>
              {inTier.map((p) => {
                const ruleCount = Array.isArray((p.document as { rules?: unknown[] }).rules)
                  ? (p.document as { rules: unknown[] }).rules.length
                  : 0;
                return (
                  <div
                    key={`${p.name}-${p.documentHash}`}
                    className="flex items-center justify-between gap-3 border-t border-border/50 px-4 py-3 first:border-t-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[12.5px] font-medium">{p.name}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                        <span className="truncate">source: {p.source}</span>
                        <span aria-hidden>·</span>
                        <span>{ruleCount} rule{ruleCount === 1 ? "" : "s"}</span>
                      </div>
                    </div>
                    <Pill tone={p.scope === "project" ? "neutral" : "info"}>{p.scope}</Pill>
                  </div>
                );
              })}
            </ListCard>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policy test matrix
// ---------------------------------------------------------------------------

function PolicyTester({ scope }: { scope: ConfigScope }) {
  const { client } = useSession();
  const { toast } = useToast();
  const [form, setForm] = React.useState<PolicyTestFormValues>(EMPTY_POLICY_TEST_FORM);
  const [result, setResult] = React.useState<EvaluateSecretPolicyResponse | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const set = <K extends keyof PolicyTestFormValues>(k: K, v: PolicyTestFormValues[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const run = async () => {
    if (form.key.trim().length === 0 || form.env.trim().length === 0) {
      toast({ kind: "error", title: "Key and env are required" });
      return;
    }
    setSubmitting(true);
    const r = await wrap(() => client.config.evaluateSecretPolicy(scope, policyTestRequest(form)));
    setSubmitting(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Evaluation failed", description: r.error.message });
      setResult(null);
      return;
    }
    setResult(r.data);
  };

  return (
    <div className="rounded-xl border bg-card px-6 py-5">
      <div className="mb-4">
        <h3 className="text-[13.5px] font-semibold">Policy test</h3>
        <p className="mt-1 text-[12.5px] leading-normal text-muted-foreground">
          Dry-run a hypothetical resolve. Reports the Layer-1 role decision and the Layer-2
          SecretPolicy decision without serving any value.
        </p>
      </div>
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Secret key">
            <Input value={form.key} onChange={(e) => set("key", e.target.value)} placeholder="STRIPE_KEY" />
          </Field>
          <Field label="Environment">
            <Input value={form.env} onChange={(e) => set("env", e.target.value)} placeholder="production" />
          </Field>
          <Field label="Platform">
            <Select value={form.platform} onValueChange={(v) => set("platform", v)}>
              <SelectTrigger aria-label="Platform">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local-cli">local-cli</SelectItem>
                <SelectItem value="ci-oidc">ci-oidc</SelectItem>
                <SelectItem value="service">service</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Serves from">
            <Select value={form.servesFrom || "any"} onValueChange={(v) => set("servesFrom", v === "any" ? "" : v)}>
              <SelectTrigger aria-label="Serves from">
                <SelectValue placeholder="Any" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any</SelectItem>
                <SelectItem value="environment">environment</SelectItem>
                <SelectItem value="project">project</SelectItem>
                <SelectItem value="workspace">workspace</SelectItem>
                <SelectItem value="account">account</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Subject kind">
            <Select value={form.subjectKind} onValueChange={(v) => set("subjectKind", v)}>
              <SelectTrigger aria-label="Subject kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">user</SelectItem>
                <SelectItem value="service_principal">service_principal</SelectItem>
                <SelectItem value="workflow">workflow</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Subject id">
            <Input value={form.subjectId} onChange={(e) => set("subjectId", e.target.value)} placeholder="usr_… (defaults to you)" />
          </Field>
          <Field label="Teams (comma-separated)">
            <Input value={form.teams} onChange={(e) => set("teams", e.target.value)} placeholder="payments, sre" />
          </Field>
          <Field label="Component type">
            <Input value={form.componentType} onChange={(e) => set("componentType", e.target.value)} placeholder="service" />
          </Field>
          <Field label="Component name">
            <Input value={form.componentName} onChange={(e) => set("componentName", e.target.value)} placeholder="checkout" />
          </Field>
          <Field label="Trigger branch">
            <Input value={form.triggerBranch} onChange={(e) => set("triggerBranch", e.target.value)} placeholder="main" />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={form.triggerDeclared} onCheckedChange={(v) => set("triggerDeclared", v)} aria-label="Declared dependency" />
            Declared dependency
          </label>
          <Button type="button" onClick={() => void run()} loading={submitting}>
            Run test
          </Button>
        </div>

        {result ? <ResultCard result={result} /> : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function ResultCard({ result }: { result: EvaluateSecretPolicyResponse }) {
  const allow = result.decision.allow;
  return (
    <div
      className={cn(
        "space-y-3 rounded-[10px] border p-3.5",
        allow ? "border-success/30 bg-success-soft" : "border-destructive/30 bg-destructive-soft",
      )}
    >
      <div className={cn("flex items-center gap-2 text-sm font-medium", allow ? "text-success" : "text-destructive")}>
        {allow ? <ShieldCheck className="h-5 w-5" /> : <ShieldX className="h-5 w-5" />}
        {allow ? "Allowed" : "Denied"}
      </div>
      <dl className="grid grid-cols-1 gap-2 text-xs">
        <LayerRow
          label="Layer 1 · role"
          allow={result.layer1.allow}
          detail={`${result.layer1.action} — ${result.layer1.reason}`}
        />
        <LayerRow
          label="Layer 2 · policy"
          allow={result.layer2.allow}
          detail={result.layer2.ruleId ? `rule ${result.layer2.ruleId} — ${result.layer2.reason}` : result.layer2.reason}
        />
      </dl>
    </div>
  );
}

function LayerRow({ label, allow, detail }: { label: string; allow: boolean; detail: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-[11px]" title={detail}>
          {detail}
        </span>
        <Pill tone={allow ? "success" : "error"}>{allow ? "allow" : "deny"}</Pill>
      </span>
    </div>
  );
}
