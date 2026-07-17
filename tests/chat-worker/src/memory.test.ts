// AN6 (saas-agents-native): the memory plane — provenanced writes through
// the VISIBLE tool only, brief assembly folding entries into the system
// context (a remembered fact demonstrably shapes later turns; a deleted one
// stops), and honest failure.

import { formatMemoryForSystem, withMemoryTool, type MemoryEntry, type MemoryRpc } from "@chat-worker/memory";
import type { ToolExecutor } from "@chat-worker/chat-thread";

function fakeMemory(seed: MemoryEntry[] = []): MemoryRpc & { entries: MemoryEntry[] } {
  const entries = [...seed];
  let n = 0;
  return {
    entries,
    async remember(e) {
      const full = { id: `mem_${++n}`, ...e };
      entries.push(full);
      return full;
    },
    async listEntries() {
      return [...entries];
    },
    async updateEntry(id, content) {
      const e = entries.find((x) => x.id === id);
      if (!e) return null;
      e.content = content;
      return e;
    },
    async deleteEntry(id) {
      const i = entries.findIndex((x) => x.id === id);
      if (i < 0) return false;
      entries.splice(i, 1);
      return true;
    },
  };
}

const base: ToolExecutor = {
  specs: () => [{ name: "runs_list", description: "d", inputSchema: {} }],
  execute: async () => ({ summary: "base", data: {} }),
};

describe("AN6: brief assembly", () => {
  it("a remembered fact shapes the system context; deleting it removes it", async () => {
    const mem = fakeMemory();
    await mem.remember({ content: "staging deploys need EU region", source: "chat:ch_1", author: "usr_rahul", createdAt: "2026-07-17T00:00:00Z" });

    const withEntry = formatMemoryForSystem(await mem.listEntries());
    expect(withEntry).toContain("staging deploys need EU region");
    expect(withEntry).toContain("usr_rahul");

    await mem.deleteEntry(mem.entries[0]!.id);
    expect(formatMemoryForSystem(await mem.listEntries())).toBe("");
  });

  it("caps the fold so hoarded memory cannot crowd the prompt", () => {
    const entries: MemoryEntry[] = Array.from({ length: 100 }, (_, i) => ({
      id: `mem_${i}`,
      content: `fact ${i}`,
      source: "chat:ch_1",
      author: "u",
      createdAt: "2026-07-17T00:00:00Z",
    }));
    const folded = formatMemoryForSystem(entries, 50);
    expect(folded).toContain("fact 49");
    expect(folded).not.toContain("fact 50");
  });
});

describe("AN6: the visible remember tool", () => {
  const ctx = { author: "usr_rahul", source: "chat:ch_7", now: () => new Date("2026-07-17T09:00:00Z") };

  it("writes a provenanced entry and confirms visibly", async () => {
    const mem = fakeMemory();
    const tools = withMemoryTool(base, mem, ctx);
    expect(tools.specs().map((s) => s.name)).toContain("memory_remember");

    const r = await tools.execute("memory_remember", { content: "ORN releases want a changelog entry" });
    expect(r.isError).toBeUndefined();
    expect(r.summary).toBe("remembered: ORN releases want a changelog entry");
    expect(mem.entries[0]).toMatchObject({
      content: "ORN releases want a changelog entry",
      source: "chat:ch_7",
      author: "usr_rahul",
      createdAt: "2026-07-17T09:00:00.000Z",
    });
  });

  it("refuses empty content and reports write failures honestly", async () => {
    const failing: MemoryRpc = {
      ...fakeMemory(),
      remember: async () => {
        throw new Error("storage down");
      },
    };
    const tools = withMemoryTool(base, failing, ctx);
    expect((await tools.execute("memory_remember", { content: "  " })).isError).toBe(true);
    const r = await tools.execute("memory_remember", { content: "x" });
    expect(r.isError).toBe(true);
    expect(r.summary).toContain("storage down");
  });

  it("passes every other tool through to the base executor", async () => {
    const tools = withMemoryTool(base, fakeMemory(), ctx);
    expect((await tools.execute("runs_list", {})).summary).toBe("base");
  });
});
