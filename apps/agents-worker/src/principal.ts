// Principal classification (shared) — pure prefix tests over the membership
// subject id. A human is a `usr_`/`team_` subject; a service principal is
// `sp_` (agent profiles, the SV2 dispatcher); the runtime's own session
// identity is `as_`. Used by the track-record fold (which counts HUMAN
// verdicts only) and by the SV5 relay control gate (which lets a human hold
// control against the dispatcher's sp_).

/** True when the principal is a human subject — not a service principal (sp_)
 * and not a session identity (as_). */
export function isHumanPrincipal(principal: string): boolean {
  return !!principal && !principal.startsWith("sp_") && !principal.startsWith("as_");
}

/** True when the principal is a service principal (sp_…) — the dispatcher and
 * every agent-profile principal. */
export function isServicePrincipal(principal: string): boolean {
  return !!principal && principal.startsWith("sp_");
}
