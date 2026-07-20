// chat-worker's REAL authorize (regression for the "Not authorized" bug).
// The router suite stubs ChatDeps.authorize, so it never exercised the
// production buildDeps() path — which shipped broken: it hand-rolled a
// {orgId,action,subjectId,subjectType} body and read data.allowed, but the
// policy-worker requires {subject, action, resource, context:{memberships}}
// and answers data.allow, AND the caller must fetch the memberships. The
// mismatch 400'd every request → deny-by-default → "Not authorized" on every
// chat + /dispatch/index route. These tests pin the real contract.

import { buildDeps } from "@chat-worker/router";
import type { Env } from "@chat-worker/env";

const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2";
const ACTOR = { subjectId: "usr_abc", subjectType: "user" };

interface Captured {
  membership: Array<{ url: string; body: any }>;
  policy: Array<{ url: string; body: any }>;
}

function fakeEnv(opts: {
  memberships?: unknown;
  membershipOk?: boolean;
  allow?: boolean;
  policyOk?: boolean;
  bindMembership?: boolean;
  bindPolicy?: boolean;
}): { env: Env; cap: Captured } {
  const cap: Captured = { membership: [], policy: [] };
  const membershipWorker = {
    fetch(url: string, init?: RequestInit): Promise<Response> {
      cap.membership.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      if (opts.membershipOk === false) return Promise.resolve(new Response("no", { status: 403 }));
      return Promise.resolve(
        Response.json({ data: { memberships: opts.memberships ?? [] }, meta: { requestId: "r", cursor: null } }),
      );
    },
  } as unknown as Fetcher;
  const policyWorker = {
    fetch(url: string, init?: RequestInit): Promise<Response> {
      cap.policy.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      if (opts.policyOk === false) return Promise.resolve(new Response("bad", { status: 400 }));
      return Promise.resolve(
        Response.json({ data: { allow: opts.allow ?? false }, meta: { requestId: "r", cursor: null } }),
      );
    },
  } as unknown as Fetcher;
  const env = {
    ENVIRONMENT: "test",
    ...(opts.bindMembership === false ? {} : { MEMBERSHIP_WORKER: membershipWorker }),
    ...(opts.bindPolicy === false ? {} : { POLICY_WORKER: policyWorker }),
  } as Env;
  return { env, cap };
}

const MEMBERSHIPS = [
  { subject: { type: "user", id: "usr_abc" }, scope: { kind: "organization", orgId: ORG_UUID }, role: "owner" },
];

describe("chat-worker buildDeps().authorize (regression)", () => {
  it("fetches memberships, then sends the REAL policy contract and reads data.allow", async () => {
    const { env, cap } = fakeEnv({ memberships: MEMBERSHIPS, allow: true });
    const ok = await buildDeps(env).authorize("organization.agent.chat", ORG_UUID, ACTOR, "req_1");
    expect(ok).toBe(true);

    // 1. Memberships fetched for this subject + org.
    expect(cap.membership).toHaveLength(1);
    expect(cap.membership[0]!.url).toContain("/v1/internal/membership/authorization-context");
    expect(cap.membership[0]!.body).toEqual({ subject: { type: "user", id: "usr_abc" }, orgId: ORG_UUID });

    // 2. The policy body is the SHARED shape — subject object, resource, and
    //    the fetched memberships in context (the bug sent none of these).
    expect(cap.policy).toHaveLength(1);
    const body = cap.policy[0]!.body;
    expect(body.subject).toEqual({ type: "user", id: "usr_abc" });
    expect(body.action).toBe("organization.agent.chat");
    expect(body.resource).toEqual({ kind: "organization", orgId: ORG_UUID });
    expect(body.context.memberships).toEqual(MEMBERSHIPS);
    // The broken fields must NOT be present.
    expect("orgId" in body).toBe(false);
    expect("subjectId" in body).toBe(false);
  });

  it("returns the policy decision (deny path reads data.allow: false)", async () => {
    const { env } = fakeEnv({ memberships: MEMBERSHIPS, allow: false });
    expect(await buildDeps(env).authorize("organization.agent.chat", ORG_UUID, ACTOR, "r")).toBe(false);
  });

  it("denies (never throws) when memberships cannot be fetched — and never calls policy", async () => {
    const { env, cap } = fakeEnv({ membershipOk: false, allow: true });
    expect(await buildDeps(env).authorize("organization.agent.chat", ORG_UUID, ACTOR, "r")).toBe(false);
    expect(cap.policy).toHaveLength(0);
  });

  it("denies when the policy-worker rejects the body (the old 400 path)", async () => {
    const { env } = fakeEnv({ memberships: MEMBERSHIPS, policyOk: false });
    expect(await buildDeps(env).authorize("organization.agent.chat", ORG_UUID, ACTOR, "r")).toBe(false);
  });

  it("denies when either binding is missing (unprivileged-but-complete authz seam)", async () => {
    const noMembership = fakeEnv({ bindMembership: false, allow: true });
    expect(await buildDeps(noMembership.env).authorize("organization.agent.chat", ORG_UUID, ACTOR, "r")).toBe(false);
    const noPolicy = fakeEnv({ bindPolicy: false, memberships: MEMBERSHIPS, allow: true });
    expect(await buildDeps(noPolicy.env).authorize("organization.agent.chat", ORG_UUID, ACTOR, "r")).toBe(false);
  });
});
