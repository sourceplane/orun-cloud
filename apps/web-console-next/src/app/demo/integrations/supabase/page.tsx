"use client";

/**
 * /demo/integrations/supabase — token-free showcase of the infrastructure
 * secret-broker detail page (saas-integrations-console IX3) across its tabs,
 * with mock data, for pixel verification. Same primitives as the live page.
 */

import * as React from "react";
import { Database, ExternalLink, Plus } from "lucide-react";
import { Breadcrumbs, Kicker, Pill, Screen, StatCard } from "@/components/ui/northwind";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { ProviderTile } from "@/components/integrations/provider-tile";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "secrets", label: "Secrets" },
  { id: "projects", label: "Projects" },
  { id: "activity", label: "Activity" },
] as const;

const BROKER = [
  { title: "Database access", desc: "Read-only and read/write Postgres, minted per run." },
  { title: "Storage", desc: "Scoped object-storage credentials for a bucket." },
  { title: "Service role", desc: "The service_role JWT, rotated on a schedule." },
];

const SECRETS = [
  { key: "SUPABASE_DB_URL", meta: "brokered · supabase · db-ro · checkout / production · ≤ 1h", badge: "Fresh per run", tone: "success" as const, action: "Manage" },
  { key: "SUPABASE_SERVICE_ROLE_KEY", meta: "rotated · supabase · service · workspace · stored encrypted", badge: "Rotated · 90d", tone: "info" as const, action: "Rotate now" },
  { key: "SUPABASE_STORAGE_KEY", meta: "brokered · supabase · storage · staging · bucket uploads · ≤ 1h", badge: "Fresh per run", tone: "success" as const, action: "Manage" },
];

const PROJECTS = [
  { ref: "acme-prod-primary", region: "us-east-1" },
  { ref: "acme-prod-analytics", region: "eu-west-2" },
];

const ACTIVITY = [
  { tone: "bg-emerald-500", title: "Credential minted", detail: "db-ro → run_2c91", time: "1h ago" },
  { tone: "bg-sky-500", title: "Service role rotated", detail: "v4", time: "12d ago" },
  { tone: "bg-emerald-500", title: "Connection authorized", detail: "acme-prod", time: "Oct 26, 2025" },
];

export default function DemoSupabaseDetail() {
  const [tab, setTab] = React.useState<string>("overview");
  return (
    <div className="min-h-screen bg-background">
      <Screen detail>
        <Breadcrumbs items={[{ label: "Integrations", href: "#" }, { label: "Supabase" }]} />

        <div className="flex flex-wrap items-start gap-4">
          <ProviderTile provider="supabase" size={56} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-serif text-[30px] font-medium leading-none">Supabase</h1>
              <Pill tone="success" dot>
                Connected
              </Pill>
              <span className="rounded-[10px] border border-border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
                WORKSPACE-PRIVATE
              </span>
            </div>
            <p className="mt-2 text-[13px] text-muted-foreground">Organization acme-prod · authorized Oct 26, 2025</p>
          </div>
          <a href="#" className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border bg-card px-3.5 py-2 text-[13px] font-medium transition-colors hover:bg-muted">
            Open dashboard
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        </div>

        <div className="mt-8">
          <div role="tablist" className="flex items-center gap-6 border-b border-border">
            {TABS.map((t) => {
              const on = t.id === tab;
              return (
                <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => setTab(t.id)}
                  className={cn("-mb-px border-b-2 pb-3 pt-1 text-[14px] transition-colors", on ? "border-link font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className="mt-7">
            {tab === "overview" ? (
              <div className="space-y-8">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <StatCard label="Projects" value={2} unit="linked" footer={<span className="text-muted-foreground">Postgres, Storage, Edge.</span>} />
                  <StatCard label="Managed secrets" value={3} unit="brokered" footer={<span className="text-muted-foreground">Minted from this connection.</span>} />
                  <StatCard label="Connected" value="271d" unit="ago" footer={<span className="text-muted-foreground">since Oct 26, 2025</span>} />
                </div>
                <section>
                  <Kicker className="mb-3">What Orun can broker</Kicker>
                  <div className="overflow-hidden rounded-xl border bg-card">
                    {BROKER.map((b, i) => (
                      <div key={b.title} className={cn("px-5 py-4", i > 0 && "border-t border-border/60")}>
                        <div className="text-[14px] font-medium">{b.title}</div>
                        <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{b.desc}</div>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="rounded-xl border border-destructive/30 bg-destructive/[0.03] px-5 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold text-destructive">Revoke this connection</div>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                        Its 3 brokered secrets stop resolving immediately and become orphaned.
                      </p>
                    </div>
                    <Button variant="outline" className="shrink-0">
                      Revoke
                    </Button>
                  </div>
                </section>
              </div>
            ) : tab === "secrets" ? (
              <div>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[15px] font-semibold">Secrets brokered from Supabase</div>
                    <p className="mt-1 text-[13px] text-muted-foreground">Orun mints these from the connection — most never touch disk.</p>
                  </div>
                  <Button>
                    <Plus className="h-4 w-4" aria-hidden />
                    New secret
                  </Button>
                </div>
                <div className="mt-5 overflow-hidden rounded-xl border bg-card">
                  {SECRETS.map((s, i) => (
                    <div key={s.key} className={cn("flex flex-wrap items-center gap-3 px-5 py-4", i > 0 && "border-t border-border/60")}>
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[13px] font-semibold">{s.key}</div>
                        <div className="mt-1 text-[12px] text-muted-foreground">{s.meta}</div>
                      </div>
                      <Pill tone={s.tone} dot>
                        {s.badge}
                      </Pill>
                      <Button variant="outline" size="sm">
                        {s.action}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : tab === "projects" ? (
              <div className="overflow-hidden rounded-xl border bg-card">
                {PROJECTS.map((p, i) => (
                  <div key={p.ref} className={cn("flex items-center gap-3 px-5 py-3.5", i > 0 && "border-t border-border/50")}>
                    <Database className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden />
                    <span className="truncate font-mono text-[12.5px]">{p.ref}</span>
                    <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">{p.region}</span>
                    <Pill tone="success" dot>
                      Active
                    </Pill>
                  </div>
                ))}
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border bg-card">
                {ACTIVITY.map((e, i) => (
                  <div key={i} className={cn("flex items-center gap-3 px-5 py-3.5", i > 0 && "border-t border-border/50")}>
                    <span className={cn("h-2 w-2 shrink-0 rounded-full", e.tone)} aria-hidden />
                    <span className="text-[13.5px]">{e.title}</span>
                    <span className="font-mono text-[12px] text-muted-foreground">{e.detail}</span>
                    <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">{e.time}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Screen>
    </div>
  );
}
