import { describe, expect, test } from "vitest";

import { evaluateAudioAssertion } from "../src/evaluators/families-observation.js";

function observations(audio: unknown): unknown {
  return { gameplay: { audio } };
}

describe("evaluateAudioAssertion minGapMs fails closed", () => {
  test("a minGapMs bound cannot pass when the recentCues ledger is absent", () => {
    const result = evaluateAudioAssertion(
      { cue: "speech:p01", minPlays: 1, minGapMs: 500 },
      observations({ cues: { "speech:p01": 2 } }),
    );
    expect(result.assertion.pass).toBe(false);
    expect(result.diagnostic?.message).toContain("recentCues");
  });

  test("a minGapMs bound passes when the ledger reports a wide enough gap", () => {
    const result = evaluateAudioAssertion(
      { cue: "speech:p01", minPlays: 1, minGapMs: 500 },
      observations({
        cues: { "speech:p01": 2 },
        recentCues: [
          { atMs: 1000, cue: "announcer" },
          { atMs: 1800, cue: "speech:p01" },
        ],
      }),
    );
    expect(result.assertion.pass).toBe(true);
  });

  test("a minGapMs bound fails when the ledger shows a cut-off cue", () => {
    const result = evaluateAudioAssertion(
      { cue: "speech:p01", minPlays: 1, minGapMs: 500 },
      observations({
        cues: { "speech:p01": 1 },
        recentCues: [
          { atMs: 1000, cue: "announcer" },
          { atMs: 1200, cue: "speech:p01" },
        ],
      }),
    );
    expect(result.assertion.pass).toBe(false);
    expect(result.diagnostic?.message).toContain("cut off");
  });
});
