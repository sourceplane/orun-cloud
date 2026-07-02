---
title: Members & invitations
description: List and manage workspace members, send and revoke invitations, and accept invitations by token or from the signed-in recipient's inbox.
---

**Members** are the users and service principals with roles in a workspace; **invitations** are how new members join — an admin invites an email address with a role, and the recipient accepts either with the one-time token or, after signing in, straight from `GET /v1/me/invitations`. For the model and role semantics, see [Members & invitations](/platform/workspaces/members-and-invitations).

## Endpoints

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/v1/organizations/{orgId}/members` | `organization.member.list` | List members with their role assignments |
| `PATCH` | `/v1/organizations/{orgId}/members/{memberId}` | `organization.member.update_role` | Change a member's workspace role |
| `DELETE` | `/v1/organizations/{orgId}/members/{memberId}` | `organization.member.remove` | Remove a member |
| `GET` | `/v1/organizations/{orgId}/invitations` | `organization.invitation.list` | List invitations |
| `POST` | `/v1/organizations/{orgId}/invitations` | `organization.invitation.create` | Invite an email address with a role |
| `DELETE` | `/v1/organizations/{orgId}/invitations/{invitationId}` | `organization.invitation.revoke` | Revoke a pending invitation |
| `POST` | `/v1/organizations/{orgId}/invitations/accept` | authenticated recipient + token | Accept an invitation with its one-time token |
| `GET` | `/v1/me/invitations` | authenticated user | The signed-in user's pending invitations |
| `POST` | `/v1/me/invitations/{invitationId}/accept` | authenticated user (email match) | Accept without a token, authorized on the verified email |

Member ids are `mem_…`; invitation ids are `inv_…`. Invitation roles are the workspace roles: `owner`, `admin`, `builder`, `viewer`, `billing_admin`.

## Invite a member

```bash
curl -X POST "https://api.orun.dev/v1/organizations/org_1f6a3c9e/invitations" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: invite-dana-builder-01" \
  -d '{ "email": "dana@example.com", "role": "builder" }'
```

```json
{
  "data": {
    "invitation": {
      "id": "inv_5d4c3b2a",
      "email": "dana@example.com",
      "role": "builder",
      "status": "pending",
      "invitedBy": "usr_9f8e7d6c",
      "expiresAt": "2026-07-09T09:15:00.000Z",
      "createdAt": "2026-07-02T09:15:00.000Z",
      "acceptedAt": null,
      "revokedAt": null
    }
  },
  "meta": { "requestId": "req_3c4d5e6f7a8b", "cursor": null }
}
```

:::note
In local development the create response additionally carries `delivery: { "mode": "local_debug", "token": "…" }` so the flow can be exercised without email delivery. In production the token travels only in the invitation email.
:::

Revoke a pending invitation with `DELETE /v1/organizations/{orgId}/invitations/{invitationId}` — the response returns the invitation with `status` and `revokedAt` updated.

## Accept as the recipient

A signed-in recipient can discover and accept pending invitations without handling the token:

```bash
curl "https://api.orun.dev/v1/me/invitations" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "invitations": [
      {
        "id": "inv_5d4c3b2a",
        "org": {
          "id": "org_1f6a3c9e",
          "name": "Acme",
          "slug": "acme",
          "workspaceRef": "ws_a1b2c3d4",
          "status": "active"
        },
        "email": "dana@example.com",
        "role": "builder",
        "invitedBy": "usr_9f8e7d6c",
        "expiresAt": "2026-07-09T09:15:00.000Z",
        "createdAt": "2026-07-02T09:15:00.000Z"
      }
    ]
  },
  "meta": { "requestId": "req_4d5e6f7a8b9c", "cursor": null }
}
```

Only still-actionable invitations are returned (pending — not revoked, accepted, or expired). Then:

```bash
curl -X POST "https://api.orun.dev/v1/me/invitations/inv_5d4c3b2a/accept" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

The response carries the accepted `invitation` plus the new `membership` (`id`, `role`, `joinedAt`, `status`). With a one-time token instead (e.g. from the email link), use `POST /v1/organizations/{orgId}/invitations/accept` with body `{ "token": "…" }`.

## Manage members with the SDK

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

const { members } = await client.memberships.listMembers("org_1f6a3c9e");

// Promote, then remove, a member.
await client.memberships.updateMemberRole("org_1f6a3c9e", "mem_8a7b6c5d", {
  role: "admin",
});
await client.memberships.removeMember("org_1f6a3c9e", "mem_8a7b6c5d");
```

Each member in the list carries `subjectType`, `subjectId`, `status`, `joinedAt`, and a `roles` array of `{ role, scopeKind }` assignments.

## Related

- [Members & invitations](/platform/workspaces/members-and-invitations)
- [RBAC](/platform/access-control/rbac)
- [Teams API](/api/resources/teams)
- [Workspaces API](/api/resources/organizations)
