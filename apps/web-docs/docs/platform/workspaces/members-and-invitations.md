---
title: Members & invitations
description: Managing workspace members, the tokenless invitation lifecycle, and the effective-access endpoint.
---

A **member** is a subject (user or service principal) joined to a workspace with one or more role assignments. Humans join through **invitations** — email-addressed, role-carrying offers that the recipient discovers and accepts from their own signed-in session. Service principals join implicitly when an [API key](/platform/identity/api-keys) is created.

All endpoints below live under `/v1/organizations/{orgId}/…` (any workspace reference spelling works) and are deny-by-default: the listed permission must resolve to allow for the calling actor.

## Manage members

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/v1/organizations/{orgId}/members` | `organization.member.list` | List members with their role assignments |
| `PATCH` | `/v1/organizations/{orgId}/members/{memberId}` | `organization.member.update_role` | Change a member's workspace role |
| `DELETE` | `/v1/organizations/{orgId}/members/{memberId}` | `organization.member.remove` | Remove a member |

```bash
curl https://api.orun.dev/v1/organizations/ws_a1b2c3d4/members \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "data": {
    "members": [
      {
        "id": "mem_5e4d3c2b1a09f8e7d6c5b4a392817065",
        "subjectType": "user",
        "subjectId": "usr_7a6b5c4d3e2f10099887766554433221",
        "status": "active",
        "joinedAt": "2026-07-02T12:00:00.000Z",
        "roles": [{ "role": "owner", "scopeKind": "organization" }]
      }
    ]
  },
  "meta": { "requestId": "req_1f2a3b4c5d6e", "cursor": null }
}
```

```ts
const { members } = await client.memberships.listMembers(orgId);
await client.memberships.updateMemberRole(orgId, memberId, { role: "admin" });
await client.memberships.removeMember(orgId, memberId);
```

Workspace roles are `owner`, `admin`, `builder`, `viewer`, `billing_admin`; see [RBAC](/platform/access-control/rbac) for what each grants.

## Invite someone

`POST /v1/organizations/{orgId}/invitations` — permission `organization.invitation.create`. The invitation carries the role the recipient will receive on acceptance and expires after 7 days.

```bash
curl -X POST https://api.orun.dev/v1/organizations/ws_a1b2c3d4/invitations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "sam@example.com", "role": "builder"}'
```

```json
{
  "data": {
    "invitation": {
      "id": "inv_2b1a09f8e7d6c5b4a3928170654e3d2c",
      "email": "sam@example.com",
      "role": "builder",
      "status": "pending",
      "invitedBy": "usr_7a6b5c4d3e2f10099887766554433221",
      "expiresAt": "2026-07-09T12:00:00.000Z",
      "createdAt": "2026-07-02T12:00:00.000Z",
      "acceptedAt": null,
      "revokedAt": null
    }
  },
  "meta": { "requestId": "req_2a3b4c5d6e7f", "cursor": null }
}
```

The recipient gets an email in the `invitation` notification category. Seats are plan-gated: the billable count is *active members + pending invitations* against `limit.members`, and an over-limit invite returns `412 precondition_failed` — pending invitations occupy seats until they are accepted, expire, or are revoked.

:::note Security property: no token in the email
The invitation email deliberately carries **no secret link or token** — nothing in the recipient's inbox can join a workspace on its own. Instead, the recipient signs in and accepts from their session, and the platform matches the invitation to the session's **verified email**. Proof of email control comes from authentication, not from possessing a forwardable link.
:::

Manage outstanding invitations from the workspace side:

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/v1/organizations/{orgId}/invitations` | `organization.invitation.list` | List invitations (status: `pending`, `accepted`, `revoked`, `expired`) |
| `DELETE` | `/v1/organizations/{orgId}/invitations/{invitationId}` | `organization.invitation.revoke` | Revoke a pending invitation |

## Accept an invitation (recipient side)

After signing in, the recipient discovers invitations addressed to their verified email and accepts by id — no token required:

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/me/invitations` | Pending invitations for the signed-in user's email, with workspace display fields |
| `POST` | `/v1/me/invitations/{invitationId}/accept` | Accept; creates the membership with the attached role |

```bash
curl https://api.orun.dev/v1/me/invitations -H "Authorization: Bearer $TOKEN"
curl -X POST https://api.orun.dev/v1/me/invitations/inv_2b1a09f8…/accept \
  -H "Authorization: Bearer $TOKEN"
```

```ts
const { invitations } = await client.memberships.listMyInvitations();
// each: { id, org: { id, name, slug, workspaceRef, status }, email, role, invitedBy, expiresAt, createdAt }
const accepted = await client.memberships.acceptMyInvitation(invitations[0].id);
// → { invitation, membership: { id, role, joinedAt, status } }
```

Acceptance is keyed on the invitation's email matching the actor's verified session email — a signed-in user cannot accept an invitation sent to someone else.

A workspace-side accept endpoint also exists — `POST /v1/organizations/{orgId}/invitations/accept` with a one-time `token` in the body (`client.memberships.acceptInvitation`). The raw token is only surfaced through debug delivery in development environments; the production email flow is the tokenless path above.

Accepting emits an `invite.accepted` event to the workspace [audit log](/platform/audit/audit-log) and a best-effort `invitation` notification.

## Check effective access

`GET /v1/organizations/{orgId}/effective-access` answers "what can this subject do here, and via which grant". It defaults to the calling actor; pass `subjectId` to inspect someone else (requires `organization.member.list`) and `projectId` to narrow the scope.

```bash
curl "https://api.orun.dev/v1/organizations/ws_a1b2c3d4/effective-access" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "data": {
    "permissions": [
      { "action": "project.create", "allow": true, "reason": "role builder grants project.create", "via": { "kind": "direct" } },
      { "action": "audit.read", "allow": true, "reason": "role admin grants audit.read", "via": { "kind": "team", "teamId": "team_3c2b1a09f8e7d6c5b4a3928170654e3d" } }
    ]
  },
  "meta": { "requestId": "req_3b4c5d6e7f8a", "cursor": null }
}
```

```ts
const { permissions } = await client.teams.effectiveAccess(orgId, { subjectId: "usr_…" });
```

The `via` provenance (`direct`, `team` with the granting team's id, or `account_cascade`) makes union-over-teams and account-role cascade explainable at a glance.

## Related

- [Workspaces & accounts](/platform/workspaces/organizations)
- [Teams](/platform/workspaces/teams)
- [Access control (RBAC)](/platform/access-control/rbac)
- [Email notifications](/platform/notifications/email)
