import type { OrthographicCamera } from "three";
// Experimental finite raw4 estimator. The source pass owns all sample views; this allocates none.
import {
  Fn,
  If,
  float,
  getViewPosition,
  int,
  ivec2,
  struct,
  uint,
  vec2,
  vec4,
  viewZToOrthographicDepth,
  viewZToPerspectiveDepth,
} from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";
import { currentSampleArea } from "./temporalCurrentArea.js";
import { CURRENT_SAMPLE_POSITIONS } from "./temporalCurrentFootprintMath.js";
import type { TemporalResolveNode } from "./temporalResolveDepth.js";
import { reconstructNeighbourhood } from "./temporalResolveMath.js";

const colourStruct = struct({ color: "vec4", mean: "vec4", variance: "vec4" });
const validityStruct = struct({ hasValidHistory: "float", historyUV: "vec2", offsetUV: "vec2" });
export interface ITemporalCurrentInputs {
  readonly colour: TextureNode;
  readonly motion: TextureNode;
  readonly depth: TextureNode;
  readonly previousDepth: TextureNode;
}
/** Raw sample sites are finite radiance observations, with exact coverage/depth ownership and
 * selective sample-frequency alpha. Ordinary opaque RGB remains a spatial approximation. */
export function createTemporalCurrentFootprint(
  inputs: ITemporalCurrentInputs,
  node: TemporalResolveNode,
  jitter: Node<"vec2">,
) {
  const inputSize = vec2(inputs.colour.size(int(0)) as Node<"uvec2">);
  const offsets = [-1, 0, 1].flatMap((y) => [-1, 0, 1].map((x) => [x, y] as const));
  const eligible = (centre: Node<"vec2">, outputSize: Node<"uvec2">) =>
    centre
      .greaterThanEqual(1)
      .all()
      .and(centre.lessThan(inputSize.sub(1)).all())
      .and(inputSize.lessThanEqual(vec2(outputSize)).all())
      .and(inputSize.lessThan(vec2(outputSize)).any());
  const tapArea = (p: Node<"vec2">, half: Node<"vec2">, cell: Node<"vec2">, sample: number) =>
    currentSampleArea(uint(sample), p.sub(half).sub(cell), p.add(half).sub(cell)) as Node<"float">;

  function reconstruct(pixelUV: Node<"vec2">, outputSize: Node<"uvec2">) {
    const baseline = reconstructNeighbourhood(
      node.beautyNode,
      pixelUV,
      inputSize as unknown as Node<"uvec2">,
      jitter,
      outputSize,
    );
    const p = pixelUV.mul(inputSize).sub(jitter);
    const centre = p.floor();
    const half = inputSize.div(vec2(outputSize)).mul(0.5);
    const color = (baseline.get("color") as Node<"vec4">).toVar();
    const mean = (baseline.get("mean") as Node<"vec4">).toVar();
    const variance = (baseline.get("variance") as Node<"vec4">).toVar();
    If(eligible(centre, outputSize), () => {
      const sum = vec4(0).toVar();
      const squares = vec4(0).toVar();
      const mass = float(0).toVar();
      for (const [x, y] of offsets)
        for (let sample = 0; sample < 4; sample++) {
          const cell = centre.add(vec2(x, y));
          const weight = tapArea(p, half, cell, sample).toVar();
          If(weight.greaterThan(0), () => {
            const value = inputs.colour.load(ivec2(cell)).level(int(sample)).max(0).toVar();
            sum.addAssign(value.mul(weight));
            squares.addAssign(value.pow2().mul(weight));
            mass.addAssign(weight);
          });
        }
      const average = sum.div(mass.max(1e-12));
      color.assign(average);
      mean.assign(average);
      variance.assign(squares.div(mass.max(1e-12)).sub(average.pow2()).max(0).sqrt());
    });
    return colourStruct(color, mean, variance);
  }

  /** Each of four periodic sites has one nearest integer cell. Exact distance ties retain the
   * former 3×3 row/cell/sample order, including a neighbouring cell winning. */
  function previousDepth(historyPoint: Node<"vec2">) {
    const p = historyPoint.mul(inputSize);
    const centre = p.floor();
    const bestDistance = float(1e6).toVar();
    const bestRank = float(36).toVar();
    const bestCell = centre.toVar();
    const bestSite = vec2(0).toVar();
    const bestIndex = int(0).toVar();
    for (let sample = 0; sample < 4; sample++) {
      const site = vec2(...(CURRENT_SAMPLE_POSITIONS[sample] as readonly [number, number]));
      const cell = p.sub(site).sub(0.5).ceil();
      const delta = p.sub(cell.add(site));
      const distance = delta.dot(delta);
      const relative = cell.sub(centre).add(1);
      const rank = relative.y.mul(12).add(relative.x.mul(4)).add(sample);
      If(
        distance
          .lessThan(bestDistance)
          .or(distance.equal(bestDistance).and(rank.lessThan(bestRank))),
        () => {
          bestDistance.assign(distance);
          bestRank.assign(rank);
          bestCell.assign(cell);
          bestSite.assign(site);
          bestIndex.assign(int(sample));
        },
      );
    }
    const packet = inputs.previousDepth.load(ivec2(bestCell)).toVar();
    const depth = bestIndex
      .equal(0)
      .select(
        packet.r,
        bestIndex.equal(1).select(packet.g, bestIndex.equal(2).select(packet.b, packet.a)),
      ) as Node<"float">;
    const position = getViewPosition(
      bestCell.add(bestSite).div(inputSize),
      depth,
      node._previousCameraProjectionMatrixInverse,
    );
    const world = node._previousCameraWorldMatrix.mul(vec4(position, 1)).xyz;
    const z = node._cameraWorldMatrixInverse.mul(vec4(world, 1)).z;
    const transformed = (node.camera as OrthographicCamera).isOrthographicCamera
      ? viewZToOrthographicDepth(z, node._cameraNearFar.x, node._cameraNearFar.y)
      : viewZToPerspectiveDepth(z, node._cameraNearFar.x, node._cameraNearFar.y);
    return {
      transformed,
      inBounds: bestCell.greaterThanEqual(0).all().and(bestCell.lessThan(inputSize).all()),
    };
  }

  /** Retain BOTH original legacy vetoes, then add contributor rejection. A new matching sample
   * can never revive a legacy rejection. Resolve and counter consume this one combined equation. */
  function historyValidity(
    pixelUV: Node<"vec2">,
    outputSize: Node<"uvec2">,
    legacy: { get(key: string): Node },
  ) {
    const legal = float(legacy.get("hasValidHistory") as Node<"float">).toVar();
    const historyUV = vec2(legacy.get("historyUV") as Node<"vec2">).toVar();
    const offsetUV = vec2(legacy.get("offsetUV") as Node<"vec2">).toVar();
    const p = pixelUV.mul(inputSize).sub(jitter);
    const centre = p.floor();
    const half = inputSize.div(vec2(outputSize)).mul(0.5);
    const nearest = float(2).toVar();
    If(legal.greaterThan(0.5).and(eligible(centre, outputSize)), () => {
      for (const [x, y] of offsets)
        for (let sample = 0; sample < 4; sample++) {
          const cell = centre.add(vec2(x, y));
          const weight = tapArea(p, half, cell, sample);
          If(weight.greaterThan(0), () => {
            const depth = inputs.depth.load(ivec2(cell)).level(int(sample)).r.toVar();
            const motion = inputs.motion
              .load(ivec2(cell))
              .level(int(sample))
              .xy.mul(vec2(0.5, -0.5))
              .toVar();
            const site = vec2(...(CURRENT_SAMPLE_POSITIONS[sample] as readonly [number, number]));
            const historyPoint = cell
              .add(site)
              .div(inputSize)
              .add(node._currentJitterUV as Node<"vec2">)
              .sub(motion)
              .sub(node._previousJitterUV as Node<"vec2">);
            const prior = previousDepth(historyPoint);
            const donorUV = pixelUV.sub(motion);
            const inBounds = prior.inBounds
              .and(historyPoint.greaterThanEqual(0).all())
              .and(historyPoint.lessThan(1).all())
              .and(donorUV.greaterThanEqual(0).all())
              .and(donorUV.lessThanEqual(1).all());
            If(
              inBounds.not().or(depth.sub(prior.transformed).greaterThan(node.depthThreshold)),
              () => {
                legal.assign(0);
              },
            );
            If(depth.lessThan(nearest), () => {
              nearest.assign(depth);
              offsetUV.assign(motion);
              historyUV.assign(donorUV);
            });
          });
        }
    });
    return validityStruct(legal, historyUV, offsetUV);
  }
  return { reconstruct, historyValidity };
}
export type TemporalCurrentFootprint = ReturnType<typeof createTemporalCurrentFootprint>;
