// WorkspaceMemory — the per-workspace memory DO (saas-agents-native AN6),
// one SQLite instance per workspace (`wsmem:<orgId>`). Provenanced entries
// only; no hidden writes (every write comes from the visible tool or the
// console page, both deny-by-default authorized upstream).

import { Agent } from "agents";
import type { Env } from "./env.js";
import type { MemoryEntry } from "./memory.js";

export class WorkspaceMemory extends Agent<Env> {
  static override options = { hibernate: true, sendIdentityOnConnect: false };

  async remember(entry: { content: string; source: string; author: string; createdAt: string }): Promise<MemoryEntry> {
    this.ensureTable();
    const id = `mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    this.sql`INSERT INTO memory (id, content, source, author, created_at)
             VALUES (${id}, ${entry.content}, ${entry.source}, ${entry.author}, ${entry.createdAt})`;
    return { id, ...entry };
  }

  async listEntries(): Promise<MemoryEntry[]> {
    this.ensureTable();
    const rows = this.sql<{ id: string; content: string; source: string; author: string; created_at: string }>`
      SELECT id, content, source, author, created_at FROM memory ORDER BY created_at DESC LIMIT 500`;
    return rows.map((r) => ({ id: r.id, content: r.content, source: r.source, author: r.author, createdAt: r.created_at }));
  }

  async updateEntry(id: string, content: string): Promise<MemoryEntry | null> {
    this.ensureTable();
    this.sql`UPDATE memory SET content = ${content} WHERE id = ${id}`;
    const rows = this.sql<{ id: string; content: string; source: string; author: string; created_at: string }>`
      SELECT id, content, source, author, created_at FROM memory WHERE id = ${id}`;
    const r = rows[0];
    return r ? { id: r.id, content: r.content, source: r.source, author: r.author, createdAt: r.created_at } : null;
  }

  async deleteEntry(id: string): Promise<boolean> {
    this.ensureTable();
    const before = this.sql<{ n: number }>`SELECT COUNT(*) as n FROM memory WHERE id = ${id}`[0]?.n ?? 0;
    this.sql`DELETE FROM memory WHERE id = ${id}`;
    return before > 0;
  }

  private ensureTable(): void {
    this.sql`CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
  }
}
