// saas-integration-registry IR7: the CLI projection's server-side lint.
//
// A served verb is DATA, never capability: its `invoke.op` must name an
// operation from the closed allowlist compiled into the orun binary
// (internal/integrationscli/ops.go). This mirror is the two-sided contract —
// a manifest verb naming an op outside it fails HERE, before any release,
// and an orun-side allowlist change must update this mirror consciously.

import { INTEGRATION_MANIFEST_MODULES } from "@integrations-worker/providers/manifests/index";

/** Mirror of orun's compiled-in op allowlist (internal/integrationscli/ops.go).
 *  Update BOTH sides together — this list changing without an orun release
 *  means served verbs that older binaries refuse with the "needs a newer
 *  orun" hint (forward-compatible, never a crash). */
const SERVED_OP_ALLOWLIST = new Set([
  "config.createBrokeredSecret",
  "config.createRotatedSecret",
  "config.listSecretsByProvider",
  "integrations.listConnections",
  "integrations.getConnection",
  "integrations.revokeConnection",
  "integrations.connectionHealth",
  "integrations.listTemplates",
  "integrations.listMinted",
  "integrations.revokeMinted",
  "integrations.listSandboxes",
]);

const VERB_SEGMENT_RE = /^[a-z][a-z0-9-]*$/;

describe("served CLI verbs (IR7)", () => {
  it("every declared verb invokes an allowlisted op with a well-formed shape", () => {
    for (const { manifest } of INTEGRATION_MANIFEST_MODULES) {
      for (const verb of manifest.cli?.verbs ?? []) {
        // Op allowlist — the security boundary, mirrored both sides.
        expect(SERVED_OP_ALLOWLIST.has(verb.invoke.op)).toBe(true);
        expect(["config", "integrations"]).toContain(verb.invoke.plane);
        // Paths are non-empty lowercase slugs (cobra command names).
        expect(verb.path.length).toBeGreaterThan(0);
        for (const segment of verb.path) expect(segment).toMatch(VERB_SEGMENT_RE);
        // Bind maps are pure arg→field data.
        for (const [arg, field] of Object.entries(verb.invoke.bind)) {
          expect(typeof arg).toBe("string");
          expect(typeof field).toBe("string");
        }
        // Args reference declared shapes only.
        for (const arg of verb.args) {
          expect(["positional", "flag"]).toContain(arg.kind);
          expect(["string", "int", "bool", "enum", "kv"]).toContain(arg.type);
          if (arg.type === "enum") expect((arg.enum ?? []).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("the dormant AWS proof serves a verb tree (IR9: manifest-only CLI presence)", () => {
    const aws = INTEGRATION_MANIFEST_MODULES.find((m) => m.manifest.id === "aws")!.manifest;
    expect(aws.cli?.verbs.length).toBeGreaterThan(0);
    const verb = aws.cli!.verbs[0]!;
    expect(verb.path).toEqual(["credentials", "list"]);
    expect(verb.invoke.op).toBe("integrations.listMinted");
    // The proof invariant: this file (+ fixtures) is the ONLY change a
    // served tree needs — the renderer and allowlist already shipped in orun.
  });
});
