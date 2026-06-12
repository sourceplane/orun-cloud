# saas-baseline — Risks & Open Questions

Live register of the human-blocked items and deferred decisions on the B cluster.
When an entry is unblocked, remove it here and treat the milestone as a normal
candidate. Mirrors the parked entries in `ai/deferred.md`.

## ⛔ Human-input gates (do NOT auto-pick)

| Item | Blocking decision | Unblock signal |
|------|-------------------|----------------|
| **B1 — real auth** | Which OAuth provider(s) + email sender domain/API key? | User supplies OAuth app creds + a verified email sender. GitHub OAuth scaffolding already landed (0129). |
| **B6 — Stripe billing UX** | Stripe account creds + receipts posture. | User supplies Stripe keys + confirms receipt flow. (U7 precondition already met.) |
| **B10 — SSO/SAML + SCIM** | IdP (Okta/AzureAD) creds + org lockout policy. | B1 stable **and** user supplies IdP creds. |

## Deferred decisions

| Item | Decision needed | Notes |
|------|-----------------|-------|
| **Notifications provider swap** | Resend vs Postmark vs SES. | Adapter seam (`apps/notifications-worker/src/providers/`) is in place; drop-in once chosen. |
| **B9 console surface** | Where does the entitlement-observability read render? B9 lives on internal-only `admin-worker`; `web-console-next` is the customer console (SDK→api-edge); no internal-operator console/auth model exists. | Needs a product/architecture call before it can be scoped. |
| **Console notification-preferences (overlaps U11/P4)** | api-edge exposes no `/v1/notifications/*` facade, so the console cannot consume `notifications.getPreferences/updatePreferences` yet. | Unblocks when an edge notifications facade lands. Tracked also in `saas-console-ux` + P4. |
