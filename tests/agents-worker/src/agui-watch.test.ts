// The session AG-UI watch door (saas-copilot-surface CX1, design §2.3): the
// relay's attach choreography (hello → replay → live) through the attach
// bridge, as SSE. Same core, same cursor discipline as the AL6 feed — a
// second dialect, not a second fan-out.

import { RelayCore, type RelayStorage } from "../../../apps/agents-worker/src/relay-core.js";
import { handleBodyRequest } from "../../../apps/agents-worker/src/relay-shell.js";
import { eventFrame } from "@saas/contracts/agents-attach";
import type { AguiEvent } from "@saas/contracts/agui";

function memStorage(): RelayStorage {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string) {
      return m.get(k) as T | undefined;
    },
    async put<T>(k: string, v: T) {
      m.set(k, v);
    },
    async list<T>({ prefix }: { prefix: string }) {
      const out = new Map<string, T>();
      for (const [k, v] of m) if (k.startsWith(prefix)) out.set(k, v as T);
      return out;
    },
    async delete(k: string) {
      return m.delete(k);
    },
  };
}

/** Read parsed AG-UI events off an open SSE body until `min` SUBSTANTIVE
 * events arrive (presence chatter is advisory and arrival-order-dependent —
 * the same carve-out the AN1 conformance suite makes). */
async function readEvents(res: Response, min: number): Promise<AguiEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const out: AguiEvent[] = [];
  const substantive = () => out.filter((e) => !(e.type === "CUSTOM" && e.name === "presence")).length;
  while (substantive() < min) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (chunk.startsWith("data: ")) out.push(JSON.parse(chunk.slice(6)) as AguiEvent);
    }
  }
  await reader.cancel().catch(() => {});
  return out.filter((e) => !(e.type === "CUSTOM" && e.name === "presence"));
}

describe("CX1: GET /agui-watch on the relay", () => {
  it("replays past the cursor and follows live, all in dialect", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_1", runKind: "implementation" });
    await core.ingestEvents([
      eventFrame(1, "state_changed", "2026-07-21T09:00:00Z", { state: "running" }),
      eventFrame(2, "cost_sample", "2026-07-21T09:01:00Z", { tokens: 800 }),
    ]);

    const res = await handleBodyRequest(
      core,
      new Request("https://relay/agui-watch?from=-1&sessionId=as_1&surface=console&principal=usr_a"),
      async () => core,
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Live event lands after attach — the same fan-out, translated at source.
    await core.ingestEvents([eventFrame(3, "state_changed", "2026-07-21T09:02:00Z", { state: "completed" })]);

    const events = await readEvents(res, 4);
    expect(events[0]!.type).toBe("STATE_SNAPSHOT");
    expect(events[0]!.snapshot).toMatchObject({ sessionId: "as_1" });

    const deltas = events.filter((e) => e.type === "STATE_DELTA");
    expect(deltas.map((d) => d.ops![0]!.value)).toEqual(["running", "completed"]);
    expect(deltas.map((d) => d.seq)).toEqual([1, 3]);
    expect(events.find((e) => e.type === "CUSTOM" && e.name === "cost")!.value).toMatchObject({ tokens: 800 });
  });

  it("honors the ?from= cursor (no duplicate replay)", async () => {
    const core = new RelayCore(memStorage(), { sessionId: "as_2" });
    await core.ingestEvents([
      eventFrame(1, "state_changed", "2026-07-21T09:00:00Z", { state: "running" }),
      eventFrame(2, "cost_sample", "2026-07-21T09:01:00Z", { tokens: 100 }),
    ]);
    const res = await handleBodyRequest(
      core,
      new Request("https://relay/agui-watch?from=1&sessionId=as_2"),
      async () => core,
    );
    const events = await readEvents(res, 2);
    // Only seq 2 replays past the cursor; seq 1 never re-crosses the wire.
    expect(events.some((e) => e.seq === 1)).toBe(false);
    expect(events.find((e) => e.type === "CUSTOM" && e.name === "cost")!.seq).toBe(2);
  });
});
