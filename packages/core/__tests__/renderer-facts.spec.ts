// The renderer facts are one reader, so the four subsystems that used to probe `"engine" in info`
// cannot disagree about which backend drew the frame. These cases pin the probe's edge: upstream
// three, no info at all, a test double that passes nothing, and the owned engine.
import { describe, expect, it } from "vitest";
import { rendererFacts } from "../src/renderer-facts.js";

describe("renderer facts", () => {
  it("should report the owned engine when its info table is there", () => {
    expect(
      rendererFacts({ kind: "webgpu", raw: { info: { engine: { version: "0.3.12" } } } }),
    ).toEqual({
      kind: "webgpu",
      ownedEngine: true,
    });
  });

  it("should report upstream three, an empty info table and no renderer alike", () => {
    for (const renderer of [
      { kind: "webgpu", raw: { info: {} } },
      { kind: "webgl", raw: { info: {} } },
      { kind: "webgpu", raw: {} },
      { kind: "webgpu" },
      undefined,
      {},
    ]) {
      expect(rendererFacts(renderer).ownedEngine, JSON.stringify(renderer)).toBe(false);
    }
  });

  it("should name the backend the renderer reports, and say when it reports none", () => {
    expect(rendererFacts({ kind: "webgl", raw: { info: {} } }).kind).toBe("webgl");
    expect(rendererFacts({ raw: { info: {} } }).kind).toBe("unknown");
  });
});
