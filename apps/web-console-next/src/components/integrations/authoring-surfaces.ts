/**
 * Built-in custom authoring-surface registrations (saas-secrets-platform SP2).
 *
 * Import this module (for its side effect) from any surface that resolves an
 * authoring surface via `authoringSurfaceFor` — the provider space does. The
 * worker adapter's `authoring: "custom"` declaration states the INTENT; this
 * registration is the console-side fulfillment. Declarative providers
 * (Supabase) are deliberately absent — they inherit the default surface,
 * which is the SP6 pluggability contrast.
 */

import { registerCustomAuthoring } from "@/components/config/authoring-registry";
import { CloudflareAuthoringSurface } from "./cloudflare-authoring";

registerCustomAuthoring("cloudflare", CloudflareAuthoringSurface);
