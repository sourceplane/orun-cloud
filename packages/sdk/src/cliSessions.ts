import type {
  ListCliSessionsResponse,
  RevokeCliSessionResponse,
  GetCliGrantResponse,
  ApproveCliGrantResponse,
  DenyCliGrantResponse,
} from "@saas/contracts/auth";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * CLI session management (saas-orun-platform OP1). Console-facing surface served
 * by `apps/identity-worker` via the api-edge `auth` facade:
 *   - "Sessions & devices": list + revoke the signed-in user's CLI sessions.
 *   - CLI approval page: read a pending grant, then approve / deny it.
 *
 * The CLI device/loopback login dance (start/poll/token/revoke) is the `orun`
 * binary's job — it is not part of this console-oriented client.
 */
export class CliSessionsClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/auth/cli/sessions — the current user's CLI sessions. */
  list(opts: RequestOptions = {}): Promise<ListCliSessionsResponse> {
    return this.transport.request<ListCliSessionsResponse>(
      { method: "GET", path: `/v1/auth/cli/sessions` },
      opts,
    );
  }

  /** DELETE /v1/auth/cli/sessions/:sessionId — revoke a CLI session (and its family). */
  revoke(sessionId: string, opts: RequestOptions = {}): Promise<RevokeCliSessionResponse> {
    return this.transport.request<RevokeCliSessionResponse>(
      { method: "DELETE", path: `/v1/auth/cli/sessions/${encodeURIComponent(sessionId)}` },
      opts,
    );
  }

  /** GET /v1/auth/cli/grants/:grantId — read a pending grant for the approval page. */
  getGrant(grantId: string, opts: RequestOptions = {}): Promise<GetCliGrantResponse> {
    return this.transport.request<GetCliGrantResponse>(
      { method: "GET", path: `/v1/auth/cli/grants/${encodeURIComponent(grantId)}` },
      opts,
    );
  }

  /** POST /v1/auth/cli/grants/:grantId/approve — approve a pending CLI login. */
  approveGrant(grantId: string, opts: RequestOptions = {}): Promise<ApproveCliGrantResponse> {
    return this.transport.request<ApproveCliGrantResponse>(
      { method: "POST", path: `/v1/auth/cli/grants/${encodeURIComponent(grantId)}/approve`, body: {} },
      opts,
    );
  }

  /** POST /v1/auth/cli/grants/:grantId/deny — deny a pending CLI login. */
  denyGrant(grantId: string, opts: RequestOptions = {}): Promise<DenyCliGrantResponse> {
    return this.transport.request<DenyCliGrantResponse>(
      { method: "POST", path: `/v1/auth/cli/grants/${encodeURIComponent(grantId)}/deny`, body: {} },
      opts,
    );
  }

  /** POST /v1/auth/cli/grants/by-code/approve — approve a device-flow login by user code. */
  approveByUserCode(userCode: string, opts: RequestOptions = {}): Promise<ApproveCliGrantResponse> {
    return this.transport.request<ApproveCliGrantResponse>(
      { method: "POST", path: `/v1/auth/cli/grants/by-code/approve`, body: { userCode } },
      opts,
    );
  }
}
