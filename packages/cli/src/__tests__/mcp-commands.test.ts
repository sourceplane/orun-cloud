// `mcp` command group (saas-mcp-server MCP1): registration, the `mcp tools`
// roster (human/json/--read-only), the serve-mode auth-missing error path
// (stderr + non-zero, no server started, stdout untouched), and the
// workspace-default precedence (flag > active context > none).

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { allTools, readOnlyTools } from "@saas/mcp";

import { runCli } from "../cli-runner.js";
import { assertServeEntitlement, resolveWorkspaceDefault } from "../commands/mcp.js";
import { ContextStore } from "../context/store.js";
import type { CommandContext } from "../router.js";
import { MemoryTokenStore } from "./helpers.js";

interface Cap {
  stdout: string[];
  stderr: string[];
}

async function withHarness(
  fn: (h: {
    cap: Cap;
    contextStore: ContextStore;
    runArgv: (argv: string[]) => Promise<{ exitCode: number }>;
  }) => Promise<void>,
  options: { storedCred?: { apiUrl: string; token: string } | null } = {},
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-mcp-"));
  try {
    const cap: Cap = { stdout: [], stderr: [] };
    const tokenStore = new MemoryTokenStore(
      options.storedCred === null ? undefined : options.storedCred,
    );
    const contextStore = new ContextStore({ configDir: dir });
    const runArgv = (argv: string[]): Promise<{ exitCode: number }> =>
      runCli(argv, {
        stdout: (l) => cap.stdout.push(l),
        stderr: (l) => cap.stderr.push(l),
        tokenStore,
        contextStore,
      });
    await fn({ cap, contextStore, runArgv });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("mcp — command registration", () => {
  it("`mcp tools` resolves in the router", async () => {
    await withHarness(async ({ runArgv }) => {
      const r = await runArgv(["mcp", "tools"]);
      expect(r.exitCode).toBe(0);
    });
  });

  it("`mcp serve` resolves in the router (not an unknown command)", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        // No stored credential → the auth error path, NOT the router's
        // exit-2 unknown-command path.
        const r = await runArgv(["mcp", "serve"]);
        expect(r.exitCode).not.toBe(2);
        expect(cap.stderr.join("\n")).not.toMatch(/unknown command/);
      },
      { storedCred: null },
    );
  });

  it("`--help` mentions the mcp command group", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["--help"]);
      expect(r.exitCode).toBe(0);
      expect(cap.stdout.join("\n")).toContain("mcp serve");
      expect(cap.stdout.join("\n")).toContain("mcp tools");
    });
  });
});

describe("mcp tools", () => {
  it("prints every registered tool (25: 19 reads + 6 writes) as a human table with markers", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["mcp", "tools"]);
      expect(r.exitCode).toBe(0);
      const text = cap.stdout.join("\n");
      expect(allTools.length).toBe(25);
      expect(text).toContain(`MCP tools (${allTools.length})`);
      for (const tool of allTools) {
        expect(text).toContain(tool.name);
      }
      // The read-only column marks reads "yes" and the MCP5 writes "no".
      expect(text).toContain("read-only");
      expect(text).toContain("yes");
      expect(text).toContain("no");
      expect(text).toContain("project_create");
    });
  });

  it("`--output=json` emits the full roster with read-only markers per tool", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["mcp", "tools", "--output=json"]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(cap.stdout.join("\n")) as {
        tools: { name: string; title: string; description: string; readOnly: boolean }[];
      };
      expect(parsed.tools.map((t) => t.name).sort()).toEqual(
        allTools.map((t) => t.name).sort(),
      );
      for (const tool of parsed.tools) {
        const registered = allTools.find((t) => t.name === tool.name);
        expect(tool.readOnly).toBe(registered?.annotations.readOnlyHint === true);
        expect(tool.title.length).toBeGreaterThan(0);
        expect(tool.description.length).toBeGreaterThan(0);
      }
      expect(parsed.tools.filter((t) => !t.readOnly).map((t) => t.name).sort()).toEqual(
        [
          "environment_create",
          "flag_set",
          "member_invite",
          "project_create",
          "webhook_create",
          "webhook_delivery_replay",
        ],
      );
    });
  });

  it("`--read-only` filters the MCP5 write tools out (19 reads remain)", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["mcp", "tools", "--read-only", "--output=json"]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(cap.stdout.join("\n")) as {
        tools: { name: string; readOnly: boolean }[];
      };
      expect(parsed.tools.length).toBe(19);
      expect(parsed.tools.length).toBe(readOnlyTools.length);
      for (const tool of parsed.tools) {
        expect(tool.readOnly, tool.name).toBe(true);
      }
    });
  });
});

