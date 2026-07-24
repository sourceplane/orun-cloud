# Epic: saas-integrations-console

## Status

| Field | Value |
|-------|-------|
| Status | ✅ Shipped (IX1–IX5) |
| Cluster | **IX** (Integrations eXperience — console layer over **IR** + **IH** + **IT** + **SP**) |
| Owner(s) | web-console-next, packages/{contracts,sdk}, integrations-worker |
| Target branch | `main` |
| Builds on | **IR0–IR9** (served registry + manifests + provider modules, shipped), **IT1–IT8** (account-shared connections + admission, shipped), **SP0–SP6** (secrets-as-substrate + brokered/rotated secrets, shipped), **IH0** (archetype capability seam, in progress) |
| Decisions locked | Detail page is **archetype-tabbed** and a pure projection of the served descriptor + connection reads; no per-provider `if` ladders in the console (mirror IR1's registry-driven hub discipline). New persisted state is minimal and additive. |
| Gate | Live provider registrations (Slack app / Cloudflare / Supabase OAuth) are env-gated — every surface degrades honestly (skeleton → empty → "not configured"), never a baked fallback. |

## Thesis

The integrations backend is already deep — a served **Integration Registry**,
account-shared **tenancy** with admission, **brokered/rotated secrets** minted
per run, channel/repository/delivery/mint reads. What the product lacks is the
**console experience** that makes that depth legible: a hub that reads like a
directory, and one **page per integration** that adapts to the provider's
_archetype_ (source-control · messaging · infrastructure secret-broker) instead
of a single generic "space".

This epic realizes the **Orun Integrations Console** design: a restyled hub
(summary stats including brokered secrets, a status+category filter bar,
connected rows with Manage, an available grid, a roadmap strip) and a
**tabbed detail page** whose tabs are chosen by archetype — Overview + capability
controls, then Repositories / Secrets / Channels, then Workspace access, then
Activity. Every surface is a pure function of the served descriptor and the
org's connections. The few genuinely-new nouns (per-connection **capability
preferences**, Slack **notification routing**) are small additive slices on the
existing seams.

## The two genuinely new nouns

1. **Connection capability preferences** — the mockup's Overview shows toggles
   (GitHub: Pull requests / Checks & status / Deployments / Issues). The
   manifest declares which capabilities a provider _supports_; this adds which
   ones the operator has _enabled_ for a given connection. An additive
   `capability_prefs` fact on the connection, read on `PublicConnection`, written
   through the existing `PATCH /integrations/{connectionId}` (which already
   carries `shareMode`).
2. **Notification routing** — the Slack detail's Notifications tab routes event
   groups (run outcomes → `#deploys`, approvals → `#eng-approvals`, …) with
   per-route on/off. A per-connection routing preference the console authors;
   real delivery stays owned by notifications-worker / event-streaming (**ES**),
   so this ships as the _authoring surface_ with an honest scope boundary.

Everything else in the design is **recomposition of existing reads**: registry,
connections, custody, minted credentials, deliveries, repositories, Slack
channels, brokered/rotated secret metadata.

## Milestones at a glance

| ID | Milestone | New backend? | Buildable vendor-free? |
|----|-----------|--------------|------------------------|
| IX1 | Hub redesign — stats · filter bar · connected rows · available grid · roadmap · search | No (adds a brokered-secret count from the existing secrets read) | ✅ |
| IX2 | Detail framework + **GitHub** (source-control) page — header · archetype tabs · Overview + **capability toggles** · Repositories · Workspace access · Activity | Yes — connection `capability_prefs` (contracts + migration + PATCH + SDK) | ✅ |
| IX3 | **Infrastructure** archetype (Supabase + Cloudflare) — Overview "what Orun can broker" · **Secrets** (brokered/rotated, create/rotate) · Projects · Activity | No (public read of a connection's brokered secrets; create/rotate reuse config-worker) | ✅ |
| IX4 | **Messaging** archetype (Slack) — Overview · Channels (add) · **Notifications routing** · Activity | Yes — per-connection notification routing prefs | ✅ (delivery stubbed with honest boundary) |
| IX5 | Global **+ Connect** picker · search polish · `/demo` integrations gallery · dark-mode/a11y · supersede the legacy generic space | No | ✅ |

## Read order

1. `design.md` — the target design (from the mockup), the archetype model, and how each surface maps to an existing read/write.
2. `implementation-plan.md` — per-milestone **Build.** / **Done when.**
3. `IMPLEMENTATION-STATUS.md` — as-built, PR trail, deltas from design.
4. `risks-and-open-questions.md`.

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The Integrations hub visual redesign | New provider adapters (that's IH/IR + `adding-an-integration.md`) |
| Archetype-tabbed per-integration detail pages | Real Slack message delivery / event routing engine (ES / notifications-worker) |
| Capability preference toggles (persisted, additive) | Changing the GitHub App's granted permissions (that stays on GitHub) |
| Brokered/rotated secret **surfacing** + create/rotate wiring | The mint/resolve broker core (shipped SP/IH — reused, not changed) |
| Notification routing **authoring** surface | The DEK/KEK/lease resolve plane (SM) |
| `/demo` gallery entries + jest coverage for the new components | Live end-to-end against prod credentials (verified on stage separately) |

## Relationship to existing work

- **IR (registry)** — this epic consumes the served `IntegrationDescriptor` as
  the single source of truth for the hub cards, the detail header, the tab set,
  and the connect posture. No console-side catalog is introduced.
- **IH (hub archetypes)** — IX gives IH's archetypes their console home. Where
  IH backend is still dormant/gated, IX renders the honest disabled/empty state.
- **IT (tenancy)** — Workspace access tab is the console for IT8 admission
  (`ConnectionAdmission` recomposed as "Open to all / By invitation").
- **SP (secrets platform)** — the Secrets tab is SP's per-integration authoring
  surface, rendered inside the integration's own page (SP's "provider owns
  create" principle).
- Supersedes the IR2/IR-U generic **ProviderSpace** chrome for the covered
  providers; the space's proven sub-components (admission, activity, channels,
  repositories, secret wizard) are **reused**, not rewritten.
