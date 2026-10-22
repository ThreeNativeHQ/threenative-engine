import { describe, expect, it } from "vitest";
import { vec3, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { GI_VISUALIZE_MODES, GIVisualize } from "../src/render/gi-visualize.js";

const beauty = vec4(1, 0.5, 0.25, 1) as unknown as Node<"vec4">;
const indirect = vec3(0.1, 0.2, 0.3) as unknown as Node<"vec3">;

describe("GIVisualize", () => {
  it("names Unreal's visualize modes it ships", () => {
    expect(GI_VISUALIZE_MODES).toEqual(["off", "indirectDiffuse"]);
  });

  it("returns the finished frame in off mode, even when a term is given", () => {
    expect(new GIVisualize({ mode: "off", beauty, indirectDiffuse: indirect }).node).toBe(beauty);
  });

  it("returns the indirect diffuse term alone in indirectDiffuse mode", () => {
    const shown = new GIVisualize({ mode: "indirectDiffuse", beauty, indirectDiffuse: indirect });
    expect(shown.node).not.toBe(beauty);
    expect(shown.mode).toBe("indirectDiffuse");
  });

  it("fails closed when the chain built no term for the mode", () => {
    expect(() => new GIVisualize({ mode: "indirectDiffuse", beauty })).toThrow(
      "TN_GI_VISUALIZE_TERM",
    );
  });

  it("fails on a mode it does not know", () => {
    expect(() => new GIVisualize({ mode: "radianceCache" as never, beauty })).toThrow(
      "TN_GI_VISUALIZE_MODE",
    );
  });
});
