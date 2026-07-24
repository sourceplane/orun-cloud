"use client";

/**
 * /demo/integrations/slack — token-free showcase of the messaging detail page
 * (saas-integrations-console IX4) across its tabs, with mock data, for pixel
 * verification. Same primitives as the live page.
 */

import * as React from "react";
import { Hash } from "lucide-react";
import { Breadcrumbs, Pill, Screen, StatCard } from "@/components/ui/northwind";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { ProviderTile } from "@/components/integrations/provider-tile";
import { SLACK_NOTIFICATION_ROUTES } from "@/components/integrations/detail-model";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "channels", label: "Channels" },
  { id: "notifications", label: "Notifications" },
  { id: "activity", label: "Activity" },
] as const;

const CHANNELS = ["deploys", "incidents", "eng-approvals", "agent-digest"];

const ACTIVITY = [
  { tone: "bg-emerald-500", title: "Message posted", detail: "run outcome → #deploys", time: "3h ago" },
  { tone: "bg-sky-500", title: "Approval requested", detail: "#eng-approvals", time: "yesterday" },
  { tone: "bg-emerald-500", title: "Workspace authorized", detail: "Acme HQ", time: "Feb 3, 2026" },
];

export default function DemoSlackDetail() {
  const [tab, setTab] = React.useState<string>("overview");
  const [prefs, setPrefs] = React.useState<Record<string, boolean>>(() => {
    const seed: Record<string, boolean> = {};
    for (const r of SLACK_NOTIFICATION_ROUTES) seed[r.id] = r.defaultOn;
    return seed;
  });
  return (
    <div className="min-h-screen bg-background">
      <Screen detail>
        <Breadcrumbs items={[{ label: "Integrations", href: "#" }, { label: "Slack" }]} />

        <div className="flex flex-wrap items-start gap-4">
          <ProviderTile provider="slack" size={56} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-serif text-[30px] font-medium leading-none">Slack</h1>
              <Pill tone="success" dot>
                Connected
              </Pill>
              <span className="rounded-[10px] border border-border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
                WORKSPACE-PRIVATE
              </span>
            </div>
            <p className="mt-2 text-[13px] text-muted-foreground">Workspace Acme HQ · authorized Feb 3, 2026</p>
          </div>
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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <StatCard label="Channels" value={4} unit="connected" footer={<span className="text-muted-foreground">Receiving plan notifications.</span>} />
                <StatCard label="Sharing" value="Workspace" unit="scope" footer={<span className="text-muted-foreground">Private to Acme HQ.</span>} />
                <StatCard label="Connected" value="171d" unit="ago" footer={<span className="text-muted-foreground">since Feb 3, 2026</span>} />
              </div>
            ) : tab === "channels" ? (
              <div>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[15px] font-semibold">Connected channels</div>
                    <p className="mt-1 text-[13px] text-muted-foreground">Orun can post to these channels.</p>
                  </div>
                  <Button variant="outline">Add channel</Button>
                </div>
                <div className="mt-5 overflow-hidden rounded-xl border bg-card">
                  {CHANNELS.map((c, i) => (
                    <div key={c} className={cn("flex items-center gap-2.5 px-5 py-3.5", i > 0 && "border-t border-border/50")}>
                      <Hash className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate text-[13.5px] font-medium">{c}</span>
                      {i === 0 ? <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">default</span> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : tab === "notifications" ? (
              <div>
                <div className="text-[15px] font-semibold">Notification routing</div>
                <p className="mt-1 text-[13px] text-muted-foreground">Choose which events post to Slack, and where.</p>
                <div className="mt-5 overflow-hidden rounded-xl border bg-card">
                  {SLACK_NOTIFICATION_ROUTES.map((route, i) => (
                    <div key={route.id} className={cn("flex items-center gap-4 px-5 py-4", i > 0 && "border-t border-border/60")}>
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium">{route.label}</div>
                        <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                          {route.description} <span className="font-mono text-[11.5px]">· {route.channel}</span>
                        </div>
                      </div>
                      <Switch checked={prefs[route.id] ?? route.defaultOn} onCheckedChange={(v) => setPrefs((p) => ({ ...p, [route.id]: v }))} aria-label={route.label} />
                    </div>
                  ))}
                </div>
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
