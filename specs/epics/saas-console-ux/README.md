# Epic: saas-console-ux

**The buyer-credible product surface** — the "UI / Design (U)" cluster, carved into
an Orun-style epic. Makes the web console look credible to an external buyer at the
Vercel / Linear / Stripe-Dashboard bar.

## Status

| Field | Value |
|-------|-------|
| Status | **In progress** (U1–U11 shipped; ongoing polish) |
| Cluster | **U** (U1–U11) |
| Owner(s) | `apps/web-console-next`, `packages/ui` (+ contracts/sdk for additive read types only) |
| Target branch | `main` |
| Builds on | `components/12-web-console.md` (the durable console contract), B4 (SDK) for U10 |
| Decisions locked | Next.js 15 App Router on Cloudflare via `@opennextjs/cloudflare`; URL is the source of truth for scope; design system in `packages/ui`; dark-mode-by-default token theming |

## Thesis

U1–U10 made the console structurally credible (App Router on Workers, URL-driven
3-level scope switcher, Cmd-K, designed empty/skeleton states, `412` upgrade UX,
dark-mode tokens, SDK client). U11 closed the remaining buyer-visible gaps to the
Vercel/Linear/Stripe bar, scoped strictly to surfaces the public API/SDK already
backs. Work continues as incremental polish (sidebar, mobile drawer, account
section, dialog a11y, optimistic mutations).

## Read order

1. `README.md` (this file).
2. `design.md` — the normative design direction (token theming, white-label, scope
   model) and its relationship to `components/12-web-console.md`.
3. `implementation-plan.md` — U1–U11.
4. `IMPLEMENTATION-STATUS.md` — what shipped.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| U1 | Next.js 15 App Router on Cloudflare Pages | ✅ Shipped |
| U2 | Design system in `packages/ui` | ✅ Shipped |
| U3 | URL-driven scope selector | ✅ Shipped |
| U4 | Empty states as a product feature | ✅ Shipped |
| U5 | Cmd-K command palette | ✅ Shipped |
| U6 | Contract-driven forms | ✅ Shipped |
| U7 | Designed `precondition_failed` / upgrade UX | ✅ Shipped |
| U8 | Skeleton + optimistic UI | ✅ Shipped (skeletons); optimistic ongoing |
| U9 | White-label-ready theming | ✅ Shipped (foundation) |
| U10 | Console-as-SDK-client | ✅ Shipped |
| U11 | Vercel-standard console completion | ✅ Shipped (notification-prefs deferred — backend) |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| Everything the public API/SDK already backs: scope switcher, palette, empty/skeleton states, upgrade UX, usage dashboard, account/org/project settings (API-backed actions only), design-system primitives, optimistic mutations | Rename/update of org/project/env (no API), real auth (B1, human-blocked), in-app notification inbox with read-state (P4), backend slices |
