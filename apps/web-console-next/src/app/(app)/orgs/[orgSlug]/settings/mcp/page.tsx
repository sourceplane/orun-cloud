"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Bot, KeyRound } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsHeader, SettingsPanel, PanelTitle } from "@/components/settings/settings-primitives";
import { ListCard, Pill } from "@/components/ui/northwind";
import {
  LOCAL_MCP_SNIPPETS,
  MCP_LOGIN_COMMAND,
  NODE_CLI_MCP_LOGIN_COMMAND,
  NODE_CLI_MCP_SNIPPETS,
  ORUN_INSTALL_COMMAND,
  activeMcpGrants,
  connectAgentLinks,
  mcpRemoteUrl,
  supportedOAuthClients,
} from "@/components/settings/connect-agent";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";

/**
 * Settings › Developer › MCP server — the "Connect an agent" surface
 * (saas-mcp-server MCP7; local path flipped to the orun binary in MCP10).
 *
 * Everything here rides shipped rails: the primary local snippets target the
 * orun binary (D7 unification), the node-CLI reference snippets mirror the CLI
 * README, the remote URL is derived the same way the console derives api-edge
 * URLs, key minting stays on the API-keys page, grants stay on Sessions &
 * devices, and MCP usage shows up in the existing Usage explorer. No new read
 * models.
 */
export default function ConnectAgentPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{() => <Inner orgSlug={slug} />}</OrgScope>;
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>;
}

/** Inline prose link (settings-copy treatment). */
function ProseLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-link underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}

/** Dark doc-style code block with a copy button (same treatment as the project CLI page). */
function CodeBlock({ code }: { code: string }) {
  return (
    <div className="flex items-start justify-between gap-3 overflow-x-auto rounded-[10px] bg-[#171717] p-4 font-mono text-[12.5px] leading-[1.7] text-[#D4D4D4]">
      <code className="whitespace-pre">{code}</code>
      <CopyButton value={code} className="shrink-0" />
    </div>
  );
}

