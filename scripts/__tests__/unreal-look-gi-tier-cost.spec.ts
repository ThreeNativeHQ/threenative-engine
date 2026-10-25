import { describe, expect, it } from "vitest";
import { parseArms } from "../unreal-look/gi-tier-cost.js";

describe("gi-tier-cost --arms", () => {
  it("reads a list of named arms and fails closed on a malformed one", () => {
    const arms = [
      { name: "rays16", method: "screenProbeGather" },
      { name: "rays8", method: "screenProbeGather", arm: { ssgiProbeRays: 8 } },
    ];
    expect(parseArms(JSON.stringify(arms))).toEqual(arms);
    expect(() => parseArms(JSON.stringify(arms.slice(0, 1)))).toThrow(/TN_GI_ARMS/);
    expect(() => parseArms(JSON.stringify([arms[0], arms[0]]))).toThrow(/duplicate/);
    expect(() => parseArms(JSON.stringify([arms[0], { name: "x" }]))).toThrow(/name and a method/);
    expect(() => parseArms(JSON.stringify([arms[0], { ...arms[1], arm: 8 }]))).toThrow(
      /chain options/,
    );
  });
});
