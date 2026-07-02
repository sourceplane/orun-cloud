---
title: Notifications
description: Read and update your own email notification preferences.
---

The **notifications API** exposes exactly one public surface: the authenticated caller's own notification **preferences**. Orun Cloud sends transactional email in five categories; each can be toggled per workspace. Delivery itself (templates, statuses, suppression) is internal — see [Email notifications](/platform/notifications/email) for the model.

The subject is **pinned to the caller**: whatever `subjectKind`/`subjectId` you supply is replaced with `user` and your own id at the edge, so a user can only ever read or update their own preferences. Workspace-level defaults are managed internally and have no public route. No permission beyond authentication is required.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/notifications/preferences` | Read the caller's preferences for a workspace |
| `PUT` | `/v1/notifications/preferences` | Upsert the caller's preferences for a workspace |

## Categories

| Category | Covers |
|---|---|
| `invitation` | Workspace membership invitations |
| `billing` | Receipts, payment issues, plan changes |
| `security` | Security-relevant account events |
| `support` | Support correspondence |
| `product` | Product updates |

Each category value is `true`, `false`, or `null` (not configured — treated as the opt-in default). The only channel in V1 is `email`.

## Read your preferences

`orgId` is a **required** query parameter (preferences are stored per workspace); `channel` is optional and must be `email` when present.

```bash
curl "https://api.orun.dev/v1/notifications/preferences?orgId=org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "preferences": [
      {
        "subjectKind": "user",
        "subjectId": "usr_3c2b1a0f9e8d7c6b5a49382716050403",
        "orgId": "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
        "channel": "email",
        "categories": {
          "invitation": true,
          "billing": true,
          "security": true,
          "support": null,
          "product": false
        },
        "updatedAt": "2026-06-28T14:02:00.000Z"
      }
    ]
  },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a29", "cursor": null }
}
```

An empty `preferences` array means nothing has been configured yet — every category is at its default.

## Update your preferences

The body requires `orgId`, `channel: "email"`, and a `categories` object; unknown category keys are rejected with `422 validation_failed`. Any `subjectKind`/`subjectId` in the body is overwritten with your own identity before the write.

:::note
`PUT` **replaces** the stored categories map — it is not a per-key merge. Send the complete map you want to keep; omitted categories revert to "not configured".
:::

```bash
curl -X PUT https://api.orun.dev/v1/notifications/preferences \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "orgId": "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
    "channel": "email",
    "categories": {
      "invitation": true,
      "billing": true,
      "security": true,
      "support": true,
      "product": false
    }
  }'
```

```json
{
  "data": {
    "preference": {
      "subjectKind": "user",
      "subjectId": "usr_3c2b1a0f9e8d7c6b5a49382716050403",
      "orgId": "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
      "channel": "email",
      "categories": {
        "invitation": true,
        "billing": true,
        "security": true,
        "support": true,
        "product": false
      },
      "updatedAt": "2026-07-02T09:40:00.000Z"
    }
  },
  "meta": { "requestId": "req_5f2d1c0b9a8e7f6d5c4b3a30", "cursor": null }
}
```

With the SDK — `subjectKind`/`subjectId` are typed on the request shape but the server pins them to the caller regardless:

```ts
const { preference } = await client.notifications.updatePreferences({
  orgId: "org_7c1f4b2a9d3e48f0a6b5c4d3e2f1a0b9",
  subjectKind: "user",
  subjectId: "self", // ignored — pinned to the authenticated actor
  channel: "email",
  categories: { invitation: true, billing: true, security: true, support: true, product: false },
});
```

## Related

- [Email notifications](/platform/notifications/email)
- [Authentication](/api/authentication)
- [Errors](/api/errors)
