# Secrets Console — target design

Pixel + feature source of truth, extracted verbatim from the `Secrets Console`
mockup (a Northwind-family design; the console already ships the design system —
`Newsreader` serif, the stat-card / chip / status-dot / attention-banner
primitives, and the exact token palette). This doc is normative for copy,
structure, and behaviour; the tokens below are the ones already in
`globals.css`.

## Design language (already in the system)

- **Type** — serif display `Newsreader` (`font-serif` / `.font-serif-display`,
  weight 500) for the page `h1`, the big stat numerals (34px), and detail card
  values; system sans for body (14px root, 12–13.5px UI); system mono for keys
  and `secrets.KEY` refs.
- **Colour** — ink `#171717` (`--foreground`/`--primary`), muted `#737373`
  (`--muted-foreground`), faint `#a3a3a3`, hairline `#E5E5E5` (`--border`), card
  `#FFF`. Status: green `#3A8159` (`--success`, fresh + created), blue `#3B76C9`
  (`--info`, rotated + minted), amber `#C39B45` dot / `#9A7B2D` text
  (`--warning`, attention), red `#C94A44` (`--destructive`, revoke).
- **Source marks** — Supabase green tile, Cloudflare orange tile, Static key
  glyph, Generated sparkle glyph.

## Data model (a secret, as the surface sees it)

Projected from `PublicSecretMetadata` (+ the derivations this epic adds):

| Field | Source |
|---|---|
| `secretKey` | served |
| `source` = `supabase` \| `cloudflare` \| `static` \| `generated` \| … | `source` + `binding.provider` (`generated` from SC4) |
| `lifecycle` = `fresh` \| `rotated` \| `static` | **derived**: brokered & no rotation ⇒ `fresh`; `rotationPolicy`/`rotation` present ⇒ `rotated`; static & no rotation ⇒ `static` |
| `scope` label | `scopeKind` + project/env names → `workspace · acme` / `checkout / production` / `staging / uploads` |
| `lifecycle badge` | `fresh`→"Fresh per run" (success), `rotated`→"Rotated" (info), `static`→"Static" (neutral) |
| `lastActivity` | "Resolved 22m ago" / "Rotated 6d ago" / "Created just now" from `lastUsedAt`/`lastRotatedAt`/`createdAt` |
| `health` + `note` | **derived**: `lastUsedAt` older than 30d ⇒ "Unused for N days"; `static` older than 180d ⇒ "Static for N days"; rotation overdue; orphaned brokered |
| `consumers` (Usage) | `listSecretSyncs({ secretKey })` rows (`target`/`entityRef`) + `lastUsedAt` |
| `history` (timeline) | `listSecretVersions` + created/rotated anchors |

Write-only invariant is preserved end-to-end: **no value is ever read into a
list/detail query.** A value materializes only in the audited reveal dialog
(out of scope here) and, transiently, in the wizard's Paste/Generate inputs
before the write.

## 1. The Secrets home (list)

