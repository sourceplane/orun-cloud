/**
 * Pre-hydration boot primer (IC3, decision D1: primer over RSC fetch).
 *
 * The audit's cold-boot chain serialized `HTML → JS → hydrate → auth → org
 * list → page queries`, so the first API call left ~2.6s after navigation
 * start. This module removes the serialization for the two session-boot reads
 * (`/v1/auth/profile`, `/v1/organizations`): an inline script in the document
 * `<head>` fires them the moment HTML arrives — before any bundle downloads
 * or hydrates — and parks the in-flight promises on `window`. When the SDK
 * client makes the same request during boot, it adopts the primed response
 * instead of fetching again.
 *
 * Safety:
 * - The primed entry is bound to the exact token + base URL it was fired
 *   with; the consumer verifies both before adopting (a token swap between
 *   primer and hydrate falls back to a normal fetch).
 * - One-shot: each entry is consumed at most once (Response bodies are
 *   single-use), then always falls through to normal fetch.
 * - TTL-bounded: entries older than PRIMED_TTL_MS are ignored — an adopted
 *   response is never older than a freshly-issued one would meaningfully be.
 * - The script never runs without a stored token and never touches the DOM.
 *
 * OpenNext-safe: the script is plain inline JS in the served HTML; no SSR
 * data dependency (HTML stays `no-store`-cacheable as before).
 */

export const PRIMED_TTL_MS = 15_000;

interface PrimedEntry {
  promise: Promise<Response>;
  consumed: boolean;
}

interface PrimedBoot {
  token: string;
  base: string;
  at: number;
  entries: Record<string, PrimedEntry>;
}

declare global {
  interface Window {
    __orunPrimedBoot?: PrimedBoot;
  }
}

/** The boot reads the primer fires — must stay the exact GETs the shell
 *  issues through `qk.profile()` / `qk.orgs()` on boot. */
export const PRIMED_PATHS = ["/v1/auth/profile", "/v1/organizations"] as const;

/**
 * Build the inline `<head>` script. Pure string builder (server-rendered into
 * the layout), parameterized on the console's target table + storage prefix so
 * it can never drift from `app-config`/`session` conventions. Everything is
 * injected via JSON.stringify — no string interpolation of user data.
 */
export function bootPrimerScript(targets: ReadonlyArray<{ name: string; url: string }>, storagePrefix: string): string {
  const urls = JSON.stringify(Object.fromEntries(targets.map((t) => [t.name, t.url])));
  const defaultName = JSON.stringify(targets[0]?.name ?? "");
  const prefix = JSON.stringify(storagePrefix);
  const paths = JSON.stringify(PRIMED_PATHS);
  return (
    "(function(){try{" +
    `var P=${prefix};` +
    'var token=localStorage.getItem(P+".token");if(!token)return;' +
    `var urls=${urls};var name=localStorage.getItem(P+".target")||${defaultName};` +
    `var base=urls[name];if(!base)return;` +
    'var h={authorization:"Bearer "+token,"x-request-id":"req_bootprimer"};' +
    `var paths=${paths};var entries={};` +
    "for(var i=0;i<paths.length;i++){entries[paths[i]]={promise:fetch(base+paths[i],{headers:h}),consumed:false};}" +
    "window.__orunPrimedBoot={token:token,base:base,at:Date.now(),entries:entries};" +
    "}catch(e){}})();"
  );
}

/**
 * If `url` is a boot read the primer already has in flight for this exact
 * token+base, adopt it (one-shot). Returns null when there is nothing to
 * adopt — caller falls back to a normal fetch.
 */
export function consumePrimedBootResponse(url: string, method: string, token: string | null): Promise<Response> | null {
  if (typeof window === "undefined" || method.toUpperCase() !== "GET" || !token) return null;
  const primed = window.__orunPrimedBoot;
  if (!primed || primed.token !== token) return null;
  if (Date.now() - primed.at > PRIMED_TTL_MS) return null;
  if (!url.startsWith(primed.base)) return null;
  const path = url.slice(primed.base.length).split("?")[0];
  const entry = path ? primed.entries[path] : undefined;
  if (!entry || entry.consumed) return null;
  entry.consumed = true;
  return entry.promise;
}
