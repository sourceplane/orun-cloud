"use client";

/**
 * /demo/integrations/github — token-free showcase of the GitHub (source-control)
 * detail page (saas-integrations-console IX2) across its tabs, with mock data,
 * for pixel verification. Reuses the same primitives the live page renders
 * (ProviderTile, StatCard, Switch, Segmented, Pill, Breadcrumbs).
 */

import * as React from "react";
import { ExternalLink, Filter, GitBranch } from "lucide-react";
import { Breadcrumbs, Kicker, Pill, Screen, StatCard } from "@/components/ui/northwind";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { ProviderTile } from "@/components/integrations/provider-tile";
import { Segmented } from "@/components/integrations/segmented";
import { GITHUB_CAPABILITY_TOGGLES } from "@/components/integrations/detail-model";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "repositories", label: "Repositories" },
  { id: "workspace-access", label: "Workspace access" },
  { id: "activity", label: "Activity" },
] as const;

const REPOS = [
  { name: "acme/checkout-api", lang: "TypeScript", checked: true },
  { name: "acme/web-console-next", lang: "TypeScript", checked: true },
  { name: "acme/infra", lang: "HCL", checked: true },
  { name: "acme/marketing-site", lang: "Astro", checked: false },
  { name: "acme/mobile", lang: "Swift", checked: false },
];

const ACTIVITY = [
  { tone: "bg-emerald-500", title: "Webhook delivered", detail: "push → checkout-api", time: "2h ago" },
  { tone: "bg-sky-500", title: "Token minted for plan run", detail: "run_8fa2", time: "yesterday" },
  { tone: "bg-emerald-500", title: "Check run reported", detail: "success → web-console-next", time: "2d ago" },
  { tone: "bg-amber-500", title: "Rate limit warning from GitHub API", detail: "", time: "5d ago" },
  { tone: "bg-emerald-500", title: "Installation added 3 repositories", detail: "", time: "Nov 12, 2025" },
];

