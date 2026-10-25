import type { ChainStage, IWorldEnvironmentOptions, OutputRenderer } from "@threenative/core";
import {
  abs,
  convertToTexture,
  dot,
  max,
  screenUV,
  select,
  textureSize,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";

/** This game's reconstruction detail. Zero disables it; full-resolution frames stay unchanged. */
export const temporalDetail = { strength: 1 };
let reportedStrength: number | undefined;

/** Match WorldEnvironment's owned temporal eligibility; an authored TRAA supplies its own provider. */
export function temporalDetailRequested(
  renderer: Pick<OutputRenderer, "kind" | "raw">,
  settings: Pick<IWorldEnvironmentOptions, "temporalAA" | "authoredStageNames">,
): boolean {
  if (settings.authoredStageNames?.includes("traa")) return true;
  const info = (renderer.raw as { info?: object }).info;
  return (
    settings.temporalAA === true &&
    renderer.kind === "webgpu" &&
    info !== undefined &&
    "engine" in info
  );
}

/** Scene-linear reconstruction detail, applied only when motion and output texture sizes differ. */
export function temporalDetailStages(): [ChainStage, ChainStage] {
  const strength = temporalDetail.strength;
  if (!Number.isFinite(strength) || strength < 0)
    throw new Error("temporalDetail.strength must be finite and nonnegative.");
  if (strength !== 1 && strength !== reportedStrength)
    console.info(`TN_TEMPORAL_DETAIL strength=${strength} source=override`);
  reportedStrength = strength;
  let colour: TextureNode | undefined;
  const available: NonNullable<ChainStage["available"]> = (chain) =>
    strength === 0
      ? "temporal-detail:strength=0"
      : chain.velocityNode === undefined
        ? "temporal-detail:velocity-missing"
        : true;
  return [
    {
      name: "temporalDetailSource",
      before: "bloom",
      available,
      build: (input) => {
        colour = convertToTexture(input as Node<"vec4">);
        return input;
      },
      dispose: () => {
        colour = undefined;
      },
    },
    {
      name: "temporalDetail",
      after: "bloom",
      available,
      build: (input, chain) => {
        if (chain.velocityNode === undefined)
          throw new Error("Temporal detail requires the temporal velocity texture.");
        if (colour === undefined) throw new Error("Temporal detail source must run before bloom.");
        const frame = input as Node<"vec4">;
        const outputSize = vec2(textureSize(colour) as unknown as Node<"uvec2">);
        const inputSize = vec2(
          textureSize(chain.velocityNode as TextureNode) as unknown as Node<"uvec2">,
        );
        const upscaled = inputSize.x.lessThan(outputSize.x).or(inputSize.y.lessThan(outputSize.y));
        const step = vec2(1).div(outputSize);
        const centre = colour.sample(screenUV);
        const left = colour.sample(screenUV.sub(vec2(step.x, 0))).rgb;
        const right = colour.sample(screenUV.add(vec2(step.x, 0))).rgb;
        const up = colour.sample(screenUV.sub(vec2(0, step.y))).rgb;
        const down = colour.sample(screenUV.add(vec2(0, step.y))).rgb;
        // UE 5.8.3 PostProcessTonemap.usf:440–485: four neighbours, HDR edge mask, strength / 6.
        // UE adds separately computed bloom later (:531–534); fuse this delta into final scene colour.
        const luma = vec3(0.2126, 0.7152, 0.0722);
        const centreLuma = dot(centre.rgb, luma);
        const edge = max(
          max(abs(dot(left, luma).sub(centreLuma)), abs(dot(right, luma).sub(centreLuma))),
          max(abs(dot(up, luma).sub(centreLuma)), abs(dot(down, luma).sub(centreLuma))),
        );
        const mask = edge.oneMinus().clamp(0, 1);
        const delta = left.add(right).add(up).add(down).sub(centre.rgb.mul(4));
        return vec4(
          select(upscaled, frame.rgb.sub(delta.mul(mask).mul(strength / 6)), frame.rgb),
          frame.a,
        );
      },
    },
  ];
}
