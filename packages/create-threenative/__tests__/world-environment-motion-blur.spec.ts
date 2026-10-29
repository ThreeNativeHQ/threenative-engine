import { PerspectiveCamera, Scene, Texture } from "three";
import { texture, vec4 } from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";
import { expect, it } from "vitest";
import {
  type OutputRenderer,
  WorldEnvironment,
} from "../../../test-support/isolated-world-environment.js";

/** The motion blur stage as the render chain meets it: asked `available` first, then built. */
function motionBlurStage(): {
  available: (context: { tier: "high" }) => boolean | string | undefined;
  build: (input: Node, context: { tier: "high"; velocityNode?: Node }) => Node;
  input: Node;
} {
  let found: ReturnType<typeof motionBlurStage> | undefined;
  const renderer: OutputRenderer = {
    kind: "webgpu",
    raw: {},
    createRenderChain(options) {
      const stage = options.stages?.find((entry) => entry.name === "motionBlur");
      if (stage === undefined) throw new Error("motionBlur stage missing");
      found = {
        available: (context) => stage.available?.(context),
        build: (input, context) => stage.build(input, context) as Node,
        input: options.input as Node,
      };
      return { applied: { stages: [], dropped: [] }, dispose() {} };
    },
  };
  new WorldEnvironment({ motionBlurEnabled: true }).apply(
    renderer,
    new Scene(),
    new PerspectiveCamera(),
  );
  if (found === undefined) throw new Error("the chain was never created");
  return found;
}

// The chain provisions the scene pass velocity after it asks `available` and before it calls
// `build`, so a stage that asks for the velocity node in `available` is dropped on every frame.
it("is available before the chain has provisioned the velocity", () => {
  const stage = motionBlurStage();
  expect(stage.available({ tier: "high" })).not.toEqual(expect.any(String));
  expect(stage.available({ tier: "high" })).not.toBe(false);
});

it("blurs the frame along the velocity the chain provisions", () => {
  const stage = motionBlurStage();
  const velocity = texture(new Texture()) as TextureNode;
  expect(stage.build(stage.input, { tier: "high", velocityNode: velocity })).not.toBe(stage.input);
});

it("names the missing velocity when the chain provisioned none", () => {
  const stage = motionBlurStage();
  expect(() => stage.build(vec4(0) as Node, { tier: "high" })).toThrow(/velocity/u);
});
