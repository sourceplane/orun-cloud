# Current Context (compact)

Last updated: 2026-06-11.

## PX cluster (saas-product-experience epic) — PX1–PX3 shipped & live-verified

Opened 2026-06-11 from a verified-live audit. **PX1 (#299), PX2 (#300/#303/
#304), PX3 (#303/#304) are shipped and verified live on stage** (authenticated
Playwright + API probes; prod smoked): designed 404/confirm-dialogs/
breadcrumbs; config settings/flags/secrets surface at all three scopes with
full secret lifecycle (create→rotate→revoke, key provisioned for stage+prod by
the config-worker deploy lane); notification preferences e2e via an
actor-pinned edge facade + console page + CLI verbs. PX3 unparked the U11
notification-preferences deferred slice.

Live verification surfaced and fixed two latent platform bugs: (1) backend
non-convergence since the failed #280 run (cascade dependency-wait timeouts +
`--changed` planning) — api-edge/config-worker/notifications-worker
redeployed; the OTHER workers (membership/events/webhooks/metering/projects/
policy) are still on pre-#280 deploys — convergence follow-up needed; (2)
SDK↔worker drift: config item routes address by public id, not key (#304).

**Next ready: PX4** (rename PATCH lifecycle), then PX5 (onboarding), PX6
(Cmd-K resource search). A parallel session is active on PERF + a new
saas-integrations epic — coordinate console-file changes.

> **Working-tree compaction (2026-06-01).** To keep a minimal context surface,
> the bulky historical AI artifacts were removed from the working tree:
> `ai/tasks/` (per-task implementer/verifier prompts), `ai/reports/`
> (implementer + verifier reports), `ai/proposals/` (spec-change proposals),
> `ai/context/task-ledger.md` (~390 KB), and the orchestrator journal/brief.
> **Nothing is lost** — they all remain in git history. Retrieve any of them with:
> `git log --all --full-history -- ai/tasks/task-0126.md` then
> `git show <sha>:ai/tasks/task-0126.md`, or browse the parent of the compaction
> commit. The live boot surface is now: this file, `ai/state.json` (slimmed),
> `ai/context/decisions.md`, `ai/context/open-risks.md`, `ai/deferred.md`, and
> `ai/waiting_for_input.md`.

## Ground truth (verify, don't trust — re-derive from git/gh on boot)

- main HEAD: `63886a6` — "feat(webhooks): manual delivery replay across the full
  stack (#181)".
- Open PRs: re-derive from GitHub on boot (PR #181 is merged). Prior briefs have
  repeatedly lagged reality (0122/0123/0124/0126 all diverged) — trust code/git
  over these notes.
- Repo health: green. (Re-run the relevant turbo lanes for the area you touch.)

## Status

**Task 0126 — B5 manual webhook delivery replay: DONE (PR #181, squash `63886a6`).**
Adds an on-demand "redeliver a specific past delivery attempt" path end to end —
`webhooks-worker` item-action `POST .../webhooks/delivery-attempts/:id/replay`
(reconstructs a fresh attempt and re-drives the existing `deliverAttempt()`
signing/delivery chokepoint), additive `ReplayWebhookDelivery{Request,Response}`
contracts, SDK `replayDelivery`, CLI `webhook deliveries replay`, and a Console
"Redeliver" action on terminal attempt rows. No migration; no change to
`deliverAttempt` signing/retry/backoff or the `retryFailedDeliveries()` cron.
This closes the last named, human-independent **B5** gap.

Recently closed before it: **0125** drift-proof `VALID_CONTEXTS` (#180, `c25fce5`);
**0124** B9 entitlement-decision observability (#179, `0a8f9d7`).

## Next focus (orchestrator must re-survey, trust code over docs)

There is **no active task**. Re-run a full B/U/P frontier survey to scope the next
leg. Known frontier state as of this compaction:

1. **B-track forward legs are human-blocked:** B1 (OAuth + email creds), B6 (Stripe
   creds + receipts; also gated on U7), B10 (SSO/SAML + SCIM creds; gated on
   B1+B8 stability). Do not auto-pick — they need human-supplied secrets/decisions.
2. **B9 Console surface — DEFERRED** pending a human architecture decision: the B9
   read lives on internal-only `admin-worker` (never mounted on api-edge), while
   `web-console-next` is the customer console via SDK→api-edge, and no
   internal-operator console/auth model exists. Needs a human product/architecture
   call before it can be scoped.
3. **P1 promote-flow** is the likely next human-independent leg — verify against
   code before committing.

## Deferred (human input required — do NOT auto-pick)

See `ai/deferred.md` for the full parked list with unblock signals:
`0085b` (cloudflare-domain v4→v5), `notifications-provider-swap`,
`notifications-worker-dev-reframe`, `optional-spec-13-commands`.

## Carry-forward nit (non-blocking)

`packages/cli/src/commands/cross-reads.ts` `parseAuditFilterFlags` doc-comment says
malformed input "surfaces as a 400" — the worker actually returns 422. Comment-only;
fold into any future cross-reads touch.

## Operating contract reminders

- Orchestrator boot reads: this file, `ai/context/decisions.md`,
  `ai/context/open-risks.md`, `ai/state.json` (per `agents/orchestrator.md`). The
  removed `ai/context/task-ledger.md` and `ai/proposals/**` are now git-history
  only — if a future boot needs the long ledger, restore it from git or rely on
  `git log` + the `completed[]` list in `ai/state.json`.
- New task prompts still go in `ai/tasks/`; new reports still go in `ai/reports/`
  (recreate the dirs as needed). BEHIND-main rebase = verifier responsibility.
