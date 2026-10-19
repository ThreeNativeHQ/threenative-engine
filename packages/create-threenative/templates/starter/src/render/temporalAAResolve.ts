// One equation owner shared by resolve and rejection counter, including explicit raw-mode rebuilds.
import { Fn, int, texture } from "three/tsl";
import type { Node, Renderer } from "three/webgpu";
import type { ITemporalAANode } from "./temporalAAFrame.js";
import {
  type TemporalCurrentFootprint,
  createTemporalCurrentFootprint,
} from "./temporalCurrentFootprint.js";
import type { TemporalCurrentProducer } from "./temporalCurrentProducer.js";
import { createExperimentalTemporalResolve } from "./temporalResolve.js";
import {
  type TemporalDepthRejection,
  type TemporalResolveNode,
  createTemporalDepthRejection,
} from "./temporalResolveDepth.js";

export function createTemporalAAResolve(
  node: TemporalResolveNode,
  jitterOffset: Node<"vec2">,
  currentProducer?: TemporalCurrentProducer,
) {
  const internals = node as unknown as ITemporalAANode;
  let rejection: TemporalDepthRejection | undefined;
  let currentFootprint: TemporalCurrentFootprint | undefined;
  function configure(renderer: Renderer): void {
    if (rejection === undefined) {
      const legacy = createTemporalDepthRejection(node, renderer);
      const current = currentProducer?.active()
        ? createTemporalCurrentFootprint(currentProducer.inputs, node, jitterOffset)
        : undefined;
      currentFootprint = current;
      rejection =
        current === undefined
          ? legacy
          : {
              ...legacy,
              historyValidity: Fn(([pixelUV]: [Node<"vec2">]) =>
                current.historyValidity(
                  pixelUV,
                  texture(internals._historyRenderTarget.texture).size(int(0)) as Node<"uvec2">,
                  legacy.historyValidity(pixelUV),
                ),
              ),
            };
    }
    internals._resolveMaterial.colorNode = createExperimentalTemporalResolve(
      node,
      renderer,
      jitterOffset,
      "linear",
      "ordinary",
      rejection,
      currentFootprint,
    );
    internals._resolveMaterial.needsUpdate = true;
  }
  return {
    equations: () => rejection,
    configure,
    invalidate: (renderer: Renderer) => {
      rejection = undefined;
      configure(renderer);
    },
  };
}