export default function DemoGithubDetail() {
  const [tab, setTab] = React.useState<string>("overview");
  const [repoView, setRepoView] = React.useState<"all" | "selected">("selected");
  const [prefs, setPrefs] = React.useState<Record<string, boolean>>({
    pull_requests: true,
    checks: true,
    deployments: true,
    issues: false,
  });

  return (
    <div className="min-h-screen bg-background">
      <Screen detail>
        <Breadcrumbs items={[{ label: "Integrations", href: "#" }, { label: "GitHub" }]} />

        <div className="flex flex-wrap items-start gap-4">
          <ProviderTile provider="github" size={56} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-serif text-[30px] font-medium leading-none">GitHub</h1>
              <Pill tone="success" dot>
                Connected
              </Pill>
              <span className="rounded-[10px] border border-border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
                ACCOUNT-SHARED
              </span>
            </div>
            <p className="mt-2 text-[13px] text-muted-foreground">
              Installation acme-platform · Organization · authorized Nov 12, 2025
            </p>
          </div>
          <a
            href="#"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border bg-card px-3.5 py-2 text-[13px] font-medium transition-colors hover:bg-muted"
          >
            Open on GitHub
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        </div>

        <div className="mt-8">
          <div role="tablist" className="flex items-center gap-6 border-b border-border">
            {TABS.map((t) => {
              const on = t.id === tab;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "-mb-px border-b-2 pb-3 pt-1 text-[14px] transition-colors",
                    on ? "border-link font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className="mt-7">
            {tab === "overview" ? (
              <div className="space-y-8">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <StatCard label="Repositories" value="All" unit="allowed" footer={<span className="text-muted-foreground">The installation covers every repository.</span>} />
                  <StatCard label="Sharing" value="Account" unit="scope" footer={<span className="text-muted-foreground">All workspaces under the account may use it.</span>} />
                  <StatCard label="Connected" value="254d" unit="ago" footer={<span className="text-muted-foreground">since Nov 12, 2025</span>} />
                </div>
                <section>
                  <Kicker className="mb-3">Capabilities</Kicker>
                  <div className="overflow-hidden rounded-xl border bg-card">
                    {GITHUB_CAPABILITY_TOGGLES.map((t, i) => (
                      <div key={t.id} className={cn("flex items-center gap-4 px-5 py-4", i > 0 && "border-t border-border/60")}>
                        <div className="min-w-0 flex-1">
                          <div className="text-[14px] font-medium">{t.label}</div>
                          <div className="mt-0.5 text-[12.5px] text-muted-foreground">{t.description}</div>
                        </div>
                        <Switch checked={prefs[t.id] ?? t.defaultOn} onCheckedChange={(v) => setPrefs((p) => ({ ...p, [t.id]: v }))} aria-label={t.label} />
                      </div>
                    ))}
                  </div>
                </section>
                <section className="rounded-xl border border-destructive/30 bg-destructive/[0.03] px-5 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-semibold text-destructive">Revoke this connection</div>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                        Plans across every workspace lose GitHub access immediately. This cannot be undone.
                      </p>
                    </div>
                    <Button variant="outline" className="shrink-0">
                      Revoke
                    </Button>
                  </div>
                </section>
              </div>
            ) : tab === "repositories" ? (
              <div>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[15px] font-semibold">Repository access</div>
                    <p className="mt-1 text-[13px] text-muted-foreground">Choose which repositories plans may act on.</p>
                  </div>
                  <Segmented
                    value={repoView}
                    onChange={setRepoView}
                    aria-label="Repository access mode"
                    options={[
                      { value: "all", label: "All repositories" },
                      { value: "selected", label: "Selected only" },
                    ]}
                  />
                </div>
                {repoView === "all" ? (
                  <div className="mt-5 rounded-xl border border-dashed px-6 py-5">
                    <div className="flex items-start gap-3">
                      <GitBranch className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden />
                      <div>
                        <div className="text-[13.5px] font-medium">All 47 repositories are accessible</div>
                        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                          New repositories are included automatically. Switch to Selected only to scope access down.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="mt-5 overflow-hidden rounded-xl border bg-card">
                    <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
                      <Filter className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <Input placeholder="Filter repositories…" aria-label="Filter repositories" className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" />
                      <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">3 of 47 selected</span>
                    </div>
                    {REPOS.map((r) => (
                      <div key={r.name} className="flex items-center gap-3 border-t border-border/50 px-5 py-3 first:border-t-0">
                        <span className={cn("grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border", r.checked ? "border-primary bg-primary text-primary-foreground" : "border-border")}>
                          {r.checked ? (
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                              <path d="M5 13l4 4L19 7" />
                            </svg>
                          ) : null}
                        </span>
                        <span className="truncate font-mono text-[12.5px]">{r.name}</span>
                        <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">{r.lang}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : tab === "workspace-access" ? (
              <div>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[15px] font-semibold">Who can use this connection</div>
                    <p className="mt-1 text-[13px] text-muted-foreground">This is an account-shared connection.</p>
                  </div>
                  <Segmented value="open" onChange={() => {}} options={[{ value: "open", label: "Open to all" }, { value: "invite", label: "By invitation" }]} />
                </div>
                <div className="mt-5 rounded-xl border border-dashed px-6 py-5 text-[13px] text-muted-foreground">
                  Every workspace under Acme Platform can use GitHub. Switch to By invitation to admit workspaces one at a time.
                </div>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border bg-card">
                {ACTIVITY.map((e, i) => (
                  <div key={i} className={cn("flex items-center gap-3 px-5 py-3.5", i > 0 && "border-t border-border/50")}>
                    <span className={cn("h-2 w-2 shrink-0 rounded-full", e.tone)} aria-hidden />
                    <span className="text-[13.5px]">{e.title}</span>
                    {e.detail ? <span className="font-mono text-[12px] text-muted-foreground">{e.detail}</span> : null}
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
