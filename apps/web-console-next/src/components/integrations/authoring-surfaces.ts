/**
 * Built-in custom authoring-surface registrations (saas-secrets-platform SP2).
 *
 * Import this module (for its side effect) from any surface that resolves an
 * authoring surface via `authoringSurfaceFor` — the provider space does. The
 * worker adapter's `authoring: "custom"` declaration states the INTENT; a
 * registration here is the console-side fulfillment.
 *
 * IR4: there are currently NO built-in custom surfaces. Cloudflare's custom
 * surface (`cloudflare-authoring.tsx`) was deleted — everything it rendered
 * (account picker, template grants/params/max-TTL detail, the honest-breadth
 * statement) is expressible by the default outcome-first wizard
 * (`config/secret-wizard.tsx`) straight from the SP0 capability read, so its
 * `registerCustomAuthoring("cloudflare", …)` graft was dropped. Cloudflare's
 * declared `authoring: "custom"` now fails open to the wizard (the SP-A3
 * fail-open rule). A future provider needing a genuinely bespoke create flow
 * registers it here with `registerCustomAuthoring(providerId, Surface)`.
 */

export {};
