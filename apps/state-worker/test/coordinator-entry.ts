// Test-only worker entry for the RunCoordinator integration test. Exports the DO
// and routes /runs/:id/<op> to its stub. This is loaded by miniflare in the
// integration test; it does not touch the deployed state-worker config.

import { RunCoordinator } from "../src/run-coordinator.js";

export { RunCoordinator };

interface TestEnv {
  COORDINATOR: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/runs\/([^/]+)(\/.*)?$/);
    if (!m) return new Response("not found", { status: 404 });
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(m[1]!));
    const inner = new URL(request.url);
    inner.pathname = m[2] ?? "/";
    return stub.fetch(new Request(inner.toString(), request));
  },
};
