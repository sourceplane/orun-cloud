"use client";

/**
 * /demo/integrations — a token-free showcase of the redesigned Integrations
 * hub (saas-integrations-console IX1). Renders the hub's visual structure with
 * mock data so the screenshot verifier can pixel-check it without an API token.
 * Uses the same presentational sub-components the live hub renders, so this
 * cannot drift from production markup.
 */

import * as React from "react";
import { Plus, Search } from "lucide-react";
import type { IntegrationDescriptor } from "@saas/contracts/integrations";
import {
  Chip,
  ChipDivider,
  ChipRow,
  Kicker,
  ListCard,
  PageHeader,
  Screen,
  StatCard,
} from "@/components/ui/northwind";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConnectedRow, ConnectPicker, ProviderCard } from "@/components/integrations/integrations-hub";

function mockDescriptor(overrides: Partial<IntegrationDescriptor>): IntegrationDescriptor {
  return {
    id: "openai",
    displayName: "OpenAI",
    category: "ai-provider",
    tagline: "Bring your own OpenAI key for agent model calls — GPT-4o, o-series, embeddings.",
    connect: [{ kind: "apikey", live: true }],
    multiConnection: false,
    capabilities: ["connect"],
    space: { tabs: ["overview"], modules: [], authoring: "declarative" },
    entitlement: "feature.integrations.openai",
    version: 1,
    status: "live",
    ...overrides,
  } as IntegrationDescriptor;
}

const AVAILABLE: Array<{ descriptor: IntegrationDescriptor; state: "available" | "locked" | "configure" }> = [
  { descriptor: mockDescriptor({ id: "openai", displayName: "OpenAI" }), state: "available" },
  {
    descriptor: mockDescriptor({
      id: "anthropic" as never,
      displayName: "Anthropic",
      tagline: "Bring your own Anthropic key for agent model calls — Claude Sonnet and Opus.",
    }),
    state: "available",
  },
  {
    descriptor: mockDescriptor({
      id: "fly" as never,
      displayName: "Fly.io",
      category: "infrastructure",
      tagline: "Deploy machines and volumes to the edge. Included on the Scale plan and above.",
      entitled: false,
    }),
    state: "locked",
  },
  {
    descriptor: mockDescriptor({
      id: "azure" as never,
      displayName: "Azure OpenAI",
      tagline: "Enterprise model access through your Azure tenancy.",
      connect: [{ kind: "apikey", live: false }],
    }),
    state: "configure",
  },
];

export default function DemoIntegrationsPage() {
  const [status, setStatus] = React.useState<"all" | "connected" | "available">("all");
  const [category, setCategory] = React.useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const noop = () => {};
  return (
    <div className="min-h-screen bg-background">
      <Screen>
        <PageHeader
          title="Integrations"
          description="An orchestration plane over the services you already use. Connect a provider, and plans can act on it — without storing your credentials."
          actions={
            <div className="flex items-center gap-2.5">
              <div className="relative hidden sm:block">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input placeholder="Search integrations" aria-label="Search integrations" className="h-9 w-[230px] pl-9" />
              </div>
              <Button onClick={() => setPickerOpen(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                Connect
              </Button>
            </div>
          }
        />

        <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard label="Connected" value={4} unit="across 5 categories" />
          <StatCard label="Brokered secrets" value={6} unit="from 2 providers" />
          <StatCard label="Available" value={4} unit="ready to connect" />
        </div>

        <div className="mt-6">
          <ChipRow>
            {(["all", "connected", "available"] as const).map((f) => (
              <Chip key={f} active={status === f} onClick={() => setStatus(f)}>
                {f === "all" ? "All" : f === "connected" ? "Connected" : "Available"}
              </Chip>
            ))}
            <ChipDivider />
            {["Source control", "Messaging", "Infrastructure", "AI providers"].map((c) => (
              <Chip key={c} active={category === c} onClick={() => setCategory(category === c ? null : c)}>
                {c}
              </Chip>
            ))}
          </ChipRow>
        </div>

        {status !== "available" ? (
          <section className="mt-7">
            <Kicker className="mb-2.5">Connected · 4</Kicker>
            <ListCard>
              <ConnectedRow
                href="#"
                provider="github"
                name="GitHub"
                status="active"
                meta="acme-platform · Account-shared · All repositories · 254d"
              />
              <ConnectedRow
                href="#"
                provider="slack"
                name="Slack"
                status="active"
                meta="Acme HQ · Workspace-private · 171d"
              />
              <ConnectedRow
                href="#"
                provider="supabase"
                name="Supabase"
                status="active"
                meta="acme-prod · Workspace-private · 3 brokered secrets"
              />
              <ConnectedRow
                href="#"
                provider="cloudflare"
                name="Cloudflare"
                status="active"
                meta="acme-platform · Account-shared · 3 brokered secrets"
              />
            </ListCard>
          </section>
        ) : null}

        {status !== "connected" ? (
          <section className="mt-8">
            <Kicker className="mb-2.5">Available · 4</Kicker>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {AVAILABLE.map(({ descriptor, state }) => (
                <ProviderCard
                  key={descriptor.id}
                  descriptor={descriptor}
                  state={state}
                  waiting={false}
                  disabled={false}
                  onConnect={noop}
                  onUpgrade={noop}
                />
              ))}
            </div>
          </section>
        ) : null}

        <section className="mt-8">
          <Kicker className="mb-2.5">On the roadmap</Kicker>
          <div className="rounded-xl border border-dashed bg-muted px-6 py-5">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              GitLab, Discord, and AWS are coming soon.{" "}
              <span className="font-medium text-foreground">Get notified</span> when they land.
            </p>
          </div>
        </section>

        <ConnectPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          descriptors={AVAILABLE.map((a) => a.descriptor)}
          connections={[]}
          loading={false}
          connectingProvider={null}
          onConnect={() => setPickerOpen(false)}
          onUpgrade={() => setPickerOpen(false)}
        />
      </Screen>
    </div>
  );
}
