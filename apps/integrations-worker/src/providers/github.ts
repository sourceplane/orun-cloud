import type { FetchLike } from "../github-app.js";
import { deleteInstallation, fetchInstallation, mintAppJwt } from "../github-app.js";
import type {
  BuildInstallUrlInput,
  CompleteConnectInput,
  InboundCapability,
  IntegrationProvider,
  ProviderConnectionFacts,
  ProviderCredentials,
} from "./types.js";

const INSTALL_BASE = "https://github.com/apps";

/** Constant-time hex compare (signature verification, R2). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// GitHub signs the RAW request body: X-Hub-Signature-256 = "sha256=" +
// HMAC-SHA256(webhook secret, body). Verify before any parse (IG2 wires
// the ingress; the verifier lives on the seam from day one).
async function verifyGithubSignature(
  webhookSecret: string,
  rawBody: ArrayBuffer,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, rawBody);
  const bytes = new Uint8Array(sig);
  let expected = "";
  for (let i = 0; i < bytes.length; i++) expected += bytes[i]!.toString(16).padStart(2, "0");
  return timingSafeEqualHex(provided, expected);
}

export function createGithubProvider(
  credentials: ProviderCredentials,
  fetchImpl: FetchLike = fetch,
): IntegrationProvider {
  const inbound: InboundCapability = {
    async verifySignature(rawBody, headers): Promise<boolean> {
      return verifyGithubSignature(
        credentials.webhookSecret,
        rawBody,
        headers["x-hub-signature-256"] ?? null,
      );
    },
  };

  return {
    id: "github",
    displayName: "GitHub",
    connectKind: "install",
    // IG4's token broker is re-expressed as the first credential-broker
    // capability in IH4; until then the capability is advertised through the
    // shipped github/token route, not the generic broker object.
    capabilities: ["connect", "inbound", "scm"],

    inbound,

    buildInstallUrl({ state }: BuildInstallUrlInput): string {
      const url = new URL(`${INSTALL_BASE}/${credentials.appSlug}/installations/new`);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async completeConnect({
      installationId,
      nowMs,
    }: CompleteConnectInput): Promise<ProviderConnectionFacts | null> {
      const jwt = await mintAppJwt(credentials.appId, credentials.privateKeyPem, nowMs);
      if (!jwt) return null;
      return fetchInstallation(jwt, installationId, fetchImpl);
    },

    async revokeInstallation(installationId: number, nowMs: number): Promise<boolean> {
      const jwt = await mintAppJwt(credentials.appId, credentials.privateKeyPem, nowMs);
      if (!jwt) return false;
      return deleteInstallation(jwt, installationId, fetchImpl);
    },

    // Legacy single-header alias (shipped IG2 handlers/tests) — delegates to
    // the capability object; one implementation, two call shapes.
    async verifyInboundSignature(
      rawBody: ArrayBuffer,
      signatureHeader: string | null,
    ): Promise<boolean> {
      return inbound.verifySignature(rawBody, { "x-hub-signature-256": signatureHeader }, 0);
    },
  };
}
