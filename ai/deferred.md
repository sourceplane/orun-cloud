# Deferred Candidates

Tasks the orchestrator has parked because they require human input or an
external decision. The orchestrator loop continues with the next safe candidate
instead of blocking on these. See `agents/orchestrator.md` → "Deferred
Decision Protocol".

When a deferred entry is unblocked (user answers, upstream lands, etc.),
remove it from this file and treat it as a normal candidate in the next
selection pass.

---

## Real notifications provider swap
- Deferred: 2026-05-30
- Blocking decision: Which transactional email provider does the user want
  wired behind `NOTIFICATIONS_PROVIDER` — Resend, Postmark, or SES? Each
  has different secrets, sender-identity setup, and billing posture.
- Unblock signal: user names a provider (and confirms a verified sender
  domain / API key path).
- Notes: notifications-worker V1 already ships an adapter seam
  (`apps/notifications-worker/src/providers/`) gated on
  `NOTIFICATIONS_PROVIDER`. Drop-in once the choice is made. Task 0089
  will leave this seam untouched.

## Task 0085b — cloudflare-domain v4 → v5 + re-import
- Deferred: 2026-05-29 (explicit user defer, carried over from prior state)
- Blocking decision: user wants the Phase 2 provider bump + `import {}`
  re-adoption parked while the two live custom-domain attachments stay
  Cloudflare-managed only.
- Unblock signal: user lifts the defer.
- Notes: Two live attachment IDs to re-import — stage
  `052eaece5e989d5a7280b6c206e562c42950e3a6`, prod
  `31e5f2ed1b1e4a5700e8ae0678846a0d753840e1`. No manual Cloudflare-dashboard
  or wrangler edits to these while parked. Task 0089 must not touch
  `infra/terraform/cloudflare-domain/**` or the cloudflare provider pin.

## Optional spec-13 CLI commands (`component list`, `resource create`, `resource get`, `deployment get`)
- Deferred: 2026-05-31
- Blocking decision: backend gap, not user input. The api-edge facade
  surface (audited 2026-05-31) does not expose `/v1/components`,
  `/v1/resources`, or `/v1/deployments` — only the auth, org, project,
  webhooks, billing, config, metering, and audit facades exist. These
  optional spec-13 commands cannot ship as a pure CLI/SDK PR; they
  require a P2 backend slice (resources + component-manifest) first.
- Unblock signal: a backend task lands `/v1/components`,
  `/v1/resources`, and `/v1/deployments` GET (and `resource create`
  POST) on api-edge with corresponding contracts in
  `@saas/contracts`. After that, this becomes a pure SDK + CLI fan-out
  task (estimated single PR, mirrors Task 0099 cadence).
- Notes: per `specs/components/13-cli-and-sdk.md` lines 72-75, these
  commands are **explicitly optional** — spec-13 required surface is
  fully live on main (Task 0101+0102). Roadmap P2 tracks the backend
  resources slice. Do not emit a CLI-only task for this until backend
  routes exist.

## notifications-worker-dev provisioning + dev binding (REFRAMED → `notifications-worker-dev-reframe`)
- Deferred: 2026-05-30 (originally parked behind Task 0089 as a narrow
  follow-up; reframed during Task 0090 scoping after orchestrator
  inspection of `apps/*/component.yaml`).
- Blocking decision: technical reframe needed, not user input. The
  original framing assumed a single wrangler/component change would
  unlock dev enqueue for the three V1 callers. In reality, dev profile
  is `verify`-only on every worker `component.yaml` (no `profileRules`
  add `deploy` on dev), so no live `*-dev` Cloudflare worker exists for
  any consumer in the repo. Provisioning `notifications-worker-dev`
  alone gives the three callers no dev binding to consume.
- Unblock signal: a separate "introduce dev-deploy lane" design pass
  lands first (component-spec change adding `profileRules: deploy` for
  dev plus the Cloudflare account/binding policy), THEN this candidate
  becomes a normal narrow follow-up.
- Notes: Task 0090 (V1 notifications idempotency keys) supersedes this
  as the next safe PR — it is a strictly stage/prod hardening change
  that lands on the existing deploy lane and does not depend on dev
  enqueue working.