describe("mcp serve — auth missing", () => {
  it("exits non-zero with the login pointer on stderr, stdout untouched", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["mcp", "serve"]);
        expect(r.exitCode).toBe(3);
        expect(cap.stderr.join("\n")).toContain("orun-cloud login");
        // Stdout purity: nothing may be written to the protocol channel.
        expect(cap.stdout).toEqual([]);
      },
      { storedCred: null },
    );
  });
});

describe("mcp serve — workspace default precedence", () => {
  function fakeCtx(
    flags: Record<string, string | boolean>,
    contextStore: ContextStore,
  ): CommandContext {
    return { flags, contextStore } as unknown as CommandContext;
  }

  it("`--workspace` flag wins over the active context org", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-mcp-ws-"));
    try {
      const contextStore = new ContextStore({ configDir: dir });
      await contextStore.setActiveOrg("org_ctx");
      const resolved = await resolveWorkspaceDefault(
        fakeCtx({ workspace: "ws_flag" }, contextStore),
      );
      expect(resolved).toBe("ws_flag");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the active org from the context store", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-mcp-ws-"));
    try {
      const contextStore = new ContextStore({ configDir: dir });
      await contextStore.setActiveOrg("org_ctx");
      const resolved = await resolveWorkspaceDefault(fakeCtx({}, contextStore));
      expect(resolved).toBe("org_ctx");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves to no default when neither flag nor context is set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-mcp-ws-"));
    try {
      const contextStore = new ContextStore({ configDir: dir });
      const resolved = await resolveWorkspaceDefault(fakeCtx({}, contextStore));
      expect(resolved).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("mcp serve — startup entitlement check (MCP6, design §8)", () => {
  function billingSdk(rows: unknown[] | Error) {
    const calls: string[] = [];
    const sdk = {
      billing: {
        getEntitlements: (org: string) => {
          calls.push(org);
          return rows instanceof Error
            ? Promise.reject(rows)
            : Promise.resolve({ entitlements: rows });
        },
      },
    } as unknown as import("@saas/sdk").OrunCloud;
    return { sdk, calls };
  }

  const mcpRow = (enabled: boolean) => ({
    entitlementKey: "feature.mcp_server",
    enabled,
  });

  it("no resolvable workspace: proceeds without any billing read (per-call tenancy)", async () => {
    const { sdk, calls } = billingSdk([mcpRow(false)]);
    const stderr: string[] = [];
    await expect(
      assertServeEntitlement(sdk, undefined, (l) => stderr.push(l)),
    ).resolves.toBe(true);
    expect(calls).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("granted: proceeds silently", async () => {
    const { sdk, calls } = billingSdk([mcpRow(true)]);
    const stderr: string[] = [];
    await expect(
      assertServeEntitlement(sdk, "org_1", (l) => stderr.push(l)),
    ).resolves.toBe(true);
    expect(calls).toEqual(["org_1"]);
    expect(stderr).toEqual([]);
  });

  it("no feature.mcp_server row: proceeds (D3 open-gate default)", async () => {
    const { sdk } = billingSdk([]);
    const stderr: string[] = [];
    await expect(
      assertServeEntitlement(sdk, "org_1", (l) => stderr.push(l)),
    ).resolves.toBe(true);
    expect(stderr).toEqual([]);
  });

  it("denied: hard fail with a clear upgrade-shaped stderr message, no server", async () => {
    const { sdk } = billingSdk([mcpRow(false)]);
    const stderr: string[] = [];
    await expect(
      assertServeEntitlement(sdk, "org_1", (l) => stderr.push(l)),
    ).resolves.toBe(false);
    const text = stderr.join("\n");
    expect(text).toContain("error:");
    expect(text).toContain("not available on the current plan");
    expect(text).toContain("feature.mcp_server");
    expect(text).toContain("org_1");
  });

  it("a failed entitlements read fails OPEN with a warning (a billing outage must not break agents)", async () => {
    const { sdk } = billingSdk(new Error("billing unreachable"));
    const stderr: string[] = [];
    await expect(
      assertServeEntitlement(sdk, "org_1", (l) => stderr.push(l)),
    ).resolves.toBe(true);
    expect(stderr.join("\n")).toContain("warning:");
    expect(stderr.join("\n")).toContain("feature.mcp_server");
  });
});
