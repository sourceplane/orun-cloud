---
title: Pagination
description: Cursor-based pagination on Orun Cloud list endpoints — limit and cursor parameters, meta.cursor continuation, and iteration patterns.
---

List endpoints in the Orun Cloud API use **cursor-based pagination**. Each page response carries a continuation token in `meta.cursor`; pass it back as the `cursor` query parameter to fetch the next page. When `meta.cursor` is `null`, you have reached the end.

## Query parameters

| Parameter | Type | Description |
|---|---|---|
| `limit` | integer | Maximum items per page (endpoint-specific default and cap) |
| `cursor` | string | Opaque continuation token from the previous page's `meta.cursor` |

## Page shape

```bash
curl "https://api.orun.dev/v1/organizations/ws_a1b2c3d4/audit?limit=50" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": { "auditEntries": [ /* …50 entries… */ ] },
  "meta": {
    "requestId": "req_7a6b5c4d3e2f1a0b9c8d7e6f",
    "cursor": "eyJvY2N1cnJlZEF0IjoiMjAyNi0wNi0zMFQxMjowMDowMC4wMDBaIn0"
  }
}
```

A non-`null` `meta.cursor` means more pages may exist; `"cursor": null` means the list is exhausted. Filters (e.g. audit's `category`, `from`, `to`) restrict which rows are eligible but do not change the cursor mechanics — send the same filters on every page of a walk.

## Loop with curl

```bash
CURSOR=""
while :; do
  URL="https://api.orun.dev/v1/organizations/ws_a1b2c3d4/audit?limit=100"
  [ -n "$CURSOR" ] && URL="$URL&cursor=$CURSOR"

  PAGE=$(curl -s "$URL" -H "Authorization: Bearer $ORUN_CLOUD_TOKEN")
  echo "$PAGE" | jq -c '.data.auditEntries[]'

  CURSOR=$(echo "$PAGE" | jq -r '.meta.cursor // empty')
  [ -z "$CURSOR" ] && break
done
```

## Iterate with the SDK

The SDK's audit client ships an async iterator that walks pages for you, stopping when `meta.cursor` is `null` (with loop guards against a misbehaving server):

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

for await (const entry of client.events.iterAuditEntries("org_1f6a3c9e", {
  by: "org",
  category: "billing",
  limit: 100,
})) {
  console.log(entry.eventType, entry.occurredAt);
}
```

When you need one page plus the cursor (e.g. for a paginated UI), use the page variant:

```ts
const { entries, cursor } = await client.events.listAuditEntriesPage(
  "org_1f6a3c9e",
  { by: "org", limit: 50 },
);
// cursor is null when there are no further pages
```

## Cursor stability

Cursors are **opaque**. Do not parse, construct, or modify them — their internal encoding can change without notice. Safe rules:

- Treat a cursor as a black-box string valid only for the same endpoint with the same filters.
- Do not persist cursors long-term as bookmarks; re-query with filters (e.g. audit's `from`) instead.
- Stop when `meta.cursor` is `null` — do not infer the end from a short page.

## Related

- [API overview](/api/overview)
- [Audit API](/api/resources/audit)
- [Audit log](/platform/audit/audit-log)
- [SDK](/developers/sdk)
