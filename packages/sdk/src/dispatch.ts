// Dispatch resource (saas-dispatch DX0) — the Situation read-model.
// One read: the per-viewer fold of Ready / In-flight / Waiting-on-me / Budget
// the Dispatch surface renders. Served by the api-edge situation facade;
// authorized per viewer downstream, so the SDK adds nothing but the call.

import type { Situation } from "@saas/contracts/dispatch";
import type { RequestOptions, Transport } from "./transport.js";

export class DispatchClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/{orgId}/dispatch/situation */
  situation(orgId: string, opts: RequestOptions = {}): Promise<Situation> {
    return this.transport.request<Situation>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}/dispatch/situation` },
      opts,
    );
  }
}