Header — serif `h1` **"Secrets"** + lede: *"Every credential a plan can touch,
in one place. Brokered secrets are minted just-in-time from an integration and
never stored — static values are encrypted and write-only."* Right: **`+ New
secret`** (ink button) → opens the wizard.

Four stat cards (serif numeral + unit + status line):
- **SECRETS** — `{total}` · "across {N} scopes"
- **FRESH PER RUN** — `{freshCount}` · "nothing stored"
- **ROTATED** — `{rotatedCount}` · "on a schedule"
- **STATIC** — `{staticCount}` · "stored encrypted"

Attention banner (amber, when any secret needs attention): **"{N} need
attention** — {KEY} — {note} · {KEY} — {note}".

Filter bar: a search input ("Search by key or scope"); a lifecycle **segmented**
control `All · Fresh per run · Rotated · Static`; a source **chip** row
`All sources · Supabase · {n} · Cloudflare · {n} · Static & generated · {n}`
(the "Static & generated" chip matches `source ∈ {static, generated}`).

Table — five columns + chevron: **KEY** (mono, status dot; a health note
renders as an amber subline), **SOURCE** (provider icon + name), **SCOPE**
(mono scope label), **LIFECYCLE** (badge), **LAST ACTIVITY** (muted). A row
opens the detail page. Empty/no-match states are honest. Footer note: *"Plans
reference a secret as `secrets.KEY` — values are resolved at run time and never
appear in logs or plan output."*

## 2. The New Secret wizard (4-step modal)

A modal dialog titled **"New secret"** with the scope subtitle *"Workspace ·
acme — pick a source, scope it, done."* and a 4-step progress rail:
**Source · Configure · Scope & lifecycle · Review**.

**Step 1 — Source.** *"Where does the value come from?"* / *"The best secret is
one that never exists until the moment it's needed."* Three cards:
- **Broker from an integration** `recommended` — *"Supabase or Cloudflare mints
  short-lived access on demand — nothing to paste, nothing stored."*
- **Paste a value** — *"Store an existing key encrypted. Write-only — it never
  appears again after saving."*
- **Generate for me** — *"A high-entropy random value minted by Orun — webhook
  signing, internal tokens."*

**Step 2 — Configure** (branch on source):
- *Broker* — *"What do you need?"* / *"Pick the outcome — the connection mints
  exactly the access it needs."* Provider tabs (one per connected broker,
  labelled by connection) then a radio list of grant templates (name · desc ·
  ttl). The grant seeds the key (e.g. `SUPABASE_DB_URL`) and, when its TTL is a
  rotation cadence (`90d`), pre-selects the rotated lifecycle.
- *Paste* — *"Paste the value"* / *"It's encrypted before it lands and
  write-only after — you won't see it again."* Key input + password Value input.
  Footer: *"Encrypted with AES-256-GCM · never logged · replaceable but not
  readable."*
- *Generate* — *"Generate a value"* / *"Orun mints it at create time — no human
  ever sees it."* Key input + format chips `64-char hex · 32-byte base64 · UUID
  v4` + a masked preview ("generated at create time").

**Step 3 — Scope & lifecycle.** *"Where can it resolve?"* / *"Narrower is safer
— a secret only resolves inside its rung."* A scope breadcrumb selector
`Workspace · acme › Project · checkout › Environment · production` with a
one-line description per rung. Then **Lifecycle** (branch):
- *Broker* — cards **Fresh per run** `recommended` (*"Nothing is stored — a
  short-lived credential is minted just-in-time at resolve, valid at most ≤
  1h."*) vs **Managed & rotated** (*"Minted once, stored encrypted, re-minted
  every 90 days with a 24-hour grace overlap."*).
- *Paste* — a "rotation reminder every 90 days" toggle.
- *Generate* — an "auto-rotate every 90 days" toggle.

**Step 4 — Review.** *"One last look before it goes live."* A SOURCE / KEY /
SCOPE / LIFECYCLE table + lock note *"Plans reference it as `secrets.KEY` — the
value never appears in logs."* Primary: **Create secret**.

**Ready.** Green check, *"{KEY} is ready"*, *"It resolves from the moment a plan
references it. The value itself never appears anywhere."*, a `secrets.KEY` copy
field, then **View secret** / **Done**.

`sanitizeKey`: uppercase, `[^A-Z0-9_] → _`, max 64.

## 3. The secret detail page

Breadcrumb `‹ Secrets › {KEY}`. Header: source icon, mono **{KEY}**, lifecycle
badge, an attention badge when unhealthy; subtitle *"{grant/tmpl} · from
{srcName} · created {date} by {user}"*. Actions: **Copy reference**; **Rotate
now** (only when lifecycle ≠ fresh). Tabs **Overview · Usage · History**.

- **Overview** — three cards (**LIFECYCLE** word + meta line; **SCOPE** label +
  "Only plans in this scope can resolve it."; **LAST ACTIVITY** + "{n}
  consumers"); a **REFERENCE IN CODE** row (`secrets.KEY` + Copy); a **HOW IT
  LIVES** paragraph (the lifeText); a **Revoke this secret** danger zone — *"Plans
  referencing `secrets.KEY` fail at resolve, immediately. This cannot be undone."*
  with a two-step arm (Revoke → Confirm revoke).
- **Usage** — consumer rows (`entityRef` + "last resolved {when}"); empty state
  *"Nothing has resolved this secret yet. Reference it as `secrets.KEY` in a plan
  and consumers appear here."*
- **History** — a colored-dot timeline (created green, minted/rotated blue,
  flags amber) with a `when`; footer *"Every mint, rotation, and change is
  recorded. Values themselves are never logged."*

## Lifecycle & health derivation (normative)

```
lifecycle(meta):
  brokered & no rotationPolicy      -> 'fresh'
  rotationPolicy set OR rotation{}  -> 'rotated'
  otherwise (static/generated head) -> 'static'

healthNote(meta, now):
  brokered & orphaned               -> { warn, 'Binding orphaned' }
  rotationStatus.due                -> { warn, 'Rotation overdue' }
  lifecycle=='static' & ageDays>180 -> { warn, `Static for ${age} days` }
  lastUsedAt & unusedDays>30        -> { warn, `Unused for ${unusedDays} days` }
  otherwise                         -> healthy
```

Both are pure functions over metadata only — unit-tested in
`tests/web-console-next`, no value ever consulted.
