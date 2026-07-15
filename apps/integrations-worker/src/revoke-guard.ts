// Connection-revoke referential guard (brokered-orphan-safety, Feature 2).
//
// A connection that still has `active` brokered secrets pointing at it cannot
// be revoked/deleted unless the caller explicitly forces it. Forcing orphans
// those secrets (they stop minting immediately) — this guard makes that an
// informed, audited choice rather than a silent side effect.
//
// Pure decision only: the handler supplies the active brokered references (read
// from config-worker via the internal reference endpoint) and whether `force`
// was requested; this returns whether the revoke may proceed and who is
// affected.

/** A brokered secret that binds to the connection under revoke. */
export interface BrokeredSecretRef {
  /** Public secret id (sec_…). */
  id: string;
  secretKey: string;
  /** Human scope label for copy, e.g. "project" or "environment (prod)". */
  scope: string;
}

export type RevokeDecision =
  | {
      allow: true;
      /**
       * Secrets that will be orphaned by proceeding. Empty when nothing bound;
       * populated (but allowed) when `force` overrode a block — the handler
       * echoes these and audits the forced orphaning.
       */
      orphans: BrokeredSecretRef[];
      forced: boolean;
    }
  | {
      allow: false;
      /** Active brokered secrets blocking the revoke — surfaced to the caller. */
      blockers: BrokeredSecretRef[];
    };

/**
 * Classify a connection revoke against the brokered secrets that reference it.
 *
 * - No references → allow (nothing to orphan).
 * - References present + `force` → allow, reporting the casualties.
 * - References present + no `force` → block, returning the blockers.
 *
 * The caller MUST pass only *active* brokered references (a revoked/deleted
 * secret is not a blocker). Fail-closed on the read is the handler's job: if the
 * references can't be fetched, a non-forced revoke must be refused rather than
 * calling this with an empty list.
 */
export function classifyRevoke(
  references: readonly BrokeredSecretRef[],
  opts: { force: boolean },
): RevokeDecision {
  if (references.length === 0) {
    return { allow: true, orphans: [], forced: false };
  }
  if (opts.force) {
    return { allow: true, orphans: [...references], forced: true };
  }
  return { allow: false, blockers: [...references] };
}
