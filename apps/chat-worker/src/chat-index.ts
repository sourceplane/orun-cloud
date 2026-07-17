// ChatIndex — the per-workspace thread registry (saas-agents-native AN4),
// one SQLite DO per workspace (`ws:<orgId>`). Just a list: id, title,
// timestamps. The threads themselves live in their own WorkspaceAgent DOs;
// this exists so the console has a thread list without a control-plane DB
// (the chat-worker stays unprivileged).

import { Agent } from "agents";
import type { Env } from "./env.js";

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  lastAt: string;
}

export class ChatIndex extends Agent<Env> {
  static override options = { hibernate: true, sendIdentityOnConnect: false };

  async register(chat: ChatSummary): Promise<void> {
    this.ensureTable();
    this.sql`INSERT OR REPLACE INTO chats (id, title, created_at, last_at)
             VALUES (${chat.id}, ${chat.title}, ${chat.createdAt}, ${chat.lastAt})`;
  }

  async touch(chatId: string, lastAt: string): Promise<void> {
    this.ensureTable();
    this.sql`UPDATE chats SET last_at = ${lastAt} WHERE id = ${chatId}`;
  }

  async removeChat(chatId: string): Promise<void> {
    this.ensureTable();
    this.sql`DELETE FROM chats WHERE id = ${chatId}`;
  }

  async listChats(): Promise<ChatSummary[]> {
    this.ensureTable();
    const rows = this.sql<{ id: string; title: string; created_at: string; last_at: string }>`
      SELECT id, title, created_at, last_at FROM chats ORDER BY last_at DESC LIMIT 200`;
    return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, lastAt: r.last_at }));
  }

  override async onStart(): Promise<void> {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.sql`CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_at TEXT NOT NULL
    )`;
  }
}
