---
title: Email notifications
description: How Orun Cloud sends transactional email, the delivery lifecycle, and how users manage their own notification preferences.
---

Orun Cloud sends **transactional email** — and only email, today; the model is channel-shaped so sms/push/in-app can be added later without breaking anything. Notifications are enqueued internally by platform services (an invitation, a billing receipt, a security alert), checked against a **suppression list**, and delivered by a provider adapter; per-user **preferences** record each user's category opt-outs. There is no public "send an email" API: the only end-user surface is reading and updating your own preferences.

## Categories

Every notification carries one routing category, and preferences are stored per category:

| Category | Typical notifications |
|---|---|
| `invitation` | Workspace invitations and membership changes |
| `billing` | Receipts, plan changes, payment issues |
| `security` | Sign-in and credential events, security alerts |
| `support` | Support and operational correspondence |
| `product` | Product announcements and updates |

All five are transactional; there is no marketing channel in this system.

## Delivery lifecycle

Each notification is a tracked record with per-attempt history:

| Status | Meaning |
|---|---|
| `queued` | Accepted and awaiting delivery |
| `sent` | Handed to the email provider; an opaque `providerMessageId` is recorded |
| `failed` | Delivery failed; a bounded `lastError` reason is recorded (never a raw provider payload) |
| `suppressed` | Skipped — the recipient address is on the suppression list |

Delivery lifecycle events (`notification.queued`, `notification.sent`, `notification.failed`, `notification.suppressed`, `notification.preference_updated`) are emitted on the platform event seam, so delivery activity is observable in the [audit log](/platform/audit/audit-log).

## Manage your preferences

`GET` and `PUT /v1/notifications/preferences` manage per-category toggles for the **calling user**. The subject is **pinned to your session**: whatever subject the request names, the platform replaces it with your own identity — you can only ever read or update your own preferences.

Read them (pass the workspace as `orgId`; `channel` is optional and only `email` exists):

```bash
curl "https://api.orun.dev/v1/notifications/preferences?orgId=org_7f3a9c2e51d84b6fa0e2c4d8b91f6a3c" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

const { preferences } = await client.notifications.getPreferences({
  orgId: "org_7f3a9c2e51d84b6fa0e2c4d8b91f6a3c",
});
```

Update them with a `categories` map. Each category is `true` (receive), `false` (opt out), or `null` (not configured — treated as the opt-in default):

```bash
curl -X PUT "https://api.orun.dev/v1/notifications/preferences" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "orgId": "org_7f3a9c2e51d84b6fa0e2c4d8b91f6a3c",
    "channel": "email",
    "categories": { "product": false, "billing": true }
  }'
```

```json
{
  "data": {
    "preference": {
      "subjectKind": "user",
      "subjectId": "usr_3e5d7c9b1a2f4e6d8c0b9a7f5e3d1c2b",
      "orgId": "7f3a9c2e-51d8-4b6f-a0e2-c4d8b91f6a3c",
      "channel": "email",
      "categories": {
        "invitation": null,
        "billing": true,
        "security": null,
        "support": null,
        "product": false
      },
      "updatedAt": "2026-07-02T09:41:18.000Z"
    }
  },
  "meta": { "requestId": "req_01j9x5d8mw", "cursor": null }
}
```

```ts
await client.notifications.updatePreferences({
  orgId: "org_7f3a9c2e51d84b6fa0e2c4d8b91f6a3c",
  subjectKind: "user",       // pinned server-side to the caller regardless
  subjectId: "self",         // ditto — you cannot target another subject
  channel: "email",
  categories: { product: false },
});
```

:::note
Workspace-level notification defaults (organization-scoped preference rows, such as org-wide billing recipients) exist in the model but are **internal-only today** — no public route reads or writes them. Only user-scoped preferences are exposed.
:::

## Suppression

Independent of preferences, a **suppression list** blocks delivery to a recipient address per workspace and channel. Entries carry a reason — `bounce`, `complaint`, `manual`, or `unsubscribe` — and any notification addressed to a suppressed recipient is short-circuited: the record is created with status `suppressed` and never handed to the provider. Suppression is managed internally (from delivery outcomes and operator action); there is no public endpoint for it.

## Delivery provider

Email is delivered through **Cloudflare Email Service** via the Workers `send_email` binding. Unlike API-key providers, **the binding itself is the credential** — it is scoped to the notifications service by deploy-time configuration, so there is no email API key to store or rotate.

This matters mostly if you run your own deployment. Sending real email requires, once per Cloudflare account:

- a **Workers Paid** plan (required to send to arbitrary recipients),
- the sending domain **verified in Email Service** (DKIM/SPF records),
- a from-address on that verified domain (`EMAIL_FROM_ADDRESS`).

Without these, deployments fall back to a local-debug provider that records would-be sends without contacting any external service — useful for development, invisible to recipients. See [Deploy your own](/self-hosting/deploy-your-own).

## Related

- [Members & invitations](/platform/workspaces/members-and-invitations)
- [Checkout, invoices & the billing portal](/platform/billing/checkout-and-portal)
- [Audit log](/platform/audit/audit-log)
- [Deploy your own](/self-hosting/deploy-your-own)
