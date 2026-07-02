---
title: Workspaces & accounts
description: The workspace tenancy model — ids, slugs, accounts as parent organizations, and the workspace lifecycle.
---

A **workspace** is the tenant boundary in Orun Cloud: members, roles, projects, config, audit, usage, and billing all hang off one. The API canonically calls this resource an **organization** — `/v1/organizations/…` — and `/v1/workspaces/*` is an accepted alias that rewrites to the same handlers, so the two spellings return identical results (the alias additionally mirrors every `orgId` as `workspaceId` in responses).

Your first workspace is created automatically on first login; you never start in an empty account.

## Three ways to reference a workspace

Every workspace carries three references, and **all three are accepted interchangeably in URL paths** — the edge resolves the segment to the canonical id before routing:

| Reference | Example | Properties |
|---|---|---|
| Canonical id | `org_1a2b3c4d5e6f70819203a4b5c6d7e8f9` | Opaque primary key; what the API returns as `id` |
| Workspace ID | `ws_a1b2c3d4` | Immutable public ref (`workspaceRef`) — safe to commit, quote, automate |
| Slug | `acme` | Mutable vanity label — human-friendly, can be renamed |

```bash
# These are the same request:
curl https://api.orun.dev/v1/organizations/org_1a2b3c4d5e6f70819203a4b5c6d7e8f9 -H "Authorization: Bearer $TOKEN"
curl https://api.orun.dev/v1/organizations/ws_a1b2c3d4 -H "Authorization: Bearer $TOKEN"
curl https://api.orun.dev/v1/organizations/acme -H "Authorization: Bearer $TOKEN"
```

An unresolvable `ws_…` or slug segment returns `404 not_found` at the edge. In scripts and CI, prefer the `ws_…` Workspace ID — a slug rename will never break it.

:::tip
Use `workspaceRef` (`ws_…`) anywhere a reference outlives the current session: intent files, pipeline variables, runbooks.
:::

## Create a workspace

`POST /v1/organizations` with a `name` (1–100 chars) and optional `slug` (2–63 chars, lowercase alphanumeric + hyphens). Omitting `slug` derives one from the name. The creator becomes the workspace's `owner`, and the free plan is assigned at bootstrap.

```bash
curl -X POST https://api.orun.dev/v1/organizations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 3f2a9d1e-create-acme" \
  -d '{"name": "Acme", "slug": "acme"}'
```

```json
{
  "data": {
    "organization": { "id": "org_1a2b3c4d5e6f70819203a4b5c6d7e8f9", "name": "Acme", "slug": "acme", "createdAt": "2026-07-02T12:00:00.000Z" },
    "membership": { "role": "owner", "joinedAt": "2026-07-02T12:00:00.000Z" }
  },
  "meta": { "requestId": "req_8c9d0e1f2a3b", "cursor": null }
}
```

```ts
const { organization } = await client.workspaces.create({ name: "Acme", slug: "acme" });
// client.organizations.create(...) is the same call under the legacy name
```

A duplicate slug returns `409 conflict`. Creating an **additional** workspace (beyond your first) is gated by the account's plan: it requires `feature.multi_org` and headroom under `limit.organizations` on the billing parent, otherwise `412 precondition_failed` with a `reason` in `details`. An allowed additional workspace is created as a **child of your account** and inherits the parent's plan entitlements (fan-out).

## List and get workspaces

```bash
curl "https://api.orun.dev/v1/organizations?limit=20" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "data": {
    "organizations": [
      {
        "id": "org_1a2b3c4d5e6f70819203a4b5c6d7e8f9",
        "name": "Acme",
        "slug": "acme",
        "workspaceRef": "ws_a1b2c3d4",
        "accountId": "ws_a1b2c3d4",
        "kind": "account",
        "isAccountRoot": true,
        "status": "active",
        "createdAt": "2026-07-02T12:00:00.000Z"
      }
    ]
  },
  "meta": { "requestId": "req_9d0e1f2a3b4c", "cursor": null }
}
```

The list is cursor-paginated; iterate until `meta.cursor` is `null`. `GET /v1/organizations/{ref}` returns a single workspace (any of the three reference spellings).

```ts
const { organizations } = await client.workspaces.list();
const { organization } = await client.workspaces.get("ws_a1b2c3d4");
```

## Accounts: the parent of your workspaces

An **account** is a parent organization — the AWS-account analog that owns a family of workspaces. Every workspace's `accountId` names its account's Workspace ID; for an account root, `accountId` equals its own `workspaceRef` (and `kind` is `account`).

What the account level gives you:

- **Child workspaces** — `GET /v1/organizations/{accountId}/workspaces` lists the workspaces under an account (requires `organization.member.list` on the account):

  ```json
  { "data": { "workspaces": [{ "orgId": "org_…", "workspaceRef": "ws_e5f6a7b8", "name": "Acme Staging" }] }, "meta": { "requestId": "req_0e1f2a3b4c5d", "cursor": null } }
  ```

  ```ts
  const { workspaces } = await client.organizations.listWorkspaces(accountId);
  ```

- **Account roles that cascade** — `account_owner`, `account_admin`, and `account_billing_admin` are granted once, on the account (`POST /v1/organizations/{accountId}/account-roles` with `subjectId` and `role`), and cascade to authority on **every** workspace under it — no per-workspace role rows. Granting requires member-management authority on the account itself; a workspace-only admin holds no role on the account and is denied.

- **Billing fan-out** — the account root is the billing entity. Its plan's entitlements fan out to child workspaces on creation and re-fan-out when the parent's plan changes (an upgrade lifts every child; a downgrade can freeze children over the new limits — surfaced as workspace `status`).

:::note
Accounts are a structural layer over the same organization resource — there is no separate account API object. A standalone workspace is simply its own account root.
:::

## Related

- [Members & invitations](/platform/workspaces/members-and-invitations)
- [Teams](/platform/workspaces/teams)
- [Access control (RBAC)](/platform/access-control/rbac)
- [Plans & entitlements](/platform/billing/plans-and-entitlements)
