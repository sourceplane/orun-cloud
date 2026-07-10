import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ATTACH_PROTOCOL_VERSION,
  decodeFrame,
  decodeFrames,
  encodeFrame,
  encodeFrameLine,
  isHeadInputFrame,
  isSealedEventFrame,
  liveFrame,
  steerFrame,
  verdictFrame,
  ackFrame,
  eventFrame,
  ATTACH_ACK_REASONS,
  type AttachFrame,
} from "@saas/contracts/agents-attach";

const here = dirname(fileURLToPath(import.meta.url));
// The golden fixtures are vendored verbatim from orun
// (internal/agent/attach/testdata); both codecs must round-trip them
// byte-identically (attach-protocol.md §7).
const FIXTURE_DIR = join(here, "../../../packages/contracts/src/agents-attach-fixtures");

describe("agents-attach: cross-repo golden fixtures", () => {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".ndjson"));

  it("has the vendored fixture set", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files).toContain("attach-replay-live.ndjson");
    expect(files).toContain("verdict-race.ndjson");
  });

  for (const file of files) {
    it(`round-trips ${file} byte-identically`, () => {
      const raw = readFileSync(join(FIXTURE_DIR, file), "utf8");
      const frames = decodeFrames(raw);
      // Every non-blank line re-encodes to exactly its source bytes — the
      // Go encoder and this TS encoder agree on the wire form.
      const reencoded = frames.map((f) => encodeFrameLine(f)).join("");
      expect(reencoded).toBe(raw);
    });
  }
});

describe("agents-attach: frame shape parity with the Go struct", () => {
  it("emits the exact wire form for representative frames", () => {
    // These byte strings are the Go encoder's output (compact, omitempty);
    // a struct-tag or field-order regression is a loud diff here.
    const cases: Array<[string, AttachFrame]> = [
      [`{"v":1,"t":"live","fromSeq":-1}`, liveFrame(-1)],
      [`{"v":1,"t":"steer","ref":"r1","text":"go"}`, steerFrame("r1", "go")],
      [`{"v":1,"t":"verdict","ref":"r2","requestId":"q1","approved":false}`, verdictFrame("r2", "q1", false, "")],
      [`{"v":1,"t":"ack","ref":"r2","ok":false,"reason":"not_pending"}`, ackFrame("r2", false, ATTACH_ACK_REASONS.notPending)],
      [
        `{"v":1,"t":"event","seq":0,"kind":"state_changed","payload":{"state":"running"}}`,
        eventFrame(0, "state_changed", "", { state: "running" }),
      ],
    ];
    for (const [want, frame] of cases) {
      expect(encodeFrame(frame)).toBe(want);
    }
  });

  it("classifies head-input and sealed-event frames", () => {
    expect(isHeadInputFrame(steerFrame("r", "x"))).toBe(true);
    expect(isHeadInputFrame(verdictFrame("r", "q", true, ""))).toBe(true);
    expect(isHeadInputFrame(liveFrame(0))).toBe(false);
    expect(isSealedEventFrame(eventFrame(1, "message_agent", "", {}))).toBe(true);
    expect(isSealedEventFrame({ v: 1, t: "delta", text: "x" })).toBe(false);
  });

  it("decodes an unknown frame type without throwing (forward compatibility)", () => {
    const f = decodeFrame(`{"v":1,"t":"future_thing","novel":true}`);
    expect(f.t).toBe("future_thing");
  });

  it("pins the protocol version", () => {
    expect(ATTACH_PROTOCOL_VERSION).toBe(1);
  });
});