function Inner({ orgSlug }: { orgSlug: string }) {
  const { client, target } = useSession();
  const links = connectAgentLinks(orgSlug);
  const remoteUrl = mcpRemoteUrl(target.name);
  const oauthClients = supportedOAuthClients();

  // MCP OAuth grants are per-user CLI-shaped sessions (MCP3) — reuse the
  // existing Sessions & devices read; revocation stays on that page.
  const sessions = useApiQuery(qk.cliSessions(), () =>
    wrap(async () => (await client.cliSessions.list()).sessions),
  );
  const grants = activeMcpGrants(sessions.data ?? []);

  return (
    <div className="space-y-[18px]">
      <SettingsHeader
        title="Connect an agent"
        description="Give AI agents — Claude Code, Cursor, VS Code, or your own — a typed tool plane over this workspace: service catalog, runs and logs, audit, usage, config, and webhooks. Every call uses the agent's own credential, so roles, rate limits, audit, and metering apply exactly as they do for any other client."
      />

      {/* Local (recommended) */}
      <SettingsPanel>
        <div className="flex items-center gap-2">
          <PanelTitle>Local server</PanelTitle>
          <Pill tone="success">recommended</Pill>
        </div>
        <p className="mt-1.5 max-w-[560px] text-[12.5px] leading-relaxed text-muted-foreground">
          The <InlineCode>orun</InlineCode> binary serves the full tool plane over stdio — this
          platform&rsquo;s tools alongside orun&rsquo;s work tools, one server. Install it and sign
          in once, then register the server with your client — it runs with your credential and
          your role.
        </p>
        <div className="mt-4">
          <div className="mb-2 text-xs text-muted-foreground">
            Install the orun binary, then sign in
          </div>
          <CodeBlock code={`${ORUN_INSTALL_COMMAND}\n${MCP_LOGIN_COMMAND}`} />
        </div>
        <Tabs defaultValue={LOCAL_MCP_SNIPPETS[0]!.id} className="mt-4">
          <TabsList>
            {LOCAL_MCP_SNIPPETS.map((s) => (
              <TabsTrigger key={s.id} value={s.id}>
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {LOCAL_MCP_SNIPPETS.map((s) => (
            <TabsContent key={s.id} value={s.id}>
              <div className="mb-2 text-xs text-muted-foreground">{s.hint}</div>
              <CodeBlock code={s.code} />
            </TabsContent>
          ))}
        </Tabs>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Useful flags: <InlineCode>--read-only</InlineCode> removes the write tools from the
          roster entirely; <InlineCode>--workspace &lt;ref&gt;</InlineCode> pins the default
          workspace for scoped tools (the workspace linked to your current repo otherwise).
        </p>
        <details className="mt-4 border-t border-border/50 pt-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            Reference implementation (node CLI)
          </summary>
          <p className="mt-2 max-w-[560px] text-xs leading-relaxed text-muted-foreground">
            The <InlineCode>orun-cloud</InlineCode> CLI still ships the platform-only MCP server —
            the same tool plane the remote server runs — and remains fully supported as the
            reference implementation. Sign in with{" "}
            <InlineCode>{NODE_CLI_MCP_LOGIN_COMMAND}</InlineCode>, then:
          </p>
          <div className="mt-3 space-y-3">
            {NODE_CLI_MCP_SNIPPETS.map((s) => (
              <div key={s.id}>
                <div className="mb-1.5 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">{s.label}</span> — {s.hint}
                </div>
                <CodeBlock code={s.code} />
              </div>
            ))}
          </div>
        </details>
      </SettingsPanel>

      {/* Remote */}
      <SettingsPanel>
        <PanelTitle>Remote server</PanelTitle>
        <p className="mt-1.5 max-w-[560px] text-[12.5px] leading-relaxed text-muted-foreground">
          For hosted agents, CI, and clients that can&rsquo;t run the CLI. The remote server speaks
          MCP over Streamable HTTP and is read-only today.
        </p>
        <div className="mt-4">
          <CodeBlock code={remoteUrl} />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <div className="text-[12.5px] font-semibold">API key (headless)</div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Send a workspace API key as the bearer token. Mint one with the role the agent needs:{" "}
              <span className="font-medium text-foreground">viewer</span> for read-only agents,{" "}
              <span className="font-medium text-foreground">builder</span> for agents that write.
            </p>
            <Button variant="outline" size="sm" className="mt-2.5" asChild>
              <Link href={links.apiKeys}>
                <KeyRound className="h-4 w-4" strokeWidth={1.8} />
                Create API key
              </Link>
            </Button>
          </div>
          <div>
            <div className="text-[12.5px] font-semibold">OAuth (interactive)</div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              OAuth-capable clients connect to the remote URL directly — no pasted key. You&rsquo;re
              sent through the console consent screen, and the grant appears under{" "}
              <ProseLink href={links.sessions}>Sessions &amp; devices</ProseLink>, where you can
              revoke it any time.
            </p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {oauthClients.map((c) => (
                <Pill key={c.clientId} tone="neutral">
                  {c.name}
                </Pill>
              ))}
            </div>
          </div>
        </div>
      </SettingsPanel>

      {/* Access & governance */}
      <SettingsPanel>
        <PanelTitle>Access &amp; governance</PanelTitle>
        <ul className="mt-2.5 max-w-[620px] list-disc space-y-1.5 pl-4 text-[12.5px] leading-relaxed text-muted-foreground">
          <li>
            An agent can do exactly what its credential can do — the key&rsquo;s role bounds which
            tools succeed. Read tools need <span className="font-medium text-foreground">viewer</span>;
            writes (create a project, set a flag, replay a delivery, invite a member) need{" "}
            <span className="font-medium text-foreground">builder</span> or above. Roles are managed
            under <ProseLink href={links.peopleAccess}>People &amp; Access</ProseLink>.
          </li>
          <li>The remote server is read-only today; write tools run through the local server.</li>
          <li>
            Every tool call is policy-checked and rate-limited at the API edge, lands in the{" "}
            audit log tagged <InlineCode>x-client-surface: mcp</InlineCode>, and is metered as{" "}
            <InlineCode>mcp.tool_call</InlineCode>. Secret values are never readable over MCP —
            metadata only.
          </li>
        </ul>
      </SettingsPanel>

      {/* Status */}
      <SettingsPanel>
        <div className="flex items-start justify-between gap-4">
          <div>
            <PanelTitle>Your connected agents</PanelTitle>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
              Active MCP grants for your account. Revoke from{" "}
              <ProseLink href={links.sessions}>Sessions &amp; devices</ProseLink>; agent traffic
              shows up under <ProseLink href={links.usage}>Usage &amp; quota</ProseLink> as{" "}
              <InlineCode>mcp.tool_call</InlineCode>.
            </p>
          </div>
        </div>
        <div className="mt-3.5">
          {sessions.loading ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : sessions.error ? (
            <p className="text-[12.5px] text-muted-foreground">
              Couldn&rsquo;t load your sessions ({sessions.error.code}).
            </p>
          ) : grants.length === 0 ? (
            <div className="flex items-center gap-2.5 rounded-[9px] border border-dashed px-3.5 py-3 text-[12.5px] text-muted-foreground">
              <Bot className="h-4 w-4 shrink-0" strokeWidth={1.8} />
              No agents connected via OAuth yet. Local (stdio) agents use your CLI login and
              don&rsquo;t appear here.
            </div>
          ) : (
            <ListCard>
              {grants.map((g) => (
                <div
                  key={g.id}
                  className="flex items-center gap-3 border-t border-border/50 px-5 py-[13px] first:border-t-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium">{g.clientName}</span>
                      <Pill tone="neutral">mcp</Pill>
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                      connected {new Date(g.createdAt).toLocaleDateString()} · last used{" "}
                      {new Date(g.lastUsedAt).toLocaleDateString()}
                    </div>
                  </div>
                </div>
              ))}
            </ListCard>
          )}
        </div>
      </SettingsPanel>
    </div>
  );
}
