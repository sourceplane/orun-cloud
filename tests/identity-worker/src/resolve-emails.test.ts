/// <reference types="@cloudflare/workers-types" />
import { handleResolveEmails } from "../../../apps/identity-worker/src/handlers/resolve-emails";
import type { Env } from "../../../apps/identity-worker/src/env";
import type { IdentityRepository, User } from "@saas/db/identity";

function makeEnv(): Env {
  return { ENVIRONMENT: "test", DEBUG_DELIVERY: "false", PLATFORM_DB: {} as Hyperdrive } as unknown as Env;
}

function user(id: string, email: string, status = "active"): User {
  return {
    id,
    email,
    emailLower: email.toLowerCase(),
    displayName: null,
    lastOrgSlug: null,
    status,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function repoWith(users: User[]): IdentityRepository {
  return {
    async listUsersByIds(ids: string[]) {
      const wanted = new Set(ids);
      return { ok: true as const, value: users.filter((u) => wanted.has(u.id) && u.status === "active") };
    },
  } as unknown as IdentityRepository;
}

function req(body: unknown): Request {
  return new Request("http://identity-worker/v1/internal/identity/resolve-emails", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("resolve-emails handler (TC1)", () => {
  it("maps subject ids to emails, omitting unknown ids", async () => {
    const res = await handleResolveEmails(req({ subjectIds: ["usr_a", "usr_b", "usr_missing"] }), makeEnv(), "r1", {
      repo: repoWith([user("usr_a", "a@x.com"), user("usr_b", "b@x.com")]),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { users: Array<{ subjectId: string; email: string }> } };
    expect(body.data.users).toHaveLength(2);
    const byId = new Map(body.data.users.map((u) => [u.subjectId, u.email]));
    expect(byId.get("usr_a")).toBe("a@x.com");
    expect(byId.get("usr_b")).toBe("b@x.com");
  });

  it("returns an empty list for an empty request", async () => {
    const res = await handleResolveEmails(req({ subjectIds: [] }), makeEnv(), "r2", { repo: repoWith([]) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { users: unknown[] } };
    expect(body.data.users).toHaveLength(0);
  });

  it("422s when subjectIds is not an array of strings", async () => {
    const res = await handleResolveEmails(req({ subjectIds: [123] }), makeEnv(), "r3", { repo: repoWith([]) });
    expect(res.status).toBe(422);
  });

  it("422s when the batch exceeds the cap", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `usr_${i}`);
    const res = await handleResolveEmails(req({ subjectIds: ids }), makeEnv(), "r4", { repo: repoWith([]) });
    expect(res.status).toBe(422);
  });
});
