// Generated user source: this kit's `traa` stage. The chain owns stage order, velocity provisioning
// and the applied report; this file owns the effect, the camera it jitters and the history it
// disposes. The chain hands the stage the *sampled* velocity texture, while the accessor TRAANode
// needs for its unjittered projection reaches it separately through the graph context.
import type { OrthographicCamera, PerspectiveCamera } from "three";
import type { Node, PassNode, TextureNode } from "three/webgpu";
import { createTemporalAA } from "./temporalAA.js";
import type { ITemporalRejectionMeasurement } from "./temporalRejectionCounter.js";
import type { ChainStage, IWorldEnvironmentStageContext } from "./worldEnvironment.js";

export type TemporalResetReason =
  | "initial"
  | "camera-cut"
  | "projection-change"
  | "resize"
  | "scene-reset"
  | "device-loss";
export interface ITemporalAAReport {
  readonly frame: number;
  readonly historyValid: boolean;
  readonly resetReason: TemporalResetReason | null;
  readonly inputWidth: number;
  readonly inputHeight: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  /** Absent until a counted copy lands, never a number the provider did not measure. */
  readonly rejection?: ITemporalRejectionMeasurement;
}

/** The live provider, published once the chain has built the stage. */
export type TemporalAAProvider = ReturnType<typeof createTemporalAA>;

/** Where the provider goes, so a scene can read its report or reset history on a teleport. */
export interface ITemporalAAStageSink {
  onProvider?: (provider: TemporalAAProvider | undefined) => void;
}

/**
 * The `traa` stage this kit can request: pass this factory as `authoredStages` and name `"traa"` in
 * `authoredStageNames`. Nothing runs until it is named, which is why no shipped tier names it.
 */
export function temporalAAStages(
  context: IWorldEnvironmentStageContext,
  sink: ITemporalAAStageSink = {},
  currentPass?: PassNode,
): readonly ChainStage[] {
  const camera = context.camera as PerspectiveCamera | OrthographicCamera;
  let provider: TemporalAAProvider | undefined;
  return [
    {
      name: "traa",
      build: (input, chain) => {
        if (chain.velocityNode === undefined)
          throw new Error(
            "Temporal AA requires the scene pass velocity; it is provisioned per request.",
          );
        provider = createTemporalAA(
          input as Node,
          context.depthNode,
          chain.velocityNode as TextureNode,
          camera,
          currentPass,
        );
        sink.onProvider?.(provider);
        return provider.node;
      },
      // The chain publishes this as its velocity report; a stage that never built has no measurement.
      rejectionMeasurement: () => provider?.rejectionMeasurement(),
      dispose: () => {
        sink.onProvider?.(undefined);
        provider?.dispose();
        provider = undefined;
      },
    },
  ];
}
