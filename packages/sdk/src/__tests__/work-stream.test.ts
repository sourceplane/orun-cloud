// Tests for `WorkClient.streamEvents` (orun-work v2 WP1b follow-up): the SSE
// tail of the coordination log. Frame parsing is pure (`parseWorkFrame`);
// the generator is driven against a fetch stub that streams a canned
// text/event-stream body, split awkwardly across chunks to prove the
// frame-boundary buffering.

import { describe, expect, it, vi } from "vitest";

import { OrunCloud } from "../index.js";
import { parseWorkFrame } from "../work.js";
import type { WorkEventView } from "@saas/contracts/work";

const EV1: WorkEventView = {
  eventId: "ev1",
  subject: "ORN-1",
  kind: "comment_added",
  actor: { type: "user", id: "usr_a", via: "console" },
  at: "2026-07-05T00:00:00Z",
  payload: { body: "hi" },
  seq: 4,
};
const EV2: WorkEventView = { ...EV1, eventId: "ev2", kind: "pinned", seq: 5 };

function sseBody(): string {
  return (
    "retry: 3000\n\n" +
    `id: 4\nevent: work\ndata: ${JSON.stringify(EV1)}\n\n` +
    ": ka\n\n" +
    `id: 5\nevent: work\ndata: ${JSON.stringify(EV2)}\n\n`
  );
}

function streamingFetch(body: string, chunkSize: number): typeof fetch {
  return vi.fn(async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < body.length; i += chunkSize) {
          controller.enqueue(encoder.encode(body.slice(i, i + chunkSize)));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

describe("parseWorkFrame", () => {
  it("parses a work frame and ignores comments and retry hints", () => {
    expect(parseWorkFrame(`id: 4\nevent: work\ndata: ${JSON.stringify(EV1)}`)).toEqual(EV1);
    expect(parseWorkFrame(": ka")).toBeNull();
    expect(parseWorkFrame("retry: 3000")).toBeNull();
    expect(parseWorkFrame("event: other\ndata: {}")).toBeNull();
    expect(parseWorkFrame("event: work\ndata: not-json")).toBeNull();
  });
});

describe("WorkClient.streamEvents", () => {
  it("yields each pushed event across awkward chunk boundaries, then returns", async () => {
    // chunkSize 7 splits frames mid-line — the buffer must reassemble them.
    const client = new OrunCloud({ baseUrl: "https://api.test", fetch: streamingFetch(sseBody(), 7) });
    const seen: WorkEventView[] = [];
    for await (const e of client.work.streamEvents("org_x", 3)) {
      seen.push(e);
    }
    expect(seen.map((e) => e.seq)).toEqual([4, 5]);
    expect(seen[0]).toEqual(EV1);
  });

  it("sends the cursor and the SSE accept header", async () => {
    const fetchImpl = streamingFetch(sseBody(), 64);
    const client = new OrunCloud({ baseUrl: "https://api.test", fetch: fetchImpl });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of client.work.streamEvents("org_x", 42)) {
      // drain
    }
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = mock.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain("/v1/organizations/org_x/work/events/stream");
    expect(url).toContain("from=42");
    expect(new Headers(init.headers).get("accept")).toBe("text/event-stream");
  });

  it("surfaces a typed error when the stream request is rejected", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "not_found", message: "Not found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const client = new OrunCloud({ baseUrl: "https://api.test", fetch: fetchImpl });
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.work.streamEvents("org_x")) {
        // unreachable
      }
    }).rejects.toMatchObject({ code: "not_found" });
  });
});
